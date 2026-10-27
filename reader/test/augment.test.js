'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAugmenter } = require('../augment');
const { createCatalog } = require('../catalog');
const { createBlockRot } = require('../blockrot');
const { WorldStore } = require('../world');

const catalog = createCatalog('1.21.1');
const md = catalog.md;
const rot = createBlockRot('1.21.1');
const aug = [0, 1, 2, 3].map((k) => createAugmenter(k, { catalog }));

const STONE = catalog.blockStateId('stone');
const STAIRS_NORTH = catalog.blockStateId('oak_stairs[facing=north]');
const LOG_X = catalog.blockStateId('oak_log[axis=x]');

// Cell / point maps applied k times, written out independently of augment.js.
function cellK(x, z, k) {
    for (let i = 0; i < k; i++) [x, z] = [-z - 1, x];
    return [x, z];
}
function pointK(x, z, k) {
    for (let i = 0; i < k; i++) [x, z] = [-z, x];
    return [x, z];
}

// k = 1 applied four times
function fourTimes(dir, name, p) {
    let v = p;
    for (let i = 0; i < 4; i++) v = aug[1].apply(dir, name, v);
    return v;
}

// Deep comparison: integers exact, floats within 1e-9, yaw keys modulo the given modulus.
function eqDeep(got, want, path = '', mods = {}) {
    if (typeof want === 'number') {
        const key = path.split('.').pop();
        if (mods[key]) {
            const m = mods[key];
            const d = (((got - want) % m) + m) % m;
            assert.ok(d === 0 || Math.abs(d - m) < 1e-9, `${path}: ${got} vs ${want} (mod ${m})`);
        } else if (Number.isInteger(want)) {
            assert.equal(got, want, `${path}`);
        } else {
            assert.ok(Math.abs(got - want) <= 1e-9, `${path}: ${got} vs ${want}`);
        }
        return;
    }
    if (want !== null && typeof want === 'object') {
        assert.equal(typeof got, 'object', path);
        for (const key of Object.keys(want)) eqDeep(got[key], want[key], path ? `${path}.${key}` : key, mods);
        return;
    }
    assert.equal(got, want, path);
}

// Packets, shaped as the parser produces them.
const POS = () => ({ x: 10.5, y: 64, z: -3.25, yaw: 30, pitch: -10, flags: {}, teleportId: 7 });
const TELEPORT = () => ({ entityId: 5, x: 1.5, y: 70, z: 2.5, yaw: 30, pitch: 0, onGround: true });
const SPAWN = () => ({
    entityId: 9,
    objectUUID: '00000000-0000-0000-0000-000000000009',
    type: md.entitiesByName.zombie.id,
    x: 4.5,
    y: 65,
    z: 6.5,
    pitch: 0,
    yaw: 20,
    headPitch: -5,
    objectData: 0,
    velocity: { x: 0.5, y: 0, z: -0.25 },
});
const REL_MOVE = () => ({ entityId: 3, dX: 100, dY: -7, dZ: -40, onGround: true });
const VELOCITY = () => ({ entityId: 3, velocity: { x: 10, y: 5, z: -20 } });
const BLOCK_CHANGE = () => ({ location: { x: 5, y: 64, z: 7 }, type: STONE });
const POS_LOOK_C2S = () => ({ x: 1.5, y: 64, z: 2.5, yaw: 45, pitch: 0, onGround: true });
const BLOCK_DIG = () => ({ status: 0, location: { x: 2, y: 60, z: -9 }, face: 2, sequence: 1 });
const BLOCK_PLACE = () => ({
    hand: 0,
    location: { x: 1, y: 64, z: 1 },
    direction: 3,
    cursorX: 0.25,
    cursorY: 0.5,
    cursorZ: 0.75,
    insideBlock: false,
    sequence: 0,
});
const EXPLOSION = () => ({
    x: 10.5,
    y: 64,
    z: 3.25,
    strength: 4,
    affectedBlockOffsets: [
        { x: 1, y: 0, z: 2 },
        { x: -1, y: 1, z: 0 },
    ],
    playerMotionX: 0.5,
    playerMotionZ: -0.25,
});

// ---------------------------------------------------------------- 1. k = 0 and four-turn round trips

test('k=0 returns the params object itself', () => {
    const p = POS();
    assert.strictEqual(aug[0].apply('S2C', 'position', p), p);
    const b = BLOCK_CHANGE();
    assert.strictEqual(aug[0].apply('S2C', 'block_change', b), b);
    const d = BLOCK_DIG();
    assert.strictEqual(aug[0].apply('C2S', 'block_dig', d), d);
});

