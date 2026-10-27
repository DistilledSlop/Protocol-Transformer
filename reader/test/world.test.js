'use strict';
// WorldStore against real Chunk Data packets from a capture. Nothing here opens a connection.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadCapture } = require('../capture');
const { createCodec } = require('../parse');
const { WorldStore } = require('../world');
const { minecraftData } = require('../deps');

const BASE = path.join(__dirname, '..', '..', 'proxy', 'data', 'session_EmeraldIngot64_1793056989898');
const HAVE = fs.existsSync(BASE + '.bin') && fs.existsSync(BASE + '.jsonl');
const SKIP = HAVE ? false : `capture missing: ${BASE}.{bin,jsonl}`;

const md = minecraftData('1.21.1');
const codec = createCodec('1.21.1');
let cache = null;

// The capture's map_chunk packets, parsed. Parsing is done once for the whole file.
function mapChunks(count) {
    if (!cache) {
        const cap = loadCapture(BASE);
        const packets = cap.packets.filter((p) => p.name === 'map_chunk' && p.state === 'play' && p.dir === 'S2C');
        cache = { cap, packets, parsed: [] };
    }
    while (cache.parsed.length < Math.min(count, cache.packets.length)) {
        const p = cache.packets[cache.parsed.length];
        cache.parsed.push(codec.parse('S2C', cache.cap.bin.subarray(p.off, p.off + p.len)).params);
    }
    return cache.parsed.slice(0, count);
}

// Motion blocking, as the server's MOTION_BLOCKING heightmap counts it: a solid collision box, or a fluid.
// Water and lava are fluids, and so is anything waterlogged. Seagrass and kelp hold water without being waterlogged.
const FLUID_PLANTS = /^(tall_)?seagrass$|^kelp(_plant)?$/;
function waterlogged(id) {
    const bl = md.blocksByStateId[id];
    let off = id - bl.minStateId;
    for (let i = bl.states.length - 1; i >= 0; i--) {
        const prop = bl.states[i];
        const idx = off % prop.num_values;
        off = Math.floor(off / prop.num_values);
        if (prop.name === 'waterlogged' && idx === 0) return true; // bool values are [true, false]
    }
    return false;
}
function motionBlocking(id) {
    const bl = md.blocksByStateId[id];
    if (!bl) return false;
    return bl.boundingBox === 'block' || bl.name === 'water' || bl.name === 'lava' || FLUID_PLANTS.test(bl.name) || waterlogged(id);
}

// MOTION_BLOCKING: 256 entries of 9 bits, 7 per long, low bits first. Stored as [hi, lo] pairs.
function motionHeights(heightmaps) {
    const longs = heightmaps.value.MOTION_BLOCKING.value;
    const out = new Array(256);
    for (let i = 0; i < 256; i++) {
        const [hi, lo] = longs[Math.floor(i / 7)];
        const v = (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
        out[i] = Number((v >> BigInt((i % 7) * 9)) & 511n);
    }
    return out;
}

const stateName = (id) => (id === undefined ? 'undefined' : `${md.blocksByStateId[id].name}#${id}`);

test('decode: first 60 map_chunk packets load with 24 sections and answer get() inside and outside', { skip: SKIP }, () => {
    const chunks = mapChunks(60);
    const ws = new WorldStore();
    const loaded = [];
    for (const c of chunks) {
        assert.doesNotThrow(() => ws.setChunk(c.x, c.z, c.chunkData), `setChunk(${c.x},${c.z})`);
        loaded.push([c.x, c.z]);
    }
    for (const [cx, cz] of loaded) {
        assert.ok(ws.has(cx, cz));
        const c = ws.chunks.get(`${cx},${cz}`);
        assert.equal(c.sections.length, 24, `sections in chunk ${cx},${cz}`);
        assert.equal(c.minY, -64);
    }
    const set = new Set(loaded.map(([x, z]) => `${x},${z}`));
    let inside = 0;
    for (const [cx, cz] of loaded) {
        for (let x = cx * 16; x < cx * 16 + 16; x++)
            for (let z = cz * 16; z < cz * 16 + 16; z++)
                for (let y = -64; y < 320; y++) {
                    assert.notEqual(ws.get(x, y, z), undefined, `get(${x},${y},${z}) in loaded chunk ${cx},${cz}`);
                    inside++;
                }
    }
    assert.equal(inside, 60 * 16 * 16 * 384);
    // outside: the height limits, and chunks that were never loaded
    for (const [cx, cz] of loaded.slice(0, 5)) {
        assert.equal(ws.get(cx * 16 + 3, -65, cz * 16 + 3), undefined, 'below minY');
        assert.equal(ws.get(cx * 16 + 3, 320, cz * 16 + 3), undefined, 'above maxY');
    }
    let probed = 0;
    for (const [cx, cz] of loaded) {
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = cx + dx, nz = cz + dz;
            if (set.has(`${nx},${nz}`)) continue;
            assert.equal(ws.has(nx, nz), false);
            assert.equal(ws.get(nx * 16 + 5, 64, nz * 16 + 5), undefined, `get in unloaded chunk ${nx},${nz}`);
            probed++;
        }
    }
    assert.ok(probed > 0);
});

