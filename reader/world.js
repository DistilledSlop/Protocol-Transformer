'use strict';
// The world store: the block state of every block in the loaded chunks, kept from Chunk Data packets and kept
// up to date by Block Update / Section Blocks Update. The reader reads chunks only to answer "what is at x,y,z"
// (neighbors of a changed block, ground height, collision); lighting, biomes and block entities are skipped.
//
// Chunk Data (1.21.1) carries chunk sections bottom to top, each:
//   i16 non-air block count
//   block states: a paletted container   u8 bits-per-entry; 0 = one value (varint), 1..8 = palette (varint count, varint ids)
//                                        then, for any width above 8, the ids themselves; then varint long count and the longs
//   biomes: the same container, skipped
// Entries are packed low bits first, several to a long, never straddling two longs. The number of sections tells
// the dimension's height: 24 is the overworld (y from -64), 16 the nether and the end (from 0).

const SECTION_BLOCKS = 4096;

class Reader_ {
    constructor(buf) {
        this.b = buf;
        this.p = 0;
    }
    eof() {
        return this.p >= this.b.length;
    }
    u8() {
        return this.b[this.p++];
    }
    i16() {
        const v = this.b.readInt16BE(this.p);
        this.p += 2;
        return v;
    }
    varint() {
        let v = 0;
        let shift = 0;
        for (;;) {
            const x = this.b[this.p++];
            v |= (x & 0x7f) << shift;
            if (!(x & 0x80)) return v >>> 0;
            shift += 7;
        }
    }
}

// Unpack `count` entries of `bits` bits from big-endian longs starting at r.p; advances past them.
function unpack(r, longs, bits, count) {
    const out = new Uint16Array(count);
    const per = Math.floor(64 / bits);
    const mask = (1 << bits) - 1;
    let n = 0;
    for (let l = 0; l < longs && n < count; l++) {
        const hi = r.b.readUInt32BE(r.p);
        const lo = r.b.readUInt32BE(r.p + 4);
        r.p += 8;
        for (let i = 0; i < per && n < count; i++, n++) {
            const shift = i * bits;
            let v;
            if (shift >= 32) v = (hi >>> (shift - 32)) & mask;
            else if (shift + bits <= 32) v = (lo >>> shift) & mask;
            else v = ((lo >>> shift) | (hi << (32 - shift))) & mask;
            out[n] = v;
        }
    }
    return out;
}

// One paletted container of `count` entries. Returns {single} or {data: Uint16Array of state ids}.
function container(r, count, direct) {
    const bits = r.u8();
    if (bits === 0) {
        const single = r.varint();
        r.varint(); // data length, 0
        return { single };
    }
    let palette = null;
    if (bits <= direct.maxIndirect) {
        const n = r.varint();
        palette = new Array(n);
        for (let i = 0; i < n; i++) palette[i] = r.varint();
    }
    const longs = r.varint();
    const idx = unpack(r, longs, bits, count);
    if (palette) for (let i = 0; i < count; i++) idx[i] = palette[idx[i]] ?? 0;
    return { data: idx };
}

const BLOCKS = { maxIndirect: 8 }; // wider than 8 bits: the entry is the state id itself
const BIOMES = { maxIndirect: 3 };

function decodeSections(buf) {
    const r = new Reader_(buf);
    const sections = [];
    while (!r.eof()) {
        r.i16(); // non-air count
        sections.push(container(r, SECTION_BLOCKS, BLOCKS));
        container(r, 64, BIOMES);
    }
    return sections;
}

class WorldStore {
    constructor() {
        this.chunks = new Map(); // 'cx,cz' -> {minY, sections: [{single}|{data}]}
    }

    setChunk(cx, cz, chunkData) {
        const sections = decodeSections(chunkData);
        const minY = sections.length === 24 ? -64 : sections.length === 16 ? 0 : -64;
        this.chunks.set(`${cx},${cz}`, { minY, sections });
    }

    // sections already decoded (and, for augmentation, turned): the same as setChunk without the bytes
    setSections(cx, cz, sections) {
        const minY = sections.length === 24 ? -64 : sections.length === 16 ? 0 : -64;
        this.chunks.set(`${cx},${cz}`, { minY, sections });
    }

    unload(cx, cz) {
        this.chunks.delete(`${cx},${cz}`);
    }

    has(cx, cz) {
        return this.chunks.has(`${cx},${cz}`);
    }

    // block state id, or undefined outside the loaded chunks and the dimension's height
    get(x, y, z) {
        const c = this.chunks.get(`${x >> 4},${z >> 4}`);
        if (!c) return undefined;
        const s = c.sections[(y - c.minY) >> 4];
        if (!s || y < c.minY) return undefined;
        if (s.single !== undefined) return s.single;
        return s.data[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)];
    }

    // returns the previous state id (undefined if the block was not in a loaded chunk)
    set(x, y, z, state) {
        const c = this.chunks.get(`${x >> 4},${z >> 4}`);
        if (!c || y < c.minY) return undefined;
        const s = c.sections[(y - c.minY) >> 4];
        if (!s) return undefined;
        if (s.single !== undefined) {
            if (s.single === state) return state;
            s.data = new Uint16Array(SECTION_BLOCKS).fill(s.single);
            delete s.single;
        }
        const i = ((y & 15) << 8) | ((z & 15) << 4) | (x & 15);
        const old = s.data[i];
        s.data[i] = state;
        return old;
    }

    minY(x, z) {
        return this.chunks.get(`${x >> 4},${z >> 4}`)?.minY;
    }

    maxY(x, z) {
        const c = this.chunks.get(`${x >> 4},${z >> 4}`);
        return c ? c.minY + c.sections.length * 16 - 1 : undefined;
    }
}

module.exports = { WorldStore, decodeSections };
