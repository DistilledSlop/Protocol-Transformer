'use strict';
// The reader: packets in, state table S and typed rows out.
//
// feed() takes events in arrival order (see capture.events); whenever the tick number changes it closes
// the previous tick and returns that tick's rows. Packets only update S while a tick is open; rows are
// built once, at the end of the tick, from what differs from the tick before, so several packets
// touching one entity merge into one row.
//
// Each row has io: 'in'  = input (the client's own actions; the model reads, never predicts),
//                  'out' = a target for the model,
//                  'eng' = derived by the engine from S (range culling); kept for context, not a target.

const { createCodec } = require('./parse');
const { createCatalog } = require('./catalog');
const Q = require('./quant');
const crypto = require('crypto');
const { intTokens, floatToken, clampStr } = require('./tokens');
const { flatten, template, simplify } = require('./component');
const { dataTokens } = require('./objectdata');
const { WorldStore } = require('./world');
const { createBlockInfo } = require('./blockinfo');
const PACKETS = require('./packets.json');

// 'S2C spawn_entity' -> tier, so a packet with no handler can be told apart: engine/baked/derived/drop
// packets make no row by design, model/hybrid/input ones without a handler are gaps.
const TIER = new Map();
for (const p of PACKETS) if (p.state === 'play' && p.name) TIER.set(`${p.bound === 'C' ? 'S2C' : 'C2S'} ${p.name}`, p.tier);
const NO_ROW_TIERS = new Set(['ENGINE', 'BAKED', 'DERIVED', 'DROP']);

const TICK_MS = 50;
const MAX_SLOTS = 64;
const ENTITY_RANGE = 32; // blocks
const ENTITY_RANGE_LEAVE = 36; // hysteresis so an entity on the edge does not flicker
const EVICT_MARGIN = 3; // blocks a visible entity must be farther than a newcomer to be culled for it
const BLOCK_RANGE = 6; // cells; offsets -6..6 are 13 values
const MAX_ROWS_PER_TICK = 64;
const MAX_TEXT_DEPTH = 4; // nested translatable components
const MAX_TEXT_ARGS = 8;
const MAX_NEAR_ROWS = 6; // neighbor context rows per tick
const GROUND_COLUMNS = 3; // the ground grid is 7x7 columns (-3..3) ...
const GROUND_STRIDE = 3; // ... every 3 blocks, so it reaches 9 blocks out
const GROUND_EVERY = 40; // ticks: older than the context window is no use
const CLOCK_EVERY = 40; // ticks between clock context rows
const GROUND_MOVED = 4; // blocks the player moves before a new grid is due
const GROUND_UP = 8; // each column is searched from 8 blocks above the player's feet to 9 below
const GROUND_DOWN = 9;
const TERRAIN_R = 6; // the terrain patch spans the same +-6 blocks as the block rows
const TERRAIN_SIDE = 2 * TERRAIN_R + 1;
const TERRAIN_EVERY = 4; // ticks between patches; the ticks in between reuse the last one
const TERRAIN_UNKNOWN = 16; // category of a cell outside the loaded chunks
const TELEPORT_UNITS = 32767; // a move larger than this on any axis is a TP row

const NEIGHBORS = [[0, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, -1], [0, 0, 1], [1, 0, 0], [-1, 0, 0]];
const ROW_ORDER = { ENTITY: 0, BLOCK: 1, SLOT: 2, EVENT: 3, TEXT: 4, GLOBAL: 5 };
const KIND_ORDER = { SPAWN: 0, TP: 1, MOVE: 2, VEL: 3, META: 4, EQUIP: 5, DESPAWN: 6 };

const wrapAngle = (i8) => i8 & 255; // protocol angles are 1/256 of a turn
const degToAngle = (deg) => (((Math.round((deg * 256) / 360) % 256) + 256) % 256);

class Reader {
    // range: how far (blocks) an entity is from the player and still in the scene; Infinity keeps every entity (a server whose entities
    // are all the model's own, so there is no server to cull for)
    constructor({ phase = 25, version = '1.21.1', catalog = createCatalog(version), snapshot = false, range = ENTITY_RANGE, deferNear = true, terrain = false } = {}) {
        this.terrain = terrain; // attach a terrain patch (a Uint8Array of block categories) to every TERRAIN_EVERY-th closed tick
        this.terrainNext = null;
        // deferNear: the neighbors of a block that changed go out with the next tick's rows, as in a capture, where the
        // server's change belongs to the tick it happened in. A live server whose changes are the model's own, read back
        // a tick late, sets it false: the change is already one tick old when it is read.
        this.deferNear = deferNear;
        this.info = createBlockInfo(version);
        this.groundNext = null; // the ground grid taken at the end of the last tick, sent with this one
        this.groundAt = null; // {tick, x, z} of the last grid taken
        this.clockNext = null; // the time of day taken at the end of the last tick, sent with this one
        this.clockAt = null; // tick of the last one taken
        this.nextNear = [];
        this.range = range;
        this.rangeLeave = range === ENTITY_RANGE ? ENTITY_RANGE_LEAVE : range;
        this.phase = phase;
        this.snapshot = snapshot; // attach the visible scene to each closed tick (used to test the writer)
        this.codec = createCodec(version);
        this.cat = catalog;
        this.stats = {
            packets: 0,
            unhandled: new Map(), // 'S2C name' -> count, packets that should make rows or state and have no handler
            slotMisses: new Map(), // entity type -> times it found no free slot (the 63 slots were full)
            byDesign: new Map(), // 'DERIVED S2C name' -> count, packets that make no row by design (engine, baked, derived, dropped)
            parseErrors: new Map(),
            rows: new Map(), // 'ENTITY MOVE' -> count
            dropped: new Map(), // reason -> count
            quant: { n: 0, absUnits: [], relErr: [] },
        };
        this.blobs = new Map(); // blob id -> {kind, value}: item components and NBT the tokens only point at
        this.tick = null;
        this.reset();
    }

