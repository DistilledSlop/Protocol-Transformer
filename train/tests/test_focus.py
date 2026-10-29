"""Tests for oversampling windows around server block changes and weighting those rows in the loss."""

import unittest
from unittest import mock

import numpy as np
import torch

import train
from protocol_ai.data import SPECIALS, FocusSampler, Vocab, WindowSet, build_stream

# 0-8 specials (TICK 4, END 5, IN 6, OUT 7, ENG 8), then 9 ENTITY 10 BLOCK 11 a 12 b 13 c
VOCAB = Vocab.from_tokens(list(SPECIALS) + ["ENTITY", "BLOCK", "a", "b", "c"])
TICK, END, IN, OUT, ENG = 4, 5, 6, 7, 8
IDS = {"out": OUT, "block": 10, "markers": [TICK, END, IN, OUT, ENG]}
CTX = 48


def _stream():
    """200 ticks; every 10th tick the input names a cell and the target row is a block change at that cell."""
    ticks = {}
    for t in range(0, 200):
        rows = [[1, 9, 11]]  # an entity target row every tick, so blocks are not the only content
        if t % 10 == 5:
            rows = [[0, 11, 12, 13]] + rows + [[1, 10, 12, 13, 11]]
        ticks[t] = rows
    return build_stream(ticks, 0, 199, VOCAB)


def _is_block_start(tokens):
    return (tokens[:-1] == OUT) & (tokens[1:] == 10)


class FocusSamplerTests(unittest.TestCase):
    def test_every_block_row_is_an_anchor(self):
        stream = _stream()
        sampler = FocusSampler({"s": stream}, VOCAB, CTX)
        self.assertEqual(len(sampler), int(_is_block_start(stream.tokens).sum()))
        self.assertEqual(len(sampler), 20)

    def test_sampled_windows_start_on_ticks_and_hold_the_row_with_lead(self):
        stream = _stream()
        sampler = FocusSampler({"s": stream}, VOCAB, CTX, lead=12)
        rng = np.random.default_rng(0)
        for ws, i in sampler.sample(rng, 200):
            s = int(ws.starts[i])
            self.assertIn(s, stream.tick_start)
            self.assertLessEqual(s + CTX + 1, len(stream.tokens))
            x, y, _ = ws[i]
            self.assertEqual(len(x), CTX)
            # the window holds a whole block row and some context before it
            hits = np.flatnonzero(_is_block_start(x))
            self.assertTrue(len(hits))
            self.assertTrue(any(h >= 12 or s == 0 for h in hits))
            self.assertTrue(any(h + 6 <= CTX for h in hits))

    def test_evaluation_items_are_deterministic_and_bounded(self):
        sampler = FocusSampler({"s": _stream()}, VOCAB, CTX)
        a = sampler.evaluation_items(7)
        b = sampler.evaluation_items(7)
        self.assertEqual(len(a), 7)
        self.assertEqual([int(w.starts[0]) for w, _ in a], [int(w.starts[0]) for w, _ in b])
        self.assertEqual(len(sampler.evaluation_items(1000)), 20)

    def test_streams_shorter_than_a_window_are_skipped(self):
        short = build_stream({1: [[1, 10, 12]]}, 0, 3, VOCAB)
        self.assertEqual(len(FocusSampler({"s": short}, VOCAB, 512)), 0)

    def test_explicit_starts_replace_the_stride_scan(self):
        stream = _stream()
        ws = WindowSet(stream, CTX, starts=[int(stream.tick_start[3])])
        self.assertEqual(len(ws), 1)
        x, y, _ = ws[0]
        np.testing.assert_array_equal(x, stream.tokens[int(stream.tick_start[3]):][:CTX])


