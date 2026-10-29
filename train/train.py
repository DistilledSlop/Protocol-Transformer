"""Train the row model on the reader's exported captures.

    uv run python train.py --dataset ../dataset --val session_EmeraldIngot64_1793051730684 --steps 1500
    uv run python train.py --dataset ../dataset --overfit        # the design doc's check: 100 ticks must reach ~0 loss

Reports, on the held-out session: the target-token loss, accuracy per kind of field (coarse and fine movement
tokens, angles, slots, row kinds, ...), and two baselines it must beat: always predict the most common token of
the field, and a unigram loss from the training sessions.
"""
from __future__ import annotations

import argparse
from assets import fingerprint
import builtins
import os
import json
import math
import time
from collections import Counter
from pathlib import Path

import numpy as np
import torch
import torch.distributed as dist
from torch.nn.parallel import DistributedDataParallel

from protocol_ai import data
from protocol_ai.model import Config, RowModel

from protocol_ai.fields import category


def load_streams(dataset: Path, names: list[str], vocab: data.Vocab) -> dict[str, data.Stream]:
    out = {}
    for name in names:
        first, last = data.load_session_range(dataset / "manifest.json", name)
        stream = data.build_stream(data.load_ticks(dataset / f"{name}.ticks.jsonl"), first, last, vocab)
        out[name] = data.load_terrain(dataset, name, stream)
    return out


def windows_of(streams: dict[str, data.Stream], ctx: int, stride: int) -> list[data.WindowSet]:
    return [data.WindowSet(s, ctx, stride_ticks=stride) for s in streams.values()]


def collate(items: list, device: str):
    """items: [(WindowSet, window index)]. Returns x, y, mask and, when the windows have terrain, the patches the TICK tokens
    in them read: (patches, batch index, position, patch number), each patch stored once however many ticks use it."""
    xs, ys, ms = [], [], []
    patches, seen, tb, tp, tu = [], {}, [], [], []
    for b, (ws, i) in enumerate(items):
        x, y, m = ws[i]
        xs.append(x), ys.append(y), ms.append(m)
        tr = ws.terrain_of(i)
        if tr is None:
            continue
        for pos, k in zip(tr[0].tolist(), tr[1].tolist()):
            u = seen.get((id(ws.stream), k))
            if u is None:
                u = seen[(id(ws.stream), k)] = len(patches)
                patches.append(ws.stream.terrain[k])
            tb.append(b), tp.append(pos), tu.append(u)
    t = lambda a, dt: torch.from_numpy(np.stack(a)).to(device=device, dtype=dt)  # noqa: E731
    terrain = None
    if patches:
        side = round(len(patches[0]) ** (1 / 3))
        terrain = (t(patches, torch.uint8).view(-1, side, side, side), *(torch.tensor(a, device=device) for a in (tb, tp, tu)))
    return t(xs, torch.long), t(ys, torch.long), t(ms, torch.float32), terrain


def sample_batch(sets: list[data.WindowSet], weights: np.ndarray, bs: int, rng: np.random.Generator, device: str):
    items = []
    for _ in range(bs):
        ws = sets[rng.choice(len(sets), p=weights)]
        items.append((ws, int(rng.integers(len(ws)))))
    return collate(items, device)


def sample_distributed_batch(sets, bs, rng, device, rank, world_size):
    """Sample unique windows uniformly across the global batch, then shard by rank."""
    sizes = np.array([len(ws) for ws in sets], dtype=np.int64)
    ends = np.cumsum(sizes)
    total = int(ends[-1]) if len(ends) else 0
    global_batch = bs * world_size
    if total < global_batch:
        raise ValueError(f"distributed global batch ({global_batch}) exceeds train windows ({total})")
    chosen = rng.choice(total, size=global_batch, replace=False)
    items = []
    for index in chosen[rank * bs : (rank + 1) * bs]:
        set_index = int(np.searchsorted(ends, index, side="right"))
        offset = int(ends[set_index - 1]) if set_index else 0
        items.append((sets[set_index], int(index) - offset))
    return collate(items, device)


def distributed_token_loss(loss, mask, world_size):
    """Weight rank-local token means so DDP produces the global token mean."""
    local_tokens = mask.sum()
    global_tokens = local_tokens.detach().clone()
    dist.all_reduce(global_tokens)
    return loss * (world_size * local_tokens / global_tokens.clamp(min=1))


