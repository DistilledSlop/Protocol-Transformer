'use strict';
// Entity rows beyond spawn and motion: metadata, equipment, riding and leashing, and the effect and pickup
// events. The tokens are built in handlers/entity.js (_metaTokens, s2c_*) and reader.js (_entityStateRows).

const { Cursor } = require('../parse_rows');

const i8 = (v) => (v << 24) >> 24; // byte values are signed on the wire; the tokens carry 0-255

// Flag bits: 'bit<n>' for each set bit, or 'bits0' for none. A row with neither is not a flag set.
function flagBits(c, width) {
    if (c.peek() === 'bits0') {
        c.next();
        return 0;
    }
    let v = 0;
    let n = 0;
    while (/^bit\d$/.test(c.peek() ?? '')) {
        const b = Number(c.next().slice(3));
        if (b >= width) throw new Error(`flag bit ${b} is out of range`);
        v |= 1 << b;
        n++;
    }
    if (!n) throw new Error('expected flag bits');
    return v;
}

// 'Δ<n>': a step against the client's last value (the reader sends one only when it had a last value)
function delta(c) {
    const m = /^Δ(-?\d+)$/.exec(c.next());
    if (!m) throw new Error('expected a delta token');
    return Number(m[1]);
}

// 'f:<float32>': the reader writes Math.fround of the value, which parses back to the same float32
function floatTok(c) {
    const m = /^f:(.+)$/.exec(c.next());
    if (!m) throw new Error('expected an f: token');
    const v = Number(m[1]);
    if (Number.isNaN(v) && m[1] !== 'NaN') throw new Error(`bad float ${m[1]}`);
    return v;
}

// 'item:<name> n<count> [blob:<id>]' -> the parts; the Slot itself is built in compile, against the blob store
function itemTail(c) {
    const m = /^item:(.+)$/.exec(c.next());
    if (!m) throw new Error('expected item:<name>');
    const count = c.int('n');
    const blob = c.peek()?.startsWith('blob:') ? c.next().slice(5) : null;
    return { item: m[1], count, blob };
}

// The client's last value for a metadata key. Deltas need it, so a delta with none is a broken row.
function base(store, key) {
    if (!store.has(key) || store.get(key) === undefined) throw new Error(`delta for key ${key} with no earlier value`);
    return store.get(key);
}

// 'v:<type>:<json>': the reader's fallback for serializers without a token form. A truncated one does not parse.
function jsonValue(t, type) {
    const m = /^v:([a-z_]+):([\s\S]*)$/.exec(t);
    if (!m || m[1] !== type) throw new Error('bad v: value token');
    let v;
    try {
        v = JSON.parse(m[2]);
    } catch (e) {
        throw new Error('truncated v: value');
    }
    return v === null ? undefined : v;
}

// Value tokens -> the metadata value as minecraft-protocol takes it. store is the entity's last values by key.
function metaValue(w, c, type, key, ctx, store) {
    const first = c.peek() ?? '';
    if (first === 'none') {
        c.next();
        if (!type.startsWith('optional_')) throw new Error(`${type} cannot be absent`);
        return undefined;
    }
    if (first.startsWith('v:')) return jsonValue(c.next(), type);
    switch (type) {
        case 'byte':
            // key 0 is the flags byte; the other byte keys are small integers
            return key === 0 ? i8(flagBits(c, 8)) : i8(c.int('i'));
        case 'int':
        case 'long':
            if (first.startsWith('Δ')) {
                if (type !== 'int' || key !== 1) throw new Error(`delta on ${type} key ${key}`);
                return base(store, key) + delta(c);
            }
            return c.int('i');
        case 'float':
            // health (key 9) is in half-points: absolute, or a delta in half-points
            if (key === 9) {
                if (first === 'abs') {
                    c.next();
                    return c.int('i') / 2;
                }
                return base(store, key) + delta(c) / 2;
            }
            return floatTok(c);
        case 'boolean': {
            const t = c.next();
            if (t !== 'true' && t !== 'false') throw new Error(`expected true or false, got ${t}`);
            return t === 'true';
        }
        case 'string':
            return w._readTemplate(c, ctx);
        case 'component':
        case 'optional_component':
            return w._readComponent(c, ctx);
        case 'item_stack': {
            const { item, count, blob } = itemTail(c);
            const slot = w._item(item, count, blob, ctx);
            if (!slot) throw new Error(`unknown item ${item}`);
            return slot;
        }
        case 'pose': {
            const m = /^pose:(\d+)$/.exec(c.next());
            if (!m) throw new Error('expected pose:<n>');
            return Number(m[1]);
        }
        case 'block_pos':
        case 'optional_block_pos': {
            // the reader stores the block's centre relative to the player; floor gives the block back
            const rel = [c.lattice('px'), c.lattice('py'), c.lattice('pz')];
            const [x, y, z] = w._world(rel, ctx.player);
            return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
        }
        default:
            throw new Error(`no token form for ${type}`);
    }
}

