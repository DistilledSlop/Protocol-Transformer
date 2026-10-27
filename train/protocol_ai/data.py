"""Turn the exported tick dataset into token streams for next-token training.

The JS exporter (reader/dataset/dataset.js) writes one vocab.json per dataset and, per capture, a
<name>.ticks.jsonl file plus a manifest.json. This module reads those files and lays each session out as one
flat token stream: every tick in the session's range becomes TICK, its input rows, its engine rows, its target
rows, and END. Only the target rows and the closing END are trained on, so the model learns to produce what the
player did next, and to say END when nothing happens (an idle tick is just TICK END).

Only numpy and the standard library are used, so this runs under the system python without the torch venv.
"""

from __future__ import annotations

import json
import operator
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

# Specials in the order the JS vocab builder writes them. Every vocab must contain all of them.
SPECIALS: tuple[str, ...] = ("<pad>", "<unk>", "<bos>", "<eos>", "TICK", "END", "IN", "OUT", "ENG")

# io codes in a ticks file row: row[0] is one of these, the rest are token ids.
IO_INPUT = 0
IO_TARGET = 1
IO_ENGINE = 2
_KNOWN_IO = (IO_INPUT, IO_TARGET, IO_ENGINE)


@dataclass
class Vocab:
    """Token table; a token's id is its position in `tokens`.

    The special ids are derived from `index` on construction so callers never hard-code positions.
    """

    tokens: list[str]
    index: dict[str, int]
    pad: int = field(init=False)
    unk: int = field(init=False)
    bos: int = field(init=False)
    eos: int = field(init=False)
    tick: int = field(init=False)
    end: int = field(init=False)
    in_: int = field(init=False)
    out: int = field(init=False)
    eng: int = field(init=False)

    def __post_init__(self) -> None:
        # A duplicate would make index disagree with the id a token actually occupies.
        if len(self.index) != len(self.tokens):
            raise ValueError("vocab has duplicate tokens")
        missing = [s for s in SPECIALS if s not in self.index]
        if missing:
            raise ValueError(f"vocab is missing specials: {missing}")
        self.pad = self.index["<pad>"]
        self.unk = self.index["<unk>"]
        self.bos = self.index["<bos>"]
        self.eos = self.index["<eos>"]
        self.tick = self.index["TICK"]
        self.end = self.index["END"]
        self.in_ = self.index["IN"]
        self.out = self.index["OUT"]
        self.eng = self.index["ENG"]

    @classmethod
    def from_tokens(cls, tokens: list[str]) -> Vocab:
        """Build a vocab from a token list, assigning ids by position."""
        return cls(tokens=list(tokens), index={t: i for i, t in enumerate(tokens)})


@dataclass
class Stream:
    """One session laid out as a flat sequence.

    tokens:      token ids, one per position.
    loss_mask:   1 where the position is trained on (target rows and the closing END), else 0.
    tick_start:  position of the TICK token that opens each tick.
    tick_of:     the tick number of each of those TICK tokens.
    """

    tokens: np.ndarray  # int32[n]
    loss_mask: np.ndarray  # uint8[n]
    tick_start: np.ndarray  # int64[k]
    tick_of: np.ndarray  # int32[k]
    # Terrain patches (block categories around the player), one every `terrain_every` ticks from tick `terrain_first`;
    # a tick uses the patch at or before it. None when the dataset was exported without them.
    terrain: np.ndarray | None = None  # uint8[patches, side**3]
    terrain_first: int = 0
    terrain_every: int = 4


def load_vocab(path: str | Path) -> Vocab:
    """Read a vocab.json written by dataset.js; only its `tokens` list matters here."""
    with open(path, encoding="utf-8") as f:
        obj = json.load(f)
    return Vocab.from_tokens(obj["tokens"])