@torch.no_grad()
def evaluate(model: RowModel, sets: list[data.WindowSet], cats: np.ndarray, device: str, vocab_end: int, max_windows: int = 96, bs: int = 8, *, distributed: bool = False, rank: int = 0, world_size: int = 1, progress=None):
    """Teacher-forced loss and accuracy on the masked (target) positions, overall and per field category."""
    # Avoid DDP forward collectives: ranks may have unequal batch counts.
    if isinstance(model, DistributedDataParallel):
        model = model.module
    was_training = model.training
    model.eval()
    names = sorted(set(cats.tolist()))
    nll = {c: 0.0 for c in names}
    hit = {c: 0 for c in names}
    cnt = {c: 0 for c in names}
    # The first target position of a tick is the decision 'does anything happen now?': OUT starts a row, END says idle.
    dec = {"n": 0, "hit": 0, "idle": 0, "pred_active_hit": 0, "active": 0, "pred_active": 0, "nll": 0.0}
    items = [(ws, int(i)) for ws in sets for i in np.linspace(0, len(ws) - 1, num=min(len(ws), max_windows), dtype=int)] if sets else []
    if distributed:
        items = items[rank::world_size]
    try:
        for i in range(0, len(items), bs):
            x, y, m, terrain = collate(items[i : i + bs], device)
            m = m.bool()
            with torch.autocast(device_type="cuda", dtype=torch.bfloat16, enabled=device.startswith("cuda")):
                logits, _ = model(x, terrain=terrain)
            lp = torch.log_softmax(logits.float(), dim=-1)
            tgt_lp = lp.gather(-1, y.unsqueeze(-1)).squeeze(-1)[m].cpu().numpy()
            correct = (lp.argmax(-1) == y)[m].cpu().numpy()
            # tick decisions: masked positions whose previous position is not masked
            prev = torch.zeros_like(m)
            prev[:, 1:] = m[:, :-1]
            start = m & ~prev
            ys, ps = y[start], lp.argmax(-1)[start]
            is_end = ys == vocab_end
            dec["n"] += int(start.sum())
            dec["hit"] += int((ys == ps).sum())
            dec["idle"] += int(is_end.sum())
            dec["active"] += int((~is_end).sum())
            dec["pred_active"] += int((ps != vocab_end).sum())
            dec["pred_active_hit"] += int(((ps != vocab_end) & ~is_end).sum())
            dec["nll"] -= float(lp.gather(-1, y.unsqueeze(-1)).squeeze(-1)[start].sum())
            c = cats[y[m].cpu().numpy()]
            for cat in names:
                sel = c == cat
                if sel.any():
                    nll[cat] -= float(tgt_lp[sel].sum())
                    hit[cat] += int(correct[sel].sum())
                    cnt[cat] += int(sel.sum())
            if progress is not None:
                progress(min(i + bs, len(items)), len(items))
    finally:
        model.train(was_training)
    if distributed:
        # Fixed layout permits ranks without windows to join the same reduction.
        values = [v for c in names for v in (nll[c], hit[c], cnt[c])]
        keys = ("n", "hit", "idle", "pred_active_hit", "active", "pred_active", "nll")
        values.extend(dec[k] for k in keys)
        reduced = torch.tensor(values, dtype=torch.float64, device=device)
        dist.all_reduce(reduced, op=dist.ReduceOp.SUM)
        values = reduced.cpu().tolist()
        for j, c in enumerate(names):
            nll[c], hit[c], cnt[c] = values[3 * j], int(values[3 * j + 1]), int(values[3 * j + 2])
        for j, k in enumerate(keys, 3 * len(names)):
            dec[k] = values[j] if k == "nll" else int(values[j])
    total = sum(cnt.values())
    per = {c: {"n": cnt[c], "nll": nll[c] / cnt[c], "acc": hit[c] / cnt[c]} for c in names if cnt[c]}
    d = dec["n"] or 1
    decision = {
        "ticks": dec["n"],
        "acc": dec["hit"] / d,
        "always_idle_acc": dec["idle"] / d,  # the 'nothing changes' baseline
        "nll": dec["nll"] / d,
        "recall_active": dec["pred_active_hit"] / max(dec["active"], 1),
        "precision_active": dec["pred_active_hit"] / max(dec["pred_active"], 1),
    }
    return {"nll": sum(nll.values()) / max(total, 1), "acc": sum(hit.values()) / max(total, 1), "tokens": total, "per_category": per, "decision": decision}


