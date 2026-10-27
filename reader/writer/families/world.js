'use strict';
// Blocks and the world-level rows: block changes, health, experience, weather, game mode.

const intRest = (c) => ({ value: c.int('v') });

const parse = {
    'BLOCK SET': () => ({}), // the block state was read with the head
    'GLOBAL *': intRest,
};

const compile = {
    'BLOCK SET'(p, ctx, tick) {
        tick.blocks.push(p);
    },

    'GLOBAL *'(p, ctx, tick) {
        const S = this.health;
        switch (p.field) {
            case 'health':
                S.health = p.value / 2; // half-hearts
                return tick.add('global', this._health());
            case 'food':
                S.food = p.value;
                return tick.add('global', this._health());
            case 'xp_bar':
                this.xp.bar = p.value / 64;
                return tick.add('global', this._experience());
            case 'xp_level':
                this.xp.level = p.value;
                return tick.add('global', this._experience());
            case 'rain':
                // the reader folds begin/stop raining and level changes into one 0-16 value
                return tick.add('global', { name: 'game_state_change', params: { reason: p.value === 0 ? 'stop_raining' : p.value === 16 ? 'begin_raining' : 'rain_level_change', gameMode: p.value / 16 } });
            case 'thunder':
                return tick.add('global', { name: 'game_state_change', params: { reason: 'thunder_level_change', gameMode: p.value / 16 } });
            case 'gamemode':
                return tick.add('global', { name: 'game_state_change', params: { reason: 'change_game_mode', gameMode: p.value } });
            // time passes by itself (ctx.clock is the engine's); the model only sets it, or locks and unlocks it
            case 'timeset': // the time of day in ticks, 0..23999
                if (!ctx.clock) return this._reject('time rows need the engine clock');
                ctx.clock.time = Math.floor(ctx.clock.time / 24000) * 24000 + (p.value % 24000);
                return tick.add('global', this._clock(ctx.clock));
            case 'timelock':
                if (!ctx.clock) return this._reject('time rows need the engine clock');
                ctx.clock.locked = p.value === 1;
                return tick.add('global', this._clock(ctx.clock));
            default:
                this._reject(`GLOBAL ${p.field} not compiled`);
        }
    },
};

const methods = {
    // Update Time for a clock {age, time, locked}: a locked day is sent as a negative time
    _clock(c) {
        return { name: 'update_time', params: { age: BigInt(c.age), time: BigInt(c.locked ? -Math.max(1, c.time) : c.time) } };
    },

    _health() {
        const h = this.health;
        return { name: 'update_health', params: { health: h.health, food: h.food, foodSaturation: h.saturation } };
    },

    // Total experience is not in the rows; it is rebuilt from level and bar with the vanilla formulas.
    _experience() {
        const { bar, level } = this.xp;
        const reach = level <= 16 ? level * level + 6 * level : level <= 31 ? 2.5 * level * level - 40.5 * level + 360 : 4.5 * level * level - 162.5 * level + 2220;
        const next = level <= 15 ? 2 * level + 7 : level <= 30 ? 5 * level - 38 : 9 * level - 158;
        return { name: 'experience', params: { experienceBar: bar, level, totalExperience: Math.round(reach + bar * next) } };
    },

    // Two or more changes in one 16x16x16 section go out as one Update Section Blocks.
    _blockPackets(rows, P) {
        const fx = Math.floor(P.x);
        const fy = Math.floor(P.y);
        const fz = Math.floor(P.z);
        const bySection = new Map();
        for (const r of rows) {
            let stateId;
            try {
                stateId = this.cat.blockStateId(r.block);
            } catch (e) {
                this._reject('BLOCK with an unknown block state');
                continue;
            }
            const x = fx + r.offset[0];
            const y = fy + r.offset[1];
            const z = fz + r.offset[2];
            const key = `${x >> 4},${y >> 4},${z >> 4}`;
            if (!bySection.has(key)) bySection.set(key, []);
            bySection.get(key).push({ x, y, z, stateId });
        }
        const out = [];
        for (const [key, list] of bySection) {
            if (list.length === 1) {
                const b = list[0];
                out.push({ name: 'block_change', params: { location: { x: b.x, y: b.y, z: b.z }, type: b.stateId } });
            } else {
                const [sx, sy, sz] = key.split(',').map(Number);
                out.push({
                    name: 'multi_block_change',
                    params: { chunkCoordinates: { x: sx, z: sz, y: sy }, records: list.map((b) => b.stateId * 4096 + (((b.x & 15) << 8) | ((b.z & 15) << 4) | (b.y & 15))) },
                });
            }
        }
        return out;
    },
};
require('../writer_methods').add(methods);

const finish = [
    function (tick) {
        if (tick.blocks.length) tick.add('block', ...this._blockPackets(tick.blocks, tick.ctx.player));
    },
];

module.exports = { parse, compile, finish };
