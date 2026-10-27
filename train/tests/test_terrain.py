"""Tests for the terrain path: TerrainEncoder inside RowModel (forward vs incremental step), the Generator's terrain
handling (set_terrain, trim, snapshot/restore), and WindowSet.terrain_of / terrain_index. Tiny random models, CPU."""

from __future__ import annotations

import unittest

import numpy as np
import torch

from protocol_ai import data
from protocol_ai.data import SPECIALS, Stream, Vocab, WindowSet
from protocol_ai.generate import Generator, Sampling
from protocol_ai.model import Config, RowModel

# Same hand-made vocab shape as the other tests: specials first, then a few content tokens.
VOCAB = Vocab.from_tokens(list(SPECIALS) + ["ENTITY", "BLOCK", "a", "b", "c"])
TICK = VOCAB.tick
END = VOCAB.end
IN = VOCAB.in_
A = VOCAB.index["a"]
B = VOCAB.index["b"]
C = VOCAB.index["c"]
CONTENT = [VOCAB.index[t] for t in ("ENTITY", "BLOCK", "a", "b", "c")]
SIDE = 13
N_PATCH_BYTES = SIDE**3  # 2197


def _model(terrain: bool, ctx_len: int = 96, seed: int = 0) -> RowModel:
    torch.manual_seed(seed)
    cfg = Config(
        vocab_size=len(VOCAB.tokens), ctx_len=ctx_len, n_layer=2, n_head=2, n_embd=32, dropout=0.0, terrain=terrain
    )
    return RowModel(cfg).eval()


def _random_patches(n: int, seed: int) -> torch.Tensor:
    g = torch.Generator().manual_seed(seed)
    return torch.randint(0, 17, (n, SIDE, SIDE, SIDE), generator=g).to(torch.uint8)


def _patch_bytes(seed: int) -> bytes:
    rng = np.random.default_rng(seed)
    return rng.integers(0, 17, N_PATCH_BYTES, dtype=np.uint8).tobytes()


def _patch_tensor(patch: bytes) -> torch.Tensor:
    return torch.frombuffer(bytearray(patch), dtype=torch.uint8).view(SIDE, SIDE, SIDE)


class ForwardVsStepTests(unittest.TestCase):
    def test_full_forward_matches_chunked_step_with_terrain(self) -> None:
        model = _model(terrain=True)
        n = 40
        g = torch.Generator().manual_seed(7)
        seq = torch.tensor(
            [CONTENT[i] for i in torch.randint(0, len(CONTENT), (n,), generator=g).tolist()], dtype=torch.long
        )
        tick_pos = [0, 6, 13, 21, 30, 37]
        seq[tick_pos] = TICK
        idx = seq[None]
        patches = _random_patches(len(tick_pos), seed=3)
        tb = torch.zeros(len(tick_pos), dtype=torch.long)
        tp = torch.tensor(tick_pos, dtype=torch.long)
        tu = torch.arange(len(tick_pos), dtype=torch.long)

        with torch.no_grad():
            full, _ = model(idx, terrain=(patches, tb, tp, tu))
            vecs = model.terrain_enc(patches)

            logits_parts = []
            past = None
            bounds = [0, 7, 19, n]
            for lo, hi in zip(bounds[:-1], bounds[1:]):
                inside = [(p, k) for k, p in enumerate(tick_pos) if lo <= p < hi]
                add = None
                if inside:
                    rel = torch.tensor([p - lo for p, _ in inside], dtype=torch.long)
                    add = (rel, torch.stack([vecs[k] for _, k in inside]))
                lg, past = model.step(idx[:, lo:hi], past, add)
                logits_parts.append(lg)
            incremental = torch.cat(logits_parts, dim=1)

        self.assertEqual(full.shape, incremental.shape)
        diff = (full - incremental).abs().max().item()
        self.assertLess(diff, 1e-4, f"forward vs chunked step differ by {diff}")

    def test_different_patch_changes_logits_from_that_tick_on(self) -> None:
        model = _model(terrain=True)
        n = 30
        tick_pos = [0, 10, 20]
        g = torch.Generator().manual_seed(11)
        seq = torch.tensor([CONTENT[i] for i in torch.randint(0, len(CONTENT), (n,), generator=g).tolist()])
        seq[tick_pos] = TICK
        idx = seq[None]
        tb = torch.zeros(3, dtype=torch.long)
        tp = torch.tensor(tick_pos, dtype=torch.long)
        tu = torch.arange(3, dtype=torch.long)

        base = _random_patches(3, seed=5)
        changed = base.clone()
        changed[1] = _random_patches(1, seed=99)[0]  # only the second TICK's patch differs

        with torch.no_grad():
            lg_a, _ = model(idx, terrain=(base, tb, tp, tu))
            lg_b, _ = model(idx, terrain=(changed, tb, tp, tu))

        p = tick_pos[1]
        before = (lg_a[0, :p] - lg_b[0, :p]).abs().max().item()
        after = (lg_a[0, p:] - lg_b[0, p:]).abs().max().item()
        self.assertLess(before, 1e-6, "positions before the changed TICK must not see its patch (causal)")
        self.assertGreater(after, 1e-6, f"a different patch at TICK {p} left the logits unchanged (diff {after})")

    def test_model_without_terrain_ignores_terrain_argument(self) -> None:
        model = _model(terrain=False)
        self.assertIsNone(model.terrain_enc)
        n = 20
        tick_pos = [0, 8]
        idx = torch.tensor([[CONTENT[i % len(CONTENT)] for i in range(n)]])
        idx[0, tick_pos] = TICK
        patches = _random_patches(2, seed=2)
        terrain = (
            patches,
            torch.zeros(2, dtype=torch.long),
            torch.tensor(tick_pos, dtype=torch.long),
            torch.arange(2, dtype=torch.long),
        )
        with torch.no_grad():
            without, _ = model(idx)
            with_arg, _ = model(idx, terrain=terrain)
        self.assertTrue(torch.equal(without, with_arg), "a terrain-less model must ignore the terrain argument")


