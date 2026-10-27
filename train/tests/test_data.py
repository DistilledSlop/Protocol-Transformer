"""Tests for protocol_ai.data: stream layout, windows, splits, and the real-data smoke test."""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

import numpy as np

from protocol_ai.data import (
    SPECIALS,
    Vocab,
    build_stream,
    describe,
    load_session_range,
    load_ticks,
    load_vocab,
    split_by_session,
    windows,
)

# Hand-made vocab: specials at their real positions, then a few content tokens.
#   0 <pad> 1 <unk> 2 <bos> 3 <eos> 4 TICK 5 END 6 IN 7 OUT 8 ENG 9 ENTITY 10 BLOCK 11 a 12 b 13 c
VOCAB = Vocab.from_tokens(list(SPECIALS) + ["ENTITY", "BLOCK", "a", "b", "c"])
TICK, END, IN, OUT, ENG = 4, 5, 6, 7, 8

# Ticks 5..8. Tick 5 has all three row kinds, tick 6 is idle (absent), tick 7 has one target row,
# tick 8 is idle at the end of the range.
TICKS = {
    5: [[0, 11, 12], [0, 13], [2, 9], [1, 10, 11], [1, 12]],
    7: [[1, 12]],
}
FIRST, LAST = 5, 8

TOKENS_5 = [TICK, IN, 11, 12, IN, 13, ENG, 9, OUT, 10, 11, OUT, 12, END]
MASK_5 = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1]
EXPECTED_TOKENS = TOKENS_5 + [TICK, END] + [TICK, OUT, 12, END] + [TICK, END]
EXPECTED_MASK = MASK_5 + [0, 1] + [0, 1, 1, 1] + [0, 1]


def _stream():
    return build_stream(TICKS, FIRST, LAST, VOCAB)


class BuildStreamTests(unittest.TestCase):
    def test_full_layout_and_mask(self) -> None:
        s = _stream()
        self.assertEqual(s.tokens.dtype, np.int32)
        self.assertEqual(s.loss_mask.dtype, np.uint8)
        self.assertEqual(s.tokens.tolist(), EXPECTED_TOKENS)
        self.assertEqual(s.loss_mask.tolist(), EXPECTED_MASK)

    def test_tick_all_three_kinds_in_group_order(self) -> None:
        # Input rows first, then engine, then targets; each row gets its own marker and keeps its order.
        s = _stream()
        self.assertEqual(s.tokens[:14].tolist(), TOKENS_5)
        self.assertEqual(s.loss_mask[:14].tolist(), MASK_5)

    def test_idle_tick_in_gap_is_tick_end(self) -> None:
        s = _stream()
        start = int(s.tick_start[1])
        self.assertEqual(s.tokens[start : start + 2].tolist(), [TICK, END])
        self.assertEqual(s.loss_mask[start : start + 2].tolist(), [0, 1])

    def test_tick_bounds(self) -> None:
        s = _stream()
        self.assertEqual(s.tick_of.tolist(), [5, 6, 7, 8])
        self.assertEqual(s.tick_start.tolist(), [0, 14, 16, 20])
        self.assertEqual(s.tick_of.dtype, np.int32)
        self.assertEqual(s.tick_start.dtype, np.int64)
        # Every tick opens with TICK, including the first and last.
        self.assertTrue(all(s.tokens[p] == TICK for p in s.tick_start))

    def test_stray_tick_outside_range_raises(self) -> None:
        with self.assertRaises(ValueError):
            build_stream({9: [[1, 12]]}, FIRST, LAST, VOCAB)

    def test_bad_io_code_raises(self) -> None:
        with self.assertRaises(ValueError):
            build_stream({5: [[3, 12]]}, FIRST, LAST, VOCAB)


class WindowTests(unittest.TestCase):
    def test_windows_start_at_tick_and_shift_by_one(self) -> None:
        s = _stream()
        ws = windows(s, ctx_len=4)
        self.assertEqual(len(ws), 2)  # the start at 0 has an all-zero target mask and is skipped
        for i in range(len(ws)):
            x, y, mask = ws[i]
            start = int(ws.starts[i])
            self.assertEqual(s.tokens[start], TICK)
            self.assertEqual(x.tolist(), s.tokens[start : start + 4].tolist())
            np.testing.assert_array_equal(y[:-1], x[1:])
            self.assertEqual(y.tolist(), s.tokens[start + 1 : start + 5].tolist())
            self.assertEqual(mask.tolist(), s.loss_mask[start + 1 : start + 5].tolist())
        self.assertEqual(ws[0][0].tolist(), [TICK, END, TICK, OUT])
        self.assertEqual(ws[0][2].tolist(), [1, 0, 1, 1])
        self.assertEqual(ws[1][0].tolist(), [TICK, OUT, 12, END])

    def test_all_zero_mask_windows_are_skipped(self) -> None:
        s = _stream()
        # Starting at tick 5 the targets are IN 11 12 IN 13 ENG 9: none are trained, so no window.
        ws = windows(s, ctx_len=4)
        self.assertNotIn(0, ws.starts.tolist())
        # Stride 2 keeps only the boundaries at ticks 5 and 7, and 5 is skipped.
        self.assertEqual(windows(s, ctx_len=4, stride_ticks=2).starts.tolist(), [16])

    def test_stream_shorter_than_ctx_gives_no_windows(self) -> None:
        s = _stream()
        self.assertEqual(len(windows(s, ctx_len=len(s.tokens))), 0)
        self.assertEqual(len(windows(s, ctx_len=50)), 0)

    def test_windows_fit_inside_stream(self) -> None:
        s = _stream()
        for ctx in range(1, 21):
            ws = windows(s, ctx)
            for start in ws.starts.tolist():
                self.assertLessEqual(start + ctx + 1, len(s.tokens))

    def test_index_out_of_range_raises(self) -> None:
        ws = windows(_stream(), ctx_len=4)
        with self.assertRaises(IndexError):
            _ = ws[len(ws)]


