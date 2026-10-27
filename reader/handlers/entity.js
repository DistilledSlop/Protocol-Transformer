'use strict';
// Entity packets beyond movement: experience orbs, metadata, equipment, effects, passengers, leashes,
// pickups, entity events and the player's own movement-state inputs.

const { intTokens, bitTokens, floatToken, clampStr } = require('../tokens');

const jsonSafe = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x));

// entity_action ids, as numbers or as the names minecraft-protocol maps them to
const ACTION_NAMES = ['start_sneaking', 'stop_sneaking', 'stop_sleeping', 'start_sprinting', 'stop_sprinting', 'start_riding_jump', 'stop_riding_jump', 'open_inventory', 'start_fall_flying'];
const FLAG_ACTIONS = { start_sneaking: [0x02, true], stop_sneaking: [0x02, false], start_sprinting: [0x08, true], stop_sprinting: [0x08, false], start_fall_flying: [0x80, true] };

const ANIMATIONS = { 0: 'SWING_MAIN', 2: 'LEAVE_BED', 3: 'SWING_OFF', 4: 'CRIT', 5: 'MAGIC_CRIT' };

module.exports = {
    s2c_spawn_entity_experience_orb(d) {
        if (this._entity(d.entityId)) this._count(this.stats.dropped, 'respawn of known entity id');
        const e = this._newEntity(d.entityId, 'experience_orb', null, d.x, d.y, d.z, 0, 0);
        e.xp = d.count;
        e.spawnTick = this.tick;
        this._touch(e);
    },

    // Metadata value -> tokens. Health and air are small steps, so they are deltas against S; everything
    // else is a flag set, a small integer, a dictionary float or a catalogue entry.
    _metaTokens(e, key, type, value, prev) {
        switch (type) {
            case 'byte':
                return key === 0 ? bitTokens(value & 0xff) : intTokens('i', value & 0xff);
            case 'int':
            case 'long':
            case 'optional_int': {
                const v = Number(value ?? -1);
                if (key === 1 && type === 'int' && prev) return [`Δ${Math.max(-999, Math.min(999, v - Number(prev.value)))}`];
                return intTokens('i', v);
            }
            case 'float': {
                if (key === 9 && prev) return [`Δ${Math.round((value - prev.value) * 2)}`];
                if (key === 9) return ['abs', ...intTokens('i', Math.round(value * 2))];
                return floatToken('f', value);
            }
            case 'boolean':
                return [value ? 'true' : 'false'];
            case 'string':
                return this._textTokens(value);
            case 'component':
            case 'optional_component':
                return value === undefined || value === null ? ['none'] : this._compTokens(value);
            case 'item_stack':
                return this._itemTokens(value);
            case 'entity_pose':
            case 'pose':
                return [`pose:${value}`];
            case 'block_pos':
            case 'optional_block_pos':
                return value ? this._relPos(value.x + 0.5, value.y + 0.5, value.z + 0.5).tokens : ['none'];
            default:
                return [`v:${type}:${clampStr(jsonSafe(value) ?? 'null', 48)}`];
        }
    },

    s2c_entity_metadata(d) {
        const e = this._entity(d.entityId);
        if (!e) return;
        if (!e.meta) e.meta = new Map();
        for (const m of d.metadata) {
            if (m.key === 0xff) continue; // end marker
            const prev = e.meta.get(m.key);
            const tokens = this._metaTokens(e, m.key, m.type, m.value, prev);
            // compare values, not tokens: two equal health drops in a row have the same delta token
            const canon = `${m.type}:${jsonSafe(m.value)}`;
            if (prev && prev.canon === canon) continue;
            // the absolute form is kept so an entity entering the scene can be described in full
            const abs = m.key === 9 && m.type === 'float' ? ['abs', ...intTokens('i', Math.round(m.value * 2))] : m.key === 1 && m.type === 'int' ? intTokens('i', Number(m.value)) : null;
            e.meta.set(m.key, { type: m.type, value: m.value, tokens, abs, canon, io: 'out' });
            (e.metaDirty || (e.metaDirty = new Set())).add(m.key);
            this.T.metaTouched.add(e.id);
        }
    },

    s2c_entity_equipment(d) {
        const e = this._entity(d.entityId);
        if (!e) return;
        if (!e.equip) e.equip = new Map();
        for (const q of d.equipments) {
            const tokens = this._itemTokens(q.item);
            const canon = tokens.join(' ');
            const prev = e.equip.get(q.slot);
            if (prev && prev.canon === canon) continue;
            e.equip.set(q.slot, { tokens, canon });
            (e.equipDirty || (e.equipDirty = new Set())).add(q.slot);
            this.T.metaTouched.add(e.id);
        }
    },

    // Effects: active ones belong in the S snapshot; applying or changing one is an event.
    s2c_entity_effect(d) {
        const e = this._entity(d.entityId);
        if (!e) return;
        if (!e.effects) e.effects = new Map();
        e.effects.set(d.effectId, { amplifier: d.amplifier, duration: d.duration, tick: this.tick });
        this._later((ctx) => {
            const s = ctx.slotOf(d.entityId);
            if (s === null) return null;
            return this._evRow('out', 'EFFECT', s, [`eff${d.effectId}`, ...intTokens('a', d.amplifier), ...intTokens('t', d.duration), ...bitTokens(d.flags & 0x0f, 4)]);
        });
    },

    // Timer expiry, derived by the engine: S only.
    s2c_remove_entity_effect(d) {
        this._entity(d.entityId)?.effects?.delete(d.effectId);
    },

    s2c_set_passengers(d) {
        const e = this._entity(d.entityId);
        if (e) e.passengers = d.passengers;
        this._later((ctx) => {
            const s = ctx.slotOf(d.entityId);
            if (s === null) return null;
            const ps = d.passengers.map((id) => ctx.slotOf(id));
            return { row: 'ENTITY', io: 'out', kind: 'PASSENGERS', slot: s, tokens: ['ENTITY', `s${s}`, 'PASSENGERS', ...ps.map((p) => (p === null ? 'tUNKNOWN' : `t${p}`))] };
        });
    },

    // Link Entities (leash): vehicleId 0 detaches.
    s2c_attach_entity(d) {
        this._later((ctx) => {
            const s = ctx.slotOf(d.entityId);
            if (s === null) return null;
            const h = d.vehicleId ? ctx.slotOf(d.vehicleId) : null;
            return { row: 'ENTITY', io: 'out', kind: 'LINK', slot: s, tokens: ['ENTITY', `s${s}`, 'LINK', d.vehicleId ? (h === null ? 'tUNKNOWN' : `t${h}`) : 'none'] };
        });
    },

    // Pickup Item: the animation only; the inventory change is a separate SLOT row.
    s2c_collect(d) {
        this._later((ctx) => {
            const by = ctx.slotOf(d.collectorEntityId);
            const it = ctx.slotOf(d.collectedEntityId);
            if (by === null) return null;
            return this._evRow('out', 'PICKUP', by, [it === null ? 'tUNKNOWN' : `t${it}`, ...intTokens('n', d.pickupItemCount)]);
        });
    },

    // Entity Event: a status byte whose meaning depends on the entity type. 24-28 on the player are
    // the permission level, which belongs to the engine.
    s2c_entity_status(d) {
        if (d.entityId === this.S.playerId) {
            // Player-only statuses that are the engine's: permission level (24-28) and reduced debug info (22, 23)
            if (d.entityStatus >= 24 && d.entityStatus <= 28) return void (this.S.opLevel = d.entityStatus - 24);
            if (d.entityStatus === 22 || d.entityStatus === 23) return void (this.S.reducedDebug = d.entityStatus === 22);
        }
        const kind = { 2: 'HURT', 3: 'DEATH' }[d.entityStatus];
        this.T.events.push({ io: 'out', kind: kind || 'STATUS', status: d.entityStatus, entityId: d.entityId });
    },

    s2c_animation(d) {
        const kind = ANIMATIONS[d.animation];
        if (kind) this.T.events.push({ io: 'out', kind, entityId: d.entityId });
        else this._count(this.stats.unhandled, `S2C animation ${d.animation}`);
    },

    // Derived by the engine from entity type, effects and equipment: kept in S, no row.
    s2c_entity_update_attributes(d) {
        const e = this._entity(d.entityId);
        if (!e) return;
        if (!e.attrs) e.attrs = new Map();
        // Counted so a server-specific change (the case that would make this packet hybrid) is visible:
        // 'initial' comes with a spawn, 'unchanged' is a re-send of the same value and modifiers.
        for (const p of d.properties) {
            const prev = e.attrs.get(p.key);
            const mods = jsonSafe(p.modifiers);
            const kind = !prev ? 'initial' : prev.value === p.value && prev.mods === mods ? 'unchanged' : 'changed';
            this._count(this.stats.byDesign, `DERIVED S2C entity_update_attributes (${kind})`);
            e.attrs.set(p.key, { value: p.value, modifiers: p.modifiers, mods });
        }
    },

    s2c_abilities(d) {
        this.S.abilities = d;
    },

    s2c_held_item_slot(d) {
        this.S.selectedSlot = d.slot;
    },

    // ---- serverbound: the player's own movement state -------------------------------------------------
    c2s_flying(d) {
        this.S.player.onGround = d.onGround;
    },

    // While riding, the vehicle's position is the player's.
    c2s_vehicle_move(d) {
        Object.assign(this.S.player, { x: d.x, y: d.y, z: d.z, yaw: d.yaw, pitch: d.pitch, known: true });
        this._syncPlayerEntity();
    },

    c2s_steer_boat(d) {
        const bits = (d.leftPaddle ? 1 : 0) | (d.rightPaddle ? 2 : 0);
        if (this.S.player.boat === bits) return;
        this.S.player.boat = bits;
        this._later(() => ({ row: 'ENTITY', io: 'in', kind: 'INPUT', slot: 0, tokens: ['ENTITY', 's0', 'INPUT', 'boat', ...bitTokens(bits, 2)] }));
    },

    // Sneak, sprint and elytra become slot-0 flags, in the same bits as the entity flags metadata.
    c2s_entity_action(d) {
        const name = typeof d.actionId === 'number' ? ACTION_NAMES[d.actionId] : d.actionId;
        const e = this._entity(this.S.playerId);
        if (!e) return;
        const flag = FLAG_ACTIONS[name];
        if (flag) {
            if (!e.meta) e.meta = new Map();
            const prev = e.meta.get(0);
            const cur = prev ? prev.value & 0xff : 0;
            const next = flag[1] ? cur | flag[0] : cur & ~flag[0];
            if (!prev || next !== cur) {
                const tokens = bitTokens(next);
                e.meta.set(0, { type: 'byte', value: next, tokens, abs: null, canon: tokens.join(' '), io: 'in' });
                (e.metaDirty || (e.metaDirty = new Set())).add(0);
                this.T.metaTouched.add(e.id);
            }
        } else {
            this.T.events.push({ io: 'in', kind: 'ACTION', entityId: this.S.playerId, action: name });
        }
    },

    // Player Input: movement keys, sampled each tick; only changes make a row.
    c2s_steer_vehicle(d) {
        const key = `${d.forward},${d.sideways},${d.jump}`;
        if (this.S.player.input === key) return;
        this.S.player.input = key;
        this._later(() => ({
            row: 'ENTITY', io: 'in', kind: 'INPUT', slot: 0,
            tokens: ['ENTITY', 's0', 'INPUT', ...floatToken('fw', d.forward), ...floatToken('sd', d.sideways), ...bitTokens(d.jump & 3, 2)],
        }));
    },

    c2s_abilities(d) {
        const flying = (d.flags & 0x02) !== 0;
        if (this.S.player.flying === flying) return;
        this.S.player.flying = flying;
        this.T.events.push({ io: 'in', kind: flying ? 'FLY_START' : 'FLY_STOP', entityId: this.S.playerId });
    },
};
