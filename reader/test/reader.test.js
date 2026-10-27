'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Reader, MAX_ROWS_PER_TICK } = require('../reader');
const { NO_FLAGS, makeReader, pkt, run, startPackets, spawnPkt, rowsAt, entityRows } = require('./helpers');

const rel = (t, entityId, dX) => pkt(t, 'S2C', 'rel_entity_move', { entityId, dX, dY: 0, dZ: 0, onGround: true });
const teleport = (t, entityId, x, y = 64, z = 0) =>
    pkt(t, 'S2C', 'entity_teleport', { entityId, x, y, z, yaw: 0, pitch: 0, onGround: true });

test('a spawn and the moves in its tick merge into one spawn row; the next tick gives one summed move', () => {
    const r = makeReader();
    const ticks = run(r, [
        ...startPackets(),
        spawnPkt(60, 10, 3, 64, 0),
        // 512 units is 1/8 block: the spawn position (3.125) lands exactly on the spawn row's 1/16 grid
        rel(70, 10, 256),
        rel(72, 10, 256),
        rel(110, 10, 100),
        rel(115, 10, 300),
    ]);

    const spawnTick = entityRows(rowsAt(ticks, 1), 10);
    assert.equal(spawnTick.length, 1);
    assert.equal(spawnTick[0].kind, 'SPAWN');
    assert.equal(spawnTick[0].io, 'out');

    const moveTick = entityRows(rowsAt(ticks, 2), 10);
    assert.equal(moveTick.length, 1);
    assert.equal(moveTick[0].kind, 'MOVE');
    assert.equal(moveTick[0].delta[0], 400);
});

test('slots: first entity gets 1, second 2, a same-tick spawn after a destroy skips the freed slot, a later one reuses it', () => {
    const r = makeReader();
    const ticks = run(r, [
        ...startPackets(),
        spawnPkt(60, 10, 3, 64, 0), // tick 1
        spawnPkt(110, 11, 4, 64, 0), // tick 2
        pkt(160, 'S2C', 'entity_destroy', { entityIds: [10] }), // tick 3
        spawnPkt(165, 12, 5, 64, 0), // tick 3, same tick as the destroy
        spawnPkt(210, 13, 6, 64, 0), // tick 4
    ]);

    assert.equal(entityRows(rowsAt(ticks, 1), 10)[0].slot, 1);
    assert.equal(entityRows(rowsAt(ticks, 2), 11)[0].slot, 2);

    const despawn = entityRows(rowsAt(ticks, 3), 10);
    assert.equal(despawn.length, 1);
    assert.equal(despawn[0].kind, 'DESPAWN');
    assert.equal(despawn[0].why, 'gone');
    assert.equal(despawn[0].slot, 1);

    const sameTick = entityRows(rowsAt(ticks, 3), 12)[0];
    assert.equal(sameTick.kind, 'SPAWN');
    assert.notEqual(sameTick.slot, 1);
    assert.equal(sameTick.slot, 3);

    const later = entityRows(rowsAt(ticks, 4), 13)[0];
    assert.equal(later.kind, 'SPAWN');
    assert.equal(later.slot, 1);
});

test('range: an entity enters within 32 blocks, stays until 36, and leaves past it with why far', () => {
    const r = makeReader();
    const ticks = run(r, [
        ...startPackets(),
        spawnPkt(60, 20, 100, 64, 0), // 100 blocks away: no row
        teleport(110, 20, 15), // within 20 blocks: enters
        teleport(160, 20, 34), // 34 blocks: inside the leave radius, stays
        teleport(210, 20, 45), // beyond 36 (and 40): leaves
    ]);

    assert.equal(entityRows(rowsAt(ticks, 1), 20).length, 0);

    const enter = entityRows(rowsAt(ticks, 2), 20);
    const spawn = enter.find((x) => x.kind === 'SPAWN');
    assert.ok(spawn, 'expected a SPAWN row when the entity enters range');
    assert.equal(spawn.io, 'eng');
    assert.notEqual(spawn.slot, null);

    const stay = entityRows(rowsAt(ticks, 3), 20);
    assert.equal(stay.filter((x) => x.kind === 'DESPAWN').length, 0);

    const leave = entityRows(rowsAt(ticks, 4), 20).find((x) => x.kind === 'DESPAWN');
    assert.ok(leave, 'expected a DESPAWN row when the entity leaves range');
    assert.equal(leave.io, 'eng');
    assert.equal(leave.why, 'far');
});

