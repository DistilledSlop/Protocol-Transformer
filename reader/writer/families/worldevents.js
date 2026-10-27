'use strict';
// World events: sounds, particles, explosions, world events, block actions, block break stages, block entity
// data, and the server moving the player (SYNC). Each kind is the inverse of a handler in handlers/world.js.
//
// LOSSY (the reader keeps less than the packet had, so the writer fills in a default):
//   PARTICLE   the particle's data (block state, dust colour, item, ...) is not in the row; PARTICLE_DATA gives a minimal valid one
//   EXPLOSION  the sound and the two particles, and the player's motion, are not in the row; defaults are used
//   SYNC       the deltas are quantized (about 1% of each value), so the position is off by that much
//   BLOCK_ACTION, DIG_STAGE, WORLD_EVENT, SOUND: none beyond the rounding noted below

const SOUND_CATEGORIES = ['master', 'music', 'record', 'weather', 'block', 'hostile', 'neutral', 'player', 'ambient', 'voice'];

// Particles that carry data on the wire. The reader keeps only the type, so these are the minimal valid values (LOSSY).
const PARTICLE_DATA = {
    block: 0,
    block_marker: 0,
    falling_dust: 0,
    dust_pillar: 0,
    dust: { red: 1, green: 0, blue: 0, scale: 1 },
    dust_color_transition: { fromRed: 1, fromGreen: 0, fromBlue: 0, scale: 1, toRed: 0, toGreen: 0, toBlue: 1 },
    entity_effect: 0,
    item: { itemCount: 0 },
    sculk_charge: 0,
    shriek: 0,
    vibration: { positionType: 'block', position: { x: 0, y: 0, z: 0 }, ticks: 0 },
};

// A float token, e.g. 'vol:0.5'. Refuses anything that is not a finite number.
function float(c, prefix) {
    const t = c.next();
    const m = new RegExp(`^${prefix}:(-?\\d+(?:\\.\\d+)?(?:e[-+]?\\d+)?)$`).exec(t);
    if (!m) throw new Error(`expected ${prefix}:<float>, got ${t}`);
    return Number(m[1]);
}

// A block offset from the focus block: bx, by, bz.
function blockOffset(c) {
    return ['bx', 'by', 'bz'].map((p) => {
        const t = c.next();
        const m = new RegExp(`^${p}(-?\\d+)$`).exec(t);
        if (!m) throw new Error(`expected ${p}<n>, got ${t}`);
        return Number(m[1]);
    });
}

// The sound holder: snd<id> is a registry id. Inline definitions (snd:<name>) are refused: the encoder
// in minecraft-protocol writes them wrong, so they would reach the client as garbage.
function soundId(c) {
    const t = c.next();
    const m = /^snd(\d+)$/.exec(t);
    if (m) return Number(m[1]);
    if (t.startsWith('snd:')) throw new Error('inline sound definition is not written');
    throw new Error(`expected snd<id>, got ${t}`);
}

function soundCategory(c) {
    const t = c.next();
    const m = /^cat:([a-z]+)$/.exec(t);
    if (!m || !SOUND_CATEGORIES.includes(m[1])) throw new Error(`bad sound category ${t}`);
    return m[1];
}

