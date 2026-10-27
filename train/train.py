"""Train the row model on the reader's exported captures.

    uv run python train.py --dataset ../dataset --val session_EmeraldIngot64_1793051730684 --steps 1500
    uv run python train.py --dataset ../dataset --overfit        # the design doc's check: 100 ticks must reach ~0 loss

Reports, on the held-out session: the target-token loss, accuracy per kind of field (coarse and fine movement
tokens, angles, slots, row kinds, ...), and two baselines it must beat: always predict the most common token of
the field, and a unigram loss from the training sessions.
"""
from __future__ import annotations

import argparse
import json
import math
import time
from collections import Counter
from pathlib import Path

import numpy as np
import torch

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


@torch.no_grad()
def evaluate(model: RowModel, sets: list[data.WindowSet], cats: np.ndarray, device: str, vocab_end: int, max_windows: int = 96, bs: int = 8):
    """Teacher-forced loss and accuracy on the masked (target) positions, overall and per field category."""
    model.eval()
    names = sorted(set(cats.tolist()))
    nll = {c: 0.0 for c in names}
    hit = {c: 0 for c in names}
    cnt = {c: 0 for c in names}
    # The first target position of a tick is the decision 'does anything happen now?': OUT starts a row, END says idle.
    dec = {"n": 0, "hit": 0, "idle": 0, "pred_active_hit": 0, "active": 0, "pred_active": 0, "nll": 0.0}
    items = [(ws, int(i)) for ws in sets for i in np.linspace(0, len(ws) - 1, num=min(len(ws), max_windows), dtype=int)] if sets else []
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
    model.train()
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
            if by_cat.get(c) and by_cat[c].most_common(1)[0][0] == t:
                majority_hit[c] += 1
        n += len(tgt)
    idle = np.mean([1 - data.describe(s, vocab)["fraction_ticks_with_out"] for s in val_streams.values()]) if val_streams else float("nan")
    return {
        "unigram_nll": unigram_nll / max(n, 1),
        "idle_tick_fraction": float(idle),
        "majority_acc": {c: majority_hit[c] / majority_n[c] for c in majority_n},
    }


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
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default="../dataset")
    ap.add_argument("--val", nargs="*", default=["session_EmeraldIngot64_1793051730684"])
    ap.add_argument("--train", nargs="*", default=None, help="default: every other session in the manifest")
    ap.add_argument("--name", default="run")
    ap.add_argument("--steps", type=int, default=1500)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--ctx", type=int, default=2048)
    ap.add_argument("--lr", type=float, default=6e-4)
    ap.add_argument("--layers", type=int, default=4)
    ap.add_argument("--heads", type=int, default=4)
    ap.add_argument("--embd", type=int, default=256)
    ap.add_argument("--dropout", type=float, default=0.1)
    ap.add_argument("--eval-every", type=int, default=250)
    ap.add_argument("--device", default="cuda:0" if torch.cuda.is_available() else "cpu")
    ap.add_argument("--overfit", action="store_true")
    ap.add_argument("--overfit-ticks", type=int, default=100)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--terrain", action=argparse.BooleanOptionalAction, default=None, help="read the terrain patches (default: yes when the dataset has them)")
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    rng = np.random.default_rng(args.seed)
    ds = Path(args.dataset)
    vocab = data.load_vocab(ds / "vocab.json")
    manifest = json.loads((ds / "manifest.json").read_text())
    all_names = [s["name"] for s in manifest["sessions"]]
    train_names = args.train if args.train else [n for n in all_names if n not in args.val]
    train = load_streams(ds, train_names, vocab)
    val = load_streams(ds, args.val, vocab) if not args.overfit else {}
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
    print(f"model {model.n_params()/1e6:.1f}M params, context {args.ctx} tokens, terrain input {'on' if use_terrain else 'off'}")
    tsets = windows_of(train, args.ctx, stride=2)
    vsets = windows_of(val, args.ctx, stride=8)
    w = np.array([len(s) for s in tsets], dtype=float)
    w /= w.sum()
    print(f"train windows {int(sum(len(s) for s in tsets))}, val windows {sum(len(s) for s in vsets)}")

    base = baselines(train, val, vocab, cats)
    print(f"baselines on val: unigram NLL {base['unigram_nll']:.3f}; {base['idle_tick_fraction']:.2f} of ticks are idle (predicting END at once is right there)")

    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, betas=(0.9, 0.95), weight_decay=0.1)
    out = Path("runs") / args.name
    out.mkdir(parents=True, exist_ok=True)
    best = float("inf")
    t0 = time.time()
    for step in range(1, args.steps + 1):
        for g in opt.param_groups:
            g["lr"] = lr_at(step - 1, args.steps, args.lr)
        x, y, m, terrain = sample_batch(tsets, w, args.batch, rng, args.device)
        with torch.autocast(device_type="cuda", dtype=torch.bfloat16, enabled=args.device.startswith("cuda")):
            _, loss = model(x, y, m, terrain=terrain)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        if step % 50 == 0:
            print(f"step {step:5d} train loss {loss.item():.4f}  ({time.time()-t0:.0f}s)")
        if step % args.eval_every == 0 or step == args.steps:
            ev = evaluate(model, vsets, cats, args.device, vocab.end)
            dc = ev["decision"]
            print(f"  val: NLL {ev['nll']:.4f} (unigram {base['unigram_nll']:.3f}), token accuracy {ev['acc']:.3f}; tick decision {dc['acc']:.3f} (always-idle {dc['always_idle_acc']:.3f})")
            if ev["nll"] < best:
                best = ev["nll"]
                torch.save({"model": model.state_dict(), "cfg": cfg.__dict__, "vocab": str(ds / "vocab.json")}, out / "best.pt")
    ev = evaluate(model, vsets, cats, args.device, vocab.end)
    dc = ev["decision"]
    print(f"\ntick decision 'does anything happen?' on {dc['ticks']} held-out ticks: accuracy {dc['acc']:.3f} vs {dc['always_idle_acc']:.3f} for always-idle; "
          f"active ticks found: recall {dc['recall_active']:.3f}, precision {dc['precision_active']:.3f}; NLL {dc['nll']:.3f}")
    print("per field on the held-out session (teacher-forced), model vs always-the-most-common-token:")
    print(f"  {'field':10s} {'tokens':>7s} {'NLL':>7s} {'acc':>6s} {'majority':>9s}")
    for c, r in sorted(ev["per_category"].items(), key=lambda kv: -kv[1]["n"]):
        print(f"  {c:10s} {r['n']:7d} {r['nll']:7.3f} {r['acc']:6.3f} {base['majority_acc'].get(c, float('nan')):9.3f}")
    (out / "metrics.json").write_text(json.dumps({"args": vars(args), "val": ev, "baselines": base, "best_val_nll": best}, indent=1))
    print(f"\nbest val NLL {best:.4f}; wrote {out}/best.pt and metrics.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
