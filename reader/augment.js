'use strict';
// Data augmentation: the same recording with the whole world turned k quarter turns about the vertical axis. A turned
// world is as valid as the original (rotation only, no mirroring, so left and right stay left and right), and it shows
// the model each movement, hit and placement facing four ways, so a direction is not a separate thing to learn four times.
//
// One quarter turn maps the continuous point (x, z) to (-z, x), the block cell (x, z) to (-z-1, x), and so a chunk
// (cx, cz) to (-cz-1, cx). Compass directions go north -> east -> south -> west. Yaw grows by 90 degrees (64 in a byte).
// Heights are unchanged. `apply(dir, name, params)` returns the turned params of one parsed packet (it does not edit its
// input); packets with nothing spatial come back as they are.
//
// Not turned (rare, and not worth a wrong guess): spatial values inside entity metadata (armor stand poses, bed and home
// positions), particle data, block entity NBT, the world border.

const { createBlockRot } = require('./blockrot');
const { decodeSections } = require('./world');

const FACE = [0, 1, 5, 4, 2, 3]; // block face / direction ids after one quarter turn: north(2) -> east(5) -> south(3) -> west(4)
const clamp16 = (v) => Math.max(-32768, Math.min(32767, v));
const byteYaw = (yaw, k) => ((yaw + 64 * k + 128) & 255) - 128;
const PISTONS = new Set(['piston', 'sticky_piston']);

