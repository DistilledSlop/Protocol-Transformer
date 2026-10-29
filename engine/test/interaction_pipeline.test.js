'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Reader } = require('../../reader/reader');
const { Writer } = require('../../reader/writer/writer');
const { createCodec } = require('../../reader/parse');
const { pkt, NO_FLAGS } = require('../../reader/test/helpers');
const { writerOwns } = require('../ownership');
const { inventorySnapshot, playerContextSnapshot } = require('../inventory_snapshot');

test('scripted dig and place compile to owned updates and update reader world', () => {
    const reader = new Reader({ phase: 0, deferNear: false });
    const ticks = [];
    const feed = (t, dir, name, params) => ticks.push(...reader.feedPacket(pkt(t, dir, name, params)));
    feed(0, 'S2C', 'login', { entityId: 1, viewDistance: 10 });
    reader.S.world.chunks.set('0,0', { minY: -64, sections: Array.from({ length: 24 }, () => ({ single: 0 })) });
    const stone = reader.cat.blockStateId('stone');
    reader.S.world.set(9, 64, 8, stone);
    feed(50, 'S2C', 'position', { x: 8.5, y: 64, z: 8.5, yaw: 0, pitch: 0, flags: NO_FLAGS, teleportId: 1 });
    const codec = createCodec(), writer = new Writer();
    const families = new Set(['scene', 'clock', 'blocks', 'slots', 'text', 'events']);
    const apply = (time, state) => {
        const packets = writer.step([{ io: 'out', tokens: ['BLOCK', 'bx1', 'by0', 'bz0', `blk:${state}`] }], { playerId: 1, player: { x: 8.5, y: 64, z: 8.5 } });
        assert.equal(packets.length, 1);
        const p = packets[0];
        assert.ok(writerOwns(p.name, p.params, families, 1));
        const decoded = codec.parse('S2C', codec.encode('S2C', p.name, p.params));
        feed(time, 'S2C', decoded.name, decoded.params);
    };
    feed(105, 'C2S', 'block_dig', { status: 0, location: { x: 9, y: 64, z: 8 }, face: 1, sequence: 1 });
    apply(110, 'air');
    assert.equal(reader.S.world.get(9, 64, 8), reader.cat.blockStateId('air'));
    feed(155, 'C2S', 'block_dig', { status: 2, location: { x: 9, y: 64, z: 8 }, face: 1, sequence: 2 });
    feed(205, 'C2S', 'block_place', { hand: 0, location: { x: 9, y: 64, z: 8 }, direction: 1, cursorX: 0.5, cursorY: 0.5, cursorZ: 0.5, insideBlock: false, sequence: 3 });
    apply(210, 'stone');
    assert.equal(reader.S.world.get(9, 64, 8), stone);
    ticks.push(...reader.advanceTo(250));
    const inputs = ticks.flatMap(t => t.rows).filter(r => r.io === 'in');
    assert.ok(inputs.some(r => r.kind === 'DIG' && r.tokens.includes('dig0')));
    assert.ok(inputs.some(r => r.kind === 'DIG' && r.tokens.includes('dig2')));
    assert.ok(inputs.some(r => r.kind === 'PLACE' && r.tokens.includes('main')));
});

test('inventory snapshot uses actual nonempty slots and training SLOT SET format', () => {
    const reader = new Reader();
    reader.S.windows.set(0, [undefined, { item: 'stone', count: 3, blob: null }, { item: 'empty', count: 0 }]);
    assert.deepEqual(inventorySnapshot(reader), [['SLOT', 'SET', 'w0', 'i1', 'item:stone', 'n3']]);
});


test('initial player context matches reader engine rows for actual state', () => {
    const reader = new Reader();
    reader.S.globals.gamemode = 0;
    reader.S.opLevel = 4;
    reader.S.abilities = { flags: 0, flyingSpeed: 0.05, walkingSpeed: 0.1 };
    assert.deepEqual(playerContextSnapshot(reader), [
        ['GLOBAL', 'g:gamemode', 'v0'],
        ['GLOBAL', 'g:op_level', 'v4'],
        ['GLOBAL', 'g:abilities', 'v0', `fly:${Math.fround(0.05)}`, `walk:${Math.fround(0.1)}`],
    ]);
});