test('a teleport of more than 8 blocks is a TP row, a smaller one is a MOVE row', () => {
    const r = makeReader();
    const ticks = run(r, [
        ...startPackets(),
        spawnPkt(60, 30, 3, 64, 0),
        teleport(110, 30, 12), // 9 blocks: over 32767 units
        teleport(160, 30, 19), // 7 blocks: under the threshold
    ]);

    const big = entityRows(rowsAt(ticks, 2), 30);
    assert.equal(big.length, 1);
    assert.equal(big[0].kind, 'TP');

    const small = entityRows(rowsAt(ticks, 3), 30);
    assert.equal(small.length, 1);
    assert.equal(small[0].kind, 'MOVE');
});

test('player input: position, arm swing and attack are io in events and player moves', () => {
    const r = makeReader();
    const ticks = run(r, [
        ...startPackets(),
        pkt(60, 'C2S', 'position_look', { x: 0.25, y: 64, z: 0, yaw: 0, pitch: 0, onGround: true }),
        pkt(110, 'C2S', 'arm_animation', { hand: 0 }),
        spawnPkt(160, 40, 3, 64, 0), // slot 1
        pkt(210, 'C2S', 'use_entity', { target: 40, mouse: 1 }),
    ]);

    const move = entityRows(rowsAt(ticks, 1), 1);
    assert.equal(move.length, 1);
    assert.equal(move[0].slot, 0);
    assert.equal(move[0].kind, 'MOVE');
    assert.equal(move[0].io, 'in');
    assert.equal(move[0].delta[0], 1024);

    const swing = rowsAt(ticks, 2).find((x) => x.row === 'EVENT' && x.kind === 'SWING_MAIN');
    assert.ok(swing, 'expected a SWING_MAIN event');
    assert.equal(swing.io, 'in');
    assert.equal(swing.slot, 0);

    const attack = rowsAt(ticks, 4).find((x) => x.row === 'EVENT' && x.kind === 'ATTACK');
    assert.ok(attack, 'expected an ATTACK event');
    assert.equal(attack.io, 'in');
    assert.ok(attack.tokens.includes('t1'), `tokens were ${attack.tokens}`);
});

test('blocks: a change near the player gives a row with offsets; far, repeated and no-op changes do not', () => {
    const r = makeReader();
    const ticks = run(r, [
        ...startPackets(),
        pkt(60, 'S2C', 'block_change', { location: { x: 2, y: 63, z: 0 }, type: 1 }),
        pkt(110, 'S2C', 'block_change', { location: { x: 7, y: 64, z: 0 }, type: 1 }), // 7 cells away
        pkt(160, 'S2C', 'block_change', { location: { x: 1, y: 64, z: 0 }, type: 1 }), // stone...
        pkt(170, 'S2C', 'block_change', { location: { x: 1, y: 64, z: 0 }, type: 0 }), // ...then air, same tick
        pkt(210, 'S2C', 'block_change', { location: { x: 2, y: 64, z: 2 }, type: 1 }),
        pkt(260, 'S2C', 'block_change', { location: { x: 2, y: 64, z: 2 }, type: 1 }), // no change
    ]);

    const first = rowsAt(ticks, 1).filter((x) => x.row === 'BLOCK');
    assert.equal(first.length, 1);
    assert.equal(first[0].ox, 2);
    assert.equal(first[0].oy, -1);
    assert.equal(first[0].oz, 0);
    assert.equal(first[0].block, 'stone');

    assert.equal(rowsAt(ticks, 2).filter((x) => x.row === 'BLOCK').length, 0);

    const merged = rowsAt(ticks, 3).filter((x) => x.row === 'BLOCK');
    assert.equal(merged.length, 1);
    assert.equal(merged[0].block, 'air');

    assert.equal(rowsAt(ticks, 4).filter((x) => x.row === 'BLOCK').length, 1);
    assert.equal(rowsAt(ticks, 5).filter((x) => x.row === 'BLOCK').length, 0);
});

