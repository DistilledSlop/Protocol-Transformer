'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBlockInfo, CATEGORY_NAMES } = require('../blockinfo');
const { minecraftData } = require('../deps');

const bi = createBlockInfo('1.21.1');
const md = bi.md;
const ids = Object.keys(md.blocksByStateId).map(Number);
const maxState = Math.max(...ids);
const EPS = 1e-9;

// First state of a block whose decoded props contain every key/value in want.
function stateWith(name, want = {}) {
    const b = md.blocksByName[name];
    assert.ok(b, `no block ${name}`);
    for (let s = b.minStateId; s <= b.maxStateId; s++) {
        const props = bi.parseState(s).props;
        if (Object.entries(want).every(([k, v]) => props[k] === v)) return s;
    }
    throw new Error(`no state of ${name} matches ${JSON.stringify(want)}`);
}

test('every state id gets a category in 0..15 without throwing', () => {
    assert.equal(CATEGORY_NAMES.length, 16);
    const hist = new Array(16).fill(0);
    for (let s = 0; s <= maxState; s++) {
        const c = bi.category(s);
        assert.ok(Number.isInteger(c) && c >= 0 && c <= 15, `state ${s} category ${c}`);
        hist[c]++;
    }
    console.log(`category histogram over ${maxState + 1} states:`);
    hist.forEach((n, i) => console.log(`  ${String(i).padStart(2)} ${CATEGORY_NAMES[i].padEnd(20)} ${n}`));
});

test('spot checks by block name', () => {
    const air = md.blocksByName.air.defaultState;
    assert.equal(bi.category(air), 0);
    assert.equal(bi.isAir(air), true);
    assert.equal(bi.isAir(md.blocksByName.cave_air.defaultState), true);
    assert.equal(bi.isAir(md.blocksByName.void_air.defaultState), true);

    const stone = md.blocksByName.stone.defaultState;
    assert.equal(bi.category(stone), 1);
    assert.equal(bi.isSolid(stone), true);
    assert.equal(bi.collisionTop(stone), 1);

    const slab = stateWith('oak_slab', { type: 'bottom', waterlogged: 'false' });
    assert.ok(Math.abs(bi.collisionTop(slab) - 0.5) < EPS);
    assert.equal(bi.category(slab), 2);
    assert.equal(bi.isSolid(slab), false);

    const water = md.blocksByName.water.defaultState;
    const lava = md.blocksByName.lava.defaultState;
    assert.equal(bi.isLiquid(water), true);
    assert.equal(bi.isLiquid(lava), true);
    assert.equal(bi.category(water), 3);
    assert.equal(bi.category(lava), 4);
    assert.equal(bi.isLiquid(stone), false);
    // flowing levels keep the same name
    assert.equal(bi.isLiquid(stateWith('water', { level: '7' })), true);
    assert.equal(bi.isLiquid(md.blocksByName.bubble_column.defaultState), true);

    assert.equal(bi.category(md.blocksByName.oak_leaves.defaultState), 5);
    assert.equal(bi.category(md.blocksByName.oak_log.defaultState), 6);

    const grass = md.blocksByName.short_grass.defaultState;
    assert.equal(bi.category(grass), 7);
    assert.deepEqual(bi.collisionBoxes(grass), []);

    assert.equal(bi.category(md.blocksByName.redstone_wire.defaultState), 8);
    assert.equal(bi.category(md.blocksByName.diamond_ore.defaultState), 9);
    assert.equal(bi.category(md.blocksByName.sand.defaultState), 10);
    assert.equal(bi.category(md.blocksByName.gravel.defaultState), 10);

    for (let s = md.blocksByName.oak_fence.minStateId; s <= md.blocksByName.oak_fence.maxStateId; s++) {
        assert.ok(Math.abs(bi.collisionTop(s) - 1.5) < EPS, `oak_fence state ${s}`);
    }
});

test('collisionBoxes returns 0..1 AABBs in [minX,minY,minZ,maxX,maxY,maxZ] form', () => {
    const boxes = bi.collisionBoxes(stateWith('oak_slab', { type: 'bottom', waterlogged: 'false' }));
    assert.equal(boxes.length, 1);
    assert.deepEqual(boxes[0], [0, 0, 0, 1, 0.5, 1]);
    // copies, so callers cannot corrupt the cache
    boxes[0][4] = 9;
    assert.equal(bi.collisionTop(stateWith('oak_slab', { type: 'bottom', waterlogged: 'false' })), 0.5);
});

test('isInvisibleChange only ignores distance and persistent on leaves', () => {
    const d1 = stateWith('oak_leaves', { distance: '1', persistent: 'false', waterlogged: 'false' });
    const d3 = stateWith('oak_leaves', { distance: '3', persistent: 'false', waterlogged: 'false' });
    assert.equal(bi.isInvisibleChange(d1, d3), true);

    const pTrue = stateWith('oak_leaves', { distance: '7', persistent: 'true', waterlogged: 'false' });
    const pFalse = stateWith('oak_leaves', { distance: '7', persistent: 'false', waterlogged: 'false' });
    assert.equal(bi.isInvisibleChange(pTrue, pFalse), true);

    const spruce = stateWith('spruce_leaves', { distance: '1', persistent: 'false', waterlogged: 'false' });
    assert.equal(bi.isInvisibleChange(d1, spruce), false);

    const wlOn = stateWith('oak_leaves', { distance: '1', persistent: 'false', waterlogged: 'true' });
    assert.equal(bi.isInvisibleChange(d1, wlOn), false);

    const stone = md.blocksByName.stone.defaultState;
    assert.equal(bi.isInvisibleChange(stone, stone), false);

    const w0 = stateWith('redstone_wire', { power: '0' });
    const w5 = stateWith('redstone_wire', { power: '5' });
    assert.equal(bi.isInvisibleChange(w0, w5), false);

    assert.equal(bi.isInvisibleChange(undefined, d1), false);
    assert.equal(bi.isInvisibleChange(d1, undefined), false);
    assert.equal(bi.isInvisibleChange(undefined, undefined), false);
});

test('isSolid and collisionTop across all states', () => {
    let solid = 0;
    for (let s = 0; s <= maxState; s++) {
        if (bi.isSolid(s)) solid++;
        // no state in 1.21.1 exceeds the 1.5 fence/wall height, so no exceptions are listed
        assert.ok(bi.collisionTop(s) <= 1.5 + EPS, `state ${s} ${bi.blockName(s)} top ${bi.collisionTop(s)}`);
    }
    console.log(`isSolid true for ${solid} states`);
    assert.ok(solid >= 800, `only ${solid} solid states`);
});

test('parseState and blockName', () => {
    assert.equal(bi.blockName(md.blocksByName.stone.defaultState), 'stone');
    assert.equal(bi.blockName(maxState + 1), 'unknown');
    assert.deepEqual(bi.parseState(maxState + 1), { name: 'unknown', props: {} });
    assert.deepEqual(bi.parseState(md.blocksByName.stone.defaultState), { name: 'stone', props: {} });
    const p = bi.parseState(stateWith('oak_leaves', { distance: '3', persistent: 'true', waterlogged: 'false' })).props;
    assert.deepEqual(p, { distance: '3', persistent: 'true', waterlogged: 'false' });
});