    // ---- state ------------------------------------------------------------------------------------
    reset() {
        this.stale = new Set(); // entities whose move row was dropped: revisited next tick
        this.carryMeta = new Set(); // same for metadata and equipment rows
        this.S = {
            playerId: null,
            player: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, known: false },
            entities: new Map(), // entityId -> entity
            slotToId: new Array(MAX_SLOTS).fill(null),
            blocks: new Map(), // 'x,y,z' -> state id, only blocks the server has changed
            windows: new Map(), // windowId -> [{item, count}]
            globals: { health: null, food: null },
            clock: { age: 0n, time: 0n },
            viewDistance: null,
            opLevel: null, // unknown until the server sends player status 24..28
            playerContextAt: null,
            selectedSlot: 0,
            center: null,
            loadedChunks: new Set(),
            world: new WorldStore(), // block states of the loaded chunks
            abilities: null,
            names: [], // player names seen, in order of first sight; a name token is its index
            nameIndex: new Map(),
            players: new Map(), // uuid -> {name, gamemode, listed, latency}
            bars: new Map(), // boss bar uuid -> bar index
            objectives: new Map(), // objective name -> index
            teams: new Map(), // team name -> index
            openWindow: null,
        };
        this._openTick();
    }

    _openTick() {
        this.T = {
            near: [], // neighborhoods of blocks the player dug or placed, taken when the packet arrived
            touched: new Set(), // entity ids with any change this tick
            velocity: new Map(), // entityId -> [x,y,z] units, packets this tick
            destroyed: [], // {entity, slot}
            blocks: new Map(), // key -> {x,y,z,old,new}
            slots: new Map(), // 'w:i' -> {w,i,old,new}
            events: [],
            later: [], // functions run at the end of the tick that return a row (or null) once slots are known
            metaTouched: new Set(), // entity ids whose metadata or equipment changed
            spans: [], // open text copied from input, indexed by span token
            globals: {},
            contextChanged: false,
            sync: null, // {from:[x,y,z]} when the server moved the player
            playerStart: { ...this.S.player },
        };
    }

    // ---- driving ------------------------------------------------------------------------------------
    // Returns an array of {tick, rows} for every tick that closed (usually 0 or 1).
    feed(ev) {
        if (ev.kind === 'state') {
            const out = [];
            // Re-entering configuration clears the world.
            if (ev.to === 'configuration') {
                if (this.tick !== null) out.push(this._closeTick());
                this.reset();
                this.tick = null;
            }
            return out;
        }
        if (ev.state !== 'play') return [];

        const out = this._advance(ev.t);
        let p;
        try {
            p = this.codec.parse(ev.dir, ev.buf);
        } catch (e) {
            const k = `${ev.dir} ${ev.name}`;
            this.stats.parseErrors.set(k, (this.stats.parseErrors.get(k) || 0) + 1);
            return out;
        }
        this.stats.packets++;
        this._apply(ev.dir, p.name, p.params);
        return out;
    }

    // Same as feed() for a packet that is already parsed: {t, dir, name, params}. Used by tests and by
    // anything that builds packets itself.
    feedPacket({ t, dir, name, params }) {
        const out = this._advance(t);
        this.stats.packets++;
        this._apply(dir, name, params);
        return out;
    }

    // Move the clock to time t, closing every tick before it.
    _advance(t) {
        const out = [];
        const tick = Math.floor((t - this.phase) / TICK_MS);
        if (this.tick === null) this.tick = tick;
        while (tick > this.tick) {
            out.push(this._closeTick());
            this.tick++;
        }
        return out;
    }

    // Close every tick that ended before time t. Live use: time passes whether or not a packet arrives.
    advanceTo(t) {
        return this.tick === null ? [] : this._advance(t);
    }

    // Close the tick still open at the end of a capture.
    flush() {
        if (this.tick === null) return [];
        const r = [this._closeTick()];
        this.tick = null;
        return r;
    }

    _count(map, key, n = 1) {
        map.set(key, (map.get(key) || 0) + n);
    }

    // ---- applying packets to S ---------------------------------------------------------------------
    _apply(dir, name, d) {
        const h = dir === 'S2C' ? this[`s2c_${name}`] : this[`c2s_${name}`];
        if (h) return h.call(this, d);
        const tier = TIER.get(`${dir} ${name}`);
        if (tier && NO_ROW_TIERS.has(tier)) this._count(this.stats.byDesign, `${tier} ${dir} ${name}`);
        else this._count(this.stats.unhandled, `${dir} ${name}`);
    }

    _entity(id) {
        return this.S.entities.get(id);
    }

    _touch(e) {
        this.T.touched.add(e.id);
        if (!e.prev) e.prev = { x: e.x, y: e.y, z: e.z, yaw: e.yaw, pitch: e.pitch, headYaw: e.headYaw };
    }

    s2c_login(d) {
        this.reset();
        const S = this.S;
        S.playerId = d.entityId;
        S.viewDistance = d.viewDistance;
        this._observeGameMode(d.worldState?.gamemode ?? d.gameMode);
        const e = this._newEntity(d.entityId, 'player', null, 0, 0, 0, 0, 0);
        e.isPlayer = true;
        e.slot = 0;
        S.slotToId[0] = e.id;
    }

    // Login/respawn context is supplied by the real engine, rather than a model target.
    _observeGameMode(value) {
        const modes = ['survival', 'creative', 'adventure', 'spectator'];
        const mode = typeof value === 'string' ? modes.indexOf(value) : value;
        if (!Number.isInteger(mode) || mode < 0 || mode > 3) return;
        if (this.S.globals.gamemode !== mode) this.T.contextChanged = true;
        this.S.globals.gamemode = mode;
    }

    s2c_respawn(d) {
        this._observeGameMode(d.worldState?.gamemode ?? d.gameMode);
    }

    _newEntity(id, type, uuid, x, y, z, yaw, pitch) {
        const e = { id, type, uuid, x, y, z, yaw, pitch, headYaw: yaw, slot: null, visible: false, prev: null, isPlayer: false };
        this.S.entities.set(id, e);
        return e;
    }

    s2c_spawn_entity(d) {
        if (this._entity(d.entityId)) this._count(this.stats.dropped, 'respawn of known entity id');
        const e = this._newEntity(d.entityId, this.cat.entityName(d.type), d.objectUUID, d.x, d.y, d.z, wrapAngle(d.yaw), wrapAngle(d.pitch));
        e.headYaw = wrapAngle(d.headPitch); // the wire field is named headPitch but carries the head yaw
        e.spawnTick = this.tick;
        e.data = d.objectData;
        this._touch(e);
        const v = d.velocity;
        if (v && (v.x || v.y || v.z)) this.T.velocity.set(e.id, [v.x, v.y, v.z]);
    }

    s2c_entity_destroy(d) {
        for (const id of d.entityIds) {
            const e = this._entity(id);
            if (!e) continue;
            this.T.destroyed.push({ entity: e, slot: e.slot, visible: e.visible });
            this.S.entities.delete(id);
            this.T.touched.delete(id);
            this.T.velocity.delete(id);
        }
    }

    s2c_rel_entity_move(d) {
        const e = this._entity(d.entityId);
        if (!e) return;
        this._touch(e);
        e.x += d.dX / 4096;
        e.y += d.dY / 4096;
        e.z += d.dZ / 4096;
    }

    s2c_entity_move_look(d) {
        const e = this._entity(d.entityId);
        if (!e) return;
        this._touch(e);
        e.x += d.dX / 4096;
        e.y += d.dY / 4096;
        e.z += d.dZ / 4096;
        e.yaw = wrapAngle(d.yaw);
        e.pitch = wrapAngle(d.pitch);
    }

    s2c_entity_look(d) {
        const e = this._entity(d.entityId);
        if (!e) return;
        this._touch(e);
        e.yaw = wrapAngle(d.yaw);
        e.pitch = wrapAngle(d.pitch);
    }

    s2c_entity_teleport(d) {
        const e = this._entity(d.entityId);
        if (!e || e.isPlayer) return;
        this._touch(e);
        e.x = d.x;
        e.y = d.y;
        e.z = d.z;
        e.yaw = wrapAngle(d.yaw);
        e.pitch = wrapAngle(d.pitch);
    }

    s2c_entity_head_rotation(d) {
        const e = this._entity(d.entityId);
        if (!e) return;
        this._touch(e);
        e.headYaw = wrapAngle(d.headYaw);
    }

    s2c_entity_velocity(d) {
        const e = this._entity(d.entityId);
        if (!e) return;
        this.T.touched.add(e.id);
        this.T.velocity.set(e.id, [d.velocity.x, d.velocity.y, d.velocity.z]);
    }

    // The server moved the player (join, setback, teleport). Flags mark axes that are relative.
    s2c_position(d) {
        const P = this.S.player;
        const f = d.flags || {};
        if (P.known) this.T.sync = this.T.sync || { from: [P.x, P.y, P.z] };
        P.x = f.x ? P.x + d.x : d.x;
        P.y = f.y ? P.y + d.y : d.y;
        P.z = f.z ? P.z + d.z : d.z;
        P.yaw = f.yaw ? P.yaw + d.yaw : d.yaw;
        P.pitch = f.pitch ? P.pitch + d.pitch : d.pitch;
        P.known = true;
        this._syncPlayerEntity();
    }

    _syncPlayerEntity() {
        const e = this._entity(this.S.playerId);
        if (!e) return;
        const P = this.S.player;
        if (!e.placed) {
            // first position of the session: place the player, no move happened
            e.placed = true;
            e.x = P.x;
            e.y = P.y;
            e.z = P.z;
            e.yaw = degToAngle(P.yaw);
            e.pitch = degToAngle(P.pitch);
            e.headYaw = e.yaw;
        }
        this._touch(e);
        e.x = P.x;
        e.y = P.y;
        e.z = P.z;
        e.yaw = degToAngle(P.yaw);
        e.pitch = degToAngle(P.pitch);
        e.headYaw = e.yaw;
    }

    c2s_position(d) {
        Object.assign(this.S.player, { x: d.x, y: d.y, z: d.z, known: true });
        this._syncPlayerEntity();
    }

    c2s_position_look(d) {
        Object.assign(this.S.player, { x: d.x, y: d.y, z: d.z, yaw: d.yaw, pitch: d.pitch, known: true });
        this._syncPlayerEntity();
    }

    c2s_look(d) {
        Object.assign(this.S.player, { yaw: d.yaw, pitch: d.pitch });
        this._syncPlayerEntity();
    }

    c2s_arm_animation(d) {
        this.T.events.push({ io: 'in', kind: d.hand === 0 ? 'SWING_MAIN' : 'SWING_OFF', entityId: this.S.playerId });
    }

    c2s_use_entity(d) {
        // mouse: 0 interact, 1 attack, 2 interact at. The main cause of hit reactions, so all three are rows.
        const kind = ['INTERACT', 'ATTACK', 'INTERACT_AT'][d.mouse] ?? 'INTERACT';
        this.T.events.push({ io: 'in', kind, entityId: this.S.playerId, targetId: d.target, tokens: d.sneaking ? ['sneak'] : [] });
    }

    // Blocks ---------------------------------------------------------------------------------------
    _setBlock(x, y, z, stateId) {
        const key = `${x},${y},${z}`;
        // the world store knows every loaded block; S.blocks only what the server has changed since the join
        const old = this.S.world.get(x, y, z) ?? this.S.blocks.get(key);
        this.S.world.set(x, y, z, stateId);
        this.S.blocks.set(key, stateId);
        const t = this.T.blocks.get(key);
        if (t) t.new = stateId;
        else this.T.blocks.set(key, { x, y, z, old, new: stateId });
    }

    s2c_block_change(d) {
        this._setBlock(d.location.x, d.location.y, d.location.z, d.type);
    }

    s2c_multi_block_change(d) {
        const c = d.chunkCoordinates; // chunk section coordinates
        for (const rec of d.records) {
            const r = Number(rec);
            const stateId = Math.floor(r / 4096);
            const local = r & 0xfff;
            this._setBlock(c.x * 16 + ((local >> 8) & 15), c.y * 16 + (local & 15), c.z * 16 + ((local >> 4) & 15), stateId);
        }
    }

    // Slots ----------------------------------------------------------------------------------------
    _slotValue(item) {
        if (!item || !item.itemCount) return { item: 'empty', count: 0, blob: null };
        // Components sit behind a blob id, so unseen components do not collapse an item to UNKNOWN.
        const hasComp = (item.components && item.components.length) || (item.removeComponents && item.removeComponents.length);
        const blob = hasComp ? this._blob('item_components', { components: item.components, removeComponents: item.removeComponents }) : null;
        return { item: this.cat.itemName(item.itemId), count: item.itemCount, blob };
    }

    _setSlot(w, i, item) {
        let win = this.S.windows.get(w);
        if (!win) this.S.windows.set(w, (win = []));
        const old = win[i];
        const nv = this._slotValue(item);
        win[i] = nv;
        const key = `${w}:${i}`;
        const t = this.T.slots.get(key);
        if (t) t.new = nv;
        else this.T.slots.set(key, { w, i, old, new: nv });
    }

    s2c_set_slot(d) {
        this._setSlot(d.windowId, d.slot, d.item);
    }

    s2c_window_items(d) {
        d.items.forEach((it, i) => this._setSlot(d.windowId, i, it));
    }

    // Events ---------------------------------------------------------------------------------------
    s2c_hurt_animation(d) {
        this.T.events.push({ io: 'out', kind: 'HURT', entityId: d.entityId });
    }

    s2c_damage_event(d) {
        this.T.events.push({ io: 'out', kind: 'DAMAGE', entityId: d.entityId, damageType: d.sourceTypeId });
    }

    // Globals --------------------------------------------------------------------------------------
    s2c_update_health(d) {
        const health = Math.round(d.health * 2); // half-hearts
        if (health !== this.S.globals.health) this.T.globals.health = health;
        if (d.food !== this.S.globals.food) this.T.globals.food = d.food;
    }

    // ---- helpers for handlers ------------------------------------------------------------------------
    // Queue a row that needs entity slots: fn(ctx) runs at the end of the tick and returns a row or null.
    _later(fn) {
        this.T.later.push(fn);
    }

    // Position relative to the focus (the player), in 1/16 block, with its tokens.
    _relPos(x, y, z) {
        const P = this.S.player;
        const rel = [x - P.x, y - P.y, z - P.z].map((v) => Math.round(v * 16));
        const tokens = [];
        ['px', 'py', 'pz'].forEach((f, i) => tokens.push(...this._lattice(f, rel[i]).tokens));
        return { rel, tokens };
    }

    // The block at x,y,z and its six neighbors (up, down, north, south, east, west) as state ids; undefined outside loaded chunks.
    _neighborhood(x, y, z) {
        const w = this.S.world;
        const st = NEIGHBORS.map(([dx, dy, dz]) => w.get(x + dx, y + dy, z + dz));
        return st[0] === undefined ? null : { x, y, z, st };
    }

    // A context row for a neighborhood, placed against the player now; null when it is out of the row range
    _nearRow(n) {
        const o = this._blockOffset(n);
        if (!o) return null;
        const tok = (v) => `nb:${v === undefined ? 'void' : this.cat.blockState(v)}`;
        return { row: 'BLOCK', io: 'eng', kind: 'NEAR', tokens: ['BLOCK', `bx${o[0]}`, `by${o[1]}`, `bz${o[2]}`, 'NEAR', ...n.st.map(tok)] };
    }

    // The blocks around the player as categories (blockinfo), x fastest, then z, then y, from -TERRAIN_R to TERRAIN_R about the
    // player's feet block. 13x13x13 cells.
    _terrainPatch() {
        const P = this.S.player;
        const out = new Uint8Array(TERRAIN_SIDE ** 3).fill(TERRAIN_UNKNOWN);
        if (!P.known) return out;
        const w = this.S.world;
        const fx = Math.floor(P.x);
        const fy = Math.floor(P.y);
        const fz = Math.floor(P.z);
        let i = 0;
        for (let dy = -TERRAIN_R; dy <= TERRAIN_R; dy++) {
            for (let dz = -TERRAIN_R; dz <= TERRAIN_R; dz++) {
                for (let dx = -TERRAIN_R; dx <= TERRAIN_R; dx++, i++) {
                    const st = w.get(fx + dx, fy + dy, fz + dz);
                    if (st !== undefined) out[i] = this.info.category(st);
                }
            }
        }
        return out;
    }

    // The ground around the player: for each of 7x7 columns, how far above (positive) or below the player's feet block the top
    // solid or liquid block is: `th<dy>`, or `thv` where no chunk is loaded and `thN` where there is none in reach.
    _groundTokens() {
        const P = this.S.player;
        const w = this.S.world;
        const fx = Math.floor(P.x);
        const fy = Math.floor(P.y);
        const fz = Math.floor(P.z);
        const out = [];
        for (let i = -GROUND_COLUMNS; i <= GROUND_COLUMNS; i++) {
            for (let k = -GROUND_COLUMNS; k <= GROUND_COLUMNS; k++) {
                const x = fx + i * GROUND_STRIDE;
                const z = fz + k * GROUND_STRIDE;
                if (w.get(x, fy, z) === undefined) {
                    out.push('thv');
                    continue;
                }
                let top = null;
                for (let y = fy + GROUND_UP; y >= fy - GROUND_DOWN; y--) {
                    const st = w.get(x, y, z);
                    if (st !== undefined && (this.info.collisionTop(st) > 0 || this.info.isLiquid(st))) {
                        top = y - fy;
                        break;
                    }
                }
                out.push(top === null ? 'thN' : `th${top}`);
            }
        }
        return out;
    }

    // Block offset from the focus block, or null when it is beyond the row range.
    _blockOffset(loc) {
        const P = this.S.player;
        const o = [loc.x - Math.floor(P.x), loc.y - Math.floor(P.y), loc.z - Math.floor(P.z)];
        return Math.max(...o.map(Math.abs)) > BLOCK_RANGE ? null : o;
    }

    // Player name -> stable index, so names are copy tokens rather than text.
    _nameTok(name) {
        const S = this.S;
        let i = S.nameIndex.get(name);
        if (i === undefined) {
            i = S.names.length;
            S.names.push(name);
            S.nameIndex.set(name, i);
        }
        return `nm${i}`;
    }

    // Open text the model only repeats: an opaque span, the compiler copies the bytes.
    _span(text) {
        this.T.spans.push(text);
        return `span${this.T.spans.length - 1}`;
    }

    // String -> template token plus value tokens. Text of 64+ bytes is cut, as the design caps it.
    _textTokens(text) {
        const { tpl, values } = template(String(text), this.S.names);
        const cut = clampStr(tpl, 96);
        const tokens = [`tpl:${cut}`];
        // values only for the placeholders that survive the cut, or the tokens would not match the template
        const kept = (cut.match(/\{[np]\}/g) || []).length;
        for (const v of values.slice(0, kept)) tokens.push(...(v.kind === 'num' ? intTokens('v', Number(v.v)) : [this._nameTok(v.v)]));
        return tokens;
    }

    // A component as tokens. Plain text is one template group. A translatable is `tr:<key> a<n>` and then its n arguments, each a
    // component of its own, so a nested key ("gameMode.survival", "entity.minecraft.creeper") is looked up by the client and not
    // shown as written. Styling, click and hover events are not kept.
    _compTokens(comp) {
        return this._nodeTokens(simplify(comp), 0);
    }

    _nodeTokens(js, depth) {
        if (js === undefined || js === null) return this._textTokens('');
        if (Array.isArray(js) && js.length === 1) return this._nodeTokens(js[0], depth);
        if (typeof js === 'object' && !Array.isArray(js)) {
            if (typeof js.translate === 'string' && depth < MAX_TEXT_DEPTH) {
                const args = (js.with || []).slice(0, MAX_TEXT_ARGS);
                return [`tr:${js.translate}`, ...intTokens('a', args.length), ...args.flatMap((a) => this._nodeTokens(a, depth + 1))];
            }
            // an empty root that only wraps one component: {text:'', extra:[X]}
            if (js.text === '' && Array.isArray(js.extra) && js.extra.length === 1) return this._nodeTokens(js.extra[0], depth);
        }
        return this._textTokens(flatten(js).text);
    }

    // Item -> variant token, a count and, when it carries components, a blob id for them.
    _itemTokens(item) {
        const v = this._slotValue(item);
        return [`item:${v.item}`, ...intTokens('n', v.count), ...(v.blob ? [`blob:${v.blob}`] : [])];
    }

    _evRow(io, kind, slot, tokens, extra = {}) {
        return { row: 'EVENT', io, kind, slot, tokens: ['EVENT', ...(slot === null || slot === undefined ? [] : [`s${slot}`]), kind, ...tokens], ...extra };
    }

    // ---- closing a tick -----------------------------------------------------------------------------
    // slotHint(entityId) -> slot, when something else already named the entity's slot (a server whose own writer made it)
    _allocSlot(e, reserved) {
        const want = this.slotHint?.(e.id);
        if (want > 0 && want < MAX_SLOTS && this.S.slotToId[want] === null && !reserved.has(want)) {
            this.S.slotToId[want] = e.id;
            e.slot = want;
            return true;
        }
        for (let s = 1; s < MAX_SLOTS; s++) {
            if (this.S.slotToId[s] === null && !reserved.has(s)) {
                this.S.slotToId[s] = e.id;
                e.slot = s;
                return true;
            }
        }
        return false;
    }

    _closeTick() {
        const terrain = this.terrainNext; // taken at the end of the last tick: the world before this tick's changes
        this.terrainNext = null;
        const S = this.S;
        const T = this.T;
        const P = S.player;
        const rows = [];
        const push = (r) => {
            rows.push(r);
            this._count(this.stats.rows, `${r.row}${r.kind ? ' ' + r.kind : ''}`);
        };
        // slots freed this tick stay unavailable until the tick is over, so a row never names a reused slot
        const reserved = new Set();

        // Destroyed entities: a DESPAWN row if the model could see them.
        for (const { entity, slot, visible } of T.destroyed) {
            if (slot === null || !visible) continue;
            S.slotToId[slot] = null;
            reserved.add(slot);
            push(this._entityRow(entity, slot, 'DESPAWN', 'out', { why: 'gone' }));
        }

        // Visibility: range culling is derived from S, so those rows are engine rows. Slots go to the
        // nearest entities: when all are taken, the farthest visible entity is culled to make room for a
        // closer one (the newcomer enters next tick, so a slot is never freed and reused in one tick).
        if (P.known) {
            const enter = [];
            for (const e of S.entities.values()) {
                if (e.isPlayer) continue;
                e.dist = Math.hypot(e.x - P.x, e.y - P.y, e.z - P.z);
                if (e.visible && e.dist > this.rangeLeave) this._cull(e, reserved, push);
                else if (!e.visible && e.dist <= this.range) enter.push(e);
            }
            enter.sort((a, b) => a.dist - b.dist);
            let farthest = null; // visible entities, farthest first, built only if the slots run out
            for (const e of enter) {
                if (this._allocSlot(e, reserved)) {
                    e.visible = true;
                    const isNew = e.spawnTick === this.tick;
                    push(this._spawnRow(e, isNew ? 'out' : 'eng'));
                    e.rowTick = this.tick; // its spawn row already carries the current state
                    for (const r of this._entityStateRows(e, true, isNew ? 'out' : 'eng')) push(r);
                    T.metaTouched.delete(e.id);
                    T.velocity.delete(e.id); // a spawn row carries its own velocity
                    e.prev = null;
                    continue;
                }
                if (!farthest) farthest = [...S.entities.values()].filter((v) => v.visible && !v.isPlayer).sort((a, b) => b.dist - a.dist);
                const victim = farthest[0];
                if (victim && victim.dist > e.dist + EVICT_MARGIN) {
                    farthest.shift();
                    this._count(this.stats.dropped, 'culled for a closer entity');
                    this._cull(victim, reserved, push);
                } else if (!e.missed) {
                    e.missed = true; // counted once per entity, not once per tick
                    this._count(this.stats.dropped, 'no free entity slot');
                    this._count(this.stats.slotMisses, e.type);
                }
            }
        }

        // Moves and looks for entities the model could already see: touched this tick, or left stale by a dropped row.
        const moving = new Set(T.touched);
        for (const id of this.stale) moving.add(id);
        this.stale.clear();
        for (const id of moving) {
            const e = S.entities.get(id);
            if (!e || (!e.visible && !e.isPlayer)) continue;
            if (e.isPlayer && !P.known) continue;
            let row = null;
            if (e.isPlayer) {
                // the player is the client's own input: deltas against the tick before, no belief to keep
                e.visible = true;
                const prev = e.prev;
                e.prev = null;
                if (!prev) continue;
                const du = [(e.x - prev.x) * 4096, (e.y - prev.y) * 4096, (e.z - prev.z) * 4096].map(Math.round);
                const turned = prev.yaw !== e.yaw || prev.pitch !== e.pitch || prev.headYaw !== e.headYaw;
                if (du.some((v) => v !== 0) || turned) row = du.some((v) => Math.abs(v) > TELEPORT_UNITS) ? this._tpRow(e, 'in') : this._moveRow(e, du, 'in');
            } else {
                if (e.rowTick === this.tick || !e.b) continue; // spawned this tick: the spawn row has it
                const b = e.b;
                const du = [(e.x - b.x) * 4096, (e.y - b.y) * 4096, (e.z - b.z) * 4096].map(Math.round);
                const turned = b.yaw !== e.yaw || b.pitch !== e.pitch || b.headYaw !== e.headYaw;
                if (du.some((v) => Math.abs(v) > TELEPORT_UNITS)) row = this._tpRow(e, 'out');
                else if (du.some((v) => v !== 0) || turned) row = this._moveRow(e, du, 'out');
            }
            if (row) push(row);
            const v = T.velocity.get(id);
            if (v) {
                push(this._velRow(e, v, e.isPlayer ? 'in' : 'out'));
                T.velocity.delete(id);
            }
        }
        // metadata and equipment changes for entities the model could already see
        for (const id of new Set([...T.metaTouched, ...this.carryMeta])) {
            const e = S.entities.get(id);
            if (!e || !(e.visible || e.isPlayer)) continue;
            for (const r of this._entityStateRows(e, false, 'out')) push(r);
        }
        this.carryMeta.clear();
        // velocity for entities whose only packet was entity_velocity
        for (const [id, v] of T.velocity) {
            const e = S.entities.get(id);
            if (e && e.visible && !e.isPlayer) push(this._velRow(e, v, 'out'));
        }

        // Blocks near the focus.
        const changed = [];
        const fx = Math.floor(P.x);
        const fy = Math.floor(P.y);
        const fz = Math.floor(P.z);
        for (const b of T.blocks.values()) {
            if (b.old === b.new) continue;
            if (this.info.isInvisibleChange(b.old, b.new)) continue; // leaf distance: the server's bookkeeping, nothing the client shows
            if (!P.known) {
                this._count(this.stats.dropped, 'block row before player position known');
                continue;
            }
            const ox = b.x - fx;
            const oy = b.y - fy;
            const oz = b.z - fz;
            if (Math.max(Math.abs(ox), Math.abs(oy), Math.abs(oz)) > BLOCK_RANGE) {
                this._count(this.stats.dropped, 'block out of range');
                continue;
            }
            push({
                row: 'BLOCK', io: 'out', ox, oy, oz, block: this.cat.blockState(b.new),
                tokens: ['BLOCK', `bx${ox}`, `by${oy}`, `bz${oz}`, `blk:${this.cat.blockState(b.new)}`],
            });
            changed.push(b);
        }

        if (this.groundNext) {
            push({ row: 'GLOBAL', io: 'eng', kind: 'ground', tokens: ['GLOBAL', 'g:ground', ...this.groundNext] });
            this.groundNext = null;
        }
        if (this.clockNext) {
            push({ row: 'GLOBAL', io: 'eng', kind: 'clock', tokens: ['GLOBAL', 'g:clock', ...this.clockNext] });
            this.clockNext = null;
        }

        // Hold initial context until position is known: dataset export omits pre-position ticks.
        // Repeat it within the context window, and whenever authoritative engine state changes.
        if (P.known && (S.playerContextAt === null || this.tick - S.playerContextAt >= 40 || T.contextChanged)) {
            const context = (field, tokens) => push({ row: 'GLOBAL', io: 'eng', field, tokens: ['GLOBAL', `g:${field}`, ...tokens] });
            if (S.globals.gamemode !== undefined) context('gamemode', intTokens('v', S.globals.gamemode));
            if (S.opLevel !== null) context('op_level', intTokens('v', S.opLevel));
            if (S.abilities) {
                const a = S.abilities;
                context('abilities', [...intTokens('v', a.flags), ...floatToken('fly', a.flyingSpeed), ...floatToken('walk', a.walkingSpeed)]);
            }
            S.playerContextAt = this.tick;
        }

        // Context rows (engine rows): the neighbors of what changed, and of what the player dug or placed. What a
        // change leaves around it is what decides the next one (leaves after a log, wire after a lever).
        if (P.known) {
            const fresh = changed.map((b) => this._neighborhood(b.x, b.y, b.z)).filter(Boolean);
            let later;
            if (this.deferNear) {
                later = this.nextNear;
                this.nextNear = fresh;
            } else later = fresh;
            const seen = new Set();
            for (const n of [...T.near, ...later]) {
                const key = `${n.x},${n.y},${n.z}`;
                if (seen.has(key) || seen.size >= MAX_NEAR_ROWS) continue;
                const row = this._nearRow(n);
                if (row) {
                    seen.add(key);
                    push(row);
                }
            }
        }

        // Slots.
        for (const s of T.slots.values()) {
            const o = s.old;
            if (o && o.item === s.new.item && o.count === s.new.count && o.blob === s.new.blob) continue;
            if (!o && s.new.count === 0) continue; // empty to empty
            push({
                row: 'SLOT', io: 'out', kind: 'SET', window: s.w, index: s.i, item: s.new.item, count: s.new.count,
                tokens: ['SLOT', 'SET', ...intTokens('w', s.w < 0 ? 0 : s.w), ...intTokens('i', s.i), `item:${s.new.item}`, ...intTokens('n', s.new.count), ...(s.new.blob ? [`blob:${s.new.blob}`] : [])],
            });
        }

        // Events. The slot of an entity the model cannot see cannot be named, so those are dropped.
        const slotOf = (id) => {
            const e = S.entities.get(id) || T.destroyed.find((x) => x.entity.id === id)?.entity;
            if (!e) return null;
            return e.isPlayer ? 0 : e.visible || e.slot !== null ? e.slot : null;
        };
        for (const ev of T.events) {
            const slot = ev.entityId === null || ev.entityId === undefined ? undefined : slotOf(ev.entityId);
            if (slot === null) {
                this._count(this.stats.dropped, 'event on an entity outside the scene');
                continue;
            }
            const tokens = slot === undefined ? ['EVENT', ev.kind] : ['EVENT', `s${slot}`, ev.kind];
            const r = { row: 'EVENT', io: ev.io, kind: ev.kind, slot };
            if (ev.targetId !== undefined) {
                const ts = slotOf(ev.targetId);
                r.target = ts;
                tokens.push(ts === null ? 'tUNKNOWN' : `t${ts}`);
            }
            if (ev.kind === 'DAMAGE') {
                r.damageType = ev.damageType;
                tokens.push(`dmg${ev.damageType}`);
            }
            if (ev.kind === 'STATUS') tokens.push(...intTokens('st', ev.status));
            if (ev.kind === 'ACTION') tokens.push(`act:${ev.action}`);
            if (ev.tokens) tokens.push(...ev.tokens);
            r.tokens = tokens;
            push(r);
        }
        const ctx = { slotOf, rel: (x, y, z) => this._relPos(x, y, z), P };
        for (const fn of T.later) {
            const r = fn(ctx);
            if (r) push(r);
        }
        if (T.sync) {
            const dx = [(P.x - T.sync.from[0]), (P.y - T.sync.from[1]), (P.z - T.sync.from[2])].map((v) => Math.round(v * 4096));
            const tokens = ['EVENT', 's0', 'SYNC'];
            ['dx', 'dy', 'dz'].forEach((f, i) => tokens.push(f, ...Q.toTokens(Q.quantize(dx[i]))));
            push({ row: 'EVENT', io: 'out', kind: 'SYNC', slot: 0, delta: dx, tokens });
        }

        // Globals.
        for (const [field, v] of Object.entries(T.globals)) {
            S.globals[field] = v;
            // A model-owned game mode change becomes engine context on the following tick.
            if (field === 'gamemode') S.playerContextAt = null;
            push({ row: 'GLOBAL', io: 'out', field, value: v, tokens: ['GLOBAL', `g:${field}`, ...intTokens('v', v)] });
        }

        // One fixed order, then the per-tick cap.
        rows.sort(
            (a, b) =>
                ROW_ORDER[a.row] - ROW_ORDER[b.row] ||
                (a.slot ?? -1) - (b.slot ?? -1) ||
                (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9)
        );
        // The per-tick cap drops only rows that can be retried: moves, velocities, metadata and equipment, farthest
        // first. SPAWN, DESPAWN and TP rows define which entities exist, so they are never dropped.
        let kept = rows;
        if (rows.length > MAX_ROWS_PER_TICK) {
            const droppable = rows.filter((r) => r.row === 'ENTITY' && ['MOVE', 'VEL', 'META', 'EQUIP'].includes(r.kind) && !(r.io === 'in'));
            droppable.sort((a, b) => b.dist - a.dist);
            const drop = new Set(droppable.slice(0, rows.length - MAX_ROWS_PER_TICK));
            this._count(this.stats.dropped, 'over the per-tick row cap', drop.size);
            if (rows.length - drop.size > MAX_ROWS_PER_TICK) this._count(this.stats.dropped, 'structural rows over the per-tick row cap', rows.length - drop.size - MAX_ROWS_PER_TICK);
            kept = rows.filter((r) => !drop.has(r));
            for (const r of drop) {
                // retry what was lost: the entity is revisited next tick, against the unchanged belief
                if (r.kind === 'MOVE') this.stale.add(r.entityId);
                else if (r.kind === 'META' || r.kind === 'EQUIP') {
                    const e = S.entities.get(r.entityId);
                    if (e) {
                        if (r.kind === 'META') (e.metaDirty || (e.metaDirty = new Set())).add(r.key);
                        else (e.equipDirty || (e.equipDirty = new Set())).add(r.equipSlot);
                        this.carryMeta.add(e.id);
                    }
                }
            }
        }
        for (const r of kept) {
            if (r._commit) r._commit();
            delete r._commit;
        }

        // Free the slots reserved this tick.
        for (const e of S.entities.values()) e.prev = null;
        const tick = this.tick;
        // The ground grid is taken now, from the world as this tick left it, and sent with the next tick's rows, so it
        // never shows a change the model is still to write.
        const at = this.groundAt;
        if (P.known && (!at || tick - at.tick >= GROUND_EVERY || Math.hypot(P.x - at.x, P.z - at.z) >= GROUND_MOVED)) {
            this.groundNext = this._groundTokens();
            this.groundAt = { tick, x: P.x, z: P.z };
        }
        if (this.terrain && (tick + 1) % TERRAIN_EVERY === 0) this.terrainNext = this._terrainPatch();
        // The time of day, as the model needs it to change it (`/time add`) and to act on it. Taken now and sent with the next
        // tick's rows, so a time set in the next tick is not in it.
        const clk = S.clock;
        if (clk?.time !== undefined && clk.tick !== undefined && (this.clockAt === null || tick - this.clockAt >= CLOCK_EVERY || T.globals.timeset !== undefined)) {
            const locked = clk.time < 0n;
            const abs = (locked ? -clk.time : clk.time) + (locked ? 0n : BigInt(tick - clk.tick));
            this.clockNext = [...intTokens('v', Number(((abs % 24000n) + 24000n) % 24000n)), locked ? 'locked' : 'free'];
            this.clockAt = tick;
        }
        const player = { entityId: S.playerId, x: P.x, y: P.y, z: P.z, yaw: P.yaw, pitch: P.pitch, known: P.known };
        const scene = this.snapshot
            ? [...S.entities.values()].filter((e) => e.visible && !e.isPlayer).map((e) => ({ slot: e.slot, id: e.id, type: e.type, x: e.x, y: e.y, z: e.z, yaw: e.yaw, pitch: e.pitch, headYaw: e.headYaw }))
            : undefined;
        this._openTick();
        return { tick, rows: kept, player, scene, names: S.names, blobs: this.blobs, terrain: terrain ?? undefined };
    }

    // Store a value the tokens cannot carry (item components, NBT) and return its id. The writer reads it back.
    _blob(kind, value) {
        const id = crypto.createHash('sha1').update(JSON.stringify([kind, value], (k, v) => (typeof v === 'bigint' ? v.toString() : v)) ?? 'null').digest('hex').slice(0, 8);
        if (!this.blobs.has(id)) this.blobs.set(id, { kind, value });
        return id;
    }

    // Slot the model knows an entity by, or null if it is not in the scene. The player is always slot 0.
    _slotForId(id) {
        if (id === this.S.playerId) return 0;
        const e = this.S.entities.get(id);
        return e && e.visible ? e.slot : null;
    }

    _cull(e, reserved, push) {
        reserved.add(e.slot);
        this.S.slotToId[e.slot] = null;
        push(this._entityRow(e, e.slot, 'DESPAWN', 'eng', { why: 'far' }));
        e.visible = false;
        e.slot = null;
        e.prev = null;
    }

    // Rows for an entity's stored metadata and equipment: all of it (when it enters the scene) or only
    // what changed this tick. One row per changed (slot, index).
    _entityStateRows(e, all, io) {
        const rows = [];
        const meta = e.meta || new Map();
        const keys = all ? [...meta.keys()] : [...(e.metaDirty || [])].filter((k) => meta.has(k));
        for (const k of keys.sort((a, b) => a - b)) {
            const m = meta.get(k);
            const mk = `mk:${e.type}:${k}:${m.type}`; // the serializer is implied by (type, index); naming it lets the writer invert the value tokens
            rows.push({ row: 'ENTITY', io: m.io === 'in' ? 'in' : io, kind: 'META', slot: e.slot, entityId: e.id, key: k, dist: this._dist(e), tokens: ['ENTITY', `s${e.slot}`, 'META', mk, ...(all ? m.abs || m.tokens : m.tokens)] });
        }
        const eq = e.equip || new Map();
        const slots = all ? [...eq.keys()] : [...(e.equipDirty || [])].filter((k) => eq.has(k));
        for (const k of slots.sort((a, b) => a - b)) {
            rows.push({ row: 'ENTITY', io, kind: 'EQUIP', slot: e.slot, entityId: e.id, equipSlot: k, dist: this._dist(e), tokens: ['ENTITY', `s${e.slot}`, 'EQUIP', `eq${k}`, ...eq.get(k).tokens] });
        }
        e.metaDirty = null;
        e.equipDirty = null;
        return rows;
    }

    // ---- row builders --------------------------------------------------------------------------------
    _dist(e) {
        const P = this.S.player;
        return Math.hypot(e.x - P.x, e.y - P.y, e.z - P.z);
    }

    _quantTokens(field, units, cls = 'move') {
        return this._quant(field, units, cls).tokens;
    }

    // A position relative to the focus, in 1/16 block: the whole-block offset (-64..63) and the sixteenth within it.
    // Exact at that resolution, unlike the log buckets, whose error grows with distance.
    _lattice(field, units) {
        const block = Math.max(-64, Math.min(63, Math.floor(units / 16)));
        const frac = Math.max(0, Math.min(15, units - block * 16));
        return { tokens: [field, `ob${block}`, `of${frac}`], deq: block * 16 + frac };
    }

    // Tokens for a field plus the value they decode to, which is what a client following the rows ends up with.
    _quant(field, units, cls = 'move') {
        const q = Q.quantize(units);
        const back = Q.dequantize(q);
        this.stats.quant.n++;
        const absUnits = Math.abs(back - units);
        const relErr = units ? absUnits / Math.abs(units) : 0;
        if (this.stats.quant.absUnits.length < 200000) {
            this.stats.quant.absUnits.push(absUnits);
            this.stats.quant.relErr.push(relErr);
        }
        return { tokens: [field, ...Q.toTokens(q)], deq: back };
    }

    _entityRow(e, slot, kind, io, extra = {}) {
        const tokens = ['ENTITY', `s${slot}`, kind];
        if (kind === 'DESPAWN') tokens.push(`why:${extra.why}`);
        return { row: 'ENTITY', io, kind, slot, entityId: e.id, type: e.type, dist: this._dist(e), tokens, ...extra };
    }

    _spawnRow(e, io) {
        const P = this.S.player;
        const rel = [e.x - P.x, e.y - P.y, e.z - P.z].map((v) => Math.round(v * 16));
        const tokens = ['ENTITY', `s${e.slot}`, 'SPAWN', `type:${e.type}`];
        const deq = ['px', 'py', 'pz'].map((f, i) => {
            const q = this._lattice(f, rel[i]);
            tokens.push(...q.tokens);
            return q.deq;
        });
        tokens.push(`yaw${e.yaw}`, `pitch${e.pitch}`, `hy${e.headYaw}`);
        // what a client following the rows now believes: the position the tokens decode to
        e.b = { x: P.x + deq[0] / 16, y: P.y + deq[1] / 16, z: P.z + deq[2] / 16, yaw: e.yaw, pitch: e.pitch, headYaw: e.headYaw };
        if (e.xp !== undefined) tokens.push(...intTokens('xp', e.xp));
        // Data field: orientation, block state or owner, by entity type
        tokens.push(...dataTokens(e.type, e.data ?? 0, { blockState: (id) => this.cat.blockState(id), slotOfId: (id) => this._slotForId(id) }));
        const v = this.T.velocity.get(e.id);
        if (v) ['vx', 'vy', 'vz'].forEach((f, i) => tokens.push(...this._quantTokens(f, v[i], 'vel')));
        return { row: 'ENTITY', io, kind: 'SPAWN', slot: e.slot, entityId: e.id, type: e.type, rel, dist: this._dist(e), tokens };
    }

    // A move is the gap between the entity and what a client following the rows believes. Quantization
    // error and dropped rows therefore correct themselves instead of accumulating. The belief only
    // changes if the row is kept (see commit), so a row dropped by the cap is retried next tick.
    _moveRow(e, du, io) {
        const tokens = ['ENTITY', `s${e.slot}`, 'MOVE'];
        const deq = ['dx', 'dy', 'dz'].map((f, i) => {
            const q = this._quant(f, du[i]);
            tokens.push(...q.tokens);
            return q.deq;
        });
        tokens.push(`yaw${e.yaw}`, `pitch${e.pitch}`, `hy${e.headYaw}`);
        const r = { row: 'ENTITY', io, kind: 'MOVE', slot: e.slot, entityId: e.id, delta: du, deq, dist: this._dist(e), tokens };
        if (e.b) {
            r._commit = () => {
                e.b.x += deq[0] / 4096;
                e.b.y += deq[1] / 4096;
                e.b.z += deq[2] / 4096;
                Object.assign(e.b, { yaw: e.yaw, pitch: e.pitch, headYaw: e.headYaw });
            };
        }
        return r;
    }

    _tpRow(e, io) {
        const P = this.S.player;
        const rel = [e.x - P.x, e.y - P.y, e.z - P.z].map((v) => Math.round(v * 16));
        const tokens = ['ENTITY', `s${e.slot}`, 'TP'];
        const deq = ['px', 'py', 'pz'].map((f, i) => {
            const q = this._lattice(f, rel[i]);
            tokens.push(...q.tokens);
            return q.deq;
        });
        tokens.push(`yaw${e.yaw}`, `pitch${e.pitch}`, `hy${e.headYaw}`);
        if (!e.isPlayer) e.b = { x: P.x + deq[0] / 16, y: P.y + deq[1] / 16, z: P.z + deq[2] / 16, yaw: e.yaw, pitch: e.pitch, headYaw: e.headYaw };
        return { row: 'ENTITY', io, kind: 'TP', slot: e.slot, entityId: e.id, rel, dist: this._dist(e), tokens };
    }

    _velRow(e, v, io) {
        const tokens = ['ENTITY', `s${e.slot}`, 'VEL'];
        ['vx', 'vy', 'vz'].forEach((f, i) => tokens.push(...this._quantTokens(f, v[i], 'vel')));
        return { row: 'ENTITY', io, kind: 'VEL', slot: e.slot, entityId: e.id, vel: v, dist: this._dist(e), tokens };
    }
}

// Handlers by family. Each file exports methods named s2c_<packet> / c2s_<packet> that update S and
// queue rows, mixed into the Reader.
for (const f of ['entity', 'world', 'inventory', 'text']) Object.assign(Reader.prototype, require(`./handlers/${f}`));

module.exports = { Reader, TICK_MS, MAX_ROWS_PER_TICK, TERRAIN_EVERY, TERRAIN_SIDE, TERRAIN_UNKNOWN, wrapAngle, degToAngle };