class SplitAndDescribeTests(unittest.TestCase):
    def test_split_holds_out_last_names(self) -> None:
        train, val = split_by_session(["a", "b", "c", "d"], holdout=1)
        self.assertEqual(train, ["a", "b", "c"])
        self.assertEqual(val, ["d"])
        self.assertEqual(split_by_session(["a", "b"], holdout=0), (["a", "b"], []))
        with self.assertRaises(ValueError):
            split_by_session(["a", "b"], holdout=2)

    def test_describe_on_hand_made_stream(self) -> None:
        d = describe(_stream(), VOCAB)
        self.assertEqual(d["ticks"], 4)
        self.assertEqual(d["tokens"], 22)
        # Masked: tick 5 has OUT 10 11 OUT 12 END (6), tick 6 END (1), tick 7 OUT 12 END (3), tick 8 END (1).
        self.assertEqual(d["masked_tokens"], 11)
        # Ticks 5 and 7 contain OUT rows, ticks 6 and 8 are idle.
        self.assertAlmostEqual(d["fraction_ticks_with_out"], 0.5)
        self.assertAlmostEqual(d["mean_tokens_per_tick"], 5.5)
        # Four END tokens among the eleven masked ones.
        self.assertAlmostEqual(d["end_share_of_masked"], 4 / 11)


class FileLoadTests(unittest.TestCase):
    def test_round_trip_through_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vocab_path = Path(tmp, "vocab.json")
            vocab_path.write_text(json.dumps({"tokens": VOCAB.tokens, "structural": 9, "sessions": []}))
            ticks_path = Path(tmp, "s.ticks.jsonl")
            lines = [{"t": t, "r": rows} for t, rows in sorted(TICKS.items())]
            ticks_path.write_text("\n".join(json.dumps(x) for x in lines) + "\n")
            manifest_path = Path(tmp, "manifest.json")
            manifest_path.write_text(
                json.dumps({"sessions": [{"name": "s", "firstTick": FIRST, "lastTick": LAST}]})
            )

            vocab = load_vocab(vocab_path)
            self.assertEqual(vocab.index["OUT"], OUT)
            self.assertEqual(load_ticks(ticks_path), TICKS)
            self.assertEqual(load_session_range(manifest_path, "s"), (FIRST, LAST))
            with self.assertRaises(KeyError):
                load_session_range(manifest_path, "missing")
            s = build_stream(load_ticks(ticks_path), FIRST, LAST, vocab)
            self.assertEqual(s.tokens.tolist(), EXPECTED_TOKENS)

    def test_vocab_without_specials_raises(self) -> None:
        with self.assertRaises(ValueError):
            Vocab.from_tokens(["a", "b"])


REAL_DIR = Path(
    "/tmp/claude-1000/-home-nathan-protocol-ai-v4/43117595-3b48-42b0-a230-c386d5b7d1ff/scratchpad/ds"
)
REAL_SESSION = "session_EmeraldIngot64_1793051401390"


@unittest.skipUnless(
    (REAL_DIR / "manifest.json").exists() and (REAL_DIR / "vocab.json").exists(),
    "real example data directory is not present",
)
class RealDataSmokeTest(unittest.TestCase):
    def test_mask_covers_exactly_out_rows_and_end(self) -> None:
        vocab = load_vocab(REAL_DIR / "vocab.json")
        first, last = load_session_range(REAL_DIR / "manifest.json", REAL_SESSION)
        ticks = load_ticks(REAL_DIR / f"{REAL_SESSION}.ticks.jsonl")
        s = build_stream(ticks, first, last, vocab)

        # Expected masked count, computed from the raw file: each io 1 row contributes its ids plus one
        # OUT marker, and every tick in the range contributes one END.
        expected = (last - first + 1) + sum(
            len(row) for rows in ticks.values() for row in rows if row[0] == 1
        )
        self.assertEqual(int(s.loss_mask.sum()), expected)

        # Markers: every OUT and END is trained, and TICK, IN and ENG never are. (Ids inside an OUT row
        # are masked too, so the mask is not just the marker tokens.)
        self.assertTrue(np.all(s.loss_mask[(s.tokens == vocab.out) | (s.tokens == vocab.end)] == 1))
        self.assertTrue(np.all(s.loss_mask[np.isin(s.tokens, [vocab.tick, vocab.in_, vocab.eng])] == 0))

        d = describe(s, vocab)
        self.assertEqual(d["ticks"], last - first + 1)
        self.assertEqual(d["masked_tokens"], expected)


if __name__ == "__main__":
    unittest.main()
