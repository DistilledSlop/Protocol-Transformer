'use strict';
// Round trips for the entity rows in families/entityextra.js: the original server packet goes through the
// Reader, the rows through the Writer, and the Writer's packet must say what the server said.
// The writer assigns its own entity ids, so entityId fields are compared against the writer's belief.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { roundTrip, sameParams, PIG, cat } = require('./helper');
const { UUID } = require('../helpers');

const pkt = (name, params) => ({ name, params });
const spawn = (id, x) => pkt('spawn_entity', { entityId: id, objectUUID: UUID, type: PIG, x, y: 64, z: 0, pitch: 0, yaw: 0, headPitch: 0, objectData: 0, velocity: { x: 0, y: 0, z: 0 } });
const meta = (metadata) => pkt('entity_metadata', { entityId: 7, metadata });

// the one packet of a name the writer made in the tested tick, or a readable failure
function one(r, name) {
    const out = r.out.filter((p) => p.name === name);
    assert.equal(out.length, 1, `one ${name}, got [${r.out.map((p) => p.name).join(', ')}]`);
    return out[0];
}

// every rejection is counted, none thrown
function clean(r) {
    assert.equal(r.writer.stats.rejected.size, 0, [...r.writer.stats.rejected.keys()].join('; '));
}

// the rows of one kind the reader made in the tested tick
const kindRows = (r, kind) => r.rows.filter((x) => x.kind === kind);

// ---- ENTITY META --------------------------------------------------------------------------------------------

test('META byte flags: several keys in one packet become one entity_metadata', () => {
    const orig = meta([
        { key: 0, type: 'byte', value: 0x42 }, // bits 1 and 6: a sprinting, glowing pig
        { key: 17, type: 'byte', value: 5 }, // a plain byte key
    ]);
    const r = roundTrip({ packets: [orig] });
    assert.deepEqual(kindRows(r, 'META').map((x) => x.key), [0, 17]);
    const out = one(r, 'entity_metadata');
    assert.equal(out.params.entityId, r.writer.bySlot.get(1).id);
    sameParams(orig.params, out.params, { ignore: ['entityId'] });
    clean(r);
});

test('META health: absolute, then a half-point delta', () => {
    const r = roundTrip({ before: [meat(20)], packets: [meat(17.5)] });
    assert.deepEqual(kindRows(r, 'META').map((x) => x.tokens.slice(4, 5)), [['Δ-5']]);
    const out = one(r, 'entity_metadata');
    assert.equal(out.params.metadata[0].value, 17.5);
    sameParams(meat(17.5).params, out.params, { ignore: ['entityId'] });
    clean(r);

    const abs = roundTrip({ packets: [meat(17.5)] });
    assert.deepEqual(kindRows(abs, 'META')[0].tokens.slice(4, 5), ['abs']);
    sameParams(meat(17.5).params, one(abs, 'entity_metadata').params, { ignore: ['entityId'] });
    clean(abs);
});

// LOSSY: the reader keeps health in half-points, so 17.3 comes back as 17.5 (the rounding is not undone).
test('META health off the half-point grid is rounded (LOSSY: half-points)', () => {
    const r = roundTrip({ packets: [meat(17.3)] });
    const out = one(r, 'entity_metadata');
    assert.ok(Math.abs(out.params.metadata[0].value - 17.3) <= 0.25);
    assert.equal(out.params.metadata[0].value, 17.5);
    clean(r);
});

test('META air supply: absolute, then an integer delta', () => {
    const r = roundTrip({ before: [air(300)], packets: [air(290)] });
    assert.deepEqual(kindRows(r, 'META').map((x) => x.tokens.slice(4, 5)), [['Δ-10']]);
    const out = one(r, 'entity_metadata');
    sameParams(air(290).params, out.params, { ignore: ['entityId'] });
    clean(r);
});

