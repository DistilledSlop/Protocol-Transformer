'use strict';
// Writer side of containers.js: close, trade offers, open screen / horse / book, cooldowns. Each kind's original
// packet goes through the Reader and back out through the Writer. The window id is engine-owned, so it is
// checked on its own and ignored in the comparison; entity ids are the Writer's, read from its bySlot table.

const test = require('node:test');
const assert = require('node:assert/strict');
const { roundTrip, sameParams, cat, PIG } = require('./helper');
const { Writer } = require('../../writer/writer');
const { synthesize } = require('../synth');

const protocol = require('../../../proxy/node_modules/minecraft-data')('1.21.1').protocol;

// LOSSY: the reader's tokens do not carry these trade_list fields, so the Writer fills defaults
const LOSSY_TRADE = ['villagerLevel', 'experience', 'isRegularVillager', 'canRestock', 'xp', 'specialPrice', 'priceMultiplier', 'demand'];

// a text component as the server sends it (anonymous NBT)
const title = (text) => ({ type: 'compound', name: '', value: { text: { type: 'string', value: text } } });

const slot = (name, count) => ({ itemCount: count, itemId: cat.itemId(name), addedComponentCount: 0, removedComponentCount: 0, components: [], removeComponents: [] });
const input = (name, count) => ({ itemId: cat.itemId(name), itemCount: count, addedComponentCount: 0, components: [] });

const openScreen = (windowId) => ({ name: 'open_window', params: { windowId, inventoryType: 2, windowTitle: title('Villager') } });

// the open window the tests close, trade into, or horse-open; the Writer gives it its own id
const OPEN_ID = 1;

test('SLOT CLOSE -> close_window with the writer\'s own window id', () => {
    const r = roundTrip({
        before: [openScreen(5)],
        packets: [{ name: 'close_window', params: { windowId: 5 } }],
    });
    assert.ok(r.rows.some((x) => x.tokens[0] === 'SLOT' && x.tokens[1] === 'CLOSE'), 'reader made a CLOSE row');
    const out = r.out.filter((p) => p.name === 'close_window');
    assert.equal(out.length, 1);
    assert.equal(out[0].params.windowId, OPEN_ID, 'the Writer closes its own window, not the server id');
    sameParams(out[0].params, { windowId: OPEN_ID });
    assert.equal(r.writer.openWindow, null, 'the window is no longer open');
    assert.equal(r.writer.stats.rejected.size, 0);
});

test('SLOT CLOSE with no open window falls back to the token id', () => {
    const r = roundTrip({ packets: [{ name: 'close_window', params: { windowId: 9 } }] });
    const out = r.out.filter((p) => p.name === 'close_window');
    assert.equal(out.length, 1);
    assert.equal(out[0].params.windowId, 9);
});

test('SLOT TRADE: two trade rows in one tick become one trade_list, trades in index order', () => {
    const trades = [
        {
            inputItem1: input('diamond', 2),
            outputItem: slot('emerald', 1),
            inputItem2: undefined,
            tradeDisabled: false,
            nbTradeUses: 0,
            maximumNbTradeUses: 12,
            xp: 2,
            specialPrice: 0,
            priceMultiplier: 0.05,
            demand: 0,
        },
        {
            inputItem1: input('emerald', 3),
            outputItem: slot('diamond', 1),
            inputItem2: input('gold_ingot', 1),
            tradeDisabled: true,
            nbTradeUses: 4,
            maximumNbTradeUses: 8,
            xp: 5,
            specialPrice: -2,
            priceMultiplier: 0.2,
            demand: 1,
        },
    ];
    const r = roundTrip({
        before: [openScreen(4)],
        packets: [{ name: 'trade_list', params: { windowId: 4, trades, villagerLevel: 3, experience: 10, isRegularVillager: true, canRestock: true } }],
    });
    const rows = r.rows.filter((x) => x.tokens[0] === 'SLOT' && x.tokens[1] === 'TRADE');
    assert.equal(rows.length, 2, 'the reader made one TRADE row per trade');
    const out = r.out.filter((p) => p.name === 'trade_list');
    assert.equal(out.length, 1, 'the two rows became one packet');
    const got = out[0].params;
    assert.equal(got.windowId, OPEN_ID);
    assert.equal(got.trades.length, 2);
    sameParams(got.trades, trades, { ignore: LOSSY_TRADE });
    // the second trade keeps its disabled flag and its optional second input
    assert.equal(got.trades[1].tradeDisabled, true);
    assert.equal(got.trades[1].inputItem2.itemId, cat.itemId('gold_ingot'));
    assert.equal(r.writer.stats.rejected.size, 0);
});

