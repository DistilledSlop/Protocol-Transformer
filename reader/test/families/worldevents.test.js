'use strict';
// Round trips for the world-event kinds: each packet goes through the Reader, the rows through the Writer, and
// the rebuilt packet is compared with the original. Lossy fields are listed in the family's header comment.

const test = require('node:test');
const assert = require('node:assert/strict');
const { roundTrip, sameParams, cat } = require('./helper');
const { Writer } = require('../../writer/writer');

const NBT = { type: 'compound', name: '', value: { text: { type: 'string', value: 'hi' } } };
const ALL_FLAGS = { x: true, y: true, z: true, yaw: true, pitch: true };

// the one packet of this name the writer made in the tested tick
function one(out, name) {
    const hits = out.filter((p) => p.name === name);
    assert.equal(hits.length, 1, `one ${name} packet`);
    return hits[0];
}

// the reader's row kind for this packet (EVENT SOUND, BLOCK ENTITY_DATA, ...)
function rowKind(rows, kind) {
    return rows.some((r) => r.kind === kind);
}

test('room-wide sound effect round trips', () => {
    const params = { sound: { soundId: 5 }, soundCategory: 'master', x: 27, y: 512, z: 0, volume: 0.5, pitch: 1, seed: 0n };
    const r = roundTrip({ packets: [{ name: 'sound_effect', params }] });
    assert.ok(rowKind(r.rows, 'SOUND'));
    const rebuilt = one(r.out, 'sound_effect');
    // sound positions are 1/8 block: the packet integer is exact here, so the tolerance is one unit
    sameParams(params, rebuilt.params, { ignore: ['seed'], tol: { x: 1, y: 1, z: 1, pitch: 1 / 32 } });
    assert.equal(r.writer.stats.rejected.size, 0);
});

test('entity sound effect round trips and names the writer id of the entity', () => {
    const params = { sound: { soundId: 9 }, soundCategory: 'hostile', entityId: 7, volume: 0.5, pitch: 0.75, seed: 0n };
    const r = roundTrip({ packets: [{ name: 'entity_sound_effect', params }] });
    assert.ok(rowKind(r.rows, 'SOUND'));
    const rebuilt = one(r.out, 'entity_sound_effect');
    // the writer assigns its own entity ids, so the id is checked against the belief, not the reader's id
    assert.equal(rebuilt.params.entityId, r.writer.bySlot.get(1).id);
    sameParams(params, rebuilt.params, { ignore: ['seed', 'entityId'], tol: { pitch: 1 / 32 } });
    assert.equal(r.writer.stats.rejected.size, 0);
});

test('an inline sound definition is refused and counted', () => {
    const params = { sound: { data: { soundName: 'minecraft:entity.generic.explode', fixedRange: undefined } }, soundCategory: 'block', x: 8, y: 512, z: 8, volume: 1, pitch: 1, seed: 0n };
    const r = roundTrip({ packets: [{ name: 'sound_effect', params }] });
    assert.equal(r.out.filter((p) => p.name === 'sound_effect').length, 0);
    assert.ok([...r.writer.stats.rejected.keys()].some((k) => /inline/.test(k)), 'the inline reason is counted');
});

test('garbage tokens for sound rows are rejected without throwing', () => {
    const w = new Writer();
    const ctx = { playerId: 1, player: { x: 0, y: 64, z: 0 }, names: [], blobs: new Map() };
    const at = ['px', 'ob0', 'of0', 'py', 'ob0', 'of0', 'pz', 'ob0', 'of0'];
    const bad = [
        ['EVENT', 'SOUND'],
        ['EVENT', 'SOUND', 'snd5', 'cat:master'],
        ['EVENT', 'SOUND', 'snd5', 'cat:nope', ...at, 'vol:1', 'pi32'],
        ['EVENT', 'SOUND', 'snd5', 'cat:master', ...at, 'vol:abc', 'pi32'],
        ['EVENT', 'SOUND', 'snd5', 'cat:master', ...at, 'vol:1', 'pi32', 'extra'],
        ['EVENT', 'SOUND', 'zzz'],
    ];
    let out;
    assert.doesNotThrow(() => {
        out = w.step(bad.map((tokens) => ({ io: 'out', tokens })), ctx);
    });
    assert.deepEqual(out, []);
    assert.equal([...w.stats.rejected.values()].reduce((a, b) => a + b, 0), bad.length);
});