test('slots: a new item gives a SLOT row; the same item again or empty to empty gives none', () => {
    const r = makeReader();
    const setSlot = (t, slot, item) => pkt(t, 'S2C', 'set_slot', { windowId: 0, stateId: 1, slot, item });
    const ticks = run(r, [
        ...startPackets(),
        setSlot(60, 36, { itemCount: 3, itemId: 1 }),
        setSlot(110, 36, { itemCount: 3, itemId: 1 }),
        setSlot(160, 37, { itemCount: 0 }),
    ]);

    const added = rowsAt(ticks, 1).filter((x) => x.row === 'SLOT');
    assert.equal(added.length, 1);
    assert.equal(added[0].count, 3);

    assert.equal(rowsAt(ticks, 2).filter((x) => x.row === 'SLOT').length, 0);
    assert.equal(rowsAt(ticks, 3).filter((x) => x.row === 'SLOT').length, 0);
});

test('events: death of a visible entity names its slot; an unknown entity is dropped and counted; damage has a dmg token', () => {
    const r = makeReader();
    const ticks = run(r, [
        ...startPackets(),
        spawnPkt(60, 50, 3, 64, 0),
        pkt(110, 'S2C', 'entity_status', { entityId: 50, entityStatus: 3 }),
        pkt(160, 'S2C', 'entity_status', { entityId: 999, entityStatus: 3 }),
        pkt(210, 'S2C', 'damage_event', { entityId: 50, sourceTypeId: 1, sourceCauseId: 0, sourceDirectId: 0 }),
    ]);

    const spawn = entityRows(rowsAt(ticks, 1), 50)[0];
    const death = rowsAt(ticks, 2).find((x) => x.row === 'EVENT' && x.kind === 'DEATH');
    assert.ok(death, 'expected a DEATH event');
    assert.equal(death.io, 'out');
    assert.equal(death.slot, spawn.slot);

    assert.equal(rowsAt(ticks, 3).filter((x) => x.row === 'EVENT').length, 0);
    assert.equal(r.stats.dropped.get('event on an entity outside the scene'), 1);

    const dmg = rowsAt(ticks, 4).find((x) => x.row === 'EVENT' && x.kind === 'DAMAGE');
    assert.ok(dmg, 'expected a DAMAGE event');
    assert.ok(dmg.tokens.some((t) => t.startsWith('dmg')), `tokens were ${dmg.tokens}`);
});

test('globals: health in half-hearts and food are rows once, and not again when unchanged', () => {
    const r = makeReader();
    const health = (t) => pkt(t, 'S2C', 'update_health', { health: 20, food: 20, foodSaturation: 5 });
    const ticks = run(r, [...startPackets(), health(60), health(110)]);

    const first = rowsAt(ticks, 1).filter((x) => x.row === 'GLOBAL');
    const h = first.find((x) => x.field === 'health');
    const f = first.find((x) => x.field === 'food');
    assert.equal(h.value, 40);
    assert.equal(f.value, 20);
    assert.equal(h.tokens[1], 'g:health');
    assert.equal(f.tokens[1], 'g:food');

    assert.equal(rowsAt(ticks, 2).filter((x) => x.row === 'GLOBAL').length, 0);
});