def baselines(train_streams, val_streams, vocab: data.Vocab, cats: np.ndarray):
    """What the model has to beat: the most common token per field, and a smoothed unigram over target tokens."""
    counts = Counter()
    by_cat: dict[str, Counter] = {}
    for s in train_streams.values():
        tgt = s.tokens[s.loss_mask.astype(bool)]
        counts.update(tgt.tolist())
        for t in tgt.tolist():
            by_cat.setdefault(cats[t], Counter())[t] += 1
    total = sum(counts.values())
    # Counter preserves first-seen order for ties, as in the uncached calculation.
    majority = {c: counter.most_common(1)[0][0] for c, counter in by_cat.items()}
    v = len(vocab.tokens)
    unigram_nll = 0.0
    n = 0
    majority_hit: Counter = Counter()
    majority_n: Counter = Counter()
    for s in val_streams.values():
        tgt = s.tokens[s.loss_mask.astype(bool)].tolist()
        for t in tgt:
            unigram_nll -= math.log((counts.get(t, 0) + 0.5) / (total + 0.5 * v))
            c = cats[t]
            majority_n[c] += 1
            if majority.get(c) == t:
                majority_hit[c] += 1
        n += len(tgt)
    idle = np.mean([1 - data.describe(s, vocab)["fraction_ticks_with_out"] for s in val_streams.values()]) if val_streams else float("nan")
    return {
        "unigram_nll": unigram_nll / max(n, 1),
        "idle_tick_fraction": float(idle),
        "majority_acc": {c: majority_hit[c] / majority_n[c] for c in majority_n},
    }


def load_initial_weights(model, cfg, vocab, checkpoint_path, vocab_path):
    """Load model weights only after checking the exact architecture and token order."""
    initial_vocab = data.load_vocab(Path(vocab_path))
    if initial_vocab.tokens != vocab.tokens:
        raise ValueError("initial checkpoint vocabulary does not match the training dataset")
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    if checkpoint["cfg"] != cfg.__dict__:
        raise ValueError("initial checkpoint configuration does not match the requested model")
    model.load_state_dict(checkpoint["model"], strict=True)


def lr_at(step: int, steps: int, lr: float, warmup: int = 100) -> float:
    if step < warmup:
        return lr * (step + 1) / warmup
    p = (step - warmup) / max(1, steps - warmup)
    return lr * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * p)))


def overfit(args, vocab, streams, device):
    """The design doc's infrastructure check: a short slice must be memorised to near-zero loss."""
    name = next(iter(streams))
    s = streams[name]
    n = int(s.tick_start[min(args.overfit_ticks, len(s.tick_start) - 1)])
    x = torch.from_numpy(s.tokens[:n].astype(np.int64)).unsqueeze(0).to(device)
    y = torch.from_numpy(s.tokens[1 : n + 1].astype(np.int64)).unsqueeze(0).to(device)
    m = torch.from_numpy(s.loss_mask[1 : n + 1].astype(np.float32)).unsqueeze(0).to(device)
    cfg = Config(vocab_size=len(vocab.tokens), ctx_len=max(n, 64), n_layer=args.layers, n_head=args.heads, n_embd=args.embd, dropout=0.0)
    model = RowModel(cfg).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=0.0)
    print(f"overfit: {args.overfit_ticks} ticks of {name} = {n} tokens ({int(m.sum())} target tokens), {model.n_params()/1e6:.1f}M params")
    for step in range(1, args.steps + 1):
        with torch.autocast(device_type="cuda", dtype=torch.bfloat16, enabled=device.startswith("cuda")):
            _, loss = model(x, y, m)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
        if step % 50 == 0 or loss.item() < 0.02:
            print(f"  step {step:4d} loss {loss.item():.4f}")
        if loss.item() < 0.02:
            print(f"overfit reached {loss.item():.4f} in {step} steps: the pipeline can learn")
            return True
    print(f"overfit did NOT reach 0.02 (last {loss.item():.4f}): something is wrong before the data is the problem")
    return False


