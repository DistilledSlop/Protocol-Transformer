#!/usr/bin/env node
'use strict';
// Usage: node reader/augment_check.js <session base> [--ks 1,2,3]
// Is a turned copy of a capture still the same game? Measured on things a turn must not change, original against turned:
//   walking direction vs facing    how often the player moves the way they look (yaw convention)
//   standing on something          how often the block under the player's feet is solid (chunks and positions agree)
//   digging what is there          how often a finished dig hits a non-air block (block locations and chunks agree)
//   placing against something      how often a block is placed against a solid block (location, face and chunks agree)
//   rows                           count of each row kind (nothing lost, nothing invented)

const path = require('path');
const { loadCapture, events } = require('./capture');
const { estimatePhase } = require('./phase');
const { Reader } = require('./reader');
const { createAugmenter } = require('./augment');

const arg = (n, d) => (process.argv.indexOf(n) > 0 ? process.argv[process.argv.indexOf(n) + 1] : d);
const base = process.argv[2];
if (!base || base.startsWith('--')) {
    console.error('usage: augment_check.js <session base> [--ks 1,2,3]');
    process.exit(2);
}
const KS = arg('--ks', '1,2,3').split(',').map(Number);

function measure(k) {
    const cap = loadCapture(base);
    const reader = new Reader({ phase: estimatePhase(cap).phase });
    const aug = createAugmenter(k, { catalog: reader.cat, version: cap.header.version });
    const info = reader.info;
    const m = { moveAlong: 0, moves: 0, onSolid: 0, ticks: 0, digSolid: 0, digs: 0, placeSolid: 0, places: 0, rows: new Map(), prev: null };
    const FACE = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
    const tickRows = (tks) => {
        for (const tk of tks) {
            const P = tk.player;
            if (P.known) {
                m.ticks++;
                const below = reader.S.world.get(Math.floor(P.x), Math.floor(P.y - 0.05) - (Number.isInteger(P.y) ? 0 : 0), Math.floor(P.z));
                const under = reader.S.world.get(Math.floor(P.x), Math.floor(P.y - 0.5), Math.floor(P.z));
                if (under !== undefined && info.collisionTop(under) > 0) m.onSolid++;
                else if (below !== undefined && info.collisionTop(below) > 0) m.onSolid++;
            }
            for (const r of tk.rows) {
                const key = `${r.row} ${r.kind ?? ''} ${r.io}`;
                m.rows.set(key, (m.rows.get(key) || 0) + 1);
            }
        }
    };
    for (const ev of events(cap)) {
        if (ev.kind === 'state' || ev.state !== 'play') {
            tickRows(reader.feed(ev));
            continue;
        }
        let p;
        try {
            p = reader.codec.parse(ev.dir, ev.buf);
        } catch (e) {
            continue;
        }
        const params = aug.apply(ev.dir, p.name, p.params);
        // measured on the turned packet, before the reader sees it
        if (ev.dir === 'C2S' && p.name === 'position_look') {
            if (m.prev) {
                const dx = params.x - m.prev.x;
                const dz = params.z - m.prev.z;
                const d = Math.hypot(dx, dz);
                if (d > 0.1) {
                    const yaw = (params.yaw * Math.PI) / 180;
                    const fx = -Math.sin(yaw);
                    const fz = Math.cos(yaw);
                    m.moves++;
                    if ((dx * fx + dz * fz) / d > 0.5) m.moveAlong++;
                }
            }
            m.prev = params;
        }
        if (ev.dir === 'C2S' && p.name === 'block_dig' && params.status === 2) {
            const st = reader.S.world.get(params.location.x, params.location.y, params.location.z);
            if (st !== undefined) {
                m.digs++;
                if (!info.isAir(st)) m.digSolid++;
            }
        }
        if (ev.dir === 'C2S' && p.name === 'block_place') {
            const st = reader.S.world.get(params.location.x, params.location.y, params.location.z);
            if (st !== undefined) {
                m.places++;
                if (info.collisionTop(st) > 0 || !info.isAir(st)) m.placeSolid++;
            }
        }
        tickRows(reader.feedPacket({ t: ev.t, dir: ev.dir, name: p.name, params }));
    }
    tickRows(reader.flush());
    return m;
}

const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + '%' : 'n/a');
const results = new Map([[0, measure(0)]]);
for (const k of KS) results.set(k, measure(k));
console.log(`${path.basename(base)}   turns:` + [...results.keys()].map((k) => `    k=${k}`).join(''));
const line = (label, f) => console.log(label.padEnd(34) + [...results.values()].map((m) => String(f(m)).padStart(9)).join(''));
line('moving the way they look', (m) => pct(m.moveAlong, m.moves) + ` (${m.moves})`);
line('block under the feet is solid', (m) => pct(m.onSolid, m.ticks));
line('finished dig hits a block', (m) => pct(m.digSolid, m.digs) + ` (${m.digs})`);
line('placed against a block', (m) => pct(m.placeSolid, m.places) + ` (${m.places})`);
const kinds = new Set();
for (const m of results.values()) for (const k of m.rows.keys()) kinds.add(k);
const total = (m) => [...m.rows.values()].reduce((a, b) => a + b, 0);
line('rows in total', total);
let worst = 0;
const base0 = results.get(0);
for (const key of [...kinds].sort()) {
    const counts = [...results.values()].map((m) => m.rows.get(key) || 0);
    const spread = Math.max(...counts) - Math.min(...counts);
    if (spread > 0) worst = Math.max(worst, spread / Math.max(1, counts[0]));
    if (spread > Math.max(2, 0.03 * counts[0])) line('  differs: ' + key, counts.join('/'));
}
console.log(`largest relative difference in a row count: ${(100 * worst).toFixed(1)}%`);