def load_ticks(path: str | Path) -> dict[int, list[list[int]]]:
    """Read a <name>.ticks.jsonl file into {tick: rows}, each row being [io, id, id, ...].

    Ticks with no rows are absent from the file, so the result is sparse; build_stream fills the gaps.
    """
    ticks: dict[int, list[list[int]]] = {}
    with open(path, encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            if not line.strip():
                continue
            rec = json.loads(line)
            t = int(rec["t"])
            if t in ticks:
                # The exporter writes each tick once; a repeat means the file is corrupt, not a merge.
                raise ValueError(f"{path}:{line_no}: tick {t} appears more than once")
            ticks[t] = [[int(v) for v in row] for row in rec["r"]]
    return ticks


def load_terrain(dataset: str | Path, name: str, stream: Stream) -> Stream:
    """Attach the session's terrain patches (<name>.terrain.u8, described in manifest.json) to its stream, if there are any."""
    dataset = Path(dataset)
    with open(dataset / "manifest.json", encoding="utf-8") as f:
        manifest = json.load(f)
    for session in manifest["sessions"]:
        if session["name"] != name:
            continue
        info = session.get("terrain")
        path = dataset / info["file"] if info else None
        if not info or info.get("firstTick") is None or not path.exists():
            return stream
        cells = int(info["side"]) ** 3
        patches = np.fromfile(path, dtype=np.uint8).reshape(-1, cells)
        if len(patches) != int(info["patches"]):
            raise ValueError(f"{path}: {len(patches)} patches, the manifest says {info['patches']}")
        stream.terrain, stream.terrain_first, stream.terrain_every = patches, int(info["firstTick"]), int(info["every"])
        return stream
    raise KeyError(f"session {name!r} not in {dataset / 'manifest.json'}")


def terrain_index(stream: Stream, ticks: np.ndarray) -> np.ndarray:
    """Which patch each tick uses: the latest at or before it (ticks before the first use the first)."""
    return np.clip((ticks - stream.terrain_first) // stream.terrain_every, 0, len(stream.terrain) - 1)


def load_session_range(manifest_path: str | Path, name: str) -> tuple[int, int]:
    """Return (firstTick, lastTick) for the named session from manifest.json."""
    with open(manifest_path, encoding="utf-8") as f:
        manifest = json.load(f)
    for session in manifest["sessions"]:
        if session["name"] == name:
            return int(session["firstTick"]), int(session["lastTick"])
    raise KeyError(f"session {name!r} not in {manifest_path}")


# The order groups are emitted in within a tick: input, then engine context, then the targets that are
# learned. Within each group the rows keep the order the exporter wrote them.
def _groups(vocab: Vocab) -> tuple[tuple[int, int, int], ...]:
    return ((IO_INPUT, vocab.in_, 0), (IO_ENGINE, vocab.eng, 0), (IO_TARGET, vocab.out, 1))


def _check_row(row: list[int], vocab: Vocab) -> None:
    if not row or row[0] not in _KNOWN_IO:
        raise ValueError(f"row has no valid io code: {row}")
    if any(not 0 <= v < len(vocab.tokens) for v in row[1:]):
        raise ValueError(f"row has a token id outside the vocab: {row}")


def build_stream(
    ticks: dict[int, list[list[int]]], first_tick: int, last_tick: int, vocab: Vocab
) -> Stream:
    """Lay out every tick from first_tick to last_tick inclusive as one token stream.

    Idle ticks are included on purpose: they become TICK END, teaching the model that END is the
    right prediction when nothing happens.
    """
    if last_tick < first_tick:
        raise ValueError(f"empty tick range {first_tick}..{last_tick}")
    stray = [t for t in ticks if not first_tick <= t <= last_tick]
    if stray:
        raise ValueError(f"ticks outside the session range {first_tick}..{last_tick}: {sorted(stray)[:5]}")

    tokens: list[int] = []
    mask: list[int] = []
    tick_start: list[int] = []
    tick_of: list[int] = []
    for t in range(first_tick, last_tick + 1):
        tick_start.append(len(tokens))
        tick_of.append(t)
        tokens.append(vocab.tick)
        mask.append(0)
        rows = ticks.get(t, [])
        for row in rows:
            _check_row(row, vocab)
        for io, marker, learn in _groups(vocab):
            # Each row gets its own marker, so a row's ids are always preceded by IN, ENG or OUT.
            for row in rows:
                if row[0] != io:
                    continue
                tokens.append(marker)
                mask.append(learn)
                tokens.extend(row[1:])
                mask.extend([learn] * (len(row) - 1))
        tokens.append(vocab.end)
        mask.append(1)

    return Stream(
        tokens=np.asarray(tokens, dtype=np.int32),
        loss_mask=np.asarray(mask, dtype=np.uint8),
        tick_start=np.asarray(tick_start, dtype=np.int64),
        tick_of=np.asarray(tick_of, dtype=np.int32),
    )


def _window_starts(stream: Stream, ctx_len: int, stride_ticks: int) -> np.ndarray:
    """Positions of the windows that are kept, as an int64 array."""
    n = len(stream.tokens)
    # Every stride-th tick boundary is a candidate start. A window needs ctx_len inputs plus one
    # extra token for the last target, so the start must leave ctx_len + 1 positions.
    candidates = stream.tick_start[::stride_ticks]
    candidates = candidates[candidates + ctx_len + 1 <= n]
    # Target positions are s+1 .. s+ctx_len; a prefix sum of the mask counts them in O(1) per window.
    cum = np.concatenate(([0], np.cumsum(stream.loss_mask, dtype=np.int64)))
    trained = cum[candidates + ctx_len + 1] - cum[candidates + 1]
    return candidates[trained > 0]


class WindowSet(Sequence[tuple[np.ndarray, np.ndarray, np.ndarray]]):
    """Fixed-length training windows over a Stream, each starting at a TICK token.

    Item i is (x, y, mask): x = tokens[s:s+ctx_len], y = the same shifted right by one, and mask is
    the loss mask of the target positions. Windows with no trained target are dropped at construction.
    """

    def __init__(self, stream: Stream, ctx_len: int, stride_ticks: int = 1) -> None:
        if ctx_len < 1:
            raise ValueError("ctx_len must be at least 1")
        if stride_ticks < 1:
            raise ValueError("stride_ticks must be at least 1")
        self.stream = stream
        self.ctx_len = ctx_len
        self.starts = _window_starts(stream, ctx_len, stride_ticks)

    def __len__(self) -> int:
        return len(self.starts)

    def __getitem__(self, i: Any) -> tuple[np.ndarray, np.ndarray, np.ndarray]:  # type: ignore[override]
        if isinstance(i, slice):
            raise TypeError("WindowSet does not support slicing")
        i = operator.index(i)
        if not -len(self) <= i < len(self):
            raise IndexError("window index out of range")
        s = int(self.starts[i])
        e = s + self.ctx_len
        toks = self.stream.tokens
        # copy so a caller that edits a window cannot corrupt the stream.
        x = toks[s:e].copy()
        y = toks[s + 1 : e + 1].copy()
        mask = self.stream.loss_mask[s + 1 : e + 1].copy()
        return x, y, mask


    def terrain_of(self, i: int) -> tuple[np.ndarray, np.ndarray] | None:
        """For window i: where its TICK tokens sit (positions within the window) and the patch each uses; None without terrain."""
        st = self.stream
        if st.terrain is None:
            return None
        s = int(self.starts[operator.index(i)])
        lo, hi = np.searchsorted(st.tick_start, [s, s + self.ctx_len], side="left")
        return st.tick_start[lo:hi] - s, terrain_index(st, st.tick_of[lo:hi])


def windows(stream: Stream, ctx_len: int, stride_ticks: int = 1) -> WindowSet:
    """Convenience wrapper returning a WindowSet."""
    return WindowSet(stream, ctx_len, stride_ticks)


def split_by_session(names: Sequence[str], holdout: int) -> tuple[list[str], list[str]]:
    """Split session names into (train, val), holding out the last `holdout` names in the given order.

    Splitting by session rather than by window keeps a session's ticks from leaking across the split.
    """
    if not 0 <= holdout < len(names):
        raise ValueError(f"holdout must be between 0 and {len(names) - 1}, got {holdout}")
    names = list(names)
    if holdout == 0:
        return names, []
    return names[:-holdout], names[-holdout:]


def describe(stream: Stream, vocab: Vocab) -> dict[str, float | int]:
    """Summary numbers for one stream, for checking the data before training on it."""
    n = len(stream.tokens)
    k = len(stream.tick_start)
    masked = int(np.count_nonzero(stream.loss_mask))
    end_masked = int(np.count_nonzero((stream.tokens == vocab.end) & (stream.loss_mask == 1)))

    # An OUT token only ever opens a target row, so counting OUT tokens per tick counts target rows.
    is_out = (stream.tokens == vocab.out).astype(np.int64)
    cum_out = np.concatenate(([0], np.cumsum(is_out)))
    tick_ends = np.append(stream.tick_start[1:], n)
    out_per_tick = cum_out[tick_ends] - cum_out[stream.tick_start]
    ticks_with_out = int(np.count_nonzero(out_per_tick))

    return {
        "ticks": k,
        "tokens": n,
        "masked_tokens": masked,
        "fraction_ticks_with_out": ticks_with_out / k if k else 0.0,
        "mean_tokens_per_tick": n / k if k else 0.0,
        "end_share_of_masked": end_masked / masked if masked else 0.0,
    }
