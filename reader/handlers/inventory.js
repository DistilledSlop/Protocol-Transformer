'use strict';
// Containers, trades and the player's inventory inputs. Vanilla click rules are the engine's; the rows
// here say what the player did and what the server decided about server-specific windows.

const { intTokens } = require('../tokens');

const win = (w) => intTokens('w', w < 0 ? 0 : w); // window -1 (cursor) and -2 are named by slot, see _slotIndex
const idx = (i) => (i < 0 ? [i === -999 ? 'iOUT' : `iNEG${-i}`] : intTokens('i', i));

module.exports = {
    _slotRow(io, kind, tokens, extra = {}) {
        return { row: 'SLOT', io, kind, tokens: ['SLOT', kind, ...tokens], ...extra };
    },

    s2c_close_window(d) {
        if (this.S.openWindow === d.windowId) this.S.openWindow = null;
        this._later(() => this._slotRow('out', 'CLOSE', win(d.windowId)));
    },

    // Open Screen: the engine owns the window id; the model decides the window type and the title.
    s2c_open_window(d) {
        this.S.openWindow = d.windowId;
        this._later(() => this._evRow('out', 'OPEN_SCREEN', null, [`wt${d.inventoryType}`, ...this._compTokens(d.windowTitle)]));
    },

    s2c_open_horse_window(d) {
        this.S.openWindow = d.windowId;
        this._later((ctx) => this._evRow('out', 'OPEN_HORSE', ctx.slotOf(d.entityId), intTokens('n', d.nbSlots)));
    },

    s2c_open_book(d) {
        this._later(() => this._evRow('out', 'OPEN_BOOK', null, [d.hand === 0 ? 'main' : 'off']));
    },

    s2c_set_cooldown(d) {
        this._later(() => this._evRow('out', 'COOLDOWN', null, [`item:${this.cat.itemName(d.itemID)}`, ...intTokens('t', d.cooldownTicks)]));
    },

    // Merchant Offers: one row per trade; the items carry components behind blob ids.
    s2c_trade_list(d) {
        d.trades.forEach((t, k) => {
            this._later(() =>
                this._slotRow('out', 'TRADE', [
                    ...win(d.windowId), ...intTokens('k', k),
                    ...this._itemTokens(t.inputItem1), ...(t.inputItem2 ? this._itemTokens(t.inputItem2) : ['item:empty', 'n0']), ...this._itemTokens(t.outputItem),
                    t.tradeDisabled ? 'disabled' : 'enabled', ...intTokens('u', t.nbTradeUses), ...intTokens('um', t.maximumNbTradeUses),
                ])
            );
        });
    },

    // ---- serverbound ------------------------------------------------------------------------------------
    c2s_window_click(d) {
        this._later(() => this._slotRow('in', 'CLICK', [...win(d.windowId), ...idx(d.slot), `btn${d.mouseButton & 0xff}`, `mode${d.mode}`, ...intTokens('c', d.changedSlots.length)]));
    },

    c2s_enchant_item(d) {
        this.T.events.push({ io: 'in', kind: 'BUTTON', entityId: this.S.playerId, tokens: [...win(d.windowId), ...intTokens('btn', d.enchantment)] });
    },

    c2s_close_window(d) {
        this.T.events.push({ io: 'in', kind: 'CLOSE_WINDOW', entityId: this.S.playerId, tokens: win(d.windowId) });
    },

    c2s_set_slot_state(d) {
        this.T.events.push({ io: 'in', kind: 'SLOT_STATE', entityId: this.S.playerId, tokens: [...intTokens('w', d.window_id), ...intTokens('i', d.slot_id), d.state ? 'on' : 'off'] });
    },

    c2s_edit_book(d) {
        this.T.events.push({ io: 'in', kind: 'EDIT_BOOK', entityId: this.S.playerId, tokens: [d.hand === 0 ? 'main' : 'off', ...intTokens('n', d.pages.length), d.title ? 'signed' : 'unsigned', ...d.pages.slice(0, 4).map((p) => this._span(p))] });
    },

    c2s_pick_item(d) {
        this._later(() => this._slotRow('in', 'PICK', intTokens('i', d.slot)));
    },

    c2s_craft_recipe_request(d) {
        this._later(() => this._slotRow('in', 'RECIPE', [...win(d.windowId), `rcp:${d.recipe}`, d.makeAll ? 'all' : 'one']));
    },

    // Anvil rename: open text the model only repeats, so an opaque span.
    c2s_name_item(d) {
        this.T.events.push({ io: 'in', kind: 'RENAME', entityId: this.S.playerId, tokens: [this._span(d.name)] });
    },

    c2s_select_trade(d) {
        this._later(() => this._slotRow('in', 'TRADE_SELECT', intTokens('k', d.slot)));
    },

    c2s_set_beacon_effect(d) {
        this.T.events.push({ io: 'in', kind: 'BEACON', entityId: this.S.playerId, tokens: [d.primary_effect === undefined ? 'none' : `eff${d.primary_effect}`, d.secondary_effect === undefined ? 'none' : `eff${d.secondary_effect}`] });
    },

    c2s_held_item_slot(d) {
        this.S.selectedSlot = d.slotId;
        this._later(() => this._slotRow('in', 'HELD', intTokens('i', d.slotId)));
    },

    // Creative inventory edit: the client's own change, so S takes it silently (the server sends no echo).
    c2s_set_creative_slot(d) {
        if (d.slot >= 0) {
            let w = this.S.windows.get(0);
            if (!w) this.S.windows.set(0, (w = []));
            w[d.slot] = this._slotValue(d.item);
        }
        this._later(() => this._slotRow('in', 'CREATIVE', [...idx(d.slot), ...this._itemTokens(d.item)]));
    },
};