def main() -> int:
    try:
        return train_main()
    finally:
        if dist.is_initialized():
            dist.destroy_process_group()


def train_main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default="../dataset")
    ap.add_argument("--val", nargs="*", default=["session_EmeraldIngot64_1793051730684"])
    ap.add_argument("--train", nargs="*", default=None, help="default: every other session in the manifest")
    ap.add_argument("--name", default="run")
    ap.add_argument("--run-root", default="runs", help="directory for training runs")
    ap.add_argument("--init-from", help="initialize model weights from a checkpoint (optimizer and step are reset)")
    ap.add_argument("--init-vocab", help="vocab.json used by --init-from, for compatibility validation")
    ap.add_argument("--steps", type=int, default=1500)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--ctx", type=int, default=2048)
    ap.add_argument("--lr", type=float, default=6e-4)
    ap.add_argument("--layers", type=int, default=4)
    ap.add_argument("--heads", type=int, default=4)
    ap.add_argument("--embd", type=int, default=256)
    ap.add_argument("--dropout", type=float, default=0.1)
    ap.add_argument("--debug-distributed", action="store_true", help="log distributed milestones on every step")
    ap.add_argument("--log-every", type=int, default=10, help="report training loss every N steps (also reports step 1)")
    ap.add_argument("--eval-every", type=int, default=1000)
    ap.add_argument("--eval-windows-per-session", type=int, default=96, help="maximum evenly spaced validation windows per session")
    ap.add_argument("--device", default="cuda:0")
    ap.add_argument("--overfit", action="store_true")
    ap.add_argument("--overfit-ticks", type=int, default=100)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--terrain", action=argparse.BooleanOptionalAction, default=None, help="read the terrain patches (default: yes when the dataset has them)")
    args = ap.parse_args()
    if bool(args.init_from) != bool(args.init_vocab):
        ap.error("--init-from and --init-vocab must be provided together")
    if args.steps < 1 or args.log_every < 1 or args.eval_every < 1 or args.eval_windows_per_session < 1:
        ap.error("--steps, --log-every, --eval-every and --eval-windows-per-session must be positive")

    world_size = int(os.environ.get("WORLD_SIZE", "1"))
    rank = int(os.environ.get("RANK", "0"))
    local_rank = int(os.environ.get("LOCAL_RANK", "0"))
    if world_size < 1 or not 0 <= rank < world_size or local_rank < 0:
        ap.error("invalid torchrun rank or world size")
    if args.batch < 1:
        ap.error("--batch must be positive")
    distributed = world_size > 1
    if not distributed:
        try:
            selected_device = torch.device(args.device)
        except (RuntimeError, ValueError) as exc:
            ap.error(f"invalid device {args.device!r}: {exc}")
        if selected_device.type == "cuda":
            index = selected_device.index if selected_device.index is not None else 0
            if not torch.cuda.is_available() or index >= torch.cuda.device_count():
                ap.error(f"CUDA device {args.device} is unavailable; check the NVIDIA driver and CUDA_VISIBLE_DEVICES, or use TRAIN_EXTRA=cpu DEVICE=cpu for CPU")
            try:
                torch.cuda.set_device(index)
            except RuntimeError as exc:
                ap.error(f"could not initialize CUDA device {args.device}: {exc}")
    if distributed and args.overfit:
        ap.error("--overfit does not support distributed training")
    if distributed:
        if args.device == "cpu":
            backend = "gloo"
        elif args.device == "cuda" or args.device.startswith("cuda:"):
            if not torch.cuda.is_available() or local_rank >= torch.cuda.device_count():
                ap.error(f"LOCAL_RANK {local_rank} has no available CUDA device")
            torch.cuda.set_device(local_rank)
            args.device = f"cuda:{local_rank}"
            backend = "nccl"
        else:
            ap.error("distributed training requires --device cpu or cuda")
        device_name = f"{torch.cuda.get_device_name(local_rank)}, current CUDA device {torch.cuda.current_device()}" if backend == "nccl" else "CPU"
        builtins.print(f"[rank {rank}/{world_size} local_rank {local_rank}] pid {os.getpid()}; device {args.device} ({device_name}); CUDA_VISIBLE_DEVICES={os.environ.get('CUDA_VISIBLE_DEVICES', '<unset>')}; initializing {backend} process group", flush=True)
        dist.init_process_group(backend=backend)
    def progress(message):
        builtins.print(f"[rank {rank}/{world_size}] {message}", flush=True)
    print = (lambda *a, **kw: builtins.print(*a, **kw, flush=True)) if rank == 0 else lambda *a, **kw: None
    progress(f"device {args.device}; loading dataset")
    print(f"training workers {world_size}; batch per worker {args.batch}; global batch {args.batch * world_size}")
    torch.manual_seed(args.seed)
    rng = np.random.default_rng(args.seed)
    ds = Path(args.dataset)
    vocab = data.load_vocab(ds / "vocab.json")
    manifest = json.loads((ds / "manifest.json").read_text())
    all_names = [s["name"] for s in manifest["sessions"]]
    train_names = args.train if args.train else [n for n in all_names if n not in args.val]
    train = load_streams(ds, train_names, vocab)
    val = load_streams(ds, args.val, vocab) if not args.overfit else {}
    progress("dataset loaded; preparing model and windows")
    cats = np.array([category(t) for t in vocab.tokens], dtype=object)
    print(f"vocab {len(vocab.tokens)} tokens; train {train_names}; val {args.val}; device {args.device}")
    for n, s in {**train, **val}.items():
        d = data.describe(s, vocab)
        print(f"  {n}: {d['ticks']} ticks, {d['tokens']} tokens, {d['masked_tokens']} target tokens, {d['fraction_ticks_with_out']:.2f} of ticks have target rows")

    if args.overfit:
        return 0 if overfit(args, vocab, train, args.device) else 1

    have_terrain = all(s.terrain is not None for s in {**train, **val}.values())
    use_terrain = have_terrain if args.terrain is None else args.terrain
    if use_terrain and not have_terrain:
        raise SystemExit("--terrain needs every session exported with terrain patches (re-run dataset.js export)")
    cfg = Config(vocab_size=len(vocab.tokens), ctx_len=args.ctx, n_layer=args.layers, n_head=args.heads, n_embd=args.embd, dropout=args.dropout, terrain=use_terrain)
    model = RowModel(cfg).to(args.device)
    if args.init_from:
        try:
            load_initial_weights(model, cfg, vocab, args.init_from, args.init_vocab)
        except ValueError as error:
            raise SystemExit(str(error)) from error
        print("initialized model weights; optimizer and step start fresh")
    print(f"model {model.n_params()/1e6:.1f}M params, context {args.ctx} tokens, terrain input {'on' if use_terrain else 'off'}")
    tsets = windows_of(train, args.ctx, stride=2)
    vsets = windows_of(val, args.ctx, stride=8)
    w = np.array([len(s) for s in tsets], dtype=float)
    w /= w.sum()
    print(f"train windows {int(sum(len(s) for s in tsets))}, val windows {sum(len(s) for s in vsets)}")

    if rank == 0:
        progress("calculating validation baselines")
    base = baselines(train, val, vocab, cats) if rank == 0 else None
    if rank == 0:
        print(f"baselines on val: unigram NLL {base['unigram_nll']:.3f}; {base['idle_tick_fraction']:.2f} of ticks are idle (predicting END at once is right there)")

    if distributed:
        if sum(len(s) for s in tsets) < args.batch * world_size:
            raise ValueError("distributed global batch exceeds the number of training windows")
        progress("waiting for workers and initializing distributed model")
        model = DistributedDataParallel(model, device_ids=[local_rank] if backend == "nccl" else None,
                                        find_unused_parameters=use_terrain)
        progress("distributed model initialized")
    torch.manual_seed(args.seed + rank)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, betas=(0.9, 0.95), weight_decay=0.1)
    out = Path(args.run_root) / args.name
    if rank == 0:
        out.mkdir(parents=True, exist_ok=True)
    best = float("inf")
    t0 = time.time()
    progress("starting training")
    for step in range(1, args.steps + 1):
        def milestone(stage):
            if distributed and (step == 1 or args.debug_distributed):
                progress(f"step {step}: {stage}")
        for g in opt.param_groups:
            g["lr"] = lr_at(step - 1, args.steps, args.lr)
        milestone("sampling batch")
        if distributed:
            x, y, m, terrain = sample_distributed_batch(tsets, args.batch, rng, args.device, rank, world_size)
        else:
            x, y, m, terrain = sample_batch(tsets, w, args.batch, rng, args.device)
        if distributed and step == 1:
            terrain_info = "none" if terrain is None else f"{terrain[0].device}, shape={tuple(terrain[0].shape)}"
            progress(f"step 1: batch x={x.device}, shape={tuple(x.shape)}; terrain patches={terrain_info}")
        milestone("starting forward")
        with torch.autocast(device_type="cuda", dtype=torch.bfloat16, enabled=args.device.startswith("cuda")):
            _, loss = model(x, y, m, terrain=terrain)
        milestone("forward returned")
        if distributed:
            # DDP averages rank gradients; weight each rank by its target-token count
            # so the result matches the loss over the complete global batch.
            milestone("starting token-count all-reduce")
            loss = distributed_token_loss(loss, m, world_size)
            milestone("token-count all-reduce returned")
        opt.zero_grad(set_to_none=True)
        milestone("starting backward")
        loss.backward()
        milestone("backward returned")
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        milestone("starting optimizer step")
        opt.step()
        milestone("optimizer step returned")
        if step == 1 or step % args.log_every == 0:
            report_loss = loss.detach().clone()
            if distributed:
                dist.all_reduce(report_loss)
                report_loss /= world_size
            print(f"step {step:5d} train loss {report_loss.item():.4f}  ({time.time()-t0:.0f}s)")
        if step % args.eval_every == 0 or step == args.steps:
            if rank == 0:
                print(f"  evaluating at step {step}" + (f" across {world_size} workers" if distributed else ""))
            progress(f"step {step}: starting validation shard")
            last_report = 0
            def eval_progress(completed, total):
                nonlocal last_report
                if completed == total or completed - last_report >= 128:
                    progress(f"validation: {completed}/{total} local windows processed")
                    last_report = completed
            ev = evaluate(model.module if distributed else model, vsets, cats, args.device, vocab.end,
                          max_windows=args.eval_windows_per_session, distributed=distributed,
                          rank=rank, world_size=world_size, progress=eval_progress)
            progress(f"step {step}: validation metrics reduced")
            if rank == 0:
                dc = ev["decision"]
                print(f"  val: NLL {ev['nll']:.4f} (unigram {base['unigram_nll']:.3f}), token accuracy {ev['acc']:.3f}; tick decision {dc['acc']:.3f} (always-idle {dc['always_idle_acc']:.3f})")
                if ev["nll"] < best:
                    best = ev["nll"]
                    torch.save({"model": (model.module if distributed else model).state_dict(), "cfg": cfg.__dict__, "vocab": os.path.relpath(ds / "vocab.json", out), "vocab_relative_to_checkpoint": True, "vocab_sha256": fingerprint(ds / "vocab.json")}, out / "best.pt")
            if distributed:
                dist.barrier()
    if rank != 0:
        return 0
    dc = ev["decision"]
    print(f"\ntick decision 'does anything happen?' on {dc['ticks']} held-out ticks: accuracy {dc['acc']:.3f} vs {dc['always_idle_acc']:.3f} for always-idle; "
          f"active ticks found: recall {dc['recall_active']:.3f}, precision {dc['precision_active']:.3f}; NLL {dc['nll']:.3f}")
    print("per field on the held-out session (teacher-forced), model vs always-the-most-common-token:")
    print(f"  {'field':10s} {'tokens':>7s} {'NLL':>7s} {'acc':>6s} {'majority':>9s}")
    for c, r in sorted(ev["per_category"].items(), key=lambda kv: -kv[1]["n"]):
        print(f"  {c:10s} {r['n']:7d} {r['nll']:7.3f} {r['acc']:6.3f} {base['majority_acc'].get(c, float('nan')):9.3f}")
    (out / "metrics.json").write_text(json.dumps({"args": vars(args), "world_size": world_size, "global_batch": args.batch * world_size, "val": ev, "baselines": base, "best_val_nll": best}, indent=1))
    print(f"\nbest val NLL {best:.4f}; wrote {out}/best.pt and metrics.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