function createAugmenter(k, { catalog, version = '1.21.1' } = {}) {
    k = ((k % 4) + 4) % 4;
    const rot = createBlockRot(version);
    const turn = (n, fn) => (...a) => {
        let v = a;
        for (let i = 0; i < n; i++) v = fn(...v);
        return v;
    };
    // one-step primitives, repeated k times
    const point = turn(k, (x, z) => [-z, x]); // a point or a vector
    const cell = turn(k, (x, z) => [-z - 1, x]); // a block cell, or a chunk
    const local = turn(k, (u, v) => [1 - v, u]); // a position inside one block
    const face = (f) => {
        for (let i = 0; i < k; i++) f = FACE[f] ?? f;
        return f;
    };
    const state = (s) => rot.rotate(s, k);
    const yawDeg = (y) => y + 90 * k;

    const loc = (l) => {
        if (!l) return l;
        const [x, z] = cell(l.x, l.z);
        return { ...l, x, z };
    };
    const vec16 = (v) => {
        const [x, z] = point(v.x, v.z);
        return { ...v, x: clamp16(x), z: clamp16(z) };
    };
    const xz = (d, fx = 'x', fz = 'z') => {
        const [x, z] = point(d[fx], d[fz]);
        return { ...d, [fx]: x, [fz]: z };
    };
    const typeName = (id) => catalog.entityName(id);

    // chunk sections, turned: block (x, z) in a chunk goes to (15 - z, x) per quarter turn, and each state turns with it
    let lut = null;
    function turnSections(sections) {
        lut ??= new Uint16Array(Object.keys(catalog.md.blocksByStateId).length).map((_, i) => state(i));
        const dst = new Uint16Array(4096);
        return sections.map((sec) => {
            if (sec.single !== undefined) return { single: lut[sec.single] };
            for (let y = 0; y < 16; y++) {
                for (let z = 0; z < 16; z++) {
                    for (let x = 0; x < 16; x++) {
                        const [nx, nz] = local16(x, z);
                        dst[(y << 8) | (nz << 4) | nx] = lut[sec.data[(y << 8) | (z << 4) | x]];
                    }
                }
            }
            return { data: dst.slice() };
        });
    }
    const local16 = turn(k, (x, z) => [15 - z, x]);

    const S2C = {
        position(d) {
            const f = d.flags || {};
            if (!!f.x !== !!f.z) return d; // one axis absolute and the other relative cannot be turned
            const out = { ...d, ...xz(d) };
            if (!f.yaw) out.yaw = yawDeg(d.yaw);
            return out;
        },
        spawn_entity(d) {
            const name = typeName(d.type);
            let objectData = d.objectData;
            if (name === 'item_frame' || name === 'glow_item_frame' || name === 'painting') objectData = face(((d.objectData % 6) + 6) % 6);
            else if (name === 'falling_block') objectData = state(d.objectData);
            return { ...d, ...xz(d), yaw: byteYaw(d.yaw, k), headPitch: byteYaw(d.headPitch, k), velocity: vec16(d.velocity), objectData };
        },
        spawn_entity_experience_orb: (d) => xz(d),
        rel_entity_move(d) {
            const [dX, dZ] = point(d.dX, d.dZ);
            return { ...d, dX: clamp16(dX), dZ: clamp16(dZ) };
        },
        entity_move_look(d) {
            const [dX, dZ] = point(d.dX, d.dZ);
            return { ...d, dX: clamp16(dX), dZ: clamp16(dZ), yaw: byteYaw(d.yaw, k) };
        },
        entity_look: (d) => ({ ...d, yaw: byteYaw(d.yaw, k) }),
        entity_teleport: (d) => ({ ...d, ...xz(d), yaw: byteYaw(d.yaw, k) }),
        entity_head_rotation: (d) => ({ ...d, headYaw: byteYaw(d.headYaw, k) }),
        entity_velocity: (d) => ({ ...d, velocity: vec16(d.velocity) }),
        block_change: (d) => ({ ...d, location: loc(d.location), type: state(d.type) }),
        multi_block_change(d) {
            const c = d.chunkCoordinates;
            const [sx, sz] = cell(c.x, c.z);
            const records = d.records.map((rec) => {
                const r = Number(rec);
                const [nx, nz] = local16((r >> 8) & 15, (r >> 4) & 15);
                const out = state(Math.floor(r / 4096)) * 4096 + ((nx << 8) | (nz << 4) | (r & 15));
                return typeof rec === 'bigint' ? BigInt(out) : out;
            });
            return { ...d, chunkCoordinates: { ...c, x: sx, z: sz }, records };
        },
        map_chunk(d) {
            const [x, z] = cell(d.x, d.z);
            const sections = Buffer.isBuffer(d.chunkData) ? decodeSections(d.chunkData) : d.chunkData.decoded;
            return { ...d, x, z, chunkData: { decoded: turnSections(sections) } };
        },
        unload_chunk(d) {
            const [x, z] = cell(d.chunkX, d.chunkZ);
            return { ...d, chunkX: x, chunkZ: z };
        },
        update_view_position(d) {
            const [x, z] = cell(d.chunkX, d.chunkZ);
            return { ...d, chunkX: x, chunkZ: z };
        },
        block_action(d) {
            const name = catalog.blockName(d.blockId);
            return { ...d, location: loc(d.location), byte2: PISTONS.has(name) ? face(d.byte2) : d.byte2 };
        },
        block_break_animation: (d) => ({ ...d, location: loc(d.location) }),
        tile_entity_data: (d) => ({ ...d, location: loc(d.location) }),
        world_event: (d) => ({ ...d, location: loc(d.location), data: d.effectId === 2001 ? state(d.data) : d.data }),
        spawn_position: (d) => ({ ...d, location: loc(d.location), angle: yawDeg(d.angle) }),
        hurt_animation: (d) => ({ ...d, yaw: yawDeg(d.yaw) }),
        vehicle_move: (d) => ({ ...xz(d), yaw: yawDeg(d.yaw) }),
        explosion(d) {
            // affected blocks are offsets from the block the centre is in; they move as cells, so work from absolute cells
            const fx = Math.floor(d.x);
            const fz = Math.floor(d.z);
            const [nx, nz] = point(d.x, d.z);
            const gx = Math.floor(nx);
            const gz = Math.floor(nz);
            const affectedBlockOffsets = (d.affectedBlockOffsets || []).map((o) => {
                const [cx, cz] = cell(fx + o.x, fz + o.z);
                return { ...o, x: cx - gx, z: cz - gz };
            });
            const [mx, mz] = point(d.playerMotionX, d.playerMotionZ);
            return { ...d, x: nx, z: nz, affectedBlockOffsets, playerMotionX: mx, playerMotionZ: mz };
        },
        world_particles(d) {
            const out = { ...d, ...xz(d) };
            if (k % 2) [out.offsetX, out.offsetZ] = [d.offsetZ, d.offsetX];
            return out;
        },
        sound_effect: (d) => xz(d),
        damage_event(d) {
            const p = d.sourcePosition;
            return p && typeof p.x === 'number' ? { ...d, sourcePosition: xz(p) } : d;
        },
    };

    const C2S = {
        position: (d) => xz(d),
        position_look: (d) => ({ ...xz(d), yaw: yawDeg(d.yaw) }),
        look: (d) => ({ ...d, yaw: yawDeg(d.yaw) }),
        vehicle_move: (d) => ({ ...xz(d), yaw: yawDeg(d.yaw) }),
        block_dig: (d) => ({ ...d, location: loc(d.location), face: face(d.face) }),
        block_place(d) {
            const [cursorX, cursorZ] = local(d.cursorX, d.cursorZ);
            return { ...d, location: loc(d.location), direction: face(d.direction), cursorX, cursorZ };
        },
        use_entity: (d) => (d.mouse === 2 && typeof d.x === 'number' ? xz(d) : d),
        use_item: (d) => (d.rotation ? { ...d, rotation: { ...d.rotation, x: yawDeg(d.rotation.x) } } : d),
        update_sign: (d) => ({ ...d, location: loc(d.location) }),
    };

    return {
        k,
        apply(dir, name, params) {
            if (k === 0) return params;
            const fn = (dir === 'S2C' ? S2C : C2S)[name];
            return fn ? fn(params) : params;
        },
        // exposed for tests
        cell,
        point,
        face,
    };
}

module.exports = { createAugmenter };
