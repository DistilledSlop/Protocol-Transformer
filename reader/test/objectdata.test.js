'use strict';
// Spawn Entity's Data field: orientation, block state and owner, by entity type.

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeReader, run, startPackets, spawnPkt, rowsAt } = require('./helpers');
const { createCatalog } = require('../catalog');

const cat = createCatalog();
const typeId = (name) => cat.md.entitiesByName[name].id;

// spawn one entity near the player and return the tokens of its SPAWN row
function spawnTokens(name, objectData, before = []) {
    const r = makeReader();
    const ticks = run(r, [...startPackets(), ...before, spawnPkt(100, 50, 3, 64, 0, { type: typeId(name), objectData })]);
    const row = ticks.flatMap((t) => t.rows).find((x) => x.kind === 'SPAWN' && x.entityId === 50);
    assert.ok(row, `${name} gets a SPAWN row`);
    return row.tokens;
}

test('item frames and paintings carry an orientation, clamped like the client does', () => {
    assert.ok(spawnTokens('item_frame', 3).includes('ori3'));
    assert.ok(spawnTokens('glow_item_frame', 7).includes('ori1'), '7 clamps to 1 through the modulus');
    assert.ok(spawnTokens('painting', -4).includes('ori4'), 'a negative value uses the absolute value');
});

test('a falling block carries its block state by name', () => {
    assert.ok(spawnTokens('falling_block', 1).includes('blk:stone'));
});

test('a projectile owned by the player names slot 0', () => {
    assert.ok(spawnTokens('arrow', 1).includes('own0'), 'the login entity id is 1 in these scenarios');
});

test('a projectile owned by an entity in the scene names that entity\'s slot', () => {
    const t = spawnTokens('arrow', 40, [spawnPkt(60, 40, 5, 64, 0)]);
    assert.ok(t.includes('own1'));
});

test('no owner and an owner outside the scene are told apart', () => {
    assert.ok(spawnTokens('arrow', 0).includes('ownNONE'));
    assert.ok(spawnTokens('arrow', 999).includes('ownUNKNOWN'));
});

test('a warden spawning in the emerging pose is marked, other values are ignored', () => {
    assert.ok(spawnTokens('warden', 1).includes('emerging'));
    assert.ok(!spawnTokens('warden', 0).includes('emerging'));
    assert.ok(!spawnTokens('warden', 5).includes('emerging'));
});

test('entities whose Data means nothing carry no data token', () => {
    const t = spawnTokens('zombie', 0);
    assert.ok(!t.some((x) => /^(ori|own|blk:|emerging)/.test(x)));
});