const parse = {
    // ENTITY s<slot> META mk:<entityType>:<key>:<serializer> <value tokens>; the value is decoded in compile
    'ENTITY META': (c) => {
        const m = /^mk:(.+):(\d+):(\w+)$/.exec(c.next());
        if (!m) throw new Error('META without its mk token');
        const raw = c.rest();
        c.i = c.t.length;
        return { key: Number(m[2]), type: m[3], raw };
    },

    // ENTITY s<slot> EQUIP eq<k> <item tokens>
    'ENTITY EQUIP': (c) => {
        const m = /^eq(\d+)$/.exec(c.next());
        if (!m) throw new Error('EQUIP without an eq token');
        return { equipSlot: Number(m[1]), ...itemTail(c) };
    },

    // t<slot> per rider; tUNKNOWN (a rider outside the scene) is left out of the list
    'ENTITY PASSENGERS': (c) => {
        const passengers = [];
        while (!c.eof()) {
            const t = c.next();
            if (t === 'tUNKNOWN') continue;
            const m = /^t(\d+)$/.exec(t);
            if (!m) throw new Error(`expected a passenger token, got ${t}`);
            passengers.push(Number(m[1]));
        }
        return { passengers };
    },

    // t<slot> for the vehicle, or none for a detach
    'ENTITY LINK': (c) => {
        const t = c.next();
        if (t === 'none') return { vehicle: null };
        const m = /^t(\d+)$/.exec(t);
        if (!m) throw new Error(`LINK to ${t}`);
        return { vehicle: Number(m[1]) };
    },

    // EVENT s<slot> EFFECT eff<id> a<amplifier> t<duration> <flag bits>
    'EVENT EFFECT': (c, head) => {
        if (head.slot === null) throw new Error('EFFECT without a slot');
        const m = /^eff(\d+)$/.exec(c.next());
        if (!m) throw new Error('EFFECT without an eff token');
        return { effectId: Number(m[1]), amplifier: c.int('a'), duration: c.int('t'), flags: flagBits(c, 4) };
    },

    // EVENT s<collector> PICKUP t<collected>|tUNKNOWN n<count>
    'EVENT PICKUP': (c, head) => {
        if (head.slot === null) throw new Error('PICKUP without a collector slot');
        const t = c.next();
        const m = /^t(\d+)$/.exec(t);
        if (!m && t !== 'tUNKNOWN') throw new Error(`PICKUP of ${t}`);
        return { collected: m ? Number(m[1]) : null, count: c.int('n') };
    },
};

