'use strict';
// Small pieces the model server relies on: the reader's range option, its slot hint, and the start of a capture
// that schedule.js builds in 'join' mode.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Reader } = require('../reader');
const { startPackets, spawnPkt, makeReader, pkt, run, rowsAt, entityRows } = require('./helpers');
const { FAMILIES } = require('../../engine/ownership');
const { build } = require('../../engine/schedule');
const { createCodec } = require('../parse');

const teleport = (t, entityId, x, y = 64, z = 0) =>
    pkt(t, 'S2C', 'entity_teleport', { entityId, x, y, z, yaw: 0, pitch: 0, onGround: true });

// ---- A. range option ------------------------------------------------------------------------------------------------

const farTicks = [
    ...startPackets(),
    spawnPkt(60, 40, 10, 64, 0), // 10 blocks: enters
    teleport(110, 40, 50), // 50 blocks: beyond the default 36
];

test('range: default culls an entity beyond 36 blocks with an eng DESPAWN row', () => {
    const ticks = run(new Reader({ phase: 0 }), farTicks);
    const despawn = entityRows(rowsAt(ticks, 2), 40).find((x) => x.kind === 'DESPAWN');
    assert.ok(despawn, 'expected a DESPAWN row');
    assert.equal(despawn.io, 'eng');
    assert.equal(despawn.why, 'far');
});

test('range: Infinity never culls the same entity', () => {
    const ticks = run(new Reader({ phase: 0, range: Infinity }), farTicks);
    assert.equal(entityRows(rowsAt(ticks, 2), 40).filter((x) => x.kind === 'DESPAWN').length, 0);
    assert.equal(entityRows(rowsAt(ticks, 2), 40).filter((x) => x.kind === 'SPAWN').length, 0);
});

// ---- B. slot hint ---------------------------------------------------------------------------------------------------

test('slotHint: a free hinted slot is used for the entity', () => {
    const r = makeReader();
    r.slotHint = (id) => (id === 10 ? 5 : undefined);
    const ticks = run(r, [...startPackets(), spawnPkt(60, 10, 3, 64, 0)]);
    const spawn = entityRows(rowsAt(ticks, 1), 10)[0];
    assert.equal(spawn.kind, 'SPAWN');
    assert.equal(spawn.slot, 5);
    assert.equal(spawn.tokens[1], 's5');
});

test('slotHint: a taken hinted slot falls back to the lowest free slot', () => {
    const r = makeReader();
    r.slotHint = () => 5; // every entity asks for slot 5
    const ticks = run(r, [...startPackets(), spawnPkt(60, 10, 3, 64, 0), spawnPkt(110, 11, 4, 64, 0)]);
    assert.equal(entityRows(rowsAt(ticks, 1), 10)[0].slot, 5);
    assert.equal(entityRows(rowsAt(ticks, 2), 11)[0].slot, 1);
});

test('slotHint: an undefined hint uses the lowest free slot', () => {
    const r = makeReader();
    r.slotHint = () => undefined;
    const ticks = run(r, [...startPackets(), spawnPkt(60, 10, 3, 64, 0)]);
    assert.equal(entityRows(rowsAt(ticks, 1), 10)[0].slot, 1);
});

// ---- C. join mode of schedule.js ------------------------------------------------------------------------------------

const CAPTURE = path.join(__dirname, '..', '..', 'proxy', 'data', 'session_EmeraldIngot64_1793056989898');
const haveCapture = ['.bin', '.jsonl'].every((ext) => fs.existsSync(CAPTURE + ext));

test('join mode: only the start of a real capture, no writer-owned packets', { skip: haveCapture ? false : 'capture files missing from proxy/data' }, () => {
    const sched = build(CAPTURE, { mode: 'join', also: [] });
    const { play } = sched;
    assert.ok(play.length > 0, 'play list is empty');
    assert.equal(play[0].name, 'login');
    assert.ok(play.every((p) => p.t < 10000), 'a packet is at or past 10 s');

    // Scene packets that survive are the player's own (its metadata and permission/debug statuses come from the server).
    const scene = new Set(FAMILIES.scene);
    const codec = createCodec(sched.header.version, 'play');
    const otherEntity = play
        .filter((p) => scene.has(p.name))
        .filter((p) => codec.parse('S2C', p.buf).params.entityId !== sched.playerId)
        .map((p) => p.name);
    assert.deepEqual([...new Set(otherEntity)], [], 'scene packets about other entities are present in join mode');

    assert.ok(play.some((p) => p.name === 'map_chunk'), 'no map_chunk packets');
    for (let i = 1; i < play.length; i++) assert.ok(play[i - 1].t <= play[i].t, `not sorted at index ${i}`);
});