test('META boolean', () => {
    const orig = meta([{ key: 5, type: 'boolean', value: true }]); // no gravity
    const r = roundTrip({ packets: [orig] });
    assert.deepEqual(kindRows(r, 'META')[0].tokens.slice(4), ['true']);
    sameParams(orig.params, one(r, 'entity_metadata').params, { ignore: ['entityId'] });
    clean(r);
});

test('META optional component: a plain text name', () => {
    const orig = meta([{ key: 2, type: 'optional_component', value: nbtText('Bob') }]);
    const r = roundTrip({ packets: [orig] });
    assert.deepEqual(kindRows(r, 'META')[0].tokens.slice(4), ['tpl:Bob']);
    sameParams(orig.params, one(r, 'entity_metadata').params, { ignore: ['entityId'] });
    clean(r);
});

test('META string: a template with a number in it', () => {
    const orig = meta([{ key: 4, type: 'string', value: 'hi 12' }]);
    const r = roundTrip({ packets: [orig] });
    sameParams(orig.params, one(r, 'entity_metadata').params, { ignore: ['entityId'] });
    clean(r);
});

test('META item_stack', () => {
    const slot = { itemCount: 3, itemId: cat.itemId('diamond'), addedComponentCount: 0, removedComponentCount: 0, components: [], removeComponents: [] };
    const orig = meta([{ key: 8, type: 'item_stack', value: slot }]);
    const r = roundTrip({ packets: [orig] });
    sameParams(orig.params, one(r, 'entity_metadata').params, { ignore: ['entityId'] });
    clean(r);
});

test('META pose', () => {
    const orig = meta([{ key: 6, type: 'pose', value: 1 }]);
    const r = roundTrip({ packets: [orig] });
    assert.deepEqual(kindRows(r, 'META')[0].tokens.slice(4), ['pose:1']);
    sameParams(orig.params, one(r, 'entity_metadata').params, { ignore: ['entityId'] });
    clean(r);
});

test('META block position: the block comes back exactly', () => {
    const orig = meta([{ key: 11, type: 'optional_block_pos', value: { x: 2, y: 65, z: -1 } }]);
    const r = roundTrip({ packets: [orig] });
    sameParams(orig.params, one(r, 'entity_metadata').params, { ignore: ['entityId'] });
    clean(r);
});

test('META with no token form falls back to v: JSON', () => {
    const orig = meta([{ key: 18, type: 'optional_unsigned_int', value: 5 }]);
    const r = roundTrip({ packets: [orig] });
    assert.equal(kindRows(r, 'META')[0].tokens[3], 'mk:pig:18:optional_unsigned_int');
    sameParams(orig.params, one(r, 'entity_metadata').params, { ignore: ['entityId'] });
    clean(r);
});

test('garbage META tokens are rejected and counted, not thrown', () => {
    const r = roundTrip({ packets: [] });
    const mk =(serializer) => `mk:pig:0:${serializer}`;
    const rows = [
        ['ENTITY', 's1', 'META', mk('byte'), 'zz'], // not a flag set or an integer
        ['ENTITY', 's1', 'META', mk('float'), 'Δ3'], // delta on a key that takes none
        ['ENTITY', 's1', 'META', 'mk:pig:9:float', 'f:x'], // health needs abs or a delta
        ['ENTITY', 's1', 'META', 'mk:pig:4:string', 'tpl:hi {n}'], // the number's token is missing
        ['ENTITY', 's1', 'META', 'mk:pig:18:optional_unsigned_int', 'v:optional_unsigned_int:[1,'], // truncated JSON
    ].map((tokens) => ({ io: 'out', tokens }));
    const before = [...r.writer.stats.rejected.values()].reduce((a, b) => a + b, 0);
    const out = r.writer.step(rows, { playerId: 1, player: { x: 0, y: 64, z: 0 }, names: [], blobs: new Map() });
    const after = [...r.writer.stats.rejected.values()].reduce((a, b) => a + b, 0);
    assert.deepEqual(out, []);
    assert.equal(after - before, rows.length);
});

// ---- ENTITY EQUIP -------------------------------------------------------------------------------------------

