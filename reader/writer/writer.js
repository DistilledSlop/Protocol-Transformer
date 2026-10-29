'use strict';
// The writer: rows (as tokens) -> the packets a client needs, by diffing against what the client believes.
//
// The engine owns everything the model does not see: entity ids and UUIDs (an entity table maps each slot
// to an id), window state ids, and the order packets go out in. The model's rows say what changed; the
// writer works out which packets say it.
//
// step() takes one tick: the rows for it and a context ({ playerId, player: {x, y, z} }; relative positions and
// block offsets are measured from the player). It returns packets as {name, params}, in the order they go out.
//
// What each kind of row compiles to lives in families/*.js, each exporting
//   parse:   '<ROW> <KIND>' -> (cursor, head) => fields           reads the kind's tail tokens
//   compile: '<ROW> <KIND>' -> function (row, ctx, tick)          emits packets with tick.add(phase, ...packets)
//   finish:  [function (tick)]                                    runs once after all rows, to batch (blocks, destroys)
// `this` in compile and finish is the Writer, which holds the client's believed state.

const { createCatalog } = require('../catalog');
const { parseRow, registerParsers } = require('./parse_rows');

const FIRST_ENTITY_ID = 10000;
const FAMILIES = ['entity', 'world', 'inventory', 'items', 'textutil', 'text', 'entityextra', 'worldevents', 'containers', 'scoreboard', 'context'];
// packets go out in this order within a tick: new entities, their state, motion, blocks, windows, slots, events, text,
// then the entities that go away last, so an event about one (a pickup, a death) still finds it.
// 'window' (open and close) comes before 'slot' so a window is open before its trades or contents are sent.
const PHASES = ['spawn', 'state', 'move', 'velocity', 'block', 'window', 'slot', 'event', 'text', 'global', 'destroy'];

const COMPILE = new Map();
const FINISH = [];
for (const f of FAMILIES) {
    const fam = require(`./families/${f}`);
    registerParsers(fam.parse ?? {});
    for (const [k, fn] of Object.entries(fam.compile ?? {})) COMPILE.set(k, fn);
    FINISH.push(...(fam.finish ?? []));
}

class Writer {
    constructor({ catalog = createCatalog(), firstEntityId = FIRST_ENTITY_ID } = {}) {
        this.cat = catalog;
        this.nextEntityId = firstEntityId;
        // what the client believes
        this.bySlot = new Map(); // slot -> {id, uuid, type, x, y, z, yaw, pitch, headYaw}
        this.windowState = new Map(); // window id -> last state id sent
        this.health = { health: 20, food: 20, saturation: 5 };
        this.xp = { bar: 0, level: 0 };
        this.stats = {
            rows: new Map(), // 'ENTITY MOVE' -> compiled count
            rejected: new Map(), // reason -> count; rows the writer could not or would not compile
            packets: new Map(), // packet name -> count
        };
    }

    // Adopt the actual client state after raw join packets were sent. IDs must stay the
    // captured IDs, and only metadata actually observed on the wire is a delta base.
    seedFromReader(reader) {
        const state = reader.S;
        if (Number.isSafeInteger(state.playerId) && state.playerId >= 0) {
            this.nextEntityId = Math.max(this.nextEntityId, state.playerId + 1);
        }
        this.bySlot.clear();
        this.playerMeta = new Map();
        this.playerMetaTypes = new Map();
        for (const e of state.entities.values()) {
            this.nextEntityId = Math.max(this.nextEntityId, e.id + 1);
            const meta = new Map();
            const metaTypes = new Map();
            for (const [key, m] of e.meta || []) {
                meta.set(key, m.value);
                metaTypes.set(key, m.type);
            }
            if (e.id === state.playerId) {
                this.playerMeta = meta;
                this.playerMetaTypes = metaTypes;
            } else if (e.slot !== null && e.slot !== undefined && state.slotToId[e.slot] === e.id) {
                this.bySlot.set(e.slot, { id: e.id, uuid: e.uuid, type: e.type, x: e.x, y: e.y, z: e.z,
                    yaw: e.yaw, pitch: e.pitch, headYaw: e.headYaw, meta, metaTypes });
            }
        }
    }

    _count(map, key, n = 1) {
        map.set(key, (map.get(key) || 0) + n);
    }

    _reject(reason) {
        this._count(this.stats.rejected, reason);
    }

    _uuid(id) {
        return `00000000-0000-4000-8000-${id.toString(16).padStart(12, '0')}`;
    }

    // slot 0 is the player, whose entity id comes from the engine, not from a row
    _entityId(slot, ctx) {
        if (slot === 0) return ctx.playerId;
        return this.bySlot.get(slot)?.id ?? null;
    }

    // position relative to the player, in 1/16 block -> world coordinates
    _world(rel, P) {
        return [P.x + rel[0] / 16, P.y + rel[1] / 16, P.z + rel[2] / 16];
    }

    // ---- one tick ----------------------------------------------------------------------------------------------
    // rows: [{io, tokens}]. Rows with io 'in' are the client's own input and never become packets.
    step(rows, ctx) {
        const phases = new Map();
        const tick = {
            ctx,
            destroy: [], // entity ids to remove, sent as one packet
            blocks: [], // block rows, batched by section
            gone: [], // slots freed at the end of the tick, so an event about a dying entity still resolves
            add(phase, ...packets) {
                if (!phases.has(phase)) phases.set(phase, []);
                phases.get(phase).push(...packets);
            },
        };
        for (const r of rows) {
            if (r.io === 'in') continue;
            let p;
            try {
                p = parseRow(r.tokens);
            } catch (e) {
                this._reject(e.message.replace(/ -?\d+.*$/, '').slice(0, 60));
                continue;
            }
            // Initial/periodic mode snapshots condition the model; replaying one must never change mode.
            // Model-owned OUT gamemode changes retain their existing packet compiler.
            if (r.io === 'eng' && p.row === 'GLOBAL' && p.field === 'gamemode') continue;
            const key = `${p.row} ${p.kind}`;
            const fn = COMPILE.get(key) ?? COMPILE.get(`${p.row} *`);
            if (!fn) {
                this._reject(`unsupported ${p.row} kind ${p.kind}`);
                continue;
            }
            this._count(this.stats.rows, key);
            try {
                fn.call(this, p, ctx, tick);
            } catch (e) {
                this._reject(`compile error in ${key}: ${String(e.message).slice(0, 50)}`);
            }
        }
        for (const fin of FINISH) fin.call(this, tick);
        for (const s of tick.gone) this.bySlot.delete(s);

        const out = [];
        for (const ph of PHASES) out.push(...(phases.get(ph) ?? []));
        for (const pk of out) this._count(this.stats.packets, pk.name);
        return out;
    }
}

// helper methods the families registered while loading
Object.assign(Writer.prototype, require('./writer_methods').methods);

module.exports = { Writer, PHASES };
