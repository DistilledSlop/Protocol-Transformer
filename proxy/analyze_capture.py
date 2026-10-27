#!/usr/bin/env python3
"""Analyse captures in data/ and print the numbers the tokenizer / reader design needs.

Usage:  python analyze_capture.py [data_dir] [--out analysis.json]

Reads, per session:
  <base>.jsonl          index from the new recorder  {t, dir, state, name, off, len} + header/state markers
  <base>.parsed.jsonl   parsed play packets          {t, dir, name, data}
  session_*.jsonl       old-style parsed-only logs   {t, dir, name, data}
Standard library only. Packet and field names are the ones minecraft-protocol uses for 1.21.1 as I
remember them; section 1 lists the names actually in your capture, so fix the NAME SETS below if
a later section says it found nothing.
"""
import argparse
import bisect
import collections
import glob
import json
import math
import os

# ---- NAME SETS (adjust after looking at the inventory) -------------------------------------------
MOVE_NAMES = {"rel_entity_move", "entity_move_look"}     # fields dX dY dZ, wire units of 1/4096 block
VELOCITY_NAMES = {"entity_velocity"}                      # fields velocityX/Y/Z, units of 1/8000 block/tick
TICK_NAMES = MOVE_NAMES | VELOCITY_NAMES | {"entity_teleport", "entity_look", "entity_head_rotation"}
SPAWN_NAMES = {"spawn_entity"}
METADATA_NAMES = {"entity_metadata"}
TIME_NAMES = {"update_time"}
LOGIN_NAMES = {"login"}
SCAN_SKIP = {"map_chunk", "update_light", "declare_commands", "declare_recipes", "advancements",
             "tags", "chunk_biomes", "map", "registry_data", "player_info", "playerlist_header"}
DICT_MAX_DISTINCT = 24     # a numeric field with <= this many distinct values is a dictionary candidate
SCHEME_SIZES = (64, 1024)  # total bucket counts to compare


# ---- helpers ---------------------------------------------------------------------------------------
def to_int(v):
    """minecraft-protocol gives longs as ints, strings, or [hi, lo] pairs."""
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        return int(v)
    if isinstance(v, str):
        try:
            return int(v)
        except ValueError:
            return None
    if isinstance(v, list) and len(v) == 2 and all(isinstance(x, int) for x in v):
        return (v[0] << 32) | (v[1] & 0xFFFFFFFF)
    return None


def get(d, *keys):
    for k in keys:
        if isinstance(d, dict) and k in d:
            return d[k]
    return None


def pct(sorted_vals, p):
    if not sorted_vals:
        return float("nan")
    return sorted_vals[int(p / 100 * (len(sorted_vals) - 1))]


def read_lines(path):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def sniff(path):
    for o in read_lines(path):
        if "data" in o:
            return "parsed"
        if o.get("kind") in ("header", "state") or "off" in o:
            return "index"
        return "parsed"
    return "parsed"


def find_files(d):
    parsed, index = [], []
    for p in sorted(glob.glob(os.path.join(d, "*.jsonl"))):
        if p.endswith(".parsed.jsonl"):
            parsed.append(p)
        elif sniff(p) == "index":
            index.append(p)
        else:
            parsed.append(p)
    return parsed, index


# ---- bucket schemes --------------------------------------------------------------------------------
def make_linear(n, cap):
    half = n // 2
    step = cap / half

    def q(v):
        return max(-half, min(half, round(v / step))) * step
    return q