test('EQUIP: changed slots of one entity become one entity_equipment', () => {
    const orig = pkt('entity_equipment', {
        entityId: 7,
        equipments: [
            { slot: 0, item: { itemCount: 1, itemId: cat.itemId('iron_sword'), addedComponentCount: 0, removedComponentCount: 0, components: [], removeComponents: [] } },
            { slot: 4, item: { itemCount: 0 } },
        ],
    });
    const r = roundTrip({ packets: [orig] });
    assert.deepEqual(kindRows(r, 'EQUIP').map((x) => x.equipSlot), [0, 4]);
    const out = one(r, 'entity_equipment');
    sameParams(orig.params, out.params, { ignore: ['entityId'] });
    clean(r);
});

// ---- ENTITY PASSENGERS and LINK -----------------------------------------------------------------------------

test('PASSENGERS: the rider keeps its writer id', () => {
    const orig = pkt('set_passengers', { entityId: 7, passengers: [8] });
    const r = roundTrip({ before: [spawn(8, 4)], packets: [orig] });
    assert.deepEqual(kindRows(r, 'PASSENGERS')[0].tokens, ['ENTITY', 's1', 'PASSENGERS', 't2']);
    const out = one(r, 'set_passengers');
    sameParams({ entityId: r.writer.bySlot.get(1).id, passengers: [r.writer.bySlot.get(2).id] }, out.params);
    clean(r);
});

test('LINK: a leash to a holder', () => {
    const orig = pkt('attach_entity', { entityId: 7, vehicleId: 8 });
    const r = roundTrip({ before: [spawn(8, 4)], packets: [orig] });
    assert.deepEqual(kindRows(r, 'LINK')[0].tokens, ['ENTITY', 's1', 'LINK', 't2']);
    sameParams({ entityId: r.writer.bySlot.get(1).id, vehicleId: r.writer.bySlot.get(2).id }, one(r, 'attach_entity').params);
    clean(r);
});

test('LINK: a detach sends vehicle 0', () => {
    const orig = pkt('attach_entity', { entityId: 7, vehicleId: 0 });
    const r = roundTrip({ packets: [orig] });
    assert.deepEqual(kindRows(r, 'LINK')[0].tokens, ['ENTITY', 's1', 'LINK', 'none']);
    sameParams({ entityId: r.writer.bySlot.get(1).id, vehicleId: 0 }, one(r, 'attach_entity').params);
    clean(r);
});

// ---- EVENT EFFECT and PICKUP --------------------------------------------------------------------------------

test('EFFECT: amplifier, duration and flag bits', () => {
    const orig = pkt('entity_effect', { entityId: 7, effectId: 1, amplifier: 1, duration: 600, flags: 7 });
    const r = roundTrip({ packets: [orig] });
    assert.deepEqual(kindRows(r, 'EFFECT')[0].tokens, ['EVENT', 's1', 'EFFECT', 'eff1', 'a1', 't=', 'd6', 'd0', 'd0', ';', 'bit0', 'bit1', 'bit2']);
    sameParams({ ...orig.params, entityId: r.writer.bySlot.get(1).id }, one(r, 'entity_effect').params);
    clean(r);
});

test('PICKUP: the collector is the row slot, the collected entity its own id', () => {
    const orig = pkt('collect', { collectedEntityId: 8, collectorEntityId: 7, pickupItemCount: 1 });
    const r = roundTrip({ before: [spawn(8, 4)], packets: [orig] });
    assert.deepEqual(kindRows(r, 'PICKUP')[0].tokens, ['EVENT', 's1', 'PICKUP', 't2', 'n1']);
    sameParams({ collectedEntityId: r.writer.bySlot.get(2).id, collectorEntityId: r.writer.bySlot.get(1).id, pickupItemCount: 1 }, one(r, 'collect').params);
    clean(r);
});

