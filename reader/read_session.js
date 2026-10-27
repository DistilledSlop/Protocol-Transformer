#!/usr/bin/env node
'use strict';
// Usage: node read_session.js <session base path, without extension> [--out rows.jsonl] [--text rows.txt]
//                              [--vocab vocab.json] [--phase ms] [--ticks N]
// Prints reader statistics; optionally writes one JSON line per tick with rows, a token text dump
// ('<' input, '>' target, '~' engine-derived), and the token counts seen.

const fs = require('fs');
const { loadCapture, events } = require('./capture');
const { estimatePhase } = require('./phase');
const { Reader } = require('./reader');

function arg(name, def) {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : def;
}

const base = process.argv[2];
if (!base || base.startsWith('--')) {
    console.error('usage: read_session.js <session base> [--out f] [--text f] [--vocab f] [--phase ms] [--ticks N]');
    process.exit(2);
}
const cap = loadCapture(base);
const est = estimatePhase(cap);
const phase = arg('--phase') !== undefined ? +arg('--phase') : est.phase;
const maxTicks = +arg('--ticks', Infinity);
const reader = new Reader({ phase });

const out = arg('--out') ? fs.createWriteStream(arg('--out')) : null;
const text = arg('--text') ? fs.createWriteStream(arg('--text')) : null;
const vocab = new Map();
let ticksWithRows = 0;
let firstTick = null;
let lastTick = null;

const emit = (tk) => {
    if (firstTick === null) firstTick = tk.tick;
    lastTick = tk.tick;
    if (!tk.rows.length) return;
    ticksWithRows++;
    for (const r of tk.rows) for (const t of r.tokens) vocab.set(t, (vocab.get(t) || 0) + 1);
    if (out) out.write(JSON.stringify({ tick: tk.tick, rows: tk.rows.map(({ tokens, io, row, kind, slot }) => ({ io, row, kind, slot, tokens })) }) + '\n');
    if (text) {
        text.write(`TICK ${tk.tick}\n`);
        for (const r of tk.rows) text.write(`${r.io === 'in' ? '<' : r.io === 'eng' ? '~' : '>'} ${r.tokens.join(' ')}\n`);
        text.write('END\n');
    }
};

for (const ev of events(cap)) {
    for (const tk of reader.feed(ev)) emit(tk);
    if (lastTick !== null && lastTick - firstTick >= maxTicks) break;
}
for (const tk of reader.flush()) emit(tk);
if (out) out.end();
if (text) text.end();
if (arg('--vocab')) fs.writeFileSync(arg('--vocab'), JSON.stringify(Object.fromEntries([...vocab].sort((a, b) => b[1] - a[1])), null, 1));

const pct = (arr, p) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const st = reader.stats;
console.log(`session   ${base}`);
console.log(`phase     tick boundary ${phase.toFixed(2)} ms, burst peak ${est.peak.toFixed(2)} ms (concentration ${est.concentration.toFixed(2)}, ${est.n} entity packets)`);
console.log(`ticks     ${firstTick}..${lastTick} (${lastTick - firstTick + 1}), ${ticksWithRows} with rows; play packets parsed ${st.packets}`);
console.log(`vocabulary ${vocab.size} distinct tokens`);
console.log('rows:');
for (const [k, n] of [...st.rows].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(7)}  ${k}`);
console.log('quantization (units of the field class): n', st.quant.n, 'median rel err', pct(st.quant.relErr, 50).toFixed(4), 'p95 rel err', pct(st.quant.relErr, 95).toFixed(4));
const show = (title, m) => {
    if (!m.size) return;
    console.log(title);
    for (const [k, n] of [...m].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${String(n).padStart(7)}  ${k}`);
};
show('dropped:', st.dropped);
show('parse errors:', st.parseErrors);
show('packets that should make rows but have no handler (top 25):', st.unhandled);
show('packets with no row by design (engine, baked, derived, dropped; top 25):', st.byDesign);
