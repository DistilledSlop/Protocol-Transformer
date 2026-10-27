"""Which kind of field a token is. Shared by the training report (per-field accuracy) and by constrained decoding."""
from __future__ import annotations

import re

TAGS = {"dx", "dy", "dz", "vx", "vy", "vz", "px", "py", "pz", "ox", "oy", "oz"}
ROW_TYPES = {"ENTITY", "BLOCK", "SLOT", "EVENT", "TEXT", "GLOBAL"}
MARKERS = {"TICK", "END", "IN", "OUT", "ENG"}
CATALOG_PREFIXES = ("type:", "item:", "blk:", "mk:", "snd", "tpl:", "tr:", "cat:", "pt:", "rcp:", "why:", "act:", "mode:", "ntv:", "vol:", "rad:", "f:", "pose:", "v:", "nb:", "arg:")


def category(tok: str) -> str:
    """Which kind of field a token belongs to, for the per-field report."""
    if tok in MARKERS or tok.startswith("<"):
        return "marker"
    if tok in ROW_TYPES:
        return "rowtype"
    if tok in TAGS:
        return "tag"
    if re.fullmatch(r"[+-]c\d+|0", tok):
        return "coarse"
    if re.fullmatch(r"f\d+", tok):
        return "fine"
    if re.fullmatch(r"(yaw|pitch|hy)\d+", tok):
        return "angle"
    if re.fullmatch(r"(s|t|own)\d+|tUNKNOWN|ownNONE|ownUNKNOWN", tok):
        return "slot"
    if re.fullmatch(r"o[bf]-?\d+", tok) or re.fullmatch(r"b[xyz]-?\d+", tok):
        return "position"
    if tok.startswith(CATALOG_PREFIXES):
        return "catalogue"
    if re.fullmatch(r"[A-Z][A-Z_]+", tok):
        return "kind"
    if re.fullmatch(r"[a-z]+-?\d+", tok) or tok in {"neg", ";", "true", "false", "none"} or tok.endswith("="):
        return "number"
    return "other"
