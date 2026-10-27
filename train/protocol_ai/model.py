"""A small GPT-style decoder over the reader's row tokens.

Standard on purpose (pre-norm blocks, learned positions, tied embeddings, PyTorch's fused attention), so that a
failure points at the data or the training setup and not at custom code. Loss is next-token cross-entropy over
the positions the mask selects: the target rows of each tick and their closing END, not the context.
"""
from __future__ import annotations

from dataclasses import dataclass

import torch
import torch.nn as nn
import torch.nn.functional as F


@dataclass
class Config:
    vocab_size: int
    ctx_len: int = 2048
    n_layer: int = 4
    n_head: int = 4
    n_embd: int = 256
    dropout: float = 0.1
    terrain: bool = False  # read the block categories around the player at every TICK token (TerrainEncoder)


class TerrainEncoder(nn.Module):
    """The blocks around the player (13x13x13 cells, each a category 0..16) -> one vector, added to the TICK token's embedding.

    The grid is centred on the player and laid out the same way every time, so strided convolutions followed by a
    flatten keep where things are: a wall one block ahead and one six blocks ahead give different vectors.
    """

    SIDE = 13
    CATEGORIES = 17  # 16 block classes (reader/blockinfo.js) and 'not loaded'

    def __init__(self, n_embd: int):
        super().__init__()
        self.cell = nn.Embedding(self.CATEGORIES, 8)
        self.c1 = nn.Conv3d(8, 24, 3, stride=2, padding=1)  # 13 -> 7
        self.c2 = nn.Conv3d(24, 48, 3, stride=2, padding=1)  # 7 -> 4
        self.c3 = nn.Conv3d(48, 64, 3, stride=2, padding=1)  # 4 -> 2
        self.out = nn.Linear(64 * 8, n_embd)

    def forward(self, cells: torch.Tensor) -> torch.Tensor:
        """cells: (U, 13, 13, 13) category ids (y, z, x). Returns (U, n_embd)."""
        x = self.cell(cells.long()).permute(0, 4, 1, 2, 3)
        x = F.gelu(self.c1(x))
        x = F.gelu(self.c2(x))
        x = F.gelu(self.c3(x))
        return self.out(x.flatten(1))


