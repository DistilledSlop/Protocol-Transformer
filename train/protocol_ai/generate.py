"""Tick-by-tick generation from a trained row model.

Each tick the caller gives the input rows (what the client did) and the engine-derived rows; the Generator appends them to
its context, then writes the target rows token by token until END. Decoding is incremental (a key/value cache), and token
choices are limited to what the row grammar allows, learned from the training data as which kinds of field may follow
which. When the context fills, the oldest ticks are dropped and the rest is recomputed ("reset from a snapshot when full").
"""
from __future__ import annotations

import json
import time
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch

from protocol_ai import data
from protocol_ai.fields import category
from protocol_ai.model import Config, RowModel

FORBIDDEN_IN_OUTPUT = ("TICK", "IN", "ENG", "<pad>", "<bos>", "<eos>", "<unk>")


@dataclass
class Sampling:
    temperature: float = 1.0
    top_k: int = 0  # 0 = the whole vocabulary
    greedy: bool = False


class Grammar:
    """Which kinds of field may follow which, from the training sessions' target rows (category bigrams)."""

    def __init__(self, vocab: data.Vocab, device: str, pairs: set[tuple[str, str]] | None = None):
        self.cats = sorted({category(t) for t in vocab.tokens})
        self.cat_id = {c: i for i, c in enumerate(self.cats)}
        self.tok_cat = torch.tensor([self.cat_id[category(t)] for t in vocab.tokens], device=device)
        v = len(vocab.tokens)
        allowed = torch.zeros(len(self.cats), v, dtype=torch.bool, device=device)
        for a, b in pairs or ():
            ia = self.cat_id[a]
            for ib in (self.cat_id[b],):
                allowed[ia] |= self.tok_cat == ib
        forbid = torch.tensor([vocab.index[t] for t in FORBIDDEN_IN_OUTPUT if t in vocab.index], device=device)
        allowed[:, forbid] = False
        self.allowed = allowed
        self.start = torch.zeros(v, dtype=torch.bool, device=device)  # right after the context: a row starts (OUT) or the tick is idle (END)
        self.start[[vocab.out, vocab.end]] = True
        self.after_out = torch.tensor([category(t) == "rowtype" for t in vocab.tokens], device=device)  # a row begins with its type
        self.out_id = vocab.out

    @staticmethod
    def learn(vocab: data.Vocab, streams: dict[str, data.Stream]) -> set[tuple[str, str]]:
        pairs: set[tuple[str, str]] = set()
        for s in streams.values():
            toks, mask = s.tokens, s.loss_mask.astype(bool)
            # consecutive target positions: tokens[i] -> tokens[i+1] where both are in the masked (target) span
            both = mask[:-1] & mask[1:]
            for a, b in zip(toks[:-1][both].tolist(), toks[1:][both].tolist()):
                pairs.add((category(vocab.tokens[a]), category(vocab.tokens[b])))
        return pairs

    def mask_after(self, prev: int, at_start: bool) -> torch.Tensor:
        if at_start:
            return self.start
        if prev == self.out_id:
            return self.after_out
        return self.allowed[self.tok_cat[prev]]


