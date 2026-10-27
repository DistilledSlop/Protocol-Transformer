'use strict';
// Round trip through the writer: packets -> Reader -> rows (tokens) -> Writer.step -> packets. Each test
// builds its own reader and writer so the order of the tests does not matter.

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeReader, pkt, run, startPackets, spawnPkt, rowsAt, entityRows } = require('./helpers');
const { Writer } = require('../writer/writer');
const { parseRow } = require('../writer/parse_rows');
const { createCatalog } = require('../catalog');
const { createCodec } = require('../parse');

// Loaded once: minecraft-data is the slow part of building a catalogue.
const cat = createCatalog();
const codec = createCodec();

const PLAYER_CTX = { playerId: 1, player: { x: 0, y: 64, z: 0 } };

// Every packet the writer emits must survive encode -> parse on the wire, with the same name. Checked for
// every packet a test produces (see compile), so a bad field fails in the test that made it.
function assertWire(packets) {
    for (const p of packets) {
        const buf = codec.encode('S2C', p.name, p.params);
        assert.equal(codec.parse('S2C', buf).name, p.name, `${p.name} survives the wire`);
    }
}

// Feed reader ticks to the writer one tick at a time. Only io 'out' and 'eng' rows go in: the writer ignores
// 'in' rows itself, and filtering them here keeps the model's side of the contract honest.
// after(o) runs once per tick, after the writer has compiled it, so a test can compare belief to truth.
function compile(writer, ticks, after = () => {}) {
    const out = [];
    for (const t of ticks) {
        const rows = t.rows.filter((r) => r.io !== 'in');
        const packets = writer.step(rows, { playerId: t.player.entityId, player: t.player });
        assertWire(packets);
        const o = { tick: t.tick, rows, packets };
        out.push(o);
        after(o);
    }
    return out;
}

// Names of the packets emitted in one tick (empty if the tick emitted nothing).
const namesAt = (out, tick) => (out.find((o) => o.tick === tick)?.packets ?? []).map((p) => p.name);

// Quantized numbers come back within one fine step: about 1.5% of the value, or 2 units for small ones.
const near = (got, want) => assert.ok(Math.abs(got - want) <= Math.max(2, 0.015 * Math.abs(want)), `${got} is near ${want}`);

const total = (map) => [...map.values()].reduce((a, b) => a + b, 0);

test('parse_rows: each reader row parses back to its slot, kind and numbers', () => {
    const r = makeReader();
    const ticks = run(r, [
        ...startPackets(),
        spawnPkt(60, 10, 3, 64, 0, { velocity: { x: 800, y: 0, z: 0 } }),
        pkt(110, 'S2C', 'rel_entity_move', { entityId: 10, dX: 333, dY: 0, dZ: 0, onGround: true }),
        pkt(160, 'S2C', 'entity_teleport', { entityId: 10, x: 20, y: 64, z: 0, yaw: 0, pitch: 0, onGround: true }),
        pkt(210, 'S2C', 'entity_velocity', { entityId: 10, velocity: { x: -400, y: 0, z: 0 } }),
        pkt(260, 'S2C', 'animation', { entityId: 10, animation: 0 }),
        pkt(310, 'S2C', 'entity_status', { entityId: 10, entityStatus: 3 }),
        pkt(360, 'S2C', 'block_change', { location: { x: 2, y: 63, z: 0 }, type: cat.blockStateId('stone') }),
        pkt(410, 'S2C', 'set_slot', { windowId: 0, stateId: 1, slot: 36, item: { itemCount: 3, itemId: cat.itemId('stone'), addedComponentCount: 0, removedComponentCount: 0, components: [], removeComponents: [] } }),
        pkt(460, 'S2C', 'update_health', { health: 17, food: 12, foodSaturation: 3 }),
        pkt(610, 'S2C', 'entity_destroy', { entityIds: [10] }),
    ]);
    // parse the token form only, as the writer does
    const parsed = ticks.flatMap((t) => t.rows).filter((x) => x.io !== 'in').map((x) => parseRow(x.tokens));
    const find = (pred) => {
        const p = parsed.find(pred);
        assert.ok(p, 'a row of that kind is present');
        return p;
    };

    const spawn = find((p) => p.row === 'ENTITY' && p.kind === 'SPAWN');
    assert.equal(spawn.slot, 1);
    assert.equal(spawn.type, 'pig');
    // positions are whole sixteenths on this lattice: 3 blocks is 48 units
    assert.deepEqual(spawn.rel, [48, 0, 0]);
    near(spawn.vel[0], 800);

    const move = find((p) => p.kind === 'MOVE');
    assert.equal(move.slot, 1);
    near(move.delta[0], 333);
    assert.equal(move.delta[1], 0);

    // 20 blocks from the player at the origin is 320 sixteenths, exact
    const tp = find((p) => p.kind === 'TP');
    assert.deepEqual(tp.rel, [320, 0, 0]);

    const vel = find((p) => p.kind === 'VEL');
    near(vel.vel[0], -400);

    const despawn = find((p) => p.kind === 'DESPAWN');
    assert.equal(despawn.slot, 1);
    assert.equal(despawn.why, 'gone');

    const swing = find((p) => p.row === 'EVENT' && p.kind === 'SWING_MAIN');
    assert.equal(swing.slot, 1);
    const death = find((p) => p.row === 'EVENT' && p.kind === 'DEATH');
    assert.equal(death.slot, 1);

    const block = find((p) => p.row === 'BLOCK');
    assert.deepEqual(block.offset, [2, -1, 0]);
    assert.equal(block.block, 'stone');

    const slot = find((p) => p.row === 'SLOT');
    assert.equal(slot.window, 0);
    assert.equal(slot.index, 36);
    assert.equal(slot.item, 'stone');
    assert.equal(slot.count, 3);

    // half-hearts on the wire from the server, so 17 hearts is 34 here
    assert.equal(find((p) => p.row === 'GLOBAL' && p.field === 'health').value, 34);
    assert.equal(find((p) => p.row === 'GLOBAL' && p.field === 'food').value, 12);
});