class Attention(nn.Module):
    def __init__(self, cfg: Config):
        super().__init__()
        assert cfg.n_embd % cfg.n_head == 0
        self.n_head = cfg.n_head
        self.qkv = nn.Linear(cfg.n_embd, 3 * cfg.n_embd, bias=False)
        self.proj = nn.Linear(cfg.n_embd, cfg.n_embd, bias=False)
        self.dropout = cfg.dropout

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        b, t, c = x.shape
        q, k, v = self.qkv(x).split(c, dim=2)
        q, k, v = (z.view(b, t, self.n_head, c // self.n_head).transpose(1, 2) for z in (q, k, v))
        y = F.scaled_dot_product_attention(q, k, v, is_causal=True, dropout_p=self.dropout if self.training else 0.0)
        return self.proj(y.transpose(1, 2).contiguous().view(b, t, c))


    def step(self, x: torch.Tensor, past: tuple[torch.Tensor, torch.Tensor] | None):
        """Attention for new tokens given the keys and values already computed for the tokens before them."""
        b, t, c = x.shape
        q, k, v = self.qkv(x).split(c, dim=2)
        q, k, v = (z.view(b, t, self.n_head, c // self.n_head).transpose(1, 2) for z in (q, k, v))
        if past is not None:
            k = torch.cat([past[0], k], dim=2)
            v = torch.cat([past[1], v], dim=2)
        p = k.size(2) - t
        if t == 1:
            y = F.scaled_dot_product_attention(q, k, v)  # one new token sees everything before it
        elif p == 0:
            y = F.scaled_dot_product_attention(q, k, v, is_causal=True)
        else:  # several new tokens after a cache: token i sees the cache and the new tokens up to itself
            allow = torch.arange(p + t, device=x.device)[None, :] <= (p + torch.arange(t, device=x.device))[:, None]
            y = F.scaled_dot_product_attention(q, k, v, attn_mask=allow)
        return self.proj(y.transpose(1, 2).contiguous().view(b, t, c)), (k, v)


class Block(nn.Module):
    def __init__(self, cfg: Config):
        super().__init__()
        self.ln1 = nn.LayerNorm(cfg.n_embd)
        self.attn = Attention(cfg)
        self.ln2 = nn.LayerNorm(cfg.n_embd)
        self.mlp = nn.Sequential(
            nn.Linear(cfg.n_embd, 4 * cfg.n_embd, bias=False),
            nn.GELU(),
            nn.Linear(4 * cfg.n_embd, cfg.n_embd, bias=False),
            nn.Dropout(cfg.dropout),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = x + self.attn(self.ln1(x))
        return x + self.mlp(self.ln2(x))

    def step(self, x: torch.Tensor, past):
        a, present = self.attn.step(self.ln1(x), past)
        x = x + a
        return x + self.mlp(self.ln2(x)), present


class RowModel(nn.Module):
    def __init__(self, cfg: Config):
        super().__init__()
        self.cfg = cfg
        self.tok = nn.Embedding(cfg.vocab_size, cfg.n_embd)
        self.pos = nn.Embedding(cfg.ctx_len, cfg.n_embd)
        self.drop = nn.Dropout(cfg.dropout)
        self.blocks = nn.ModuleList(Block(cfg) for _ in range(cfg.n_layer))
        self.ln_f = nn.LayerNorm(cfg.n_embd)
        self.terrain_enc = TerrainEncoder(cfg.n_embd) if cfg.terrain else None
        self.head = nn.Linear(cfg.n_embd, cfg.vocab_size, bias=False)
        self.head.weight = self.tok.weight  # tied: the same table reads and writes tokens
        self.apply(self._init)

    @staticmethod
    def _init(m: nn.Module) -> None:
        if isinstance(m, (nn.Linear, nn.Embedding)):
            nn.init.normal_(m.weight, mean=0.0, std=0.02)

    def n_params(self) -> int:
        return sum(p.numel() for p in self.parameters())

    @torch.no_grad()
    def step(self, idx: torch.Tensor, past: list | None = None, add: tuple[torch.Tensor, torch.Tensor] | None = None):
        """Incremental decoding: logits for the new tokens `idx` (B, T) given the cache `past` (one (k, v) per layer, or None).
        Returns (logits, new_cache). Call in eval mode. Positions continue from the cache length, so the total must stay
        within ctx_len; the caller trims and re-prefills when it would not. `add` carries terrain vectors for TICK tokens."""
        p = 0 if past is None else past[0][0].size(2)
        assert p + idx.size(1) <= self.cfg.ctx_len, "context full: trim and re-prefill"
        x = self.tok(idx) + self.pos(torch.arange(p, p + idx.size(1), device=idx.device))
        if add is not None:  # terrain vectors for the TICK tokens among the new ones: (positions within idx, (K, n_embd))
            x[:, add[0]] += add[1].to(x.dtype)
        presents = []
        for i, blk in enumerate(self.blocks):
            x, pr = blk.step(x, None if past is None else past[i])
            presents.append(pr)
        return self.head(self.ln_f(x)), presents

    def forward(self, idx: torch.Tensor, targets: torch.Tensor | None = None, mask: torch.Tensor | None = None, terrain: tuple | None = None):
        """idx, targets: (B, T) token ids; mask: (B, T), 1 where the target counts toward the loss.
        terrain: (patches (U, 13, 13, 13), batch index, position, patch number) for the TICK tokens that get a terrain vector;
        ignored by a model built without terrain."""
        b, t = idx.shape
        pos = torch.arange(t, device=idx.device)
        x = self.tok(idx) + self.pos(pos)
        if terrain is not None and self.terrain_enc is not None:
            patches, tb, tp, tu = terrain
            x = x.index_put((tb, tp), self.terrain_enc(patches)[tu].to(x.dtype), accumulate=True)
        x = self.drop(x)
        for blk in self.blocks:
            x = blk(x)
        logits = self.head(self.ln_f(x))
        if targets is None:
            return logits, None
        per_token = F.cross_entropy(logits.view(-1, logits.size(-1)).float(), targets.reshape(-1), reduction="none")
        if mask is None:
            return logits, per_token.mean()
        m = mask.reshape(-1).float()
        return logits, (per_token * m).sum() / m.sum().clamp(min=1.0)
