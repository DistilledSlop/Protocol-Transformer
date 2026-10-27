'use strict';
// Entity rows (spawn, despawn, motion, velocity) and the events about a single entity.

const collide = require('../collide');

const toI8 = (v) => (v << 24) >> 24; // protocol angles are signed bytes; the rows carry 0-255

const parse = {
    'ENTITY SPAWN': (c) => {
        const m = /^type:(.+)$/.exec(c.next());
        if (!m) throw new Error('SPAWN without a type');
        const out = { type: m[1], rel: [c.lattice('px'), c.lattice('py'), c.lattice('pz')], yaw: c.angle('yaw'), pitch: c.angle('pitch'), headYaw: c.angle('hy'), data: {}, vel: null };
        // optional tail, each part recognised by its prefix: xp, then Data (orientation, block state, owner), then velocity
        while (!c.eof()) {
            const t = c.peek();
            if (/^xp/.test(t)) out.xp = c.int('xp');
            else if (/^ori\d$/.test(t)) out.data.orientation = Number(c.next().slice(3));
            else if (t.startsWith('blk:')) out.data.blockState = c.next().slice(4);
            else if (/^own/.test(t)) {
                const o = c.next().slice(3);
                out.data.owner = o === 'NONE' || o === 'UNKNOWN' ? null : Number(o);
            } else if (t === 'emerging') {
                c.next();
                out.data.emerging = true;
            } else if (t === 'vx') out.vel = [c.quant('vx'), c.quant('vy'), c.quant('vz')];
            else throw new Error(`unexpected SPAWN token ${t}`);
        }
        return out;
    },
    'ENTITY DESPAWN': (c) => ({ why: c.next().replace(/^why:/, '') }),
    'ENTITY MOVE': (c) => ({ delta: [c.quant('dx'), c.quant('dy'), c.quant('dz')], yaw: c.angle('yaw'), pitch: c.angle('pitch'), headYaw: c.angle('hy') }),
    'ENTITY TP': (c) => ({ rel: [c.lattice('px'), c.lattice('py'), c.lattice('pz')], yaw: c.angle('yaw'), pitch: c.angle('pitch'), headYaw: c.angle('hy') }),
    'ENTITY VEL': (c) => ({ vel: [c.quant('vx'), c.quant('vy'), c.quant('vz')] }),
};

// events about an entity name its slot first
const entityEvent = (c, head) => {
    if (head.slot === null) throw new Error(`EVENT ${head.kind} without a slot`);
    return {};
};
for (const k of ['SWING_MAIN', 'SWING_OFF', 'HURT', 'DEATH', 'CRIT', 'MAGIC_CRIT', 'LEAVE_BED']) parse[`EVENT ${k}`] = entityEvent;
parse['EVENT DAMAGE'] = (c, head) => ({ ...entityEvent(c, head), damageType: c.int('dmg') });
parse['EVENT STATUS'] = (c, head) => ({ ...entityEvent(c, head), status: c.int('st') });

