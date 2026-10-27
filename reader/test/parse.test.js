'use strict';
// The one malformed server packet seen in the wild: Set Equipment whose first entry lacks the "more follow" bit.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCodec } = require('../parse');
const sanitize = require('../../proxy/sanitize');

const codec = createCodec('1.21.1');
// from a recording: entity 6184, slot 0 item 801 flagged as the last entry, then slot 2 item 859 anyway
const BAD = Buffer.from('5ba8300001a106000002' + '01db060000', 'hex');
const GOOD = Buffer.from('5ba83080' + '01a1060000' + '0201db060000', 'hex');

test('a Set Equipment with a missing continue bit is read as all its entries', () => {
    const r = codec.parse('S2C', BAD);
    assert.equal(r.repaired, true);
    assert.deepEqual(r.params.equipments.map((e) => [e.slot, e.item.itemId]), [[0, 801], [2, 859]]);
});

test('fix() gives the bytes the vanilla client accepts: the same entries with the flag on the first', () => {
    const fixed = codec.fix('S2C', BAD);
    assert.equal(fixed.toString('hex'), GOOD.toString('hex'));
    assert.equal(codec.parse('S2C', fixed).repaired, false, 'the fixed packet parses cleanly');
});

test('a well-formed Set Equipment is left alone', () => {
    assert.equal(codec.fix('S2C', GOOD), null);
    assert.equal(codec.parse('S2C', GOOD).repaired, false);
});

test('the proxy hook repairs, counts, and passes everything else through untouched', () => {
    const counts = new Map();
    assert.equal(sanitize.forServer('entity_equipment', BAD, counts).toString('hex'), GOOD.toString('hex'));
    assert.equal(counts.get('entity_equipment'), 1);
    const other = Buffer.from('1234', 'hex');
    assert.equal(sanitize.forServer('rel_entity_move', other, counts), other);
    assert.equal(sanitize.forServer('entity_equipment', GOOD, counts), GOOD, 'unchanged packets come back as the same buffer');
});

test('garbage that cannot be parsed is forwarded as it was', () => {
    const junk = Buffer.from('5bff', 'hex');
    assert.equal(sanitize.forServer('entity_equipment', junk, new Map()), junk);
});