test('stop sound with source and sound round trips', () => {
    const params = { flags: 3, source: 1, sound: 'minecraft:music.game' };
    const r = roundTrip({ packets: [{ name: 'stop_sound', params }] });
    assert.ok(rowKind(r.rows, 'STOP_SOUND'));
    sameParams(params, one(r.out, 'stop_sound').params);
    assert.equal(r.writer.stats.rejected.size, 0);
});

test('stop sound with only a sound round trips', () => {
    const params = { flags: 2, sound: 'minecraft:entity.creeper.primed' };
    const r = roundTrip({ packets: [{ name: 'stop_sound', params }] });
    const rebuilt = one(r.out, 'stop_sound');
    sameParams(params, rebuilt.params);
    assert.equal(rebuilt.params.source, undefined);
    assert.equal(r.writer.stats.rejected.size, 0);
});

test('particle without data round trips', () => {
    const params = { longDistance: false, x: 3.25, y: 64.5, z: -2.0625, offsetX: 0.5, offsetY: 0.25, offsetZ: 0.125, velocityOffset: 0.125, amount: 12, particle: { type: 'end_rod' } };
    const r = roundTrip({ packets: [{ name: 'world_particles', params }] });
    assert.ok(rowKind(r.rows, 'PARTICLE'));
    sameParams(params, one(r.out, 'world_particles').params, { tol: { x: 1 / 16, y: 1 / 16, z: 1 / 16 } });
    assert.equal(r.writer.stats.rejected.size, 0);
});

test('particle with data round trips the type; the data is LOSSY and comes back as a default', () => {
    const params = { longDistance: false, x: 1, y: 64, z: 1, offsetX: 0.5, offsetY: 0.5, offsetZ: 0.5, velocityOffset: 0, amount: 4, particle: { type: 'dust', data: { red: 0.5, green: 0.5, blue: 0.5, scale: 2 } } };
    const r = roundTrip({ packets: [{ name: 'world_particles', params }] });
    const rebuilt = one(r.out, 'world_particles');
    assert.equal(rebuilt.params.particle.type, 'dust');
    sameParams(params, rebuilt.params, { ignore: ['particle.data'] });
    assert.equal(r.writer.stats.rejected.size, 0);
});

test('explosion round trips; sound, particles and player motion are LOSSY defaults', () => {
    const params = {
        x: 10.5, y: 64.25, z: -3, radius: 4, affectedBlockOffsets: [], playerMotionX: 0, playerMotionY: 0, playerMotionZ: 0,
        block_interaction_type: 1, small_explosion_particle: { type: 'explosion' }, large_explosion_particle: { type: 'explosion_emitter' }, sound: { soundId: 3 },
    };
    const r = roundTrip({ packets: [{ name: 'explosion', params }] });
    assert.ok(rowKind(r.rows, 'EXPLOSION'));
    sameParams(params, one(r.out, 'explosion').params, { ignore: ['sound', 'playerMotionX', 'playerMotionY', 'playerMotionZ', 'small_explosion_particle', 'large_explosion_particle'], tol: { x: 1 / 16, y: 1 / 16, z: 1 / 16 } });
    assert.equal(r.writer.stats.rejected.size, 0);
});

test('world event round trips with a long effect id and a global flag', () => {
    const params = { effectId: 2001, location: { x: 2, y: 65, z: -1 }, data: 33, global: true };
    const r = roundTrip({ packets: [{ name: 'world_event', params }] });
    assert.ok(rowKind(r.rows, 'WORLD_EVENT'));
    sameParams(params, one(r.out, 'world_event').params);
    assert.equal(r.writer.stats.rejected.size, 0);
});

test('world event beyond the row range is refused and counted', () => {
    const r = roundTrip({ packets: [{ name: 'world_event', params: { effectId: 1000, location: { x: 500, y: 64, z: 0 }, data: 0, global: false } }] });
    assert.equal(r.out.filter((p) => p.name === 'world_event').length, 0);
    assert.ok([...r.writer.stats.rejected.keys()].some((k) => /beyond/.test(k)));
});

