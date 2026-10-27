"""Run a trained row model.

    # score it on a held-out capture, tick by tick (the input rows come from the capture; the model writes the target rows)
    uv run python infer.py replay --ckpt runs/night/best.pt --dataset ../dataset --session session_EmeraldIngot64_1793056989898

    # drive it from another process: JSON lines on stdin, one JSON line back per tick (for the live proxy)
    uv run python infer.py serve --ckpt runs/night/best.pt --dataset ../dataset

`replay --feed truth` (default) puts the real target rows into the context after each tick, so every tick is judged on its own;
`--feed own` puts the model's own rows in, so mistakes carry forward as they would live (the "free-running" case).
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import torch

from protocol_ai import data
from protocol_ai.generate import Generator, Grammar, Sampling


def build_generator(args) -> Generator:
    ds = Path(args.dataset)
    device = args.device
    ck = torch.load(args.ckpt, map_location="cpu", weights_only=False)
    vocab_path = Path(args.vocab) if args.vocab else ds / "vocab.json"
    vocab = data.load_vocab(vocab_path)
    pairs = None
    if not args.no_grammar:
        manifest = json.loads((ds / "manifest.json").read_text())
        names = [s["name"] for s in manifest["sessions"] if s["name"] not in (args.exclude or [])]
        streams = {}
        for n in names:
            first, last = data.load_session_range(ds / "manifest.json", n)
            streams[n] = data.build_stream(data.load_ticks(ds / f"{n}.ticks.jsonl"), first, last, vocab)
        pairs = Grammar.learn(vocab, streams)
    sampling = Sampling(temperature=args.temperature, top_k=args.top_k, greedy=args.greedy)
    gen = Generator.load(args.ckpt, device, vocab_path, sampling, pairs)
    del ck
    return gen


def sig(tokens: list[str]) -> str:
    return " ".join(tokens[:3])


def replay(args) -> int:
    gen = build_generator(args)
    ds = Path(args.dataset)
    first, last = data.load_session_range(ds / "manifest.json", args.session)
    ticks = data.load_ticks(ds / f"{args.session}.ticks.jsonl")
    last = min(last, first + args.max_ticks - 1) if args.max_ticks else last
    print(f"{args.session}: ticks {first}..{last}, feed={args.feed}, {'greedy' if args.greedy else f'T={args.temperature} top_k={args.top_k}'}, grammar={'off' if args.no_grammar else 'on'}")

    cm = Counter()  # decision confusion and totals
    sig_tp = Counter()
    sig_gen = Counter()
    sig_true = Counter()
    by_type = defaultdict(lambda: [0, 0, 0])  # row type -> [matched, generated, true]
    tok_eq = tok_n = row_eq = row_n = 0
    lat, ntok = [], []
    shown = []
    out_file = open(args.out, "w") if args.out else None
    stream = data.load_terrain(ds, args.session, data.Stream(None, None, np.array([first]), np.array([first])))
    patch_of = lambda t: int(data.terrain_index(stream, np.array([t]))[0]) if stream.terrain is not None else None  # noqa: E731
    cur_patch = None
    for t in range(first, last + 1):
        rows = ticks.get(t, [])
        if patch_of(t) is not None and patch_of(t) != cur_patch:
            cur_patch = patch_of(t)
            gen.set_terrain(stream.terrain[cur_patch].tobytes())
        ins = [r[1:] for r in rows if r[0] == data.IO_INPUT]
        engs = [r[1:] for r in rows if r[0] == data.IO_ENGINE]
        truth = [r[1:] for r in rows if r[0] == data.IO_TARGET]
        if args.device.startswith("cuda"):
            torch.cuda.synchronize()
        t0 = time.perf_counter()
        gen.begin_tick(ins, engs)
        snap = gen.snapshot()
        made = gen.generate(args.max_tokens, args.max_rows)
        if args.device.startswith("cuda"):
            torch.cuda.synchronize()
        lat.append((time.perf_counter() - t0) * 1000)
        ntok.append(sum(len(r) + 1 for r in made) + 1)
        if args.feed == "truth":
            gen.restore(snap)
            gen.feed_out(truth)

        gt, tt = [gen.to_tokens(r) for r in made], [gen.to_tokens(r) for r in truth]
        cm["ticks"] += 1
        cm["true_active"] += bool(tt)
        cm["gen_active"] += bool(gt)
        cm["both_active"] += bool(tt) and bool(gt)
        cm["decision_hit"] += bool(tt) == bool(gt)
        cm["exact"] += sorted(map(tuple, made)) == sorted(map(tuple, truth))
        sg, st = Counter(map(sig, gt)), Counter(map(sig, tt))
        both = sg & st
        sig_tp.update(both), sig_gen.update(sg), sig_true.update(st)
        for k, n in both.items():
            by_type[k.split()[0]][0] += n
        for k, n in sg.items():
            by_type[k.split()[0]][1] += n
        for k, n in st.items():
            by_type[k.split()[0]][2] += n
        # rows with the same signature, paired in order: how many tokens agree
        gb, tb = defaultdict(list), defaultdict(list)
        for r in gt:
            gb[sig(r)].append(r)
        for r in tt:
            tb[sig(r)].append(r)
        for k in gb.keys() & tb.keys():
            for a, b in zip(gb[k], tb[k]):
                row_n += 1
                row_eq += a == b
                tok_n += max(len(a), len(b))
                tok_eq += sum(x == y for x, y in zip(a, b))
        if out_file:
            out_file.write(json.dumps({"t": t, "truth": [" ".join(r) for r in tt], "gen": [" ".join(r) for r in gt], "ms": lat[-1]}) + "\n")
        if tt and gt and len(shown) < args.show and t % 7 == 0:
            shown.append((t, tt, gt))
    if out_file:
        out_file.close()

    n = cm["ticks"]
    idle = 1 - cm["true_active"] / n
    print(f"\n{n} ticks; {cm['true_active']} had target rows ({1-idle:.1%}), the model wrote rows on {cm['gen_active']}")
    print(f"  tick decision: accuracy {cm['decision_hit']/n:.3f} vs {idle:.3f} for always-idle; "
          f"recall {cm['both_active']/max(cm['true_active'],1):.3f}, precision {cm['both_active']/max(cm['gen_active'],1):.3f}")
    print(f"  ticks whose rows are exactly right: {cm['exact']/n:.3f} (an idle model scores {idle:.3f})")
    tp, g, tr = sum(sig_tp.values()), sum(sig_gen.values()), sum(sig_true.values())
    print(f"  rows by (type, slot, kind): precision {tp/max(g,1):.3f}, recall {tp/max(tr,1):.3f}  ({g} written, {tr} real)")
    for ty, (m, gg, tt_) in sorted(by_type.items(), key=lambda kv: -kv[1][2]):
        print(f"    {ty:7s} matched {m:5d}  written {gg:5d}  real {tt_:5d}  precision {m/max(gg,1):.2f} recall {m/max(tt_,1):.2f}")
    print(f"  of the rows that matched in kind: {row_eq/max(row_n,1):.3f} are token-for-token identical, {tok_eq/max(tok_n,1):.3f} of their tokens agree")
    a = np.array(lat)
    print(f"  latency per tick: median {np.median(a):.1f} ms, p95 {np.percentile(a,95):.1f} ms, max {a.max():.1f} ms; {np.mean(ntok):.1f} tokens/tick "
          f"({'within' if np.percentile(a,95) <= 50 else 'over'} the 50 ms tick budget at p95)")
    for t, tt, gt in shown:
        print(f"\n--- tick {t}: real rows" + ("" if tt else " (none)"))
        for r in tt[:6]:
            print("   ", " ".join(r))
        print(f"--- model rows")
        for r in gt[:6]:
            print("   ", " ".join(r))
    return 0


def serve(args) -> int:
    """One JSON object per line in, one per line out.
    {"op":"reset"}                                       -> {"ok":true}
    {"op":"tick","in":[[tok,...],...],"eng":[...]}       -> {"out":[[tok,...],...],"ms":12.3}
    add "terrain":"<base64 of the 13*13*13 terrain bytes>" on every fourth tick for a model trained with terrain;
    add "feed_out":[[tok,...],...] to a tick to put those rows in the context instead of the model's own (a hybrid replay),
    or "gen":false to have the model read the tick without answering it (a server that has fallen behind)."""
    gen = build_generator(args)
    print(json.dumps({"ready": True, "vocab": len(gen.vocab.tokens), "ctx": gen.ctx_len}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            if req.get("op") == "reset":
                gen.reset()
                resp = {"ok": True}
            else:
                t0 = time.perf_counter()
                if req.get("terrain"):  # a new terrain patch, base64 of 13*13*13 category bytes; sent every few ticks
                    gen.set_terrain(base64.b64decode(req["terrain"]))
                gen.begin_tick([gen.to_ids(r) for r in req.get("in", [])], [gen.to_ids(r) for r in req.get("eng", [])])
                snap = gen.snapshot()
                if req.get("gen") is False:  # the caller is behind: the model reads this tick but writes nothing
                    gen.feed_out([])
                    made = []
                else:
                    made = gen.generate(args.max_tokens, args.max_rows)
                if "feed_out" in req:
                    gen.restore(snap)
                    gen.feed_out([gen.to_ids(r) for r in req["feed_out"]])
                resp = {"out": [gen.to_tokens(r) for r in made], "ms": round((time.perf_counter() - t0) * 1000, 2)}
                if "tick" in req:
                    resp["tick"] = req["tick"]
        except Exception as e:  # a bad request must not kill the loop
            resp = {"error": f"{type(e).__name__}: {e}"}
        print(json.dumps(resp), flush=True)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["replay", "serve"])
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--dataset", default="../dataset")
    ap.add_argument("--vocab", default=None, help="default: <dataset>/vocab.json")
    ap.add_argument("--session", help="replay: the session to run (a name in the dataset manifest)")
    ap.add_argument("--exclude", nargs="*", default=None, help="sessions the row grammar must not be learned from (default: none; pass the held-out one)")
    ap.add_argument("--feed", choices=["truth", "own"], default="truth")
    ap.add_argument("--temperature", type=float, default=0.8)
    ap.add_argument("--top-k", type=int, default=40)
    ap.add_argument("--greedy", action="store_true")
    ap.add_argument("--no-grammar", action="store_true", help="do not limit tokens to what the row grammar allows")
    ap.add_argument("--max-tokens", type=int, default=600, help="per tick; END is forced after this many")
    ap.add_argument("--max-rows", type=int, default=32, help="per tick; after this many rows the model can only finish the last one (0 = no limit)")
    ap.add_argument("--max-ticks", type=int, default=0, help="replay: stop after this many ticks (0 = the whole session)")
    ap.add_argument("--show", type=int, default=3, help="replay: print this many ticks, real rows beside the model's")
    ap.add_argument("--out", default=None, help="replay: write every tick's real and generated rows here (JSON lines)")
    ap.add_argument("--device", default="cuda:0" if torch.cuda.is_available() else "cpu")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()
    torch.manual_seed(args.seed)
    if args.mode == "replay":
        if not args.session:
            ap.error("replay needs --session")
        return replay(args)
    return serve(args)


if __name__ == "__main__":
    raise SystemExit(main())