test('spawn: one bundle holds the spawn, with a new id, the type and a position within a sixteenth', () => {
    const r = makeReader();
    // off-grid positions: the spawn row can only say the nearest sixteenth, so the error is up to 1/32 a block
    const truth = [
        { x: 3.03, y: 64.02, z: -2.01 },
        { x: 5.4, y: 65.2, z: 1.7 },
    ];
    const ticks = run(r, [...startPackets(), spawnPkt(60, 10, truth[0].x, truth[0].y, truth[0].z), spawnPkt(110, 11, truth[1].x, truth[1].y, truth[1].z)]);
    const writer = new Writer({ catalog: cat });
    const out = compile(writer, ticks);

    // the first spawn sits in one bundle on its own tick
    const first = out.find((o) => o.packets.some((p) => p.name === 'spawn_entity'));
    assert.deepEqual(first.packets.map((p) => p.name), ['bundle_delimiter', 'spawn_entity', 'bundle_delimiter']);

    const spawnRows = ticks.flatMap((t) => t.rows).filter((x) => x.io !== 'in' && x.kind === 'SPAWN');
    const spawnPackets = out.flatMap((o) => o.packets).filter((p) => p.name === 'spawn_entity');
    assert.equal(spawnPackets.length, spawnRows.length);

    const ids = new Set();
    spawnPackets.forEach((p, i) => {
        const row = spawnRows[i];
        const pos = truth[i];
        assert.equal(p.params.type, cat.entityTypeId(row.type), `type of ${row.type}`);
        for (const [axis, v] of [['x', pos.x], ['y', pos.y], ['z', pos.z]]) {
            assert.ok(Math.abs(p.params[axis] - v) <= 0.04, `${axis} ${p.params[axis]} within 0.04 of ${v}`);
        }
        assert.ok(p.params.entityId >= 10000, 'ids come from the engine range');
        assert.ok(!ids.has(p.params.entityId), 'ids are unique per spawn');
        ids.add(p.params.entityId);
        assert.equal(writer.bySlot.get(row.slot)?.id, p.params.entityId, 'the slot now belongs to this entity');
    });
});

