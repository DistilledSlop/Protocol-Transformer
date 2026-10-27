'use strict';
// Containers, slots and trades.

const parse = {
    'SLOT SET': (c) => {
        const window = c.int('w');
        const index = c.int('i');
        const it = c.next();
        if (!it.startsWith('item:')) throw new Error(`expected item:<name>, got ${it}`);
        const count = c.int('n');
        const out = { window, index, item: it.slice(5), count, blob: null };
        if (!c.eof() && c.peek().startsWith('blob:')) out.blob = c.next().slice(5);
        return out;
    },
};

const compile = {
    'SLOT SET'(p, ctx, tick) {
        const item = this._item(p.item, p.count, p.blob, ctx);
        if (item === null) return this._reject('SLOT with an unknown item');
        const stateId = (this.windowState.get(p.window) ?? 0) + 1;
        this.windowState.set(p.window, stateId);
        tick.add('slot', { name: 'set_slot', params: { windowId: p.window, stateId, slot: p.index, item } });
    },
};

module.exports = { parse, compile, finish: [] };