def _reference_logits(model: RowModel, gen: Generator) -> torch.Tensor:
    """Last-position logits from a fresh prefill of the whole context, with the terrain vectors the generator holds."""
    with torch.no_grad():
        lg, _ = model.step(torch.tensor([gen.ids]), None, gen._add(0))
    return lg[0, -1]


class GeneratorTerrainTrimTests(unittest.TestCase):
    def test_trim_keeps_context_and_cache_consistent(self) -> None:
        model = _model(terrain=True, ctx_len=96)
        gen = Generator(model, VOCAB, "cpu", Sampling(greedy=True))
        used_patches: list[bytes] = []  # the patch each begun tick used, in tick order
        trims = 0
        real_trim = gen._trim

        def counting_trim(incoming: int) -> None:
            nonlocal trims
            trims += 1
            real_trim(incoming)

        gen._trim = counting_trim  # type: ignore[method-assign]

        for t in range(30):
            if t % 4 == 0:
                patch = _patch_bytes(seed=100 + t)
                gen.set_terrain(patch)
                current = patch
            in_rows = [[A, B, C, A]] if t % 2 == 0 else [[B, C, A]]  # long enough that 30 ticks overflow 96 several times
            gen.begin_tick(in_rows, [])
            used_patches.append(current)
            gen.feed_out([])

            self.assertLessEqual(len(gen.ids), 96, f"tick {t}: context grew past ctx_len")
            tick_positions = [i for i, tok in enumerate(gen.ids) if tok == TICK]
            for pos in gen.tvec:
                self.assertEqual(gen.ids[pos], TICK, f"tick {t}: terrain vector at non-TICK position {pos}")
            self.assertEqual(set(gen.tvec), set(tick_positions), f"tick {t}: TICK tokens and terrain vectors disagree")

            # cached logits against a fresh prefill of the same context
            ref_prefill = _reference_logits(model, gen)
            diff = (gen.logits - ref_prefill).abs().max().item()
            self.assertLess(diff, 1e-4, f"tick {t}: cached logits vs fresh prefill differ by {diff}")

            # and against a full forward with the actual patches of the ticks still in the context
            k = len(tick_positions)
            patches = torch.stack([_patch_tensor(p) for p in used_patches[-k:]])
            with torch.no_grad():
                full, _ = model(
                    torch.tensor([gen.ids]),
                    terrain=(
                        patches,
                        torch.zeros(k, dtype=torch.long),
                        torch.tensor(tick_positions, dtype=torch.long),
                        torch.arange(k, dtype=torch.long),
                    ),
                )
            diff_full = (gen.logits - full[0, -1]).abs().max().item()
            self.assertLess(diff_full, 1e-4, f"tick {t}: cached logits vs full forward differ by {diff_full}")

        self.assertGreaterEqual(trims, 2, "the context should have overflowed and trimmed several times")