def make_log(n, lo, hi):
    m = max(2, (n - 1) // 2)                      # buckets per sign, plus one zero bucket
    ratio = (hi / lo) ** (1.0 / (m - 1))
    lr = math.log(ratio)

    def q(v):
        if v == 0:
            return 0.0
        j = max(0, min(m - 1, round(math.log(abs(v) / lo) / lr)))
        return math.copysign(lo * ratio ** j, v)
    return q


def make_quantile(n, train):
    m = max(2, (n - 1) // 2)
    pos = sorted(abs(x) for x in train if x != 0)
    if not pos:
        return lambda v: 0.0
    bounds = [pos[min(len(pos) - 1, (len(pos) * k) // m)] for k in range(1, m)]
    members = [[] for _ in range(m)]
    for a in pos:
        members[bisect.bisect_right(bounds, a)].append(a)
    centers = []
    for j, mem in enumerate(members):
        if mem:
            centers.append(mem[len(mem) // 2])
        else:
            centers.append(bounds[j - 1] if j > 0 else pos[0])

    def q(v):
        if v == 0:
            return 0.0
        return math.copysign(centers[bisect.bisect_right(bounds, abs(v))], v)
    return q


def make_hybrid(n, train, wire_max=32767, tail_share=0.05, tail_frac=0.25):
    """Quantile edges for the body (lowest 95% of non-zero |v|), then geometric buckets from there up to
    the wire maximum, so values larger than anything in the fit data do not clip."""
    m = max(4, (n - 1) // 2)
    pos = sorted(abs(x) for x in train if x != 0)
    if not pos:
        return lambda v: 0.0
    m_t = max(2, int(m * tail_frac))
    m_q = m - m_t
    cut = max(1, pos[min(len(pos) - 1, int(len(pos) * (1 - tail_share)))])
    body = [a for a in pos if a < cut]
    if len(body) < m_q or cut >= wire_max:
        return make_quantile(n, train)
    bounds_q = [body[min(len(body) - 1, (len(body) * k) // m_q)] for k in range(1, m_q)]
    ratio = (wire_max / cut) ** (1.0 / m_t)
    allb = bounds_q + [cut * ratio ** k for k in range(m_t)]
    members = [[] for _ in range(m)]
    for a in pos:
        members[min(m - 1, bisect.bisect_right(allb, a))].append(a)
    centers = []
    for j in range(m):
        if j >= m_q:
            centers.append(cut * ratio ** (j - m_q + 0.5))
        elif members[j]:
            centers.append(members[j][len(members[j]) // 2])
        else:
            centers.append(allb[j - 1] if j > 0 else pos[0])

    def q(v):
        if v == 0:
            return 0.0
        return math.copysign(centers[min(m - 1, bisect.bisect_right(allb, abs(v)))], v)
    return q


def evaluate(values, unit, label_prefix=""):
    """Fit on the first 60% of samples (chronological), test on the last 40%.

    A time split, not an even/odd split: neighbouring samples come from the same entity moving at
    nearly the same speed, so an interleaved split leaks the test set into the fit."""
    k = int(len(values) * 0.6)
    train, test = values[:k], values[k:]
    nz = [v for v in test if v != 0]
    if not nz or not train:
        return []
    hi = max(2, max(abs(v) for v in train))
    results = []
    for n in SCHEME_SIZES:
        schemes = {
            "linear": make_linear(n, hi),
            "log": make_log(n, 1, hi),
            "quantile": make_quantile(n, train),
            "hybrid": make_hybrid(n, train),     # note: reaches the wire max; linear/log stop at the fit data's max
        }
        for name, q in schemes.items():
            rel = sorted(abs(q(v) - v) / abs(v) for v in nz)
            ab = sorted(abs(q(v) - v) for v in nz)
            collapsed = sum(1 for v in nz if q(v) == 0) / len(nz)
            results.append({
                "scheme": f"{name}{n}", "median_rel_err": pct(rel, 50), "p95_rel_err": pct(rel, 95),
                "p95_abs_err_blocks": pct(ab, 95) / unit, "collapsed_to_zero": collapsed,
            })
    return results


# ---- the analysis ----------------------------------------------------------------------------------
class Stats:
    def __init__(self):
        self.inv = collections.Counter()              # (dir, state, name) -> count
        self.inv_bytes = collections.Counter()
        self.inv_has_bytes = False
        self.markers = []
        self.series = collections.defaultdict(list)   # move_xz, move_y, velocity (wire units)
        self.phase = []                               # per session
        self.numeric = {}                             # path -> {"vals": set|None, "n": int, "nonint": bool}
        self.meta = collections.defaultdict(collections.Counter)   # (etype, index) -> Counter(serializer)
        self.time = []                                # per session
        self.sessions = 0
        self.samples = {}                             # first S2C packet per configured name, for diagnostics


def scan_numbers(stats, d, path, depth, direction):
    if depth > 3:
        return
    if isinstance(d, dict):
        for k, v in d.items():
            scan_numbers(stats, v, f"{path}.{k}", depth + 1, direction)
    elif isinstance(d, list):
        if len(d) <= 16:
            for v in d:
                sub = path + "[]"
                # lists of {key, value} (attributes, metadata): keep the key in the path
                if isinstance(v, dict) and isinstance(v.get("key"), (str, int)) and not isinstance(v.get("key"), bool):
                    sub = f"{path}[{v['key']}]"
                scan_numbers(stats, v, sub, depth + 1, direction)
    elif isinstance(d, (int, float)) and not isinstance(d, bool):
        e = stats.numeric.setdefault(path, {"vals": set(), "n": 0, "nonint": False})
        e["n"] += 1
        if isinstance(d, float) and not float(d).is_integer():
            e["nonint"] = True
        if e["vals"] is not None:
            e["vals"].add(d)
            if len(e["vals"]) > 64:
                e["vals"] = None


def analyse_parsed(stats, path, has_index):
    stats.sessions += 1
    entity_type = {}
    tick_ts = []
    time_seq = []
    for o in read_lines(path):
        name, direction, t, data = o.get("name"), o.get("dir"), o.get("t"), o.get("data")
        if name is None or t is None:
            continue
        if not has_index:
            stats.inv[(direction, "play", name)] += 1
        if name not in SCAN_SKIP:
            scan_numbers(stats, data, f"{direction} {name}", 0, direction)
        if direction != "S2C":
            continue
        if name in TICK_NAMES | SPAWN_NAMES | METADATA_NAMES | TIME_NAMES and name not in stats.samples:
            stats.samples[name] = json.dumps(data, default=str)[:300]
        if name in LOGIN_NAMES:
            eid = get(data, "entityId")
            if eid is not None:
                entity_type[eid] = "self"
        elif name in SPAWN_NAMES:
            eid = get(data, "entityId")
            if eid is not None:
                entity_type[eid] = get(data, "type")
        elif name in METADATA_NAMES:
            etype = entity_type.get(get(data, "entityId"), "unknown")
            for m in get(data, "metadata") or []:
                stats.meta[(etype, m.get("key"))][m.get("type")] += 1
        elif name in TIME_NAMES:
            age, tod = to_int(get(data, "age", "worldAge")), to_int(get(data, "time", "timeOfDay"))
            if age is not None and tod is not None:
                time_seq.append((t, age, tod))
        if name in TICK_NAMES:
            tick_ts.append(t)
        if name in MOVE_NAMES:
            for ax in ("X", "Y", "Z"):
                v = get(data, "d" + ax, "delta" + ax)
                if isinstance(v, int):
                    stats.series["move_y" if ax == "Y" else "move_xz"].append(v)
                    stats.series["move_all"].append(v)     # chronological, for the time split
        elif name in VELOCITY_NAMES:
            comps = [get(data, "velocity" + ax) for ax in ("X", "Y", "Z")]
            nested = get(data, "velocity")           # newer versions: velocity: {x, y, z}
            if isinstance(nested, dict):
                comps = [get(nested, "x"), get(nested, "y"), get(nested, "z")]
            for v in comps:
                if isinstance(v, int) and not isinstance(v, bool):
                    stats.series["velocity"].append(v)

    # tick phase: circular concentration of t mod 50
    if len(tick_ts) >= 50:
        def phase_of(ts):
            c = sum(math.cos(2 * math.pi * (x % 50) / 50) for x in ts) / len(ts)
            s = sum(math.sin(2 * math.pi * (x % 50) / 50) for x in ts) / len(ts)
            return (math.atan2(s, c) % (2 * math.pi)) / (2 * math.pi) * 50, math.hypot(c, s)
        ph, r = phase_of(tick_ts)
        windows = collections.defaultdict(list)
        for x in tick_ts:
            windows[int(x // 30000)].append(x)
        wph = [phase_of(w)[0] for w in windows.values() if len(w) >= 50]
        stats.phase.append({"file": os.path.basename(path), "n": len(tick_ts), "phase_ms": ph,
                            "concentration": r, "window_phase_min": min(wph) if wph else None,
                            "window_phase_max": max(wph) if wph else None})

    if len(time_seq) >= 2:
        regular = locked = jumps = 0
        examples, gaps, dage = [], [], collections.Counter()
        for (t0, a0, d0), (t1, a1, d1) in zip(time_seq, time_seq[1:]):
            gaps.append(t1 - t0)
            dage[a1 - a0] += 1
            if d1 < 0:
                locked += 1
            elif abs((d1 - d0) - (a1 - a0)) <= 2:
                regular += 1
            else:
                jumps += 1
                if len(examples) < 5:
                    examples.append({"t": t1, "tod_from": d0, "tod_to": d1, "age_delta": a1 - a0})
        gaps.sort()
        stats.time.append({"file": os.path.basename(path), "packets": len(time_seq),
                           "median_gap_ms": pct(gaps, 50), "age_delta_top": dage.most_common(3),
                           "regular": regular, "locked": locked, "jumps": jumps, "jump_examples": examples})


def analyse_index(stats, path):
    for o in read_lines(path):
        if o.get("kind") == "state":
            stats.markers.append((os.path.basename(path), o.get("t"), o.get("from"), o.get("to"), o.get("cause")))
        elif "name" in o:
            key = (o.get("dir"), o.get("state"), o.get("name"))
            stats.inv[key] += 1
            stats.inv_bytes[key] += o.get("len", 0)
            stats.inv_has_bytes = True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("data_dir", nargs="?", default="data")
    ap.add_argument("--out", default="analysis.json")
    args = ap.parse_args()

    parsed, index = find_files(args.data_dir)
    if not parsed and not index:
        raise SystemExit(f"no .jsonl files in {args.data_dir}")
    stats = Stats()
    for p in index:
        analyse_index(stats, p)
    for p in parsed:
        base = p[:-len(".parsed.jsonl")] if p.endswith(".parsed.jsonl") else None
        analyse_parsed(stats, p, has_index=bool(base and os.path.exists(base + ".jsonl")))

    report = {}

    # 1. inventory
    print(f"== 1. Packet inventory ({stats.sessions} parsed session(s), {len(index)} index file(s)) ==")
    rows = sorted(stats.inv.items(), key=lambda kv: -kv[1])
    for (dr, st, nm), n in rows[:40]:
        b = f"{stats.inv_bytes[(dr, st, nm)]:>12,d} B" if stats.inv_has_bytes else ""
        print(f"  {n:>9,d}  {dr} {st:<13s} {nm} {b}")
    rare = [(k, n) for k, n in rows if n <= 3]
    print(f"  ... {len(rows)} distinct packet kinds; {len(rare)} seen <= 3 times (replay-only candidates):")
    print("   ", ", ".join(f"{k[0]} {k[1]} {k[2]}({n})" for k, n in rare[:60]) or "none")
    report["inventory"] = [{"dir": k[0], "state": k[1], "name": k[2], "count": n,
                            "bytes": stats.inv_bytes.get(k)} for k, n in rows]
    if stats.markers:
        print("  state markers:")
        for m in stats.markers[:20]:
            print("   ", m)
    report["markers"] = stats.markers

    # 2. tick phase
    print("\n== 2. Tick phase (t mod 50 over entity packets; concentration 1.0 = perfectly aligned) ==")
    if not stats.phase:
        print("  no entity packets found; check TICK_NAMES against section 1")
    for p in stats.phase:
        print(f"  {p['file']}: n={p['n']:,d} phase={p['phase_ms']:.1f} ms concentration={p['concentration']:.2f}"
              f" window range={p['window_phase_min']}..{p['window_phase_max']}")
    report["tick_phase"] = stats.phase

    # 3. movement distribution
    print("\n== 3. Movement deltas (wire units; xz and y separately) ==")
    report["distributions"] = {}
    for sname, unit in (("move_xz", 4096), ("move_y", 4096), ("velocity", 8000)):
        vals = stats.series.get(sname, [])
        if not vals:
            print(f"  {sname}: none found; check MOVE_NAMES / VELOCITY_NAMES against section 1")
            for nm in sorted((MOVE_NAMES if sname != "velocity" else VELOCITY_NAMES) & set(stats.samples)):
                print(f"    first {nm} packet looks like: {stats.samples[nm]}")
            continue
        nz = sorted(abs(v) for v in vals if v != 0)
        zero = 1 - len(nz) / len(vals)
        row = {f"p{p}": pct(nz, p) for p in (1, 5, 25, 50, 75, 95, 99)}
        row["max"] = nz[-1] if nz else 0
        print(f"  {sname}: n={len(vals):,d} zero={zero:.1%} |v| units:",
              " ".join(f"{k}={v}" for k, v in row.items()), f"(1 unit = 1/{unit} block)")
        report["distributions"][sname] = {"n": len(vals), "zero_fraction": zero, "unit_per_block": unit, **row}

    # 4. bucket scheme comparison
    print("\n== 4. Bucket schemes (fit on first 60% by time, tested on last 40%; linear/log/quantile at 64 and 1024) ==")
    report["schemes"] = {}
    series_eval = {"move_all": (stats.series.get("move_all", []), 4096),
                   "velocity": (stats.series.get("velocity", []), 8000)}
    for sname, (vals, unit) in series_eval.items():
        if len(vals) < 200:
            continue
        res = evaluate(vals, unit)
        report["schemes"][sname] = res
        print(f"  {sname} (n={len(vals):,d}):  scheme       median_rel  p95_rel   p95_abs(blocks)  collapsed_to_0")
        for r in res:
            print(f"    {r['scheme']:<12s} {r['median_rel_err']:>10.3f} {r['p95_rel_err']:>9.3f} "
                  f"{r['p95_abs_err_blocks']:>16.5f} {r['collapsed_to_zero']:>14.1%}")
    if not report["schemes"]:
        print("  not enough movement samples")

    # 5. numeric fields: dictionary vs bucket
    print("\n== 5. Non-integer numeric fields ==")
    cand = {k: v for k, v in stats.numeric.items() if v["nonint"]}
    # a real dictionary field repeats its values: require >= 3 samples per distinct value
    few = sorted((k, v) for k, v in cand.items()
                 if v["vals"] is not None and len(v["vals"]) <= DICT_MAX_DISTINCT
                 and v["n"] >= 3 * len(v["vals"]))
    few_keys = {k for k, _ in few}
    many = sorted(k for k in cand if k not in few_keys)
    print(f"  dictionary candidates (<= {DICT_MAX_DISTINCT} distinct values): {len(few)}")
    for k, v in few[:40]:
        print(f"    {k}  n={v['n']:,d}  values={sorted(v['vals'])[:8]}{' ...' if len(v['vals']) > 8 else ''}")
    print(f"  continuous (bucket) candidates: {len(many)}")
    print("   ", ", ".join(many[:30]))
    report["dictionary_candidates"] = {k: sorted(v["vals"]) for k, v in few}
    report["continuous_fields"] = many

    # 6. metadata serializer table
    print("\n== 6. Entity metadata: (entity type id, index) -> serializer types ==")
    if not stats.meta:
        print("  none found; check METADATA_NAMES / SPAWN_NAMES against section 1")
    conflicts = 0
    for (et, idx), c in sorted(stats.meta.items(), key=lambda kv: (str(kv[0][0]), str(kv[0][1]))):
        flag = ""
        if len(c) > 1:
            flag = "  <-- more than one serializer"
            conflicts += 1
        print(f"    type={et!s:<10} index={idx!s:<3} {dict(c)}{flag}")
    report["metadata_table"] = [{"entity_type": str(k[0]), "index": k[1], "serializers": dict(c)}
                                for k, c in stats.meta.items()]
    if conflicts:
        print(f"  {conflicts} (type, index) pairs have conflicting serializers; entity type was probably unknown")

    # 7. update_time
    print("\n== 7. update_time ==")
    if not stats.time:
        print("  none found; check TIME_NAMES against section 1")
    for tm in stats.time:
        print(f"  {tm['file']}: {tm['packets']:,d} packets, median gap {tm['median_gap_ms']:.0f} ms, "
              f"age delta {tm['age_delta_top']}")
        print(f"    follows the +age clock: {tm['regular']:,d}; locked (negative time): {tm['locked']:,d}; "
              f"jumps: {tm['jumps']:,d}")
        for ex in tm["jump_examples"]:
            print(f"      jump at t={ex['t']:.0f}: {ex['tod_from']} -> {ex['tod_to']} (age +{ex['age_delta']})")
    report["update_time"] = stats.time

    with open(args.out, "w") as f:
        json.dump(report, f, indent=1, default=str)
    print(f"\nWrote {args.out}")


if __name__ == "__main__":
    main()