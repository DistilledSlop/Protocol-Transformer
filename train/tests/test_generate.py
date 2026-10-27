"""Tests for protocol_ai.generate: the max_rows cap, max_tokens, and snapshot/restore. A tiny random model, no checkpoint."""

from __future__ import annotations

import unittest

import torch

from protocol_ai.data import SPECIALS, Vocab
from protocol_ai.generate import Generator, Sampling
from protocol_ai.model import Config, RowModel

# Same hand-made vocab shape as test_data.py: specials first, then a few content tokens.
VOCAB = Vocab.from_tokens(list(SPECIALS) + ["ENTITY", "BLOCK", "a", "b", "c"])
OUT = VOCAB.out
END = VOCAB.end


def _model(seed: int = 0) -> RowModel:
    torch.manual_seed(seed)
    cfg = Config(vocab_size=len(VOCAB.tokens), ctx_len=256, n_layer=1, n_head=2, n_embd=32, dropout=0.0)
    return RowModel(cfg)


def _bias(model: RowModel, token: int, amount: float) -> None:
    """Add `amount` to one token's logit at every step. (The head is tied to the embeddings, so there is no bias term.)"""
    real_step = model.step

    def step(idx, past=None, add=None):
        lg, pres = real_step(idx, past, add)
        lg = lg.clone()
        lg[..., token] += amount
        return lg, pres

    model.step = step


def _tick_tokens(gen: Generator) -> list[int]:
    """Ids of the current tick: from its last TICK on."""
    start = max(i for i, t in enumerate(gen.ids) if t == VOCAB.tick)
    return gen.ids[start:]


class GenerateCapTests(unittest.TestCase):
    def test_max_rows_stops_out_markers(self) -> None:
        model = _model()
        _bias(model, OUT, 1e4)  # every step wants to start a row
        gen = Generator(model, VOCAB, "cpu", Sampling(greedy=True))
        gen.begin_tick([[VOCAB.index["a"]]], [])

        rows = gen.generate(max_tokens=30, max_rows=2)

        tick = _tick_tokens(gen)
        self.assertEqual(tick.count(OUT), 2, "the tick should stop at exactly two OUT markers")
        self.assertLessEqual(len(rows), 2)
        # TICK, IN and one id, then at most max_tokens generated tokens plus the forced END
        self.assertLessEqual(len(tick), 3 + 30 + 1, "tick outgrew max_tokens")
        self.assertEqual(tick[-1], END)

    def test_max_rows_zero_is_no_limit(self) -> None:
        model = _model()
        _bias(model, OUT, 1e4)
        gen = Generator(model, VOCAB, "cpu", Sampling(greedy=True))
        gen.begin_tick([[VOCAB.index["a"]]], [])

        gen.generate(max_tokens=12, max_rows=0)

        self.assertGreater(_tick_tokens(gen).count(OUT), 2)


class SnapshotTests(unittest.TestCase):
    def test_restore_gives_back_the_context_and_logits(self) -> None:
        gen = Generator(_model(), VOCAB, "cpu", Sampling(greedy=True))
        gen.begin_tick([[VOCAB.index["a"], VOCAB.index["b"]]], [[VOCAB.index["c"]]])
        snap = gen.snapshot()
        n_before = len(gen.ids)
        logits_before = gen.logits.clone()

        gen.generate(max_tokens=20, max_rows=2)
        self.assertGreater(len(gen.ids), n_before)

        gen.restore(snap)
        self.assertEqual(len(gen.ids), n_before)
        self.assertTrue(torch.equal(gen.logits, logits_before))


if __name__ == "__main__":
    unittest.main()