test('moves: belief stays within 3/4096 of the truth, and rotation picks the packet variant', () => {
    const r = makeReader();
    const packets = [...startPackets(), spawnPkt(60, 10, 3, 64, 0)];
    // thirty moves of 333 units, one per tick: the true position is the spawn plus what the packets say
    for (let i = 0; i < 30; i++) packets.push(pkt(110 + i * 50, 'S2C', 'rel_entity_move', { entityId: 10, dX: 333, dY: 0, dZ: 0, onGround: true }));
    const ticks = run(r, packets);
    const writer = new Writer({ catalog: cat });
    let k = 0;
    const out = compile(writer, ticks, (o) => {
        if (!o.packets.some((p) => p.name === 'rel_entity_move')) return;
        k++;
        const truth = 3 + (k * 333) / 4096;
        const belief = writer.bySlot.get(1).x;
        assert.ok(Math.abs(belief - truth) <= 3 / 4096, `move ${k}: belief ${belief} vs truth ${truth}`);
    });
    assert.equal(k, 30);
    // no rotation changed, so nothing but the delta packet goes out
    const moveNames = out.flatMap((o) => o.packets.map((p) => p.name)).filter((n) => n !== 'bundle_delimiter' && n !== 'spawn_entity');
    assert.deepEqual(moveNames, Array(30).fill('rel_entity_move'));
});

test('moves: a yaw change makes entity_move_look, a turn of the head alone makes entity_head_rotation', () => {
    const r = makeReader();
    const ticks = run(r, [
        ...startPackets(),
        spawnPkt(60, 10, 3, 64, 0),
        // a move with a new yaw, in its own tick
        pkt(110, 'S2C', 'entity_move_look', { entityId: 10, dX: 333, dY: 0, dZ: 0, yaw: 64, pitch: 0, onGround: true }),
        // a head turn in a later tick; the entity has not moved since the spawn, so its belief is exact
        pkt(260, 'S2C', 'spawn_entity', { entityId: 11, objectUUID: '00000000-0000-0000-0000-000000000002', type: 77, x: 0, y: 64, z: 4, pitch: 0, yaw: 0, headPitch: 0, objectData: 0, velocity: { x: 0, y: 0, z: 0 } }),
        pkt(310, 'S2C', 'entity_head_rotation', { entityId: 11, headYaw: 32 }),
    ]);
    const out = compile(new Writer({ catalog: cat }), ticks);
    assert.deepEqual(namesAt(out, 2), ['entity_move_look']);
    assert.deepEqual(namesAt(out, 6), ['entity_head_rotation']);
});

test('teleport: an entity_teleport over 8 blocks lands within 0.04 blocks of the true position', () => {
    const r = makeReader();
    const target = { x: 20.03, y: 64, z: 1.97 };
    const ticks = run(r, [
        ...startPackets(),
        spawnPkt(60, 10, 3, 64, 0),
        pkt(110, 'S2C', 'entity_teleport', { entityId: 10, x: target.x, y: target.y, z: target.z, yaw: 0, pitch: 0, onGround: true }),
    ]);
    const out = compile(new Writer({ catalog: cat }), ticks);
    const tp = out.find((o) => o.packets.some((p) => p.name === 'entity_teleport')).packets.find((p) => p.name === 'entity_teleport');
    for (const axis of ['x', 'y', 'z']) {
        assert.ok(Math.abs(tp.params[axis] - target[axis]) <= 0.04, `${axis} ${tp.params[axis]} within 0.04 of ${target[axis]}`);
    }
});

test('despawn: entity_destroy names the spawned id, the slot is forgotten, and a same-tick death still comes out', () => {
    const r = makeReader();
    // the death event and the destroy arrive in the same tick: the event must still resolve to the id
    const ticks = run(r, [
        ...startPackets(),
        spawnPkt(60, 10, 3, 64, 0),
        pkt(110, 'S2C', 'entity_status', { entityId: 10, entityStatus: 3 }),
        pkt(110, 'S2C', 'entity_destroy', { entityIds: [10] }),
    ]);
    const writer = new Writer({ catalog: cat });
    const out = compile(writer, ticks);
    const spawned = out.flatMap((o) => o.packets).find((p) => p.name === 'spawn_entity');
    const dying = out.find((o) => o.tick === 2).packets;
    const destroy = dying.find((p) => p.name === 'entity_destroy');
    assert.deepEqual(destroy.params.entityIds, [spawned.params.entityId]);
    const status = dying.find((p) => p.name === 'entity_status');
    assert.ok(status, 'the death event comes out in the same tick');
    assert.equal(status.params.entityId, spawned.params.entityId);
    assert.equal(status.params.entityStatus, 3);
    assert.equal(writer.bySlot.has(1), false, 'the slot is forgotten once the tick is done');
});

