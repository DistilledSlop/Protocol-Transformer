'use strict';
// Small token builders shared by the handlers. Every function returns an array of strings.

// A non-negative integer up to 255 is one token; anything else is spelled in digits so the model
// never has to do arithmetic on a value it cannot bucket.
function intTokens(prefix, v) {
    v = Number(v);
    if (Number.isInteger(v) && v >= 0 && v <= 255) return [`${prefix}${v}`];
    return [`${prefix}=`, ...String(Math.trunc(v)).split('').map((c) => (c === '-' ? 'neg' : `d${c}`)), ';'];
}

// Bit tokens for a flags byte: the set bits, in order, or 'bits0' for none.
function bitTokens(v, width = 8) {
    const out = [];
    for (let i = 0; i < width; i++) if (v & (1 << i)) out.push(`bit${i}`);
    return out.length ? out : ['bits0'];
}

// Few-valued floats (speeds, volumes, pitches) use a dictionary of exact float32 values.
function floatToken(prefix, v) {
    return [`${prefix}:${Math.fround(v)}`];
}

const clampStr = (s, n) => (s.length > n ? s.slice(0, n) : s);

module.exports = { intTokens, bitTokens, floatToken, clampStr };

// i64 fields arrive as BigInt, number, or a [hi, lo] pair depending on the codec path.
function toInt64(v) {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number') return BigInt(Math.trunc(v));
    if (Array.isArray(v)) return v.length === 2 ? (BigInt(v[0]) << 32n) | (BigInt(v[1]) & 0xffffffffn) : BigInt(v[0]);
    return BigInt(v);
}

module.exports.toInt64 = toInt64;