// The collected item despawns in the same tick: its slot must still resolve for the pickup.
test('PICKUP of an entity that despawns in the same tick still resolves', () => {
    const r = roundTrip({ before: [spawn(8, 4)], packets: [pkt('collect', { collectedEntityId: 8, collectorEntityId: 7, pickupItemCount: 1 }), pkt('entity_destroy', { entityIds: [8] })] });
    const destroyed = one(r, 'entity_destroy').params.entityIds[0];
    assert.equal(one(r, 'collect').params.collectedEntityId, destroyed);
    clean(r);
});

// ---- helpers ------------------------------------------------------------------------------------------------

function meat(v) {
    return meta([{ key: 9, type: 'float', value: v }]);
}

function air(v) {
    return meta([{ key: 1, type: 'int', value: v }]);
}

// nameless anonymous NBT text, as the 1.21 packets carry it
function nbtText(s) {
    return { type: 'compound', name: '', value: { text: { type: 'string', value: s } } };
}

test('join metadata seeds player and entity deltas using the captured entity IDs', () => {
    const { makeReader, pkt: feedPacket, startPackets, spawnPkt } = require('../helpers');
    const { Writer } = require('../../writer/writer');
    const reader = makeReader();
    for (const p of startPackets()) reader.feedPacket(p);
    reader.feedPacket(spawnPkt(10, 10000, 3, 64, 0, { type: PIG }));
    reader.feedPacket(feedPacket(11, 'S2C', 'entity_metadata', { entityId: 10000, metadata: [{ key: 1, type: 'int', value: 280 }] }));
    reader.feedPacket(feedPacket(12, 'S2C', 'entity_metadata', { entityId: 1, metadata: [{ key: 1, type: 'int', value: 300 }] }));
    reader.advanceTo(100);
    const writer = new Writer();
    writer.seedFromReader(reader);
    const ctx = { playerId: 1, player: { x: 0, y: 64, z: 0 } };
    const out = writer.step([
        { tokens: ['ENTITY', 's1', 'META', 'mk:pig:1:int', 'Δ-10'] },
        { tokens: ['ENTITY', 's0', 'META', 'mk:player:1:int', 'Δ-5'] },
    ], ctx).filter(p => p.name === 'entity_metadata');
    assert.deepEqual(out.map(p => [p.params.entityId, p.params.metadata[0].value]), [[10000, 270], [1, 295]]);
    assert.equal(writer.nextEntityId, 10001);
    for (const p of out) require('./helper').checkWire(p);
});

test('unresolvable deltas are rejected without stopping other rows or poisoning metadata', () => {
    const { Writer } = require('../../writer/writer');
    const writer = new Writer();
    const ctx = { playerId: 1, player: { x: 0, y: 64, z: 0 } };
    const row = (...tokens) => ({ tokens });
    const out = writer.step([
        row('ENTITY', 's0', 'META', 'mk:player:1:int', 'Δ-10'),
        row('ENTITY', 's0', 'META', 'mk:player:1:int', 'i300'),
        row('ENTITY', 's0', 'META', 'mk:player:1:int', 'Δ-5'),
        row('ENTITY', 's1', 'META', 'mk:pig:1:int', 'Δ-1'),
    ], ctx);
    assert.equal(out.find(p => p.name === 'entity_metadata').params.metadata[0].value, 295);
    assert.equal(writer.stats.rejected.get('META delta without a matching baseline'), 1);
    assert.equal(writer.stats.rejected.get('META of an empty slot'), 1);
});


test('join reserves the player ID even when its entity record is absent', () => {
    const { Writer } = require('../../writer/writer');
    const writer = new Writer();
    writer.seedFromReader({ S: { playerId: 10000, entities: new Map(), slotToId: [] } });
    const out = writer.step([{ tokens: ['ENTITY', 's1', 'SPAWN', 'type:pig', 'px', 'ob9', 'of6', 'py', 'ob0', 'of0', 'pz', 'ob8', 'of8', 'yaw0', 'pitch0', 'hy0'] }],
        { playerId: 10000, player: { x: 0, y: 64, z: 0 } });
    assert.equal(out.find(p => p.name === 'spawn_entity').params.entityId, 10001);
});