test('blocks: one change is a block_change, two in one section are one multi_block_change that decodes back', () => {
    const r = makeReader();
    const ticks = run(r, [
        ...startPackets(),
        // player floor is (0, 64, 0): offsets are (2, -1, 0) and so on
        pkt(60, 'S2C', 'block_change', { location: { x: 2, y: 63, z: 0 }, type: cat.blockStateId('stone') }),
        pkt(110, 'S2C', 'block_change', { location: { x: 3, y: 62, z: 1 }, type: cat.blockStateId('dirt') }),
        pkt(110, 'S2C', 'block_change', { location: { x: 4, y: 61, z: 2 }, type: cat.blockStateId('cobblestone') }),
    ]);
    const out = compile(new Writer({ catalog: cat }), ticks);

    const single = out.find((o) => o.tick === 1).packets.find((p) => p.name === 'block_change');
    assert.deepEqual(single.params.location, { x: 2, y: 63, z: 0 });
    assert.equal(single.params.type, cat.blockStateId('stone'));

    const multi = out.find((o) => o.tick === 2).packets;
    assert.deepEqual(multi.map((p) => p.name), ['multi_block_change']);
    const { chunkCoordinates, records } = multi[0].params;
    // the section is 16 blocks wide: (0, 3, 0) covers x 0..15, y 48..63, z 0..15
    assert.deepEqual([chunkCoordinates.x, chunkCoordinates.y, chunkCoordinates.z], [0, 3, 0]);
    // each record packs state << 12 | x << 8 | z << 4 | y, all within the section
    const decoded = records.map((rec) => {
        const v = Number(rec);
        return {
            state: v >> 12,
            x: chunkCoordinates.x * 16 + ((v >> 8) & 15),
            y: chunkCoordinates.y * 16 + (v & 15),
            z: chunkCoordinates.z * 16 + ((v >> 4) & 15),
        };
    });
    const got = decoded.map((d) => `${d.x},${d.y},${d.z}=${d.state}`).sort();
    const want = [`3,62,1=${cat.blockStateId('dirt')}`, `4,61,2=${cat.blockStateId('cobblestone')}`].sort();
    assert.deepEqual(got, want);
});

test('slots: set_slot carries the item and count, and the state id goes up by one per change', () => {
    const r = makeReader();
    const item = (n) => ({ itemCount: n, itemId: cat.itemId('stone'), addedComponentCount: 0, removedComponentCount: 0, components: [], removeComponents: [] });
    const ticks = run(r, [
        ...startPackets(),
        pkt(60, 'S2C', 'set_slot', { windowId: 0, stateId: 1, slot: 36, item: item(3) }),
        pkt(110, 'S2C', 'set_slot', { windowId: 0, stateId: 2, slot: 37, item: item(1) }),
    ]);
    const out = compile(new Writer({ catalog: cat }), ticks);
    const sets = out.flatMap((o) => o.packets).filter((p) => p.name === 'set_slot');
    assert.equal(sets.length, 2);
    assert.equal(sets[0].params.item.itemId, cat.itemId('stone'));
    assert.equal(sets[0].params.item.itemCount, 3);
    assert.equal(sets[0].params.slot, 36);
    assert.equal(sets[1].params.stateId, sets[0].params.stateId + 1, 'state id counts up within the window');
});

test('globals: health, food, experience and rain come out as their packets with the right values', () => {
    const r = makeReader();
    const ticks = run(r, [
        ...startPackets(),
        pkt(60, 'S2C', 'update_health', { health: 17, food: 12, foodSaturation: 3 }),
        pkt(60, 'S2C', 'experience', { experienceBar: 0, level: 5, totalExperience: 55 }),
        pkt(60, 'S2C', 'game_state_change', { reason: 'begin_raining', gameMode: 0 }),
    ]);
    const out = compile(new Writer({ catalog: cat }), ticks);
    const all = out.flatMap((o) => o.packets);

    // the writer sends the whole health state with each change, so the last one holds both values
    const health = all.filter((p) => p.name === 'update_health').pop();
    assert.equal(health.params.health, 17);
    assert.equal(health.params.food, 12);

    // level 5 needs 55 points in total (vanilla), and the bar is empty
    const xp = all.filter((p) => p.name === 'experience').pop();
    assert.equal(xp.params.level, 5);
    assert.equal(xp.params.totalExperience, 55);

    const rain = all.find((p) => p.name === 'game_state_change');
    assert.equal(rain.params.reason, 'begin_raining');
});

