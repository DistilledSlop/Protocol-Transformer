'use strict';
// Quarter turns of block states about the vertical axis, clockwise as seen from above.
// Used for data augmentation: the world is rotated, never mirrored, so left/right stays left/right.

const { minecraftData } = require('./deps');

// Clockwise order. A quarter turn moves each direction one step along this list.
const DIRS = ['north', 'east', 'south', 'west'];
const DIR_SET = new Set(DIRS);

// Same value mapping as catalog.blockState: bool index 0 is 'true', enums use values[idx], ints use the index.
function valueOf(st, idx) {
    if (st.type === 'bool') return idx === 0 ? 'true' : 'false';
    if (st.values) return st.values[idx];
    return String(idx);
}

// Index of a value string in a property, or -1 when it is not legal for that property.
function indexOfValue(st, s) {
    if (st.type === 'bool') return s === 'true' ? 0 : s === 'false' ? 1 : -1;
    if (st.values) return st.values.indexOf(s);
    return /^\d+$/.test(s) && Number(s) < st.num_values ? Number(s) : -1;
}

function createBlockRot(version = '1.21.1') {
    const md = minecraftData(version);
    // blocksByStateId is an object keyed by state id, not an array, so size the table from the blocks.
    let n = 0;
    for (const b of Object.values(md.blocksByStateId)) n = Math.max(n, b.maxStateId + 1);
    // Lazy per-k tables. k = 0 is the identity and needs no table.
    const tables = [null, null, null, null];

    // New state id for one state of block b after k quarter turns (k in 1..3).
    function rotateState(b, stateId, k) {
        const sts = b.states;
        const count = sts.length;
        // Decode: the last property varies fastest.
        const idx = new Array(count);
        let off = stateId - b.minStateId;
        for (let i = count - 1; i >= 0; i--) {
            idx[i] = off % sts[i].num_values;
            off = Math.floor(off / sts[i].num_values);
        }

        const byName = new Map();
        sts.forEach((st, i) => byName.set(st.name, i));
        const out = idx.slice();

        // Connections: the value at direction d moves to direction d + k, so new east = old north for k=1.
        if (DIRS.every((d) => byName.has(d))) {
            for (let d = 0; d < 4; d++) {
                out[byName.get(DIRS[(d + k) % 4])] = idx[byName.get(DIRS[d])];
            }
        }

        for (let i = 0; i < count; i++) {
            const st = sts[i];
            const name = st.name;
            // Connection props were moved above; up/down stay put.
            if (DIR_SET.has(name)) continue;
            if (name === 'rotation') {
                // Standing signs, banners, heads: 16 steps, 0 = south, clockwise.
                out[i] = (idx[i] + 4 * k) % 16;
                continue;
            }
            if (name === 'axis') {
                // Pillars swap x and z on odd turns; y stays.
                if (k % 2 === 1) {
                    const v = valueOf(st, idx[i]);
                    const w = v === 'x' ? 'z' : v === 'z' ? 'x' : v;
                    const j = indexOfValue(st, w);
                    if (j >= 0) out[i] = j;
                }
                continue;
            }
            // Other props that name directions in their value: facing, rail shape, orientation, ...
            const words = valueOf(st, idx[i]).split('_');
            if (!words.some((w) => DIR_SET.has(w))) continue;
            const mapped = words.map((w) => (DIR_SET.has(w) ? DIRS[(DIRS.indexOf(w) + k) % 4] : w));
            // Rail shapes exist in one word order only ('south_east' but not 'east_south'), so try the reverse too.
            const first = mapped.join('_');
            const second = mapped.slice().reverse().join('_');
            let j = indexOfValue(st, first);
            if (j < 0) j = indexOfValue(st, second);
            if (j >= 0) out[i] = j;
        }

        // Re-encode with the same ordering.
        let id = b.minStateId;
        let mul = 1;
        for (let i = count - 1; i >= 0; i--) {
            id += out[i] * mul;
            mul *= sts[i].num_values;
        }
        return id;
    }

    function table(k) {
        if (tables[k]) return tables[k];
        const t = new Uint16Array(n);
        for (let id = 0; id < n; id++) {
            const b = md.blocksByStateId[id];
            t[id] = b ? rotateState(b, id, k) : id;
        }
        tables[k] = t;
        return t;
    }

    return {
        // Block state id after k clockwise quarter turns. Any integer k is taken mod 4.
        rotate(stateId, k) {
            const q = ((Math.trunc(k) % 4) + 4) % 4;
            if (q === 0) return stateId;
            return table(q)[stateId];
        },
    };
}

module.exports = { createBlockRot };