test('four quarter turns give back the original position-like packets', () => {
    eqDeep(fourTimes('S2C', 'position', POS()), POS(), '', { yaw: 360 });
    eqDeep(fourTimes('S2C', 'entity_teleport', TELEPORT()), TELEPORT(), '', { yaw: 256 });
    eqDeep(fourTimes('S2C', 'spawn_entity', SPAWN()), SPAWN(), '', { yaw: 256, headPitch: 256 });
    eqDeep(fourTimes('S2C', 'rel_entity_move', REL_MOVE()), REL_MOVE());
    eqDeep(fourTimes('S2C', 'entity_velocity', VELOCITY()), VELOCITY());
    eqDeep(fourTimes('S2C', 'block_change', BLOCK_CHANGE()), BLOCK_CHANGE());
    eqDeep(fourTimes('C2S', 'position_look', POS_LOOK_C2S()), POS_LOOK_C2S(), '', { yaw: 360 });
    eqDeep(fourTimes('C2S', 'block_dig', BLOCK_DIG()), BLOCK_DIG());
    eqDeep(fourTimes('C2S', 'block_place', BLOCK_PLACE()), BLOCK_PLACE());
    eqDeep(fourTimes('S2C', 'explosion', EXPLOSION()), EXPLOSION());
});

// ---------------------------------------------------------------- 2. hand-computed single turns

test('S2C position: x=10,z=3,yaw=0 turns to x=-3,z=10,yaw=90', () => {
    const out = aug[1].apply('S2C', 'position', { x: 10, y: 64, z: 3, yaw: 0, pitch: 0, flags: {}, teleportId: 1 });
    assert.equal(out.x, -3);
    assert.equal(out.z, 10);
    assert.equal(out.yaw, 90);
    assert.equal(out.y, 64);
    assert.equal(out.pitch, 0);
});

test('S2C position with absolute x,z and yaw flags: offsets rotate, yaw unchanged', () => {
    const flags = { x: true, z: true, yaw: true, y: false, pitch: false };
    const out = aug[1].apply('S2C', 'position', { x: 10, y: 64, z: 3, yaw: 0, pitch: 0, flags, teleportId: 1 });
    assert.equal(out.x, -3);
    assert.equal(out.z, 10);
    assert.equal(out.yaw, 0);
    assert.deepEqual(out.flags, flags);
});

test('S2C position with one axis absolute and the other relative is returned unchanged', () => {
    const p = { x: 10, y: 64, z: 3, yaw: 0, pitch: 0, flags: { x: true, z: false }, teleportId: 1 };
    const out = aug[1].apply('S2C', 'position', p);
    assert.strictEqual(out, p);
});

test('block_change location {5,64,7} -> {-8,64,5}', () => {
    const out = aug[1].apply('S2C', 'block_change', { location: { x: 5, y: 64, z: 7 }, type: STONE });
    assert.deepEqual(out.location, { x: -8, y: 64, z: 5 });
    assert.equal(out.type, rot.rotate(STONE, 1));
});

test('entity_teleport x=1.5,z=2.5,yaw=0 -> x=-2.5,z=1.5,yaw=64', () => {
    const out = aug[1].apply('S2C', 'entity_teleport', { entityId: 1, x: 1.5, y: 0, z: 2.5, yaw: 0, pitch: 0, onGround: true });
    assert.equal(out.x, -2.5);
    assert.equal(out.z, 1.5);
    assert.equal(out.yaw, 64);
});

test('rel_entity_move dX=100,dZ=-40 -> dX=40,dZ=100', () => {
    const out = aug[1].apply('S2C', 'rel_entity_move', { entityId: 1, dX: 100, dY: 0, dZ: -40, onGround: true });
    assert.equal(out.dX, 40);
    assert.equal(out.dZ, 100);
    assert.equal(out.dY, 0);
});

