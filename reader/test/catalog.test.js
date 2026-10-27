'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCatalog } = require('../catalog');

const cat = createCatalog();
const md = cat.md;

test('blockStateId inverts blockState for every block state id', () => {
    for (const key of Object.keys(md.blocksByStateId)) {
        const id = Number(key);
        const str = cat.blockState(id);
        assert.equal(cat.blockStateId(str), id, `state ${id} as "${str}"`);
    }
});

test('blockStateId parses names, property order, and partial property lists', () => {
    assert.equal(cat.blockStateId('stone'), md.blocksByName.stone.defaultState);
    assert.equal(cat.blockStateId('minecraft:stone'), md.blocksByName.stone.defaultState);

    const canonical = 'oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]';
    const id = cat.blockStateId(canonical);
    assert.equal(cat.blockState(id), canonical);
    // property order in the input does not matter
    assert.equal(cat.blockStateId('oak_stairs[waterlogged=false,facing=north,shape=straight,half=bottom]'), id);

    // unlisted properties take the default state's values
    assert.equal(cat.blockStateId('oak_stairs'), md.blocksByName.oak_stairs.defaultState);
    const east = cat.blockStateId('oak_stairs[facing=east]');
    assert.equal(cat.blockState(east), 'oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]');
});

test('blockStateId throws for unknown blocks, properties and values', () => {
    assert.throws(() => cat.blockStateId('not_a_block'), /unknown block/);
    assert.throws(() => cat.blockStateId('oak_stairs[facing=up]'), /unknown value "up"/);
    assert.throws(() => cat.blockStateId('oak_stairs[color=red]'), /unknown property "color"/);
});

test('itemId, entityTypeId and blockId agree with the name lookups for every id', () => {
    for (const item of md.itemsArray) {
        assert.equal(cat.itemId(item.name), item.id);
        assert.equal(cat.itemName(item.id), item.name);
    }
    for (const e of md.entitiesArray) {
        assert.equal(cat.entityTypeId(e.name), e.id);
        assert.equal(cat.entityName(e.id), e.name);
    }
    for (const b of md.blocksArray) {
        assert.equal(cat.blockId(b.name), b.id);
        assert.equal(cat.blockName(b.id), b.name);
    }
});

test('itemId rejects empty and unknown names', () => {
    assert.throws(() => cat.itemId('empty'), /unknown item: empty/);
    assert.throws(() => cat.itemId('not_an_item'), /unknown item/);
    assert.throws(() => cat.entityTypeId('not_an_entity'), /unknown entity type/);
    assert.throws(() => cat.blockId('not_a_block'), /unknown block/);
});