class Generator:
    def __init__(self, model: RowModel, vocab: data.Vocab, device: str, sampling: Sampling | None = None, grammar: Grammar | None = None):
        self.model = model.eval()
        self.vocab = vocab
        self.device = device
        self.sampling = sampling or Sampling()
        self.grammar = grammar
        self.ctx_len = model.cfg.ctx_len
        self.reset()

    @classmethod
    def load(cls, ckpt_path: str | Path, device: str, vocab_path: str | Path | None = None, sampling: Sampling | None = None, grammar_pairs=None):
        ck = torch.load(ckpt_path, map_location=device, weights_only=False)
        cfg = Config(**ck["cfg"])
        model = RowModel(cfg).to(device)
        model.load_state_dict(ck["model"])
        vp = Path(vocab_path or ck["vocab"])
        vocab = data.load_vocab(vp)
        grammar = Grammar(vocab, device, grammar_pairs) if grammar_pairs is not None else None
        return cls(model, vocab, device, sampling, grammar)

    # ---- context ------------------------------------------------------------------------------------------------
    def reset(self) -> None:
        self.ids: list[int] = []
        self.past = None
        self.logits: torch.Tensor | None = None
        self.at_start = False
        self.tvec: dict[int, torch.Tensor] = {}  # position in ids of a TICK token -> its terrain vector
        self.cur_vec: torch.Tensor | None = None  # the vector the next TICK token gets: the latest patch's

    @torch.no_grad()
    def set_terrain(self, patch: bytes) -> None:
        """A new terrain patch (13*13*13 category bytes): ticks from here on read it. No-op for a model without terrain."""
        enc = self.model.terrain_enc
        if enc is None:
            return
        side = enc.SIDE
        cells = torch.frombuffer(bytearray(patch), dtype=torch.uint8).view(1, side, side, side).to(self.device)
        self.cur_vec = enc(cells)[0]

    def _add(self, base: int) -> tuple[torch.Tensor, torch.Tensor] | None:
        """Terrain vectors for the TICK tokens among ids[base:], as the model's step wants them."""
        hit = sorted(p for p in self.tvec if p >= base)
        if not hit:
            return None
        return torch.tensor([p - base for p in hit], device=self.device), torch.stack([self.tvec[p] for p in hit])

    def _feed(self, ids: list[int], tick_vec: torch.Tensor | None = None) -> None:
        """Append ids to the context. tick_vec: the terrain vector for ids[0], when that is a TICK token."""
        if not ids:
            return
        if len(self.ids) + len(ids) > self.ctx_len:
            self._trim(len(ids))
        x = torch.tensor([ids], device=self.device)
        add = None if tick_vec is None else (torch.zeros(1, dtype=torch.long, device=self.device), tick_vec[None])
        lg, self.past = self.model.step(x, self.past, add)
        self.logits = lg[0, -1]
        if tick_vec is not None:
            self.tvec[len(self.ids)] = tick_vec
        self.ids += ids

    def _trim(self, incoming: int) -> None:
        """Drop the oldest whole ticks until the context has room, then recompute what is kept."""
        starts = [i for i, t in enumerate(self.ids) if t == self.vocab.tick]
        budget = int(self.ctx_len * 0.6) - incoming
        keep_from = next((s for s in starts if len(self.ids) - s <= budget), None)
        kept = self.ids[keep_from:] if keep_from is not None else []
        self.tvec = {p - keep_from: v for p, v in self.tvec.items() if keep_from is not None and p >= keep_from}
        self.ids, self.past, self.logits = [], None, None
        if kept:
            x = torch.tensor([kept], device=self.device)
            lg, self.past = self.model.step(x, None, self._add(0))
            self.logits = lg[0, -1]
            self.ids = kept

    def snapshot(self):
        # the cache tensors are never edited in place (each step concatenates new ones), so keeping references is enough
        # generating may trim the context, so the token list is copied too (a couple of thousand ints)
        return (list(self.ids), self.past, self.logits, self.at_start, dict(self.tvec))

    def restore(self, snap) -> None:
        ids, self.past, self.logits, self.at_start, tvec = snap
        self.ids = list(ids)
        self.tvec = dict(tvec)

    # ---- one tick -----------------------------------------------------------------------------------------------
    def begin_tick(self, in_rows: list[list[int]], eng_rows: list[list[int]]) -> None:
        """Append TICK, the input rows and the engine rows. Rows are lists of token ids (without the IN/ENG marker)."""
        v = self.vocab
        ids = [v.tick]
        for r in in_rows:
            ids += [v.in_, *r]
        for r in eng_rows:
            ids += [v.eng, *r]
        self._feed(ids, self.cur_vec)
        self.at_start = True

    def _sample(self, logits: torch.Tensor, allowed: torch.Tensor | None) -> int:
        lg = logits.float()
        if allowed is not None:
            lg = lg.masked_fill(~allowed, float("-inf"))
        if self.sampling.greedy or self.sampling.temperature <= 0:
            return int(lg.argmax())
        lg = lg / self.sampling.temperature
        if self.sampling.top_k > 0:
            kth = torch.topk(lg, min(self.sampling.top_k, lg.numel())).values[-1]
            lg = lg.masked_fill(lg < kth, float("-inf"))
        return int(torch.multinomial(torch.softmax(lg, dim=-1), 1))

    @torch.no_grad()
    def generate(self, max_tokens: int = 600, max_rows: int = 0) -> list[list[int]]:
        """Write the target rows of this tick. Returns them as lists of ids (without the OUT marker); the tokens, ending in
        END, stay in the context. max_rows (0 = no limit) stops a tick that will not end: once that many rows are written
        the model can only finish the last one."""
        v = self.vocab
        out: list[int] = []
        prev = self.ids[-1] if self.ids else v.tick
        at_start = self.at_start
        rows_written = 0
        while True:
            allowed = self.grammar.mask_after(prev, at_start) if self.grammar else None
            if max_rows and rows_written >= max_rows:
                allowed = torch.ones(self.logits.numel(), dtype=torch.bool, device=self.device) if allowed is None else allowed.clone()
                allowed[v.out] = False
            tok = self._sample(self.logits, allowed) if len(out) < max_tokens else v.end
            at_start = False
            rows_written += tok == v.out
            out.append(tok)
            self._feed([tok])
            prev = tok
            if tok == v.end:
                break
        self.at_start = False
        rows: list[list[int]] = []
        for t in out[:-1]:
            if t == v.out:
                rows.append([])
            elif rows:
                rows[-1].append(t)
        return [r for r in rows if r]

    def feed_out(self, rows: list[list[int]]) -> None:
        """Put given target rows (instead of generated ones) into the context, as the tick's answer."""
        v = self.vocab
        ids: list[int] = []
        for r in rows:
            ids += [v.out, *r]
        ids.append(v.end)
        self._feed(ids)
        self.at_start = False

    # ---- helpers ------------------------------------------------------------------------------------------------
    def to_ids(self, tokens: list[str]) -> list[int]:
        return [self.vocab.index.get(t, self.vocab.unk) for t in tokens]

    def to_tokens(self, ids: list[int]) -> list[str]:
        return [self.vocab.tokens[i] for i in ids]