test('block action round trips', () => {
    const params = { location: { x: 1, y: 63, z: 4 }, byte1: 1, byte2: 2, blockId: cat.blockId('note_block') };
    const r = roundTrip({ packets: [{ name: 'block_action', params }] });
    assert.ok(rowKind(r.rows, 'BLOCK_ACTION'));
    sameParams(params, one(r.out, 'block_action').params);
    assert.equal(r.writer.stats.rejected.size, 0);
});

test('block break stage round trips for an entity and for the player', () => {
    const r = roundTrip({
        packets: [
            { name: 'block_break_animation', params: { entityId: 7, location: { x: 2, y: 64, z: 0 }, destroyStage: 3 } },
            { name: 'block_break_animation', params: { entityId: 1, location: { x: 0, y: 64, z: 2 }, destroyStage: 5 } },
        ],
    });
    const outs = r.out.filter((p) => p.name === 'block_break_animation');
    assert.equal(outs.length, 2);
    // rows are sorted by slot, so the player (slot 0) comes first; the pig's id is the writer's, not the reader's 7
    const pig = outs.find((p) => p.params.entityId === r.writer.bySlot.get(1).id);
    const player = outs.find((p) => p.params.entityId === 1);
    assert.ok(pig && player, 'both diggers are named');
    sameParams({ location: { x: 2, y: 64, z: 0 }, destroyStage: 3 }, pig.params, { ignore: ['entityId'] });
    sameParams({ location: { x: 0, y: 64, z: 2 }, destroyStage: 5 }, player.params, { ignore: ['entityId'] });
    assert.equal(r.writer.stats.rejected.size, 0);
});

test('block break stage with an unknown digger sends entity 0', () => {
    const r = roundTrip({ packets: [{ name: 'block_break_animation', params: { entityId: 999, location: { x: 0, y: 64, z: 0 }, destroyStage: -1 } }] });
    const rebuilt = one(r.out, 'block_break_animation');
    assert.equal(rebuilt.params.entityId, 0);
    sameParams({ location: { x: 0, y: 64, z: 0 }, destroyStage: -1 }, rebuilt.params, { ignore: ['entityId'] });
});

test('tile entity data round trips its NBT through the blob store', () => {
    const params = { location: { x: 0, y: 70, z: 0 }, action: 1, nbtData: NBT };
    const r = roundTrip({ packets: [{ name: 'tile_entity_data', params }] });
    assert.ok(rowKind(r.rows, 'ENTITY_DATA'));
    sameParams(params, one(r.out, 'tile_entity_data').params);
    assert.equal(r.writer.stats.rejected.size, 0);
});

test('tile entity data with a missing blob is refused and counted', () => {
    const w = new Writer();
    const ctx = { playerId: 1, player: { x: 0, y: 64, z: 0 }, names: [], blobs: new Map() };
    const out = w.step([{ io: 'out', tokens: ['BLOCK', 'bx0', 'by6', 'bz0', 'ENTITY_DATA', 'bet1', 'blob:deadbeef'] }], ctx);
    assert.deepEqual(out, []);
    assert.equal(w.stats.rejected.get('ENTITY_DATA with no NBT blob'), 1);
});

test('the server moving the player becomes a relative position with a writer teleport id', () => {
    const params = { x: 0.5, y: -0.25, z: 1.75, yaw: 0, pitch: 0, flags: ALL_FLAGS, teleportId: 5 };
    const r = roundTrip({ packets: [{ name: 'position', params }] });
    assert.ok(rowKind(r.rows, 'SYNC'));
    const rebuilt = one(r.out, 'position');
    // SYNC deltas are quantized, about 1% of each value; teleport ids are the writer's own counter
    sameParams(params, rebuilt.params, { ignore: ['teleportId'], tol: { x: 0.02, y: 0.02, z: 0.02 } });
    assert.equal(rebuilt.params.teleportId, 1);
    assert.equal(r.writer.teleportId, 1);
    assert.equal(r.writer.stats.rejected.size, 0);
});