test('rel_entity_move clamps to int16 and never leaves its range', () => {
    const a = aug[1].apply('S2C', 'rel_entity_move', { entityId: 1, dX: -32768, dY: 0, dZ: 7, onGround: true });
    // (dX, dZ) -> (-dZ, dX): dZ = 7 gives dX = -7, dZ = -32768
    assert.equal(a.dX, -7);
    assert.equal(a.dZ, -32768);
    const b = aug[1].apply('S2C', 'rel_entity_move', { entityId: 1, dX: 7, dY: 0, dZ: -32768, onGround: true });
    // (7, -32768) -> (32768, 7): clamped to 32767
    assert.equal(b.dX, 32767);
    assert.equal(b.dZ, 7);
    for (const v of [a, b]) {
        assert.ok(v.dX >= -32768 && v.dX <= 32767);
        assert.ok(v.dZ >= -32768 && v.dZ <= 32767);
    }
});

test('entity_velocity {10,5,-20} -> {20,5,10}', () => {
    const out = aug[1].apply('S2C', 'entity_velocity', { entityId: 1, velocity: { x: 10, y: 5, z: -20 } });
    assert.deepEqual(out.velocity, { x: 20, y: 5, z: 10 });
});

test('C2S block_dig face rotates north->east->south->west, 0 and 1 unchanged', () => {
    const face = (f) => aug[1].apply('C2S', 'block_dig', { status: 0, location: { x: 0, y: 0, z: 0 }, face: f, sequence: 0 }).face;
    assert.equal(face(2), 5);
    assert.equal(face(5), 3);
    assert.equal(face(3), 4);
    assert.equal(face(4), 2);
    assert.equal(face(0), 0);
    assert.equal(face(1), 1);
});

test('C2S block_place cursor (0.25, 0.75) -> (0.25, 0.25) and direction rotates like a face', () => {
    const out = aug[1].apply('C2S', 'block_place', {
        hand: 0,
        location: { x: 1, y: 64, z: 1 },
        direction: 2,
        cursorX: 0.25,
        cursorY: 0.5,
        cursorZ: 0.75,
        insideBlock: false,
        sequence: 0,
    });
    assert.ok(Math.abs(out.cursorX - 0.25) <= 1e-9);
    assert.ok(Math.abs(out.cursorZ - 0.25) <= 1e-9);
    assert.equal(out.cursorY, 0.5);
    assert.equal(out.direction, 5);
    // location: cell (1,1) -> (-2, 1)
    assert.deepEqual(out.location, { x: -2, y: 64, z: 1 });
});

test('unload_chunk {3,4} -> {-5,3}', () => {
    const out = aug[1].apply('S2C', 'unload_chunk', { chunkX: 3, chunkZ: 4 });
    assert.equal(out.chunkX, -5);
    assert.equal(out.chunkZ, 3);
});

test('spawn_entity item_frame objectData 2 (north) -> 5 (east)', () => {
    const type = catalog.entityTypeId('item_frame');
    assert.equal(type, md.entitiesByName.item_frame.id);
    const out = aug[1].apply('S2C', 'spawn_entity', { ...SPAWN(), type, objectData: 2 });
    assert.equal(out.objectData, 5);
});

test('spawn_entity falling_block objectData is turned as a block state', () => {
    const type = md.entitiesByName.falling_block.id;
    const east = catalog.blockStateId('oak_stairs[facing=east,half=bottom]');
    const south = catalog.blockStateId('oak_stairs[facing=south,half=bottom]');
    const out = aug[1].apply('S2C', 'spawn_entity', { ...SPAWN(), type, objectData: east });
    assert.equal(out.objectData, south);
    assert.equal(out.objectData, rot.rotate(east, 1));
});

// ---------------------------------------------------------------- 3. multi_block_change

function mbcRecord(state, x, y, z) {
    return state * 4096 + ((x << 8) | (z << 4) | y);
}
function decodeRecord(r) {
    const n = Number(r);
    return { state: Math.floor(n / 4096), x: (n >> 8) & 15, z: (n >> 4) & 15, y: n & 15 };
}

test('multi_block_change: chunk and record cells turn; state turns with the cell', () => {
    const LOG_Z = catalog.blockStateId('oak_log[axis=z]');
    const inputs = [
        [STONE, 3, 2, 5, 7],
        [STAIRS_NORTH, 0, 1, 15, 2],
        [LOG_X, 14, 0, 1, 0],
        [LOG_Z, 9, 15, 0, 9],
    ];
    const records = inputs.map(([s, x, y, z]) => mbcRecord(s, x, y, z));
    const out = aug[1].apply('S2C', 'multi_block_change', {
        chunkCoordinates: { x: 2, y: 4, z: -3 },
        records,
    });
    assert.equal(out.chunkCoordinates.x, 2);
    assert.equal(out.chunkCoordinates.z, 2);
    assert.equal(out.chunkCoordinates.y, 4);
    inputs.forEach(([s, x, y, z], i) => {
        const got = decodeRecord(out.records[i]);
        assert.equal(got.state, rot.rotate(s, 1), `record ${i} state`);
        assert.equal(got.x, 15 - z, `record ${i} local x`);
        assert.equal(got.z, x, `record ${i} local z`);
        assert.equal(got.y, y, `record ${i} y`);
    });
});