test('heightmap: MOTION_BLOCKING matches the highest motion-blocking block of 20 real chunks', { skip: SKIP }, () => {
    const chunks = mapChunks(20);
    let match = 0;
    let total = 0;
    const mismatches = [];
    for (const c of chunks) {
        // a fresh store for each packet, so the check reads only this packet's chunk
        const ws = new WorldStore();
        ws.setChunk(c.x, c.z, c.chunkData);
        const minY = ws.minY(c.x * 16, c.z * 16);
        const maxY = ws.maxY(c.x * 16, c.z * 16);
        const hm = motionHeights(c.heightmaps);
        for (let lz = 0; lz < 16; lz++) {
            for (let lx = 0; lx < 16; lx++) {
                const X = c.x * 16 + lx;
                const Z = c.z * 16 + lz;
                let got = 0;
                let gotId;
                for (let y = maxY; y >= minY; y--) {
                    const id = ws.get(X, y, Z);
                    if (motionBlocking(id)) {
                        got = y - minY + 1;
                        gotId = id;
                        break;
                    }
                }
                const exp = hm[lz * 16 + lx];
                total++;
                if (exp === got) {
                    match++;
                } else {
                    const expId = exp ? ws.get(X, exp - 1 + minY, Z) : undefined;
                    mismatches.push({ x: X, z: Z, expected: exp, got, expState: stateName(expId), gotState: stateName(gotId) });
                }
            }
        }
    }
    const frac = match / total;
    console.log(`heightmap match: ${match}/${total} = ${frac.toFixed(4)}; mismatches: ${mismatches.length}`);
    for (const m of mismatches.slice(0, 3)) {
        console.log(`  column x=${m.x} z=${m.z}: expected ${m.expected} (${m.expState}), got ${m.got} (${m.gotState})`);
    }
    assert.ok(frac >= 0.97, `heightmap match fraction ${frac.toFixed(4)} below 0.97`);
});

test('set/get: a block in a single-value section changes alone and set returns the previous state', { skip: SKIP }, () => {
    const chunks = mapChunks(60);
    const ws = new WorldStore();
    for (const c of chunks) ws.setChunk(c.x, c.z, c.chunkData);
    let found = null;
    for (const [key, c] of ws.chunks) {
        const si = c.sections.findIndex((s) => s.single !== undefined);
        if (si >= 0) {
            found = { key, si, c };
            break;
        }
    }
    assert.ok(found, 'a loaded chunk has a single-value section');
    const [cx, cz] = found.key.split(',').map(Number);
    const sec = found.c.sections[found.si];
    const old = sec.single;
    const sy = found.c.minY + found.si * 16;
    const x = cx * 16 + 5, y = sy + 9, z = cz * 16 + 7;
    const stone = 1;
    assert.equal(ws.get(x, y, z), old);
    const prev = ws.set(x, y, z, stone);
    assert.equal(prev, old, 'set returns the previous state');
    assert.equal(ws.get(x, y, z), stone);
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [3, 4, 2]]) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (ny < sy || ny >= sy + 16) continue;
        assert.equal(ws.get(nx, ny, nz), old, `neighbor ${nx},${ny},${nz} keeps the single value`);
    }
    // the section stays a valid store after the write: the same block reads back as before the write
    assert.equal(ws.set(x, y, z, old), stone);
    assert.equal(ws.get(x, y, z), old);

    // outside loaded chunks, and out of height: undefined, no throw
    assert.equal(ws.set(1000000, 64, 1000000, stone), undefined);
    assert.equal(ws.get(1000000, 64, 1000000), undefined);
    assert.equal(ws.set(x, -65, z, stone), undefined);
    assert.equal(ws.set(x, 320, z, stone), undefined);
});

test('unload: an unloaded chunk is gone and other chunks stay', { skip: SKIP }, () => {
    const chunks = mapChunks(60);
    const ws = new WorldStore();
    for (const c of chunks) ws.setChunk(c.x, c.z, c.chunkData);
    const [a, b] = [chunks[0], chunks[1]];
    assert.equal(ws.has(a.x, a.z), true);
    ws.unload(a.x, a.z);
    assert.equal(ws.has(a.x, a.z), false);
    assert.equal(ws.get(a.x * 16 + 2, 64, a.z * 16 + 2), undefined);
    assert.equal(ws.get(a.x * 16 + 2, -64, a.z * 16 + 2), undefined);
    assert.equal(ws.minY(a.x * 16, a.z * 16), undefined);
    if (b.x !== a.x || b.z !== a.z) {
        assert.equal(ws.has(b.x, b.z), true);
        assert.notEqual(ws.get(b.x * 16 + 2, 64, b.z * 16 + 2), undefined);
    }
    assert.doesNotThrow(() => ws.unload(a.x, a.z), 'unloading twice is harmless');
});

test('speed: decoding 300 chunks takes under 5 seconds', { skip: SKIP }, () => {
    const chunks = mapChunks(300);
    assert.equal(chunks.length, 300);
    const ws = new WorldStore();
    const t0 = process.hrtime.bigint();
    for (const c of chunks) ws.setChunk(c.x, c.z, c.chunkData);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`decoded 300 chunks in ${ms.toFixed(1)} ms`);
    assert.ok(ms < 5000, `300 chunks took ${ms.toFixed(0)} ms`);
});