class SnapshotTerrainTests(unittest.TestCase):
    def _check_roundtrip(self, gen: Generator, max_tokens: int) -> None:
        snap = gen.snapshot()
        ids_before = list(gen.ids)
        tvec_before = {k: v.clone() for k, v in gen.tvec.items()}
        logits_before = gen.logits.clone()

        first_rows = gen.generate(max_tokens=max_tokens, max_rows=2)
        self.assertGreater(len(gen.ids), len(ids_before), "generation should have written tokens")

        gen.restore(snap)
        self.assertEqual(gen.ids, ids_before)
        self.assertEqual(set(gen.tvec), set(tvec_before))
        for k, v in tvec_before.items():
            self.assertTrue(torch.equal(gen.tvec[k], v), f"terrain vector at {k} changed on restore")
        self.assertTrue(torch.equal(gen.logits, logits_before))

        # the restored state is usable: greedy generation from it reproduces the first run
        again = gen.generate(max_tokens=max_tokens, max_rows=2)
        self.assertEqual(again, first_rows)

    def test_restore_after_a_tick_with_terrain(self) -> None:
        model = _model(terrain=True)
        gen = Generator(model, VOCAB, "cpu", Sampling(greedy=True))
        gen.set_terrain(_patch_bytes(seed=1))
        gen.begin_tick([[A, B]], [[C]])
        self.assertEqual(len(gen.tvec), 1)
        self._check_roundtrip(gen, max_tokens=8)

    def test_restore_when_generation_trims_the_context(self) -> None:
        model = _model(terrain=True, ctx_len=96)
        gen = Generator(model, VOCAB, "cpu", Sampling(greedy=True))
        for t in range(22):
            if t % 3 == 0:
                gen.set_terrain(_patch_bytes(seed=200 + t))
            gen.begin_tick([[A]], [])
            gen.feed_out([])
        self.assertGreater(len(gen.ids), 80, "setup should leave the context nearly full")
        self._check_roundtrip(gen, max_tokens=40)


class WindowTerrainTests(unittest.TestCase):
    N_TICKS = 20
    TOKENS_PER_TICK = 3  # TICK, IN, a

    def _stream(self, terrain_every: int, n_patches: int = 5, terrain_first: int = 0) -> Stream:
        k = self.N_TICKS
        tokens = np.array([TICK, IN, A] * k, dtype=np.int32)
        return Stream(
            tokens=tokens,
            loss_mask=np.ones(len(tokens), dtype=np.uint8),
            tick_start=np.arange(k, dtype=np.int64) * self.TOKENS_PER_TICK,
            tick_of=np.arange(k, dtype=np.int32),
            terrain=np.zeros((n_patches, N_PATCH_BYTES), dtype=np.uint8),
            terrain_first=terrain_first,
            terrain_every=terrain_every,
        )

    def test_terrain_of_gives_tick_positions_and_patch_numbers(self) -> None:
        stream = self._stream(terrain_every=4)
        ws = WindowSet(stream, ctx_len=12, stride_ticks=1)
        # window 5 starts at position 15 (tick 5) and covers ticks 5..8 (positions 15, 18, 21, 24)
        self.assertEqual(int(ws.starts[5]), 15)
        pos, patch = ws.terrain_of(5)
        self.assertEqual(pos.tolist(), [0, 3, 6, 9], "TICK positions relative to the window start")
        self.assertEqual(patch.tolist(), [5 // 4, 6 // 4, 7 // 4, 8 // 4], "patch = tick // every")
        # every TICK position in the window really is a TICK token
        window_tokens, _, _ = ws[5]
        self.assertTrue(all(window_tokens[p] == TICK for p in pos))

    def test_terrain_of_clips_to_last_patch(self) -> None:
        stream = self._stream(terrain_every=2, n_patches=3)  # ticks 12..19 would use patches 6..9, clipped to 2
        ws = WindowSet(stream, ctx_len=12, stride_ticks=1)
        last = len(ws) - 1
        pos, patch = ws.terrain_of(last)
        self.assertGreater(len(pos), 0)
        self.assertTrue(np.all(patch <= len(stream.terrain) - 1))
        self.assertTrue(np.all(patch >= 0))
        self.assertEqual(int(patch[-1]), 2, "the last tick must clip to the last patch")

    def test_terrain_of_is_none_without_terrain(self) -> None:
        stream = self._stream(terrain_every=4)
        stream.terrain = None
        self.assertIsNone(WindowSet(stream, ctx_len=12).terrain_of(0))

    def test_terrain_index_before_first_patch_is_zero(self) -> None:
        stream = self._stream(terrain_every=4, terrain_first=5)
        ticks = np.array([0, 3, 4, 5, 8, 9, 13, 19])
        got = data.terrain_index(stream, ticks)
        # before tick 5 the first patch is used; then one patch every 4 ticks, clipped to the last of 5
        self.assertEqual(got.tolist(), [0, 0, 0, 0, 0, 1, 2, 3])


if __name__ == "__main__":
    unittest.main()
