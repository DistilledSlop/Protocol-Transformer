'use strict';
// Slots go to the nearest entities; a full table culls the farthest for a closer newcomer.

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeReader, run, startPackets, spawnPkt, rowsAt, entityRows } = require('./helpers');

// 63 entities between 10 and 30 blocks away fill every slot; ids 100..162.
const fill = () => Array.from({ length: 63 }, (_, i) => spawnPkt(60, 100 + i, 10 + (i * 20) / 62, 64, 0));

test('a closer newcomer culls the farthest entity, and enters the tick after', () => {
    const r = makeReader();
    const ticks = run(r, [...startPackets(), ...fill(), spawnPkt(160, 999, 2, 64, 0), spawnPkt(260, 998, 29.5, 64, 0)]);

    // tick 3 (t=160): the newcomer finds no slot, so the farthest entity (id 162, 30 blocks) is culled
    const t3 = rowsAt(ticks, 3);
    const cull = t3.filter((x) => x.kind === 'DESPAWN');
    assert.equal(cull.length, 1);
    assert.equal(cull[0].entityId, 162);
    assert.equal(cull[0].io, 'eng');
    assert.ok(cull[0].tokens.includes('why:far'));
    assert.equal(entityRows(t3, 999).length, 0, 'the newcomer cannot reuse the slot in the tick it was freed');

    // tick 4 (t=210) is empty of packets, but the newcomer enters when tick 4 closes
    const spawn = ticks.flatMap((t) => t.rows).find((x) => x.kind === 'SPAWN' && x.entityId === 999);
    assert.ok(spawn, 'the newcomer gets a SPAWN row');
    assert.equal(spawn.slot, cull[0].slot, 'it takes the slot that was freed');
    assert.equal(r.stats.dropped.get('culled for a closer entity'), 1);
    // the second newcomer (29.5 blocks) is not 3 blocks closer than the next farthest (29.7), so no second cull
});

test('a newcomer that is not clearly closer is not admitted, and the miss is counted once', () => {
    const r = makeReader();
    // 29 blocks is within 3 of the farthest (30), so nobody is culled
    run(r, [...startPackets(), ...fill(), spawnPkt(160, 999, 29, 64, 0), spawnPkt(260, 998, 29.5, 64, 0), spawnPkt(360, 997, 28, 64, 5)]);
    assert.equal(r.stats.dropped.get('culled for a closer entity'), undefined);
    assert.equal([...r.stats.slotMisses.values()].reduce((a, b) => a + b, 0), 3);
    // counted once per entity, not once per tick
    assert.equal(r.stats.dropped.get('no free entity slot'), 3);
});