test('rows in one tick come out in the order ENTITY, BLOCK, SLOT, EVENT, GLOBAL', () => {
    const r = makeReader();
    const ticks = run(r, [
        ...startPackets(),
        spawnPkt(60, 10, 3, 64, 0),
        // one tick with a row of every kind, sent in the reverse order
        pkt(110, 'S2C', 'update_health', { health: 20, food: 20, foodSaturation: 5 }),
        pkt(110, 'S2C', 'damage_event', { entityId: 10, sourceTypeId: 1, sourceCauseId: 0, sourceDirectId: 0 }),
        pkt(110, 'S2C', 'set_slot', { windowId: 0, stateId: 1, slot: 36, item: { itemCount: 3, itemId: 1 } }),
        pkt(110, 'S2C', 'block_change', { location: { x: 2, y: 63, z: 0 }, type: 1 }),
        rel(110, 10, 100),
    ]);

    const rows = rowsAt(ticks, 2);
    const names = rows.map((x) => x.row);
    const order = ['ENTITY', 'BLOCK', 'SLOT', 'EVENT', 'GLOBAL'];
    const seen = names.filter((n, i) => i === 0 || names[i - 1] !== n);
    assert.deepEqual(seen, order);
});

test('per-tick cap: a tick with more rows than the cap keeps the cap and counts the drops', () => {
    const r = makeReader();
    const packets = [...startPackets()];
    // 70 entities close to the player in one tick: only 63 non-player slots exist
    for (let i = 0; i < 70; i++) packets.push(spawnPkt(60, 100 + i, (i % 10) + 1, 64, Math.floor(i / 10) + 1));
    // then every one of them moves, and ten blocks change near the player, in the next tick
    for (let i = 0; i < 70; i++) packets.push(rel(110, 100 + i, 100));
    for (let i = 0; i < 10; i++) packets.push(pkt(110, 'S2C', 'block_change', { location: { x: i - 4, y: 64, z: 5 }, type: 1 }));

    const ticks = run(r, packets);

    const spawnRows = rowsAt(ticks, 1);
    assert.equal(spawnRows.filter((x) => x.kind === 'SPAWN').length, 63);
    assert.ok(r.stats.dropped.get('no free entity slot') > 0, 'the 64th to 70th spawns should be counted as dropped');

    const moveTick = rowsAt(ticks, 2);
    assert.ok(moveTick.length <= MAX_ROWS_PER_TICK, `tick had ${moveTick.length} rows`);
    assert.ok(r.stats.dropped.get('over the per-tick row cap') > 0);
});

test('state: a configuration marker clears the world, and a following login starts fresh', () => {
    const r = new Reader({ phase: 0 });
    for (const p of [...startPackets(), spawnPkt(60, 10, 3, 64, 0)]) r.feedPacket(p);
    assert.ok(r.S.entities.size > 1);

    r.feed({ kind: 'state', to: 'configuration' });
    assert.equal(r.S.entities.size, 0);

    const ticks = run(r, [
        pkt(200, 'S2C', 'login', { entityId: 1, viewDistance: 10 }),
        pkt(201, 'S2C', 'position', { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, flags: NO_FLAGS, teleportId: 2 }),
    ]);
    assert.ok(ticks.length > 0);
    assert.equal(r.S.playerId, 1);
    assert.equal(r.S.entities.get(1).slot, 0);
    assert.equal(r.S.slotToId[0], 1);
    assert.equal(r.S.entities.size, 1);
});

test('phase: with phase 25 a packet at t=24 is tick -1 and t=25 is tick 0', () => {
    const r = new Reader({ phase: 25 });
    const first = r.feedPacket(pkt(24, 'S2C', 'login', { entityId: 1, viewDistance: 10 }));
    assert.deepEqual(first, []);
    assert.equal(r.tick, -1);

    const closed = r.feedPacket(pkt(25, 'S2C', 'update_time', { age: 0, time: 0 }));
    assert.equal(closed.length, 1);
    assert.equal(closed[0].tick, -1);
    assert.equal(r.tick, 0);
});
