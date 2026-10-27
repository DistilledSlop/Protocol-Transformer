'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { minecraftData } = require('../deps');
const { createBlockRot } = require('../blockrot');

const md = minecraftData('1.21.1');
const rot = createBlockRot('1.21.1');
// blocksByStateId is keyed by state id (ids are contiguous from 0).
const N = Object.keys(md.blocksByStateId).length;

// Property map of a state id, decoded here rather than through catalog.js.
function props(id) {
    const b = md.blocksByStateId[id];
    const sts = b.states;
    const idx = new Array(sts.length);
    let off = id - b.minStateId;
    for (let i = sts.length - 1; i >= 0; i--) {
        idx[i] = off % sts[i].num_values;
        off = Math.floor(off / sts[i].num_values);
    }
    const out = {};
    sts.forEach((st, i) => {
        out[st.name] = st.type === 'bool' ? String(idx[i] === 0) : st.values ? st.values[idx[i]] : String(idx[i]);
    });
    return out;
}

// First state of a block whose listed properties all match.
function findState(name, want) {
    const b = md.blocksByName[name];
    for (let id = b.minStateId; id <= b.maxStateId; id++) {
        const p = props(id);
        if (Object.keys(want).every((k) => p[k] === want[k])) return id;
    }
    throw new Error(`no state of ${name} matches ${JSON.stringify(want)}`);
}

// Properties after k quarter turns of the state matching `want`.
function rotated(name, want, k) {
    return props(rot.rotate(findState(name, want), k));
}

test('k=0 is the identity for every state', () => {
    for (let s = 0; s < N; s++) assert.equal(rot.rotate(s, 0), s);
});

test('group laws hold for every state', () => {
    for (let s = 0; s < N; s++) {
        const one = rot.rotate(s, 1);
        assert.equal(rot.rotate(one, 3), s, `state ${s}`);
        assert.equal(rot.rotate(s, 2), rot.rotate(one, 1), `state ${s}`);
        let t = s;
        for (let i = 0; i < 4; i++) t = rot.rotate(t, 1);
        assert.equal(t, s, `state ${s}`);
    }
});

test('k is taken mod 4', () => {
    const s = findState('oak_stairs', { facing: 'north', half: 'bottom', shape: 'straight', waterlogged: 'false' });
    assert.equal(rot.rotate(s, 5), rot.rotate(s, 1));
    assert.equal(rot.rotate(s, -1), rot.rotate(s, 3));
});

test('oak_stairs facing turns clockwise and nothing else changes', () => {
    const want = { facing: 'north', half: 'bottom', shape: 'straight', waterlogged: 'false' };
    const base = props(findState('oak_stairs', want));
    assert.deepEqual(rotated('oak_stairs', want, 1), { ...base, facing: 'east' });
    assert.deepEqual(rotated('oak_stairs', want, 2), { ...base, facing: 'south' });
    assert.deepEqual(rotated('oak_stairs', want, 3), { ...base, facing: 'west' });
});

test('oak_log axis x <-> z on odd turns, y unchanged', () => {
    assert.equal(rotated('oak_log', { axis: 'x' }, 1).axis, 'z');
    assert.equal(rotated('oak_log', { axis: 'x' }, 2).axis, 'x');
    assert.equal(rotated('oak_log', { axis: 'y' }, 1).axis, 'y');
});

test('oak_fence connection moves one step clockwise', () => {
    const want = { north: 'true', east: 'false', south: 'false', west: 'false', waterlogged: 'false' };
    assert.deepEqual(rotated('oak_fence', want, 1), {
        north: 'false', east: 'true', south: 'false', west: 'false', waterlogged: 'false',
    });
});

test('redstone_wire connections rotate and power is kept', () => {
    const want = { north: 'side', east: 'none', south: 'up', west: 'none', power: '3' };
    const r = rotated('redstone_wire', want, 1);
    assert.equal(r.east, 'side');
    assert.equal(r.south, 'none');
    assert.equal(r.west, 'up');
    assert.equal(r.north, 'none');
    assert.equal(r.power, '3');
});

test('standing sign rotation advances by 4 per turn mod 16', () => {
    assert.equal(rotated('oak_sign', { rotation: '0' }, 1).rotation, '4');
    assert.equal(rotated('oak_sign', { rotation: '14' }, 1).rotation, '2');
});

test('rail shape directions rotate and stay legal', () => {
    const legal = md.blocksByName.rail.states.find((st) => st.name === 'shape').values;
    assert.equal(rotated('rail', { shape: 'north_south' }, 1).shape, 'east_west');
    assert.equal(rotated('rail', { shape: 'ascending_north' }, 1).shape, 'ascending_east');
    const se = rotated('rail', { shape: 'south_east' }, 1).shape;
    assert.ok(['west_south', 'south_west'].includes(se), se);
    assert.ok(legal.includes(se), se);
});

test('powered_rail shape rotates and stays legal', () => {
    const legal = md.blocksByName.powered_rail.states.find((st) => st.name === 'shape').values;
    const r = rotated('powered_rail', { shape: 'north_south', powered: 'true' }, 1);
    assert.equal(r.shape, 'east_west');
    assert.equal(r.powered, 'true');
    // powered rail has no diagonal shapes, so only the ascending ones can be checked here
    assert.equal(rotated('powered_rail', { shape: 'ascending_south', powered: 'false' }, 1).shape, 'ascending_west');
    assert.ok(legal.includes(rotated('powered_rail', { shape: 'ascending_west', powered: 'false' }, 1).shape));
});

test('hopper and piston facing', () => {
    assert.equal(rotated('hopper', { facing: 'down', enabled: 'true' }, 1).facing, 'down');
    assert.equal(rotated('hopper', { facing: 'north', enabled: 'true' }, 1).facing, 'east');
    assert.equal(rotated('piston', { facing: 'up', extended: 'false' }, 1).facing, 'up');
});

test('oak_door hinge is unchanged by rotation', () => {
    const want = { facing: 'north', half: 'lower', hinge: 'left', open: 'false', powered: 'false' };
    const r = rotated('oak_door', want, 1);
    assert.equal(r.facing, 'east');
    assert.equal(r.hinge, 'left');
    assert.equal(r.half, 'lower');
});

test('stone, air and water are unchanged for every k', () => {
    for (const name of ['stone', 'air', 'water']) {
        const b = md.blocksByName[name];
        for (let s = b.minStateId; s <= b.maxStateId; s++) {
            for (let k = 0; k < 4; k++) assert.equal(rot.rotate(s, k), s, `${name} state ${s} k=${k}`);
        }
    }
    const water = md.blocksByName.water;
    assert.equal(rotated('water', { level: '3' }, 1).level, '3');
});

test('count of states that change under one quarter turn', () => {
    let changed = 0;
    for (let s = 0; s < N; s++) if (rot.rotate(s, 1) !== s) changed++;
    console.log(`states changed by k=1: ${changed} of ${N}`);
    assert.ok(changed > 0 && changed < N);
});
