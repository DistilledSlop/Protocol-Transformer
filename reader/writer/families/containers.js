'use strict';
// Containers and the events that open or touch them: close, trade offers, open screen / horse / book, and cooldowns.
// The window id is engine-owned: the server's id in a row is only a fallback, the Writer allocates its own.

const { Cursor } = require('../parse_rows');

// the rest of the row, as a new cursor's tokens; the tail parser must consume it, or parseRow rejects trailing tokens
function takeRest(c) {
    const rest = c.rest();
    c.i = c.t.length;
    return rest;
}

// one item group of a trade: item:<name>, n<count>, and blob:<id> when the item has components
function itemGroup(c) {
    const it = c.next();
    if (!it.startsWith('item:')) throw new Error(`expected item:<name>, got ${it}`);
    const count = c.int('n');
    const blob = !c.eof() && c.peek().startsWith('blob:') ? c.next().slice(5) : null;
    return { item: it.slice(5), count, blob };
}

// allocate a window id for a window the server opens; ids run 1..100 and are never 0 (the player's inventory)
function allocWindow(writer) {
    writer.nextWindowId = (writer.nextWindowId ?? 0) % 100 + 1;
    writer.openWindow = writer.nextWindowId;
    return writer.openWindow;
}

const parse = {
    'SLOT CLOSE': (c) => ({ window: c.int('w') }),

    // one row per trade; the group order is input1, input2 (item:empty n0 when absent), output
    'SLOT TRADE': (c) => {
        const window = c.int('w');
        const k = c.int('k');
        const input1 = itemGroup(c);
        const input2 = itemGroup(c);
        const output = itemGroup(c);
        const flag = c.next();
        if (flag !== 'enabled' && flag !== 'disabled') throw new Error(`expected enabled or disabled, got ${flag}`);
        const uses = c.int('u');
        const maxUses = c.int('um');
        return { window, k, input1, input2, output, disabled: flag === 'disabled', uses, maxUses };
    },

    'EVENT COOLDOWN': (c) => {
        const it = c.next();
        if (!it.startsWith('item:')) throw new Error(`expected item:<name>, got ${it}`);
        return { item: it.slice(5), ticks: c.int('t') };
    },

    // the title is a text component, read by the compile step with the other text families' helper
    'EVENT OPEN_SCREEN': (c) => ({ type: c.int('wt'), title: takeRest(c) }),

    'EVENT OPEN_HORSE': (c) => ({ slots: c.int('n') }),

    'EVENT OPEN_BOOK': (c) => {
        const hand = c.next();
        if (hand !== 'main' && hand !== 'off') throw new Error(`expected main or off, got ${hand}`);
        return { hand: hand === 'main' ? 0 : 1 };
    },
};

// trade inputs have no empty form on the wire: a missing first input is a bad row
function tradeInput(writer, g, ctx) {
    if (g.item === 'empty' || g.count === 0) throw new Error('trade input is empty');
    const s = writer._item(g.item, g.count, g.blob, ctx);
    if (s === null) throw new Error('trade input is an unknown item');
    // the trade input shape has no removed-components list
    return { itemId: s.itemId, itemCount: s.itemCount, addedComponentCount: s.addedComponentCount, components: s.components };
}

const compile = {
    'SLOT CLOSE'(p, ctx, tick) {
        // the client's window is the one the Writer opened; the server's id is only a fallback
        const windowId = this.openWindow ?? p.window;
        this.openWindow = null;
        tick.add('window', { name: 'close_window', params: { windowId } });
    },

    // trades are collected here and sent as one trade_list in finish
    'SLOT TRADE'(p, ctx, tick) {
        const input1 = tradeInput(this, p.input1, ctx);
        const input2 = p.input2.item === 'empty' ? undefined : tradeInput(this, p.input2, ctx);
        const output = this._item(p.output.item, p.output.count, p.output.blob, ctx);
        if (output === null) throw new Error('TRADE with an unknown output item');
        (tick.trades ??= []).push({ k: p.k, window: p.window, input1, input2, output, disabled: p.disabled, uses: p.uses, maxUses: p.maxUses });
    },

    'EVENT COOLDOWN'(p, ctx, tick) {
        tick.add('event', { name: 'set_cooldown', params: { itemID: this.cat.itemId(p.item), cooldownTicks: p.ticks } });
    },

    'EVENT OPEN_SCREEN'(p, ctx, tick) {
        const c = new Cursor(p.title);
        const windowTitle = this._readComponent(c, ctx);
        if (!c.eof()) throw new Error(`trailing title tokens: ${c.rest().join(' ')}`);
        const windowId = allocWindow(this);
        tick.add('window', { name: 'open_window', params: { windowId, inventoryType: p.type, windowTitle } });
    },

    // the row's slot is the horse; the packet names it by entity id
    'EVENT OPEN_HORSE'(p, ctx, tick) {
        const entityId = this._entityId(p.slot, ctx);
        if (entityId === null) return this._reject('OPEN_HORSE of an empty slot');
        const windowId = allocWindow(this);
        tick.add('window', { name: 'open_horse_window', params: { windowId, nbSlots: p.slots, entityId } });
    },

    'EVENT OPEN_BOOK'(p, ctx, tick) {
        tick.add('window', { name: 'open_book', params: { hand: p.hand } });
    },
};

// one trade_list per tick, its trades in index order
const finish = [
    function (tick) {
        const trades = tick.trades;
        if (!trades?.length) return;
        trades.sort((a, b) => a.k - b.k);
        const kept = trades.filter((t, i) => {
            if (i > 0 && trades[i - 1].k === t.k) {
                this._reject('TRADE with a repeated index');
                return false;
            }
            return true;
        });
        // the client's window: the one the Writer opened, else the server's id from the rows
        const windowId = this.openWindow ?? kept[0].window;
        tick.add('slot', {
            name: 'trade_list',
            params: {
                windowId,
                trades: kept.map((t) => ({
                    inputItem1: t.input1,
                    outputItem: t.output,
                    inputItem2: t.input2,
                    tradeDisabled: t.disabled,
                    nbTradeUses: t.uses,
                    maximumNbTradeUses: t.maxUses,
                    // LOSSY: the tokens do not carry these; a regular villager with no special price and no demand
                    xp: 0,
                    specialPrice: 0,
                    priceMultiplier: 0,
                    demand: 0,
                })),
                // LOSSY: the tokens do not carry the villager's level, experience or flags
                villagerLevel: 1,
                experience: 0,
                isRegularVillager: true,
                canRestock: true,
            },
        });
    },
];

module.exports = { parse, compile, finish };