const compile = {
    // Values are decoded and stored at once: the next row's delta is against this one.
    'ENTITY META'(p, ctx, tick) {
        if (tick.gone.includes(p.slot)) return; // leaving this tick, so the client drops it with the entity
        const e = p.slot === 0 ? null : this.bySlot.get(p.slot);
        if (p.slot !== 0 && !e) return this._reject('META of an empty slot');
        if (e && !e.meta) e.meta = new Map();
        if (!e && !this.playerMeta) this.playerMeta = new Map();
        const store = e ? e.meta : this.playerMeta;
        const c = new Cursor(p.raw);
        const value = metaValue(this, c, p.type, p.key, ctx, store);
        if (!c.eof()) throw new Error('trailing META tokens');
        store.set(p.key, value);
        // one entity_metadata per entity per tick, built in finish
        if (!tick.meta) tick.meta = new Map();
        const id = this._entityId(p.slot, ctx);
        if (!tick.meta.has(id)) tick.meta.set(id, new Map());
        tick.meta.get(id).set(p.key, value === undefined ? { key: p.key, type: p.type } : { key: p.key, type: p.type, value });
    },

    'ENTITY EQUIP'(p, ctx, tick) {
        if (tick.gone.includes(p.slot)) return;
        const id = this._entityId(p.slot, ctx);
        if (id === null) return this._reject('EQUIP of an empty slot');
        const item = this._item(p.item, p.count, p.blob, ctx);
        if (!item) return this._reject('EQUIP of an unknown item');
        if (!tick.equip) tick.equip = new Map();
        if (!tick.equip.has(id)) tick.equip.set(id, new Map());
        tick.equip.get(id).set(p.equipSlot, item);
    },

    'ENTITY PASSENGERS'(p, ctx, tick) {
        const id = this._entityId(p.slot, ctx);
        if (id === null) return this._reject('PASSENGERS of an empty slot');
        const ids = p.passengers.map((s) => this._entityId(s, ctx));
        if (ids.includes(null)) return this._reject('PASSENGERS names an empty slot');
        tick.add('state', { name: 'set_passengers', params: { entityId: id, passengers: ids } });
    },

    'ENTITY LINK'(p, ctx, tick) {
        const id = this._entityId(p.slot, ctx);
        if (id === null) return this._reject('LINK of an empty slot');
        let vehicleId = 0; // a detach
        if (p.vehicle !== null) {
            vehicleId = this._entityId(p.vehicle, ctx);
            if (vehicleId === null) return this._reject('LINK to an empty slot');
        }
        tick.add('state', { name: 'attach_entity', params: { entityId: id, vehicleId } });
    },

    'EVENT EFFECT'(p, ctx, tick) {
        const id = this._entityId(p.slot, ctx);
        if (id === null) return this._reject('EFFECT on an empty slot');
        tick.add('event', { name: 'entity_effect', params: { entityId: id, effectId: p.effectId, amplifier: p.amplifier, duration: p.duration, flags: p.flags } });
    },

    // The collected entity may despawn in this same tick: its slot is only forgotten at the end of the tick.
    'EVENT PICKUP'(p, ctx, tick) {
        const by = this._entityId(p.slot, ctx);
        if (by === null) return this._reject('PICKUP by an empty slot');
        if (p.collected === null) return this._reject('PICKUP of an entity outside the scene');
        const it = this._entityId(p.collected, ctx);
        if (it === null) return this._reject('PICKUP of an empty slot');
        tick.add('event', { name: 'collect', params: { collectedEntityId: it, collectorEntityId: by, pickupItemCount: p.count } });
    },
};

const finish = [
    function (tick) {
        if (tick.meta) {
            for (const [entityId, byKey] of tick.meta) {
                const metadata = [...byKey.keys()].sort((a, b) => a - b).map((k) => byKey.get(k));
                tick.add('state', { name: 'entity_metadata', params: { entityId, metadata } });
            }
        }
        if (tick.equip) {
            for (const [entityId, bySlot] of tick.equip) {
                const equipments = [...bySlot.keys()].sort((a, b) => a - b).map((slot) => ({ slot, item: bySlot.get(slot) }));
                tick.add('state', { name: 'entity_equipment', params: { entityId, equipments } });
            }
        }
    },
];

module.exports = { parse, compile, finish };
