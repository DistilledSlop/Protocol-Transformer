#!/usr/bin/env node
'use strict';
// Usage: node roundtrip.js <session base>...
// Checks encode(parse(bytes)) == bytes for every play packet, both directions, and lists failures by name.

const { loadCapture, events } = require('./capture');
const { createCodec } = require('./parse');

let failed = false;
for (const base of process.argv.slice(2)) {
    const cap = loadCapture(base);
    const codec = createCodec(cap.header.version);
    let ok = 0;
    const mismatch = new Map();
    const errors = new Map();
    for (const e of events(cap)) {
        if (e.kind || e.state !== 'play') continue;
        const key = `${e.dir} ${e.name}`;
        try {
            const p = codec.parse(e.dir, e.buf);
            if (p.name !== e.name) throw new Error(`parsed as ${p.name}`);
            if (Buffer.compare(codec.encode(e.dir, p.name, p.params), e.buf) === 0) ok++;
            else mismatch.set(key, (mismatch.get(key) || 0) + 1);
        } catch (err) {
            errors.set(key, (errors.get(key) || 0) + 1);
        }
    }
    const bad = [...mismatch.values(), ...errors.values()].reduce((a, b) => a + b, 0);
    console.log(`${base}: ${ok} identical, ${mismatch.size ? [...mismatch].map(([k, n]) => `${n}x ${k} differ`).join(', ') : 'no byte mismatches'}, ${errors.size ? [...errors].map(([k, n]) => `${n}x ${k} unparsable`).join(', ') : 'no parse errors'}`);
    if (bad) failed = true;
}
process.exit(failed ? 1 : 0);