test('multi_block_change: four turns restore the records and chunk coordinates', () => {
    const records = [mbcRecord(STONE, 3, 2, 5, 7), mbcRecord(STAIRS_NORTH, 0, 1, 15, 2)];
    const p = { chunkCoordinates: { x: 2, y: 4, z: -3 }, records };
    const back = fourTimes('S2C', 'multi_block_change', p);
    assert.deepEqual(back.chunkCoordinates, p.chunkCoordinates);
    assert.deepEqual(back.records, p.records);
});

test('multi_block_change: BigInt records stay BigInt', () => {
    const records = [BigInt(mbcRecord(STONE, 3, 2, 5, 7)), BigInt(mbcRecord(LOG_X, 1, 1, 1, 1))];
    const out = aug[1].apply('S2C', 'multi_block_change', { chunkCoordinates: { x: 2, y: 4, z: -3 }, records });
    for (const r of out.records) assert.equal(typeof r, 'bigint');
    const got = decodeRecord(out.records[0]);
    assert.equal(got.state, rot.rotate(STONE, 1));
    assert.equal(got.x, 15 - 5);
    assert.equal(got.z, 3);
    const back = fourTimes('S2C', 'multi_block_change', { chunkCoordinates: { x: 2, y: 4, z: -3 }, records });
    for (const r of back.records) assert.equal(typeof r, 'bigint');
    assert.deepEqual(back.records, records);
});

// ---------------------------------------------------------------- 4. map_chunk through the store

function buildWorld() {
    const w = new WorldStore();
    w.chunks.set('0,0', { minY: -64, sections: Array.from({ length: 24 }, () => ({ single: 0 })) });
    w.set(1, -64, 2, STONE);
    w.set(3, 70, 5, STAIRS_NORTH);
    w.set(7, 0, 9, LOG_X);
    w.set(0, -64, 0, LOG_X);
    w.set(15, 319, 15, STONE);
    w.set(12, -1, 4, STAIRS_NORTH);
    return w;
}

function snapshot(sections) {
    return sections.map((s) => (s.single !== undefined ? { single: s.single } : { data: Uint16Array.from(s.data) }));
}

for (const k of [1, 2, 3]) {
    test(`map_chunk k=${k}: every block of chunk (0,0) lands in the turned world`, () => {
        const w = buildWorld();
        const sections = w.chunks.get('0,0').sections;
        const before = snapshot(sections);

        const out = aug[k].apply('S2C', 'map_chunk', { x: 0, z: 0, chunkData: { decoded: sections } });
        const [ex, ez] = cellK(0, 0, k);
        assert.equal(out.x, ex);
        assert.equal(out.z, ez);
        assert.ok(Array.isArray(out.chunkData.decoded));
        assert.equal(out.chunkData.decoded.length, 24);

        const second = new WorldStore();
        second.setSections(out.x, out.z, out.chunkData.decoded);

        let checked = 0;
        for (let x = 0; x < 16; x++) {
            for (let z = 0; z < 16; z++) {
                const [nx, nz] = cellK(x, z, k);
                for (let y = -64; y < 320; y++) {
                    const orig = w.get(x, y, z);
                    assert.equal(second.get(nx, y, nz), rot.rotate(orig, k), `cell (${x},${y},${z}) k=${k}`);
                    checked++;
                }
            }
        }
        assert.equal(checked, 16 * 16 * 384);

        // the placed blocks read back with the expected facing
        const [sx, sz] = cellK(3, 5, k);
        const stairs = second.get(sx, 70, sz);
        assert.equal(stairs, rot.rotate(STAIRS_NORTH, k));
        if (k === 1) assert.match(catalog.blockState(second.get(-6, 70, 3)), /facing=east/);

        // the input sections were not modified
        assert.deepEqual(snapshot(sections), before);
    });
}

