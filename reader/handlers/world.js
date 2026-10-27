'use strict';
// Blocks, effects in the world (sounds, particles, explosions), weather and time, chunk bookkeeping
// and the player's block-facing inputs.

const { intTokens, bitTokens, floatToken, toInt64 } = require('../tokens');

const TICKS_PER_DAY = 24000;
const jsonSafe = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x));
const offTokens = (o) => ['bx' + o[0], 'by' + o[1], 'bz' + o[2]];

module.exports = {
    // Set Block Destroy Stage: the model emits dig events, the engine times the stages 0-9.
    s2c_block_break_animation(d) {
        const o = this._blockOffset(d.location);
        if (!o) return this._count(this.stats.dropped, 'block out of range');
        this._later((ctx) => this._evRow('out', 'DIG_STAGE', ctx.slotOf(d.entityId), [...offTokens(o), ...intTokens('stage', d.destroyStage)]));
    },

    // Block Entity Data (signs, chests): the NBT sits behind a blob id and the compiler expands it.
    s2c_tile_entity_data(d) {
        const o = this._blockOffset(d.location);
        if (!o) return this._count(this.stats.dropped, 'block out of range');
        this._later(() => ({ row: 'BLOCK', io: 'out', kind: 'ENTITY_DATA', tokens: ['BLOCK', ...offTokens(o), 'ENTITY_DATA', ...intTokens('bet', d.action), `blob:${this._blob('nbt', d.nbtData)}`] }));
    },

    // Block Action uses the block id, not a block state.
    s2c_block_action(d) {
        const o = this._blockOffset(d.location);
        if (!o) return this._count(this.stats.dropped, 'block out of range');
        this.T.events.push({ io: 'out', kind: 'BLOCK_ACTION', entityId: null, tokens: [...offTokens(o), `blk:${this.cat.blockName(d.blockId)}`, ...intTokens('a', d.byte1), ...intTokens('b', d.byte2)] });
    },

    // Explosion: the model gives the position, strength and block interaction; the engine computes the
    // block records against the world store and the player's motion.
    s2c_explosion(d) {
        const { tokens } = this._relPos(d.x, d.y, d.z);
        this.T.events.push({ io: 'out', kind: 'EXPLOSION', entityId: null, tokens: [...tokens, ...floatToken('rad', d.radius), ...intTokens('bi', d.block_interaction_type)] });
    },

    s2c_world_event(d) {
        const o = this._blockOffset(d.location);
        const tokens = [...intTokens('we', d.effectId), ...(o ? offTokens(o) : ['bFAR']), ...intTokens('data', d.data), d.global ? 'global' : 'local'];
        this.T.events.push({ io: 'out', kind: 'WORLD_EVENT', entityId: null, tokens });
    },

    s2c_world_particles(d) {
        const { tokens } = this._relPos(d.x, d.y, d.z);
        this.T.events.push({
            io: 'out', kind: 'PARTICLE', entityId: null,
            tokens: [`pt:${d.particle?.type}`, ...tokens, ...intTokens('n', d.amount), ...floatToken('ox', d.offsetX), ...floatToken('oy', d.offsetY), ...floatToken('oz', d.offsetZ), ...floatToken('ps', d.velocityOffset)],
        });
    },

    _soundToken(sound) {
        if (!sound) return 'snd:none';
        // a registry sound has a soundId (0 is a real sound); an inline definition has none
        return sound.soundId !== undefined ? `snd${sound.soundId}` : `snd:${sound.soundEvent?.resource ?? sound.resource ?? 'inline'}`;
    },

    // Sound Effect: the position is a fixed-point int, 8 per block.
    s2c_sound_effect(d) {
        const { tokens } = this._relPos(d.x / 8, d.y / 8, d.z / 8);
        this.T.events.push({
            io: 'out', kind: 'SOUND', entityId: null,
            tokens: [this._soundToken(d.sound), `cat:${d.soundCategory}`, ...tokens, ...floatToken('vol', d.volume), ...intTokens('pi', Math.round(d.pitch * 32))],
        });
    },

    s2c_entity_sound_effect(d) {
        this._later((ctx) => {
            const s = ctx.slotOf(d.entityId);
            if (s === null) return null;
            return this._evRow('out', 'SOUND', s, [this._soundToken(d.sound), `cat:${d.soundCategory}`, ...floatToken('vol', d.volume), ...intTokens('pi', Math.round(d.pitch * 32))]);
        });
    },

    s2c_stop_sound(d) {
        const tokens = [...bitTokens(d.flags & 3, 2)];
        if (d.source !== undefined) tokens.push(`cat:${d.source}`);
        if (d.sound !== undefined) tokens.push(`snd:${d.sound}`);
        this.T.events.push({ io: 'out', kind: 'STOP_SOUND', entityId: null, tokens });
    },

    // Game Event: weather and game mode are model rows; the rest (start waiting for chunks, demo
    // messages, the respawn screen) are the engine's.
    s2c_game_state_change(d) {
        const r = d.reason;
        const set = (field, v) => {
            if (this.S.globals[field] === v) return;
            this.T.globals[field] = v;
        };
        if (r === 'begin_raining') set('rain', 16);
        else if (r === 'stop_raining') set('rain', 0);
        else if (r === 'rain_level_change') set('rain', Math.round(d.gameMode * 16));
        else if (r === 'thunder_level_change') set('thunder', Math.round(d.gameMode * 16));
        else if (r === 'change_game_mode') set('gamemode', d.gameMode);
        else this._count(this.stats.byDesign, `HYBRID S2C game_state_change ${r}`);
    },

    s2c_experience(d) {
        const bar = Math.round(d.experienceBar * 64);
        if (this.S.globals.xp_bar !== bar) this.T.globals.xp_bar = bar;
        if (this.S.globals.xp_level !== d.level) this.T.globals.xp_level = d.level;
    },

    // Update Time is the engine clock. A row appears only when the packet disagrees with the clock
    // (a time set) or time is frozen (a negative time of day means locked).
    s2c_update_time(d) {
        const S = this.S;
        const age = toInt64(d.age);
        const time = toInt64(d.time);
        const prev = S.clock;
        const locked = time < 0n;
        if (prev.tick !== undefined) {
            const dt = BigInt(this.tick - prev.tick);
            const prevAbs = prev.time < 0n ? -prev.time : prev.time;
            // a locked day stands still; an unlocked one has moved on by the ticks since the last packet
            const expected = prev.time < 0n ? prevAbs : prevAbs + dt;
            const abs = locked ? -time : time;
            const off = abs - expected;
            if (off > 2n || off < -2n) {
                // the time of day it was set to, in ticks
                this.T.globals.timeset = Number(((abs % BigInt(TICKS_PER_DAY)) + BigInt(TICKS_PER_DAY)) % BigInt(TICKS_PER_DAY));
            }
        }
        const lock = locked ? 1 : 0;
        if (lock !== (S.globals.timelock ?? 0)) this.T.globals.timelock = lock;
        S.clock = { age, time, tick: this.tick };
    },

    // ---- chunk bookkeeping (derived by the engine from the world store) -----------------------------------
    s2c_update_view_position(d) {
        this.S.center = { x: d.chunkX, z: d.chunkZ };
    },

    s2c_map_chunk(d) {
        this.S.loadedChunks.add(`${d.x},${d.z}`);
        try {
            if (d.chunkData?.decoded) this.S.world.setSections(d.x, d.z, d.chunkData.decoded); // a turned chunk (reader/augment.js)
            else this.S.world.setChunk(d.x, d.z, d.chunkData);
        } catch (e) {
            this._count(this.stats.dropped, 'chunk data not decoded');
        }
    },

    s2c_unload_chunk(d) {
        this.S.loadedChunks.delete(`${d.chunkX},${d.chunkZ}`);
        this.S.world.unload(d.chunkX, d.chunkZ);
    },

    // ---- serverbound: what the player does to blocks and items ----------------------------------------------
    // Player Action: dig start, cancel, finish, drops, swap hand. The sequence number is the engine's to ack.
    c2s_block_dig(d) {
        const n = this._neighborhood(d.location.x, d.location.y, d.location.z);
        if (n && d.status !== 1) this.T.near.push(n); // not a cancelled dig
        const o = this._blockOffset(d.location);
        const tokens = [...intTokens('dig', d.status), ...(o ? offTokens(o) : ['bFAR']), ...intTokens('fc', Math.max(0, d.face))];
        this.T.events.push({ io: 'in', kind: 'DIG', entityId: this.S.playerId, tokens });
    },

    // Use Item On: placing a block or interacting with one.
    c2s_block_place(d) {
        const n = this._neighborhood(d.location.x, d.location.y, d.location.z);
        if (n) this.T.near.push(n);
        const o = this._blockOffset(d.location);
        if (!o) return this._count(this.stats.dropped, 'block out of range');
        this._later(() => ({
            row: 'BLOCK', io: 'in', kind: 'PLACE',
            tokens: ['BLOCK', ...offTokens(o), 'PLACE', ...intTokens('fc', d.direction), d.hand === 0 ? 'main' : 'off', d.insideBlock ? 'inside' : 'outside'],
        }));
    },

    c2s_use_item(d) {
        this.T.events.push({ io: 'in', kind: 'USE_ITEM', entityId: this.S.playerId, tokens: [d.hand === 0 ? 'main' : 'off'] });
    },

    c2s_update_sign(d) {
        const o = this._blockOffset(d.location);
        if (!o) return this._count(this.stats.dropped, 'block out of range');
        this._later(() => ({
            row: 'BLOCK', io: 'in', kind: 'SIGN',
            tokens: ['BLOCK', ...offTokens(o), 'SIGN', d.isFrontText ? 'front' : 'back', ...[d.text1, d.text2, d.text3, d.text4].flatMap((t) => (t ? this._textTokens(t) : ['tpl:']))],
        }));
    },
};