class BatchTests(unittest.TestCase):
    def setUp(self):
        stream = _stream()
        self.sets = [WindowSet(stream, CTX, stride_ticks=2)]
        self.w = np.array([1.0])
        self.focus = FocusSampler({"s": stream}, VOCAB, CTX)

    def test_full_focus_batch_is_all_block_windows(self):
        x, y, m, _ = train.sample_batch(self.sets, self.w, 6, np.random.default_rng(1), "cpu", self.focus, 1.0)
        self.assertEqual(tuple(x.shape), (6, CTX))
        for row in y:
            self.assertTrue(bool(_is_block_start(row.numpy()).any()))

    def test_no_focus_matches_the_old_behaviour(self):
        a = train.sample_batch(self.sets, self.w, 4, np.random.default_rng(2), "cpu")
        b = train.sample_batch(self.sets, self.w, 4, np.random.default_rng(2), "cpu", self.focus, 0.0)
        self.assertTrue(torch.equal(a[0], b[0]))

    def test_distributed_shards_cover_the_global_batch(self):
        got = [train.sample_distributed_batch(self.sets, 4, np.random.default_rng(3), "cpu", r, 2, self.focus, 0.5)[0] for r in range(2)]
        self.assertEqual([tuple(g.shape) for g in got], [(4, CTX)] * 2)
        blocks = sum(int(_is_block_start(row.numpy()).any()) for g in got for row in g)
        self.assertGreaterEqual(blocks, 4)  # half of the 8 global windows are focus windows (others may hold one by chance)

    def test_focus_count_rounds_and_caps(self):
        self.assertEqual(train.focus_count(0.25, 16), 4)
        self.assertEqual(train.focus_count(1.0, 3), 3)
        self.assertEqual(train.focus_count(0.0, 16), 0)


class WeightTests(unittest.TestCase):
    def test_only_block_rows_are_weighted(self):
        #            OUT BLOCK a   b   OUT ENTITY a   END  OUT BLOCK c   END(tick)
        y = torch.tensor([[OUT, 10, 11, 12, OUT, 9, 11, END, OUT, 10, 13, END]])
        m = torch.ones_like(y, dtype=torch.float32)
        w = train.weight_block_rows(m, y, IDS, 5.0)
        self.assertEqual(w.tolist(), [[5, 5, 5, 5, 1, 1, 1, 1, 5, 5, 5, 1]])

    def test_weight_one_is_a_no_op_and_respects_the_mask(self):
        y = torch.tensor([[OUT, 10, 11, END]])
        m = torch.tensor([[1.0, 1.0, 0.0, 1.0]])
        self.assertTrue(torch.equal(train.weight_block_rows(m, y, IDS, 1.0), m))
        self.assertEqual(train.weight_block_rows(m, y, IDS, 3.0).tolist(), [[3, 3, 0, 1]])

    def test_a_block_token_inside_another_row_is_not_a_block_row(self):
        y = torch.tensor([[OUT, 9, 10, END]])
        start, _, in_row = train.block_rows(y, IDS)
        self.assertFalse(bool(start.any()) or bool(in_row.any()))


class _Oracle(torch.nn.Module):
    """Predicts exactly the next token of the batch it was last shown (through the patched collate)."""
    def __init__(self, vocab):
        super().__init__()
        self.vocab, self.y, self.p = vocab, None, torch.nn.Parameter(torch.zeros(1))

    def forward(self, x, terrain=None):
        logits = torch.full((*x.shape, self.vocab), -20.0)
        logits.scatter_(-1, self.y.unsqueeze(-1), 20.0)
        return logits + self.p, None


class EvaluateBlocksTests(unittest.TestCase):
    def setUp(self):
        self.items = FocusSampler({"s": _stream()}, VOCAB, CTX).evaluation_items(8)

    def test_oracle_scores_every_row_exact(self):
        oracle = _Oracle(len(VOCAB.tokens))
        real = train.collate

        def collate(items, device):
            out = real(items, device)
            oracle.y = out[1]
            return out

        with mock.patch.object(train, "collate", collate):
            r = train.evaluate_blocks(oracle, self.items, "cpu", IDS, bs=3)
        self.assertGreaterEqual(r["rows"], 8)
        self.assertEqual(r["exact"], 1.0)
        self.assertAlmostEqual(r["joint_p"], 1.0, places=3)
        self.assertEqual(r["token_acc"], 1.0)

    def test_untrained_model_scores_low_and_restores_mode(self):
        from protocol_ai.model import Config, RowModel
        model = RowModel(Config(vocab_size=len(VOCAB.tokens), ctx_len=CTX, n_layer=1, n_head=2, n_embd=16))
        model.train()
        r = train.evaluate_blocks(model, self.items, "cpu", IDS, bs=4)
        self.assertTrue(model.training)
        self.assertLess(r["joint_p"], 0.05)
        self.assertGreater(r["rows"], 0)

    def test_no_items_is_all_zero(self):
        r = train.evaluate_blocks(torch.nn.Identity(), [], "cpu", IDS)
        self.assertEqual((r["rows"], r["exact"]), (0, 0.0))


if __name__ == "__main__":
    unittest.main()