test('map_chunk: rotated section lookups for several cells', () => {
    const w = buildWorld();
    const out = aug[1].apply('S2C', 'map_chunk', { x: 0, z: 0, chunkData: { decoded: w.chunks.get('0,0').sections } });
    const second = new WorldStore();
    second.setSections(out.x, out.z, out.chunkData.decoded);
    assert.equal(out.x, -1);
    assert.equal(out.z, 0);
    // stone at (1,-64,2) -> cell (-3, 1)
    assert.equal(second.get(-3, -64, 1), rot.rotate(STONE, 1));
});

test('map_chunk with k=0 returns the same packet', () => {
    const w = buildWorld();
    const p = { x: 0, z: 0, chunkData: { decoded: w.chunks.get('0,0').sections } };
    assert.strictEqual(aug[0].apply('S2C', 'map_chunk', p), p);
});

// ---------------------------------------------------------------- 5. nothing spatial, unknown names

test('packets with nothing spatial come back as the same reference', () => {
    for (const [dir, name, p] of [
        ['S2C', 'system_chat', { content: '{"text":"hi"}', isActionBar: false }],
        ['C2S', 'chat_message', { message: 'hello', timestamp: 1n, salt: 0n }],
    ]) {
        for (const k of [1, 2, 3]) {
            assert.strictEqual(aug[k].apply(dir, name, p), p, `${dir} ${name} k=${k}`);
        }
    }
});

test('unknown packet names do not throw and come back unchanged', () => {
    const p = { anything: 1, x: 5 };
    for (const k of [1, 2, 3]) {
        assert.doesNotThrow(() => aug[k].apply('S2C', 'no_such_packet', p));
        assert.strictEqual(aug[k].apply('S2C', 'no_such_packet', p), p);
        assert.strictEqual(aug[k].apply('C2S', 'no_such_packet', p), p);
    }
});

// ---------------------------------------------------------------- 6. explosion

test('explosion: affected cells map by the cell formula for k=1..3, and playerMotion rotates', () => {
    const base = EXPLOSION();
    const fx = Math.floor(base.x);
    const fz = Math.floor(base.z);
    for (const k of [1, 2, 3]) {
        const out = aug[k].apply('S2C', 'explosion', EXPLOSION());
        const [nx, nz] = pointK(base.x, base.z, k);
        assert.ok(Math.abs(out.x - nx) <= 1e-9, `center x k=${k}`);
        assert.ok(Math.abs(out.z - nz) <= 1e-9, `center z k=${k}`);
        const gx = Math.floor(out.x);
        const gz = Math.floor(out.z);
        base.affectedBlockOffsets.forEach((o, i) => {
            const oldAbs = [fx + o.x, fz + o.z];
            const [ax, az] = cellK(oldAbs[0], oldAbs[1], k);
            const n = out.affectedBlockOffsets[i];
            assert.equal(gx + n.x, ax, `offset ${i} x k=${k}`);
            assert.equal(gz + n.z, az, `offset ${i} z k=${k}`);
            assert.equal(n.y, o.y, `offset ${i} y k=${k}`);
        });
        const [mx, mz] = pointK(base.playerMotionX, base.playerMotionZ, k);
        assert.ok(Math.abs(out.playerMotionX - mx) <= 1e-9);
        assert.ok(Math.abs(out.playerMotionZ - mz) <= 1e-9);
    }
});

test('explosion k=1 with the numbers spelled out', () => {
    const out = aug[1].apply('S2C', 'explosion', EXPLOSION());
    // center (10.5, 3.25) -> (-3.25, 10.5); floor (-4, 10)
    assert.ok(Math.abs(out.x + 3.25) <= 1e-9);
    assert.ok(Math.abs(out.z - 10.5) <= 1e-9);
    // offset (1,0,2) from cell (10,3) -> cell (11,5) -> (-6,11) -> offset (-2, 1)
    assert.equal(out.affectedBlockOffsets[0].x, -2);
    assert.equal(out.affectedBlockOffsets[0].z, 1);
    // offset (-1,1,0) from cell (10,3) -> cell (9,3) -> (-4,9) -> offset (0,-1)
    assert.equal(out.affectedBlockOffsets[1].x, 0);
    assert.equal(out.affectedBlockOffsets[1].z, -1);
    // motion (0.5, -0.25) -> (0.25, 0.5)
    assert.ok(Math.abs(out.playerMotionX - 0.25) <= 1e-9);
    assert.ok(Math.abs(out.playerMotionZ - 0.5) <= 1e-9);
});
