'use strict';
// Entity collision in writer/collide.js: a move is clipped by the solid blocks in its way, using a flat synthetic
// world (no capture). The Writer test checks that a clipped MOVE row becomes a shorter packet and is counted.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const collide = require('../writer/collide');
const { WorldStore } = require('../world');
const { createBlockInfo } = require('../blockinfo');
const { createCatalog } = require('../catalog');
const { Writer } = require('../writer/writer');
const Q = require('../quant');

const cat = createCatalog();
const md = cat.md;
const info = createBlockInfo();
const DIMS = { w: 0.6, h: 1.8 };
const STONE = md.blocksByName.stone.defaultState;
const SLAB = md.blocksByName.oak_slab.defaultState;
const FENCE = md.blocksByName.oak_fence.defaultState;
const GRASS = md.blocksByName.short_grass.defaultState;

// Flat world: one chunk (0,0) of 24 sections from y=-64, all air, stone floor at y=63 over x,z 0..15.
function flatWorld() {
    const w = new WorldStore();
    w.chunks.set('0,0', { minY: -64, sections: Array.from({ length: 24 }, () => ({ single: 0 })) });
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) w.set(x, 63, z, STONE);
    return w;
}

// the stone wall column at x=10, y=64..65, z=8 used by most tests
function wallWorld() {
    const w = flatWorld();
    w.set(10, 64, 8, STONE);
    w.set(10, 65, 8, STONE);
    return w;
}

const near = (got, want, tol = 1e-6) => assert.ok(Math.abs(got - want) <= tol, `${got} is not ${want} (tolerance ${tol})`);

test('a free move in open air is returned unchanged', () => {
    const w = flatWorld();
    const d = [0.2, 0, 0.1];
    assert.deepEqual(collide.resolve(w, info, DIMS, [8.5, 64, 8.5], d), [0.2, 0, 0.1]);
});

test('falling onto the floor stops at the surface', () => {
    const w = flatWorld();
    const fromAbove = collide.resolve(w, info, DIMS, [8.5, 65, 8.5], [0, -1, 0]);
    near(fromAbove[1], -1); // lands exactly at y=64
    const partway = collide.resolve(w, info, DIMS, [8.5, 64.5, 8.5], [0, -1, 0]);
    near(partway[1], -0.5);
});

test('walking into a wall stops the front face at the wall', () => {
    const w = wallWorld();
    // feet at x=9.4: half-width 0.3, so the front face is at 9.7 and reaches the wall at x=10 after 0.3
    const d = collide.resolve(w, info, DIMS, [9.4, 64, 8.5], [1, 0, 0]);
    near(d[0], 0.3);
    assert.equal(d[1], 0);
    assert.equal(d[2], 0);
});

test('moving along the wall keeps the sideways part free', () => {
    const w = wallWorld();
    const d = collide.resolve(w, info, DIMS, [9.4, 64, 8.5], [1, 0, 1]);
    near(d[0], 0.3);
    assert.equal(d[2], 1);
});

test('sliding: the blocked axis is clipped and the other axis is kept', () => {
    const w = wallWorld();
    const d = collide.resolve(w, info, DIMS, [9.4, 64, 8.5], [1, 0, 0.5]);
    near(d[0], 0.3);
    near(d[2], 0.5);
});

test('an oak slab stops a side move at its height, and the entity walks over it after rising by collisionTop', () => {
    const w = flatWorld();
    w.set(10, 64, 8, SLAB); // default state is bottom-half: collisionTop 0.5
    const top = info.collisionTop(SLAB);
    near(top, 0.5, 0); // the slab is half a block tall

    const blocked = collide.resolve(w, info, DIMS, [9.4, 64, 8.5], [1, 0, 0]);
    near(blocked[0], 0.3);

    // rise onto the slab's top: nothing is in the way at y=64+top
    const up = collide.resolve(w, info, DIMS, [9.4, 64, 8.5], [0, top, 0]);
    near(up[1], top);
    const forward = collide.resolve(w, info, DIMS, [9.4, 64 + top, 8.5], [1, 0, 0]);
    assert.deepEqual(forward, [1, 0, 0]);
});

