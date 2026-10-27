'use strict';
// Number tokens for continuous deltas: a coarse log group, then a fine step.
//
// Size runs from 1 unit to MAX_UNITS (the wire maximum of an i16 delta) in 32 groups per sign, each
// about 1.38 times wider than the last. Each group splits into 16 fine steps of about 2%, so a value
// lands within about 1% of the truth. Zero is its own coarse token and has no fine step.
// Field classes differ only in their unit; a field tag in the row says which class applies.

const GROUPS = 32;
const FINE = 16;
const MAX_UNITS = 32767;
const RATIO = Math.pow(MAX_UNITS, 1 / GROUPS); // about 1.384

// unit = size of one wire unit in blocks (or blocks per tick for velocity)
const CLASSES = {
    move: { unit: 1 / 4096 }, // rel_entity_move and friends
    vel: { unit: 1 / 8000 }, // entity_velocity
    rel: { unit: 1 / 16 }, // positions relative to the focus (spawns, teleports)
};

const lo = (g) => Math.pow(RATIO, g);

// integer units -> { sign, group, fine } ; sign 0 means zero
function quantize(units) {
    if (!Number.isFinite(units)) throw new Error(`cannot quantize ${units}`);
    const v = Math.round(units);
    if (v === 0) return { sign: 0, group: 0, fine: 0 };
    const sign = v < 0 ? -1 : 1;
    const a = Math.min(Math.abs(v), MAX_UNITS); // out of range clamps to the last bucket
    const g = Math.min(GROUPS - 1, Math.max(0, Math.floor(Math.log(a) / Math.log(RATIO) + 1e-9)));
    const l = lo(g);
    const h = lo(g + 1);
    const f = Math.min(FINE - 1, Math.max(0, Math.floor((FINE * (a - l)) / (h - l))));
    return { sign, group: g, fine: f };
}

// { sign, group, fine } -> integer units (the centre of the fine step)
function dequantize({ sign, group, fine }) {
    if (sign === 0) return 0;
    const l = lo(group);
    const h = lo(group + 1);
    const c = l + ((fine + 0.5) * (h - l)) / FINE;
    return sign * Math.max(1, Math.round(c));
}

// Tokens: '0' alone for zero, otherwise '+c18' 'f8' (sign, coarse group, fine step).
function toTokens(q, { coarseOnly = false } = {}) {
    if (q.sign === 0) return ['0'];
    const c = `${q.sign > 0 ? '+' : '-'}c${q.group}`;
    return coarseOnly ? [c] : [c, `f${q.fine}`];
}

function fromTokens(tokens) {
    const t0 = tokens[0];
    if (t0 === '0') return { q: { sign: 0, group: 0, fine: 0 }, used: 1 };
    const m = /^([+-])c(\d+)$/.exec(t0);
    if (!m) throw new Error(`bad coarse token ${t0}`);
    const f = /^f(\d+)$/.exec(tokens[1] || '');
    return {
        q: { sign: m[1] === '+' ? 1 : -1, group: +m[2], fine: f ? +f[1] : 0 },
        used: f ? 2 : 1,
    };
}

module.exports = { GROUPS, FINE, MAX_UNITS, RATIO, CLASSES, quantize, dequantize, toTokens, fromTokens };