test('rejection: bad, unknown and ghost rows are counted and do not throw or emit', () => {
    // a row whose number is garbage: parse fails, the writer counts it and carries on
    const w1 = new Writer({ catalog: cat });
    const before1 = total(w1.stats.rejected);
    assert.doesNotThrow(() => w1.step([{ io: 'out', tokens: ['ENTITY', 's9', 'MOVE', 'dx', 'garbage'] }], PLAYER_CTX));
    assert.equal(total(w1.stats.rejected), before1 + 1);

    // a move for a slot the writer never spawned: the model named a ghost, so nothing is sent
    const w2 = new Writer({ catalog: cat });
    const ghost = ['ENTITY', 's9', 'MOVE', 'dx', '0', 'dy', '0', 'dz', '0', 'yaw0', 'pitch0', 'hy0'];
    assert.deepEqual(w2.step([{ io: 'out', tokens: ghost }], PLAYER_CTX), []);
    assert.equal(w2.stats.rejected.get('MOVE of an empty slot'), 1);

    // a real spawn row with its type replaced by one that does not exist: counted, no packet
    const r = makeReader();
    const ticks = run(r, [...startPackets(), spawnPkt(60, 10, 3, 64, 0)]);
    const realSpawn = ticks.flatMap((t) => t.rows).find((x) => x.io !== 'in' && x.kind === 'SPAWN');
    const badTokens = realSpawn.tokens.map((t) => (t.startsWith('type:') ? 'type:not_a_mob' : t));
    const w3 = new Writer({ catalog: cat });
    assert.deepEqual(w3.step([{ io: 'out', tokens: badTokens }], PLAYER_CTX), []);
    assert.equal(w3.stats.rejected.get('SPAWN of an unknown entity type'), 1);
    assert.equal(w3.bySlot.has(realSpawn.slot), false, 'no entity was made from the bad row');
});

test('closed loop: after the tick that retries dropped rows, every entity matches its truth within 3/4096', () => {
    const r = makeReader();
    // same situation as belief.test.js: 63 entities, then ten block changes that push the tick past the row cap
    const entities = Array.from({ length: 63 }, (_, i) => ({ id: 100 + i, x: 3, y: 64, z: 0.5 + i * 0.4 }));
    const spawns = entities.map((e) => spawnPkt(60, e.id, e.x, e.y, e.z));
    const moves1 = entities.map((e) => pkt(110, 'S2C', 'rel_entity_move', { entityId: e.id, dX: 64, dY: 0, dZ: 0, onGround: true }));
    const blocks = Array.from({ length: 10 }, (_, i) => pkt(111, 'S2C', 'block_change', { location: { x: -5 + i, y: 63, z: 1 }, type: 1 }));
    const ticks = run(r, [...startPackets(), ...spawns, ...moves1, ...blocks, pkt(160, 'S2C', 'rel_entity_move', { entityId: 100, dX: 0, dY: 0, dZ: 0, onGround: true })]);

    assert.ok(r.stats.dropped.get('over the per-tick row cap') > 0, 'the reader really dropped some moves');

    // the true position of every entity after tick 3: the spawn plus the 64-unit move (entity 100's later move is zero)
    const slotOf = new Map(ticks.flatMap((t) => t.rows).filter((x) => x.io !== 'in' && x.kind === 'SPAWN').map((x) => [x.entityId, x.slot]));
    const writer = new Writer({ catalog: cat });
    let checked = 0;
    compile(writer, ticks, (o) => {
        if (o.tick !== 3) return;
        for (const e of entities) {
            const b = writer.bySlot.get(slotOf.get(e.id));
            assert.ok(b, `entity ${e.id} is in the writer's belief`);
            assert.ok(Math.abs(b.x - (e.x + 64 / 4096)) <= 3 / 4096, `entity ${e.id} x ${b.x}`);
            assert.ok(Math.abs(b.z - e.z) <= 3 / 4096, `entity ${e.id} z ${b.z} vs ${e.z}`);
            checked++;
        }
    });
    assert.equal(checked, 63, 'every entity was checked after tick 3');
});