test('an entity that starts inside a solid block is not stopped by it', () => {
    const w = flatWorld();
    w.set(8, 64, 8, STONE);
    const d = collide.resolve(w, info, DIMS, [8.5, 64, 8.5], [0.3, 0, 0]);
    assert.deepEqual(d, [0.3, 0, 0]);
});

test('a move through unloaded chunks is unchanged', () => {
    const w = flatWorld();
    // x=40 is in chunk 2,0, which is not loaded
    assert.equal(w.get(40, 64, 8), undefined);
    assert.deepEqual(collide.resolve(w, info, DIMS, [40.5, 64, 8.5], [0.5, 0, 0]), [0.5, 0, 0]);
    assert.deepEqual(collide.resolve(w, info, DIMS, [40.5, 64, 8.5], [-1, 0, 0]), [-1, 0, 0]);
    // a walk from the loaded chunk into the unloaded one at x=16 is not stopped by what it cannot see
    assert.deepEqual(collide.resolve(w, info, DIMS, [15.5, 64, 8.5], [1, 0, 0]), [1, 0, 0]);
});

test('a block with no collision (short grass) does not stop a move', () => {
    const w = flatWorld();
    w.set(10, 64, 8, GRASS);
    assert.deepEqual(info.collisionBoxes(GRASS), []);
    assert.deepEqual(collide.resolve(w, info, DIMS, [9.4, 64, 8.5], [1, 0, 0]), [1, 0, 0]);
});

test('a move longer than 4 blocks is a teleport and is returned unchanged', () => {
    const w = wallWorld();
    assert.deepEqual(collide.resolve(w, info, DIMS, [9.4, 64, 8.5], [5, 0, 0]), [5, 0, 0]);
    assert.deepEqual(collide.resolve(w, info, DIMS, [9.4, 64, 8.5], [-5, 0, 0]), [-5, 0, 0]);
});

test('a fence (collision top 1.5) stops a side move at its post', () => {
    const w = flatWorld();
    w.set(10, 64, 8, FENCE);
    // the post's box starts at x=10.375, so the front face at 9.7 can move 0.675
    const d = collide.resolve(w, info, DIMS, [9.4, 64, 8.5], [1, 0, 0]);
    near(d[0], 0.675);
});

// ---- through the Writer ---------------------------------------------------------------------------------------

test('Writer: a MOVE into a wall is shortened in the packet and counted as clamped', () => {
    const w = wallWorld();
    const writer = new Writer();
    const ctx = { playerId: 1, player: { x: 0, y: 64, z: 0 }, world: w, info };

    // zombie at (9.375, 64, 8.5): x lattice 9 blocks + 6 sixteenths, y and z at the player's feet
    const spawn = ['ENTITY', 's1', 'SPAWN', 'type:zombie', 'px', 'ob9', 'of6', 'py', 'ob0', 'of0', 'pz', 'ob8', 'of8', 'yaw0', 'pitch0', 'hy0'];
    writer.step([{ io: 'out', tokens: spawn }], ctx);

    // a move of about one block in +x, quantized the way the reader quantizes it
    const want = Q.dequantize(Q.quantize(4096));
    const move = ['ENTITY', 's1', 'MOVE', 'dx', ...Q.toTokens(Q.quantize(4096)), 'dy', '0', 'dz', '0', 'yaw0', 'pitch0', 'hy0'];
    const out = writer.step([{ io: 'out', tokens: move }], ctx);

    const pk = out.find((p) => p.name === 'rel_entity_move');
    assert.ok(pk, `a relative move packet, got [${out.map((p) => p.name).join(', ')}]`);
    // zombie x = 9.375, front face 9.675, wall at 10: 0.325 blocks = 1331 units (within rounding)
    const expected = Math.round((10 - 0.3 - 9.375) * 4096);
    assert.ok(Math.abs(pk.params.dX - expected) <= 2, `dX ${pk.params.dX} is near ${expected} (requested ${want})`);
    assert.ok(pk.params.dX < want, 'the move was shortened');
    assert.equal(pk.params.dY, 0);
    assert.equal(pk.params.dZ, 0);
    assert.equal(writer.stats.clamped, 1);
});
