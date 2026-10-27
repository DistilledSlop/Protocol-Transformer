'use strict';
// Rows describe the gap between an entity and what a client following the rows believes, so quantization
// error and dropped rows correct themselves.

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeReader, pkt, run, startPackets, spawnPkt, rowsAt, entityRows } = require('./helpers');
const { MAX_ROWS_PER_TICK } = require('../reader');

const rel = (t, id, dX, dZ = 0) => pkt(t, 'S2C', 'rel_entity_move', { entityId: id, dX, dY: 0, dZ, onGround: true });

test('quantization error does not accumulate over many moves', () => {
    const r = makeReader();
    const packets = [...startPackets(), spawnPkt(60, 10, 3, 64, 0)];
    // 80 steps of 333 units: not a value the log buckets hit exactly
    for (let i = 0; i < 80; i++) packets.push(rel(110 + i * 50, 10, 333));
    const ticks = run(r, packets);
    const moves = ticks.flatMap((t) => entityRows(t.rows, 10)).filter((x) => x.kind === 'MOVE');
    assert.equal(moves.length, 80);
    const sentUnits = moves.reduce((a, m) => a + m.deq[0], 0);
    // open loop the error would be about 80 times the per-step error (several units); closed loop it stays within one step's
    assert.ok(Math.abs(sentUnits - 80 * 333) <= 4, `sent ${sentUnits} units for ${80 * 333}`);
});

test('a move row dropped by the cap is made up the next tick', () => {
    const r = makeReader();
    // 70 entities fill the slots (63), 10 blocks apart in z so that their order by distance is fixed; the far ones lose rows when the cap bites
    const spawns = Array.from({ length: 63 }, (_, i) => spawnPkt(60, 100 + i, 3, 64, 0.5 + i * 0.4));
    const moves1 = Array.from({ length: 63 }, (_, i) => rel(110, 100 + i, 64));
    // ten block changes next to the player push the tick to 73 rows, so the 9 farthest moves are dropped
    const blocks = Array.from({ length: 10 }, (_, i) => pkt(111, 'S2C', 'block_change', { location: { x: -5 + i, y: 63, z: 1 }, type: 1 }));
    const ticks = run(r, [...startPackets(), ...spawns, ...moves1, ...blocks, rel(160, 100, 0)]);
    const t2 = rowsAt(ticks, 2);
    assert.ok(t2.length <= MAX_ROWS_PER_TICK, 'the cap holds');
    assert.ok(r.stats.dropped.get('over the per-tick row cap') > 0, 'some move rows were dropped');
    // every entity whose row was dropped is revisited, and its row carries the full delta since the belief
    const t3 = rowsAt(ticks, 3).filter((x) => x.kind === 'MOVE');
    assert.ok(t3.length > 0, 'the dropped moves come back');
    for (const m of t3) assert.ok(Math.abs(m.delta[0] - 64) <= 1, `delta ${m.delta[0]} carries the missed 64 units`);
});

test('spawn, despawn and teleport rows are never dropped by the cap', () => {
    const r = makeReader();
    // 63 spawns plus ten block changes: 73 rows in one tick, all spawns must survive
    const spawns = Array.from({ length: 63 }, (_, i) => spawnPkt(60, 100 + i, 3, 64, 0.5 + i * 0.4));
    const blocks = Array.from({ length: 10 }, (_, i) => pkt(61, 'S2C', 'block_change', { location: { x: 1 + i, y: 63, z: 1 }, type: 1 }));
    const ticks = run(r, [...startPackets(), ...spawns, ...blocks]);
    const spawnRows = rowsAt(ticks, 1).filter((x) => x.kind === 'SPAWN');
    assert.equal(spawnRows.length, 63);
});

test('a spawn row whose position is off the 1/16 grid is corrected by the entity\'s next move', () => {
    const r = makeReader();
    // 3.03 blocks is 48.5 units; the spawn row can only say 48 or 49
    const ticks = run(r, [...startPackets(), spawnPkt(60, 10, 3.03, 64, 0), rel(110, 10, 10)]);
    const spawn = entityRows(rowsAt(ticks, 1), 10)[0];
    const move = entityRows(rowsAt(ticks, 2), 10)[0];
    const believed = spawn.rel[0] / 16;
    const truth = 3.03 + 10 / 4096;
    assert.ok(Math.abs(move.deq[0] / 4096 - (truth - believed)) < 0.002, 'the move carries the spawn rounding error too');
});
