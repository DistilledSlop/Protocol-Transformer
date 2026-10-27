'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../quant');

test('zero quantizes to sign 0 and the single token 0', () => {
    const q = Q.quantize(0);
    assert.equal(q.sign, 0);
    assert.deepEqual(Q.toTokens(q), ['0']);
    assert.equal(Q.dequantize(q), 0);
});

test('relative error is within 3% from 40 up, and exact for 1 to 39', () => {
    for (let v = 1; v <= 32767; v++) {
        const back = Q.dequantize(Q.quantize(v));
        if (v <= 39) {
            assert.equal(back, v, `value ${v} should be exact`);
        } else {
            const rel = Math.abs(back - v) / v;
            assert.ok(rel <= 0.03, `value ${v} came back as ${back}, relative error ${rel}`);
        }
    }
});

test('negative values mirror the positive ones', () => {
    for (const v of [1, 2, 7, 39, 40, 41, 100, 999, 4096, 32767]) {
        const pos = Q.quantize(v);
        const neg = Q.quantize(-v);
        assert.equal(neg.sign, -1);
        assert.equal(neg.group, pos.group);
        assert.equal(neg.fine, pos.fine);
        assert.equal(Q.dequantize(neg), -Q.dequantize(pos));
    }
});

test('values above the wire maximum clamp to the last group', () => {
    const q = Q.quantize(100000);
    assert.equal(q.sign, 1);
    assert.equal(q.group, 31);
    assert.equal(Q.quantize(-100000).group, 31);
});

test('tokens round-trip through fromTokens, and coarseOnly gives one token', () => {
    const values = [0, 1, 2, 3, 7, 39, 40, 41, 100, 255, 1000, 4096, 12345, 32767, -1, -40, -999, -32767];
    for (const v of values) {
        const q = Q.quantize(v);
        const tokens = Q.toTokens(q);
        const { q: back, used } = Q.fromTokens(tokens);
        assert.deepEqual(back, q, `round trip of ${v}`);
        assert.equal(used, tokens.length);

        const coarse = Q.toTokens(q, { coarseOnly: true });
        if (v === 0) {
            assert.deepEqual(coarse, ['0']);
        } else {
            assert.equal(coarse.length, 1, `coarse tokens for ${v}`);
            const fromCoarse = Q.fromTokens(coarse);
            assert.equal(fromCoarse.used, 1);
            assert.equal(fromCoarse.q.sign, q.sign);
            assert.equal(fromCoarse.q.group, q.group);
        }
    }
});