test('SLOT TRADE: garbage tokens are rejected without throwing', () => {
    const w = new Writer();
    const ctx = { playerId: 1, player: { x: 0, y: 64, z: 0 }, names: [], blobs: new Map() };
    const garbage = [
        ['SLOT', 'TRADE', 'garbage'],
        ['SLOT', 'TRADE', 'w0', 'k0', 'item:diamond', 'n1', 'item:empty', 'n0', 'item:emerald', 'n1', 'maybe', 'u0', 'um12'],
        ['SLOT', 'TRADE', 'w0', 'k0', 'item:empty', 'n0', 'item:empty', 'n0', 'item:emerald', 'n1', 'enabled', 'u0', 'um12'],
        ['SLOT', 'TRADE', 'w0', 'k0', 'item:not_a_real_item', 'n1', 'item:empty', 'n0', 'item:emerald', 'n1', 'enabled', 'u0', 'um12'],
    ];
    let packets;
    assert.doesNotThrow(() => {
        packets = w.step(garbage.map((tokens) => ({ io: 'out', tokens })), ctx);
    });
    assert.equal(packets.filter((p) => p.name === 'trade_list').length, 0);
    assert.ok(w.stats.rejected.size > 0, 'the bad rows are counted as rejected');
});

test('EVENT OPEN_SCREEN -> open_window with the writer\'s own window id', () => {
    const r = roundTrip({ packets: [openScreen(5)] });
    assert.ok(r.rows.some((x) => x.tokens[0] === 'EVENT' && x.tokens[1] === 'OPEN_SCREEN'), 'reader made an OPEN_SCREEN row');
    const out = r.out.filter((p) => p.name === 'open_window');
    assert.equal(out.length, 1);
    assert.equal(out[0].params.windowId, OPEN_ID, 'the Writer allocates the window id');
    sameParams(out[0].params, openScreen(OPEN_ID).params, { ignore: ['windowId'] });
    assert.equal(r.writer.openWindow, OPEN_ID);
    assert.equal(r.writer.stats.rejected.size, 0);
});

test('EVENT OPEN_HORSE -> open_horse_window with the horse by entity id', () => {
    const horse = { name: 'open_horse_window', params: { windowId: 6, nbSlots: 3, entityId: 7 } };
    const r = roundTrip({ packets: [horse] });
    assert.ok(r.rows.some((x) => x.tokens[0] === 'EVENT' && x.tokens[1] === 's1' && x.tokens[2] === 'OPEN_HORSE'), 'reader made an OPEN_HORSE row on slot 1');
    const out = r.out.filter((p) => p.name === 'open_horse_window');
    assert.equal(out.length, 1);
    const horseId = r.writer.bySlot.get(1).id;
    assert.equal(out[0].params.entityId, horseId, 'the entity id comes from the Writer\'s table');
    assert.equal(out[0].params.windowId, OPEN_ID);
    sameParams(out[0].params, { ...horse.params, entityId: horseId }, { ignore: ['windowId'] });
    assert.equal(r.writer.stats.rejected.size, 0);
});

test('EVENT OPEN_BOOK -> open_book, main and off hand', () => {
    for (const hand of [0, 1]) {
        const r = roundTrip({ packets: [{ name: 'open_book', params: { hand } }] });
        assert.ok(r.rows.some((x) => x.tokens[1] === 'OPEN_BOOK'), 'reader made an OPEN_BOOK row');
        const out = r.out.filter((p) => p.name === 'open_book');
        assert.equal(out.length, 1);
        sameParams(out[0].params, { hand });
        assert.equal(r.writer.stats.rejected.size, 0);
    }
});

test('EVENT COOLDOWN -> set_cooldown', () => {
    const cd = { name: 'set_cooldown', params: { itemID: cat.itemId('diamond'), cooldownTicks: 40 } };
    const r = roundTrip({ packets: [cd] });
    assert.ok(r.rows.some((x) => x.tokens[1] === 'COOLDOWN'), 'reader made a COOLDOWN row');
    const out = r.out.filter((p) => p.name === 'set_cooldown');
    assert.equal(out.length, 1);
    sameParams(out[0].params, cd.params);
    assert.equal(r.writer.stats.rejected.size, 0);
});

test('a set_slot whose item has components round trips through the blob store', () => {
    // the rich Slot from the synthesizer has no components, so the list is filled in by hand in the shape it gives
    const rich = synthesize(protocol, 'play', 'toClient', 'set_slot', 'rich');
    const item = {
        ...rich.item,
        itemCount: 1,
        itemId: cat.itemId('diamond'),
        addedComponentCount: 1,
        removedComponentCount: 1,
        components: [{ type: 'max_stack_size', data: 16 }],
        removeComponents: [{ type: 'damage' }],
    };
    const orig = { name: 'set_slot', params: { windowId: 0, stateId: 1, slot: 36, item } };
    const r = roundTrip({ packets: [orig] });
    const out = r.out.filter((p) => p.name === 'set_slot');
    assert.equal(out.length, 1);
    // the components and the removed list are what the blob stored; if this fails, the blob lost something
    sameParams(out[0].params.item, item);
    assert.equal(r.writer.stats.rejected.size, 0);
});