const compile = {
    'ENTITY DESPAWN'(p, ctx, tick) {
        const e = this.bySlot.get(p.slot);
        if (!e) return this._reject('DESPAWN of an empty slot');
        tick.destroy.push(e.id);
        tick.gone.push(p.slot);
    },

    'ENTITY SPAWN'(p, ctx, tick) {
        if (p.slot === 0 || this.bySlot.has(p.slot)) return this._reject('SPAWN into an occupied slot');
        let typeId;
        try {
            typeId = this.cat.entityTypeId(p.type);
        } catch (e) {
            return this._reject('SPAWN of an unknown entity type');
        }
        const id = this.nextEntityId++;
        const [x, y, z] = this._world(p.rel, ctx.player);
        const e = { id, uuid: this._uuid(id), type: p.type, x, y, z, yaw: p.yaw, pitch: p.pitch, headYaw: p.headYaw };
        this.bySlot.set(p.slot, e);
        // experience orbs have a spawn packet of their own in 1.21.1, with the amount instead of a rotation
        if (p.type === 'experience_orb') return tick.add('spawn', { name: 'spawn_entity_experience_orb', params: { entityId: id, x, y, z, count: p.xp ?? 1 } });
        const v = p.vel ?? [0, 0, 0];
        const spawn = {
            name: 'spawn_entity',
            params: { entityId: id, objectUUID: e.uuid, type: typeId, x, y, z, pitch: toI8(p.pitch), yaw: toI8(p.yaw), headPitch: toI8(p.headYaw), objectData: this._objectData(p, ctx), velocity: { x: v[0], y: v[1], z: v[2] } },
        };
        // a spawn travels in its own bundle so the client applies it in one tick
        tick.add('spawn', { name: 'bundle_delimiter', params: {} }, spawn, { name: 'bundle_delimiter', params: {} });
    },

    // Small moves use the delta packets; whether rotation changed picks the variant.
    'ENTITY MOVE'(p, ctx, tick) {
        if (p.slot === 0) return; // the player moves by its own input
        const e = this.bySlot.get(p.slot);
        if (!e) return this._reject('MOVE of an empty slot');
        let [dx, dy, dz] = p.delta;
        if (ctx.world && ctx.info) {
            // the engine holds the world: the entity stops at the first solid block in its way
            const want = [dx / 4096, dy / 4096, dz / 4096];
            const got = collide.resolve(ctx.world, ctx.info, collide.dimensions(this.cat.md, e.type), [e.x, e.y, e.z], want);
            if (got[0] !== want[0] || got[1] !== want[1] || got[2] !== want[2]) {
                [dx, dy, dz] = got.map((v) => Math.round(v * 4096));
                this.stats.clamped = (this.stats.clamped ?? 0) + 1;
            }
        }
        const turned = e.yaw !== p.yaw || e.pitch !== p.pitch;
        const moved = dx !== 0 || dy !== 0 || dz !== 0;
        const onGround = dy === 0; // not in the row; a standing entity does not change height
        if (moved && turned) tick.add('move', { name: 'entity_move_look', params: { entityId: e.id, dX: dx, dY: dy, dZ: dz, yaw: toI8(p.yaw), pitch: toI8(p.pitch), onGround } });
        else if (moved) tick.add('move', { name: 'rel_entity_move', params: { entityId: e.id, dX: dx, dY: dy, dZ: dz, onGround } });
        else if (turned) tick.add('move', { name: 'entity_look', params: { entityId: e.id, yaw: toI8(p.yaw), pitch: toI8(p.pitch), onGround } });
        if (e.headYaw !== p.headYaw) tick.add('move', { name: 'entity_head_rotation', params: { entityId: e.id, headYaw: toI8(p.headYaw) } });
        // the client's position is the sum of the deltas it was sent, so the belief integrates the same numbers
        e.x += dx / 4096;
        e.y += dy / 4096;
        e.z += dz / 4096;
        Object.assign(e, { yaw: p.yaw, pitch: p.pitch, headYaw: p.headYaw });
    },

    'ENTITY TP'(p, ctx, tick) {
        if (p.slot === 0) return;
        const e = this.bySlot.get(p.slot);
        if (!e) return this._reject('TP of an empty slot');
        const [x, y, z] = this._world(p.rel, ctx.player);
        Object.assign(e, { x, y, z, yaw: p.yaw, pitch: p.pitch, headYaw: p.headYaw });
        tick.add('move', { name: 'entity_teleport', params: { entityId: e.id, x, y, z, yaw: toI8(p.yaw), pitch: toI8(p.pitch), onGround: false } }, { name: 'entity_head_rotation', params: { entityId: e.id, headYaw: toI8(p.headYaw) } });
    },

    'ENTITY VEL'(p, ctx, tick) {
        const id = this._entityId(p.slot, ctx);
        if (id === null) return this._reject('VEL of an empty slot');
        tick.add('velocity', { name: 'entity_velocity', params: { entityId: id, velocity: { x: p.vel[0], y: p.vel[1], z: p.vel[2] } } });
    },
};

const ANIM = { SWING_MAIN: 0, LEAVE_BED: 2, SWING_OFF: 3, CRIT: 4, MAGIC_CRIT: 5 };
for (const kind of Object.keys(ANIM)) {
    compile[`EVENT ${kind}`] = function (p, ctx, tick) {
        const id = this._entityId(p.slot, ctx);
        if (id === null) return this._reject('EVENT on an empty slot');
        tick.add('event', { name: 'animation', params: { entityId: id, animation: ANIM[kind] } });
    };
}
const statusEvent = (status) =>
    function (p, ctx, tick) {
        const id = this._entityId(p.slot, ctx);
        if (id === null) return this._reject('EVENT on an empty slot');
        tick.add('event', { name: 'entity_status', params: { entityId: id, entityStatus: status ?? p.status } });
    };
compile['EVENT DEATH'] = statusEvent(3);
compile['EVENT HURT'] = statusEvent(2);
compile['EVENT STATUS'] = statusEvent(null);
// cause and direct ids are not in the row; 0 means none
compile['EVENT DAMAGE'] = function (p, ctx, tick) {
    const id = this._entityId(p.slot, ctx);
    if (id === null) return this._reject('EVENT on an empty slot');
    tick.add('event', { name: 'damage_event', params: { entityId: id, sourceTypeId: p.damageType, sourceCauseId: 0, sourceDirectId: 0 } });
};

// The Data field: orientation, block state, owner (a slot becomes an entity id) or the warden's pose.
const methods = {
    _objectData(p, ctx) {
        const d = p.data;
        if (d.orientation !== undefined) return d.orientation;
        if (d.blockState !== undefined) {
            try {
                return this.cat.blockStateId(d.blockState);
            } catch (e) {
                this._reject('SPAWN with an unknown block state');
                return 0;
            }
        }
        if (d.owner !== undefined && d.owner !== null) return this._entityId(d.owner, ctx) ?? 0;
        return d.emerging ? 1 : 0;
    },
};
require('../writer_methods').add(methods);

const finish = [
    function (tick) {
        if (tick.destroy.length) tick.add('destroy', { name: 'entity_destroy', params: { entityIds: tick.destroy } });
    },
];

module.exports = { parse, compile, finish, toI8 };