// Room-wide events name their position; entity events name their slot in the head instead.
const parse = {
    'EVENT SOUND': (c, head) => {
        const sound = soundId(c);
        const category = soundCategory(c);
        const rel = head.slot === null ? [c.lattice('px'), c.lattice('py'), c.lattice('pz')] : null;
        const volume = float(c, 'vol');
        const pitch = c.int('pi') / 32;
        return { sound, category, rel, volume, pitch };
    },

    // flags: bit0 = source present, bit1 = sound present. 'bits0' stands for no bits.
    'EVENT STOP_SOUND': (c) => {
        let flags = 0;
        while (!c.eof() && /^bits?\d$/.test(c.peek())) {
            const t = c.next();
            if (t === 'bits0') continue;
            const i = Number(t.slice(3));
            if (i > 1) throw new Error(`stop_sound has no flag bit ${i}`);
            flags |= 1 << i;
        }
        const out = { flags };
        if (!c.eof() && /^cat:\d+$/.test(c.peek())) out.source = Number(c.next().slice(4));
        if (!c.eof() && c.peek().startsWith('snd:')) out.sound = c.next().slice(4);
        if ((flags & 1) !== (out.source === undefined ? 0 : 1)) throw new Error('stop_sound source does not match its flags');
        if ((flags & 2) !== (out.sound === undefined ? 0 : 2)) throw new Error('stop_sound sound does not match its flags');
        return out;
    },

    'EVENT PARTICLE': (c) => {
        const m = /^pt:([a-z0-9_]+)$/.exec(c.next());
        if (!m) throw new Error('PARTICLE without a type');
        const rel = [c.lattice('px'), c.lattice('py'), c.lattice('pz')];
        const amount = c.int('n');
        const offset = [float(c, 'ox'), float(c, 'oy'), float(c, 'oz')];
        const speed = float(c, 'ps');
        return { type: m[1], rel, amount, offset, speed };
    },

    'EVENT EXPLOSION': (c) => {
        const rel = [c.lattice('px'), c.lattice('py'), c.lattice('pz')];
        const radius = float(c, 'rad');
        const interaction = c.int('bi');
        return { rel, radius, interaction };
    },

    'EVENT WORLD_EVENT': (c) => {
        const effectId = c.int('we');
        if (c.peek() === 'bFAR') throw new Error('WORLD_EVENT beyond the row range');
        const offset = blockOffset(c);
        const data = c.int('data');
        const g = c.next();
        if (g !== 'global' && g !== 'local') throw new Error(`expected global or local, got ${g}`);
        return { effectId, offset, data, global: g === 'global' };
    },

    'EVENT BLOCK_ACTION': (c) => {
        const offset = blockOffset(c);
        const m = /^blk:([a-z0-9_]+)$/.exec(c.next());
        if (!m) throw new Error('BLOCK_ACTION without a block');
        const byte1 = c.int('a');
        const byte2 = c.int('b');
        return { offset, block: m[1], byte1, byte2 };
    },

    // the digger is the optional slot in the head; none means entity 0
    'EVENT DIG_STAGE': (c) => ({ offset: blockOffset(c), stage: c.int('stage') }),

    'BLOCK ENTITY_DATA': (c) => {
        const action = c.int('bet');
        const m = /^blob:([0-9a-f]+)$/.exec(c.next());
        if (!m) throw new Error('ENTITY_DATA without a blob');
        return { action, blob: m[1] };
    },

    // the server moved the player: three quantized deltas in 1/4096 block (the head names slot 0)
    'EVENT SYNC': (c, head) => {
        if (head.slot !== 0) throw new Error('SYNC without the player slot');
        return { delta: [c.quant('dx'), c.quant('dy'), c.quant('dz')] };
    },
};

// Block location from the player's block and a row offset.
const blockLocation = (o, P) => ({ x: Math.floor(P.x) + o[0], y: Math.floor(P.y) + o[1], z: Math.floor(P.z) + o[2] });

const compile = {
    // Sound Effect is room-wide (position, 8 per block); Entity Sound Effect names the entity.
    'EVENT SOUND'(p, ctx, tick) {
        const sound = { soundId: p.sound };
        if (p.slot !== null) {
            const id = this._entityId(p.slot, ctx);
            if (id === null) return this._reject('SOUND on an empty slot');
            return tick.add('event', { name: 'entity_sound_effect', params: { sound, soundCategory: p.category, entityId: id, volume: p.volume, pitch: p.pitch, seed: 0n } });
        }
        const [x, y, z] = this._world(p.rel, ctx.player).map((v) => Math.round(v * 8));
        tick.add('event', { name: 'sound_effect', params: { sound, soundCategory: p.category, x, y, z, volume: p.volume, pitch: p.pitch, seed: 0n } });
    },

    // the reader gives the source as the category number, and the sound name as a string
    'EVENT STOP_SOUND'(p, ctx, tick) {
        const params = { flags: p.flags };
        if (p.source !== undefined) params.source = p.source;
        if (p.sound !== undefined) params.sound = p.sound;
        tick.add('event', { name: 'stop_sound', params });
    },

    'EVENT PARTICLE'(p, ctx, tick) {
        if (!this.cat.md.particlesByName[p.type]) return this._reject('PARTICLE of an unknown type');
        const particle = { type: p.type };
        if (Object.hasOwn(PARTICLE_DATA, p.type)) particle.data = PARTICLE_DATA[p.type]; // LOSSY: the data is a default
        const [x, y, z] = this._world(p.rel, ctx.player);
        tick.add('event', { name: 'world_particles', params: { longDistance: false, x, y, z, offsetX: p.offset[0], offsetY: p.offset[1], offsetZ: p.offset[2], velocityOffset: p.speed, amount: p.amount, particle } });
    },

    // LOSSY: sound and particles are fixed. Sound 0 stands in for the explosion sound (the catalogue has
    // no sound names for the reader's ids), and the player's motion is zero.
    'EVENT EXPLOSION'(p, ctx, tick) {
        const [x, y, z] = this._world(p.rel, ctx.player);
        const explodeSound = this.cat.md.soundsByName['entity.generic.explode']?.id ?? 0;
        tick.add('event', {
            name: 'explosion',
            params: {
                x, y, z, radius: p.radius, affectedBlockOffsets: [], playerMotionX: 0, playerMotionY: 0, playerMotionZ: 0,
                block_interaction_type: p.interaction,
                small_explosion_particle: { type: 'explosion' },
                large_explosion_particle: { type: 'explosion_emitter' },
                sound: { soundId: explodeSound },
            },
        });
    },

    'EVENT WORLD_EVENT'(p, ctx, tick) {
        tick.add('event', { name: 'world_event', params: { effectId: p.effectId, location: blockLocation(p.offset, ctx.player), data: p.data, global: p.global } });
    },

    'EVENT BLOCK_ACTION'(p, ctx, tick) {
        let blockId;
        try {
            blockId = this.cat.blockId(p.block);
        } catch (e) {
            return this._reject('BLOCK_ACTION with an unknown block');
        }
        tick.add('event', { name: 'block_action', params: { location: blockLocation(p.offset, ctx.player), byte1: p.byte1, byte2: p.byte2, blockId } });
    },

    'EVENT DIG_STAGE'(p, ctx, tick) {
        // no digger in the row means entity 0
        const entityId = (p.slot === null ? null : this._entityId(p.slot, ctx)) ?? 0;
        tick.add('event', { name: 'block_break_animation', params: { entityId, location: blockLocation(p.offset, ctx.player), destroyStage: p.stage } });
    },

    'BLOCK ENTITY_DATA'(p, ctx, tick) {
        const b = ctx.blobs?.get(p.blob);
        if (!b || b.kind !== 'nbt') return this._reject('ENTITY_DATA with no NBT blob');
        tick.add('block', { name: 'tile_entity_data', params: { location: blockLocation(p.offset, ctx.player), action: p.action, nbtData: b.value } });
    },

    // LOSSY: the deltas are quantized. The packet is relative on every axis, with yaw and pitch unchanged.
    'EVENT SYNC'(p, ctx, tick) {
        this.teleportId = (this.teleportId ?? 0) + 1;
        const [x, y, z] = p.delta.map((u) => u / 4096);
        tick.add('event', {
            name: 'position',
            params: { x, y, z, yaw: 0, pitch: 0, flags: { x: true, y: true, z: true, yaw: true, pitch: true }, teleportId: this.teleportId },
        });
    },
};

module.exports = { parse, compile, finish: [] };
