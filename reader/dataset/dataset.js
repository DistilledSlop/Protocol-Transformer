#!/usr/bin/env node
'use strict';
// Usage:
//   node reader/dataset/dataset.js vocab  --out DIR  SESSION...           count tokens over the training sessions, write DIR/vocab.json
//   node reader/dataset/dataset.js export --vocab DIR/vocab.json --out DIR  SESSION...
//                                                                       write DIR/<session>.ticks.jsonl and DIR/manifest.json
//   node reader/dataset/dataset.js build --out DIR [--augment 3] [--val BASE,BASE] [--jobs N]  TRAIN_SESSION...
//                                                                       vocab and export in one go (what preprocess.sh runs): each session
//                                                                       (and each turned copy) is tokenized once, in parallel, and kept in
//                                                                       DIR/.cache until its capture or the reader code changes
//
// A session is a capture base path (without extension). The vocabulary is built from training sessions only and
// then frozen: a held-out session is exported with the same vocab.json, so its unseen tokens show up as <unk>.
//
// A ticks file has one line per tick that has rows: {"t": tick, "r": [[io, id, id, ...], ...]} where io is 0 input,
// 1 target (out), 2 engine-derived. Ticks with no rows are absent; tick numbers are absolute, so a gap is idle ticks.

const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { fork } = require('child_process');
const path = require('path');
const { loadCapture, events } = require('../capture');
const { estimatePhase } = require('../phase');
const { Reader, TERRAIN_EVERY, TERRAIN_SIDE } = require('../reader');
const V = require('./vocab');
const { createAugmenter } = require('../augment');
const { TimeSynth } = require('../synth');

const IO_CODE = { in: 0, out: 1, eng: 2 };

function arg(name, def) {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : def;
}

// every closed tick of a session, with the phase that was used. k > 0: the same session with the world turned k quarter
// turns (reader/augment.js), packet by packet before the reader sees it
function* ticksOf(base, k = 0, { synth = false } = {}) {
    const cap = loadCapture(base);
    const est = estimatePhase(cap);
    const reader = new Reader({ phase: est.phase, terrain: true });
    const aug = k ? createAugmenter(k, { catalog: reader.cat, version: cap.header.version }) : null;
    // synth: /time commands the capture does not have (reader/synth.js), fed as packets among the real ones
    const time = synth ? new TimeSynth(`${path.basename(base)}@${k}`) : null;
    for (const ev of events(cap)) {
        if (time && ev.state === 'play') {
            for (const s of time.due(ev.t)) yield* reader.feedPacket(s).map((tk) => ({ tk, est, cap }));
            if (ev.dir === 'S2C' && ev.name === 'update_time') {
                try {
                    const p = reader.codec.parse(ev.dir, ev.buf);
                    yield* reader.feedPacket({ t: ev.t, dir: ev.dir, name: p.name, params: time.adjust(p.params, ev.t) }).map((tk) => ({ tk, est, cap }));
                    continue;
                } catch (e) {
                    // an Update Time that does not parse goes through as it is
                }
            }
        }
        if (!aug || ev.kind === 'state' || ev.state !== 'play') {
            yield* reader.feed(ev).map((tk) => ({ tk, est, cap }));
            continue;
        }
        let p;
        try {
            p = reader.codec.parse(ev.dir, ev.buf);
        } catch (e) {
            continue; // the plain reader counts these; a packet it cannot read is not in the turned copy either
        }
        yield* reader.feedPacket({ t: ev.t, dir: ev.dir, name: p.name, params: aug.apply(ev.dir, p.name, p.params) }).map((tk) => ({ tk, est, cap }));
    }
    yield* reader.flush().map((tk) => ({ tk, est, cap }));
}

// the copies of a session to write: the original and, with --augment N, N turned ones named <session>@r<k>
const copies = (n) => Array.from({ length: n + 1 }, (_, k) => k);
const copyName = (base, k) => path.basename(base) + (k ? `@r${k}` : '');

function sessions() {
    const rest = process.argv.slice(3);
    const out = [];
    for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--append') continue; // a flag without a value
        if (rest[i].startsWith('--')) i++;
        else out.push(rest[i]);
    }
    return out;
}

const cmd = process.argv[2];
const outDir = arg('--out', path.join(__dirname, 'out'));
fs.mkdirSync(outDir, { recursive: true });

if (cmd === 'vocab') {
    const counts = new Map();
    for (const base of sessions()) {
        for (const k of copies(+arg('--augment', 0))) {
            for (const { tk } of ticksOf(base, k)) for (const r of tk.rows) for (const t of r.tokens) counts.set(t, (counts.get(t) || 0) + 1);
        }
    }
    const v = V.build(counts, { minCount: +arg('--min-count', 1) });
    fs.writeFileSync(path.join(outDir, 'vocab.json'), JSON.stringify({ tokens: v.tokens, structural: v.structural, sessions: sessions().map((s) => path.basename(s)) }));
    console.log(`vocabulary: ${v.tokens.length} tokens (${v.structural} structural, ${v.tokens.length - v.structural} learned from ${counts.size} distinct tokens seen)`);
} else if (cmd === 'export') {
    const vocab = V.load(JSON.parse(fs.readFileSync(arg('--vocab'), 'utf8')));
    let manifest = { vocab: path.resolve(arg('--vocab')), sessions: [] };
    const manifestPath = path.join(outDir, 'manifest.json');
    // --append adds to the manifest already there (the held-out sessions are exported on their own, unturned)
    if (process.argv.includes('--append') && fs.existsSync(manifestPath)) manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const jobs = sessions().flatMap((base) => copies(+arg('--augment', 0)).map((k) => ({ base, k })));
    for (const { base, k } of jobs) {
        const name = copyName(base, k);
        manifest.sessions = manifest.sessions.filter((s) => s.name !== name);
        const file = fs.createWriteStream(path.join(outDir, `${name}.ticks.jsonl`));
        const stats = { unk: new Map() };
        let first = null;
        let last = null;
        let withRows = 0;
        const rows = { in: 0, out: 0, eng: 0 };
        let phase = null;
        // terrain patches, one per TERRAIN_EVERY ticks, in tick order; a missing one repeats the last
        const terrainFile = fs.createWriteStream(path.join(outDir, `${name}.terrain.u8`));
        let terrainFirst = null;
        let terrainCount = 0;
        let lastPatch = null;
        for (const { tk, est } of ticksOf(base, k)) {
            phase = est.phase;
            if (first === null) first = tk.tick;
            last = tk.tick;
            if (tk.terrain) {
                if (terrainFirst === null) terrainFirst = tk.tick;
                while (terrainCount < (tk.tick - terrainFirst) / TERRAIN_EVERY) {
                    terrainFile.write(lastPatch);
                    terrainCount++;
                }
                terrainFile.write(tk.terrain);
                lastPatch = tk.terrain;
                terrainCount++;
            }
            if (!tk.rows.length) continue;
            withRows++;
            const r = tk.rows.map((row) => {
                rows[row.io]++;
                return [IO_CODE[row.io], ...V.encode(row.tokens, vocab, stats)];
            });
            file.write(JSON.stringify({ t: tk.tick, r }) + '\n');
        }
        file.end();
        terrainFile.end();
        const unk = [...stats.unk.values()].reduce((a, b) => a + b, 0);
        manifest.sessions.push({ name, phase, firstTick: first, lastTick: last, ticks: last - first + 1, ticksWithRows: withRows, rows, terrain: { file: `${name}.terrain.u8`, firstTick: terrainFirst, every: TERRAIN_EVERY, side: TERRAIN_SIDE, patches: terrainCount }, unkTokens: unk, topUnk: [...stats.unk].sort((a, b) => b[1] - a[1]).slice(0, 8) });
        console.log(`${name}: ticks ${first}..${last}, ${withRows} with rows, rows in/out/eng ${rows.in}/${rows.out}/${rows.eng}, ${unk} <unk> tokens`);
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
} else if (cmd === 'worker') {
    // one session (one turn of it) tokenized: rows as token strings into the cache, terrain patches into the dataset
    (async () => {
        const base = arg('--base');
        const k = +arg('--k', 0);
        const name = copyName(base, k);
        const cache = path.join(outDir, '.cache');
        fs.mkdirSync(cache, { recursive: true });
        const tokens = fs.createWriteStream(path.join(cache, `${name}.tokens.jsonl`));
        const terrainFile = fs.createWriteStream(path.join(outDir, `${name}.terrain.u8`));
        const counts = {};
        const rows = { in: 0, out: 0, eng: 0 };
        let first = null;
        let last = null;
        let withRows = 0;
        let phase = null;
        let terrainFirst = null;
        let terrainCount = 0;
        let lastPatch = null;
        for (const { tk, est } of ticksOf(base, k, { synth: process.argv.includes('--synth') })) {
            phase = est.phase;
            if (first === null) first = tk.tick;
            last = tk.tick;
            if (tk.terrain) {
                if (terrainFirst === null) terrainFirst = tk.tick;
                while (terrainCount < (tk.tick - terrainFirst) / TERRAIN_EVERY) {
                    terrainFile.write(lastPatch);
                    terrainCount++;
                }
                terrainFile.write(tk.terrain);
                lastPatch = tk.terrain;
                terrainCount++;
            }
            if (!tk.rows.length) continue;
            withRows++;
            const r = tk.rows.map((row) => {
                rows[row.io]++;
                for (const t of row.tokens) counts[t] = (counts[t] || 0) + 1;
                return [IO_CODE[row.io], ...row.tokens];
            });
            tokens.write(JSON.stringify({ t: tk.tick, r }) + '\n');
        }
        await Promise.all([tokens, terrainFile].map((f) => new Promise((res) => f.end(res))));
        const meta = {
            key: arg('--key'), name, phase, firstTick: first, lastTick: last, ticks: last - first + 1, ticksWithRows: withRows, rows, counts,
            terrain: { file: `${name}.terrain.u8`, firstTick: terrainFirst, every: TERRAIN_EVERY, side: TERRAIN_SIDE, patches: terrainCount },
        };
        fs.writeFileSync(path.join(cache, `${name}.meta.json`), JSON.stringify(meta));
    })().then(() => process.exit(0), (e) => {
        console.error(e);
        process.exit(1);
    });
} else if (cmd === 'build') {
    (async () => {
        const augment = +arg('--augment', 0);
        const val = (arg('--val', '') || '').split(',').filter(Boolean);
        const pool = +arg('--jobs', Math.max(1, Math.min(os.cpus().length - 2, 12)));
        const jobs = [
            ...sessions().flatMap((base) => copies(augment).map((k) => ({ base, k, train: true }))),
            ...val.map((base) => ({ base, k: 0, train: false })),
        ];
        const cache = path.join(outDir, '.cache');
        fs.mkdirSync(cache, { recursive: true });

        // what a tokenized session depends on: the capture and the reader code
        const code = crypto.createHash('sha1');
        const readerDir = path.join(__dirname, '..');
        for (const dir of ['', 'handlers', 'dataset']) {
            for (const f of fs.readdirSync(path.join(readerDir, dir)).sort()) {
                if (/\.(js|json|tsv)$/.test(f)) code.update(f).update(fs.readFileSync(path.join(readerDir, dir, f)));
            }
        }
        code.update(fs.readFileSync(path.join(readerDir, 'wiki', 'entity_classes.json')));
        const codeKey = code.digest('hex');
        for (const j of jobs) {
            const st = ['.bin', '.jsonl'].map((e) => fs.statSync(j.base + e));
            j.name = copyName(j.base, j.k);
            j.key = crypto.createHash('sha1').update(`${codeKey}|${st.map((x) => `${x.size}:${x.mtimeMs}`)}|${j.k}|${j.train ? 'synth' : ''}`).digest('hex');
            const metaPath = path.join(cache, `${j.name}.meta.json`);
            j.fresh = fs.existsSync(metaPath) && JSON.parse(fs.readFileSync(metaPath, 'utf8')).key === j.key
                && fs.existsSync(path.join(cache, `${j.name}.tokens.jsonl`)) && fs.existsSync(path.join(outDir, `${j.name}.terrain.u8`));
        }
        const stale = jobs.filter((j) => !j.fresh);
        console.log(`${jobs.length} sessions and turned copies: ${jobs.length - stale.length} unchanged, ${stale.length} to tokenize on ${Math.min(pool, stale.length)} processes`);
        let next = 0;
        let done = 0;
        const t0 = Date.now();
        const worker = async () => {
            while (next < stale.length) {
                const j = stale[next++];
                await new Promise((res, rej) => {
                    const c = fork(__filename, ['worker', '--out', outDir, '--base', j.base, '--k', String(j.k), '--key', j.key, ...(j.train ? ['--synth'] : [])], { stdio: 'inherit' });
                    c.on('exit', (code) => (code === 0 ? res() : rej(new Error(`tokenizing ${j.name} failed (${code})`))));
                });
                done++;
                if (done % 10 === 0 || done === stale.length) console.log(`  ${done}/${stale.length} tokenized (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
            }
        };
        await Promise.all(Array.from({ length: Math.min(pool, stale.length) }, worker));

        // vocabulary from the training sessions only, then every session encoded with it
        const metas = jobs.map((j) => JSON.parse(fs.readFileSync(path.join(cache, `${j.name}.meta.json`), 'utf8')));
        const counts = new Map();
        jobs.forEach((j, i) => {
            if (j.train) for (const [t, n] of Object.entries(metas[i].counts)) counts.set(t, (counts.get(t) || 0) + n);
        });
        const v = V.build(counts, { minCount: +arg('--min-count', 1) });
        fs.writeFileSync(path.join(outDir, 'vocab.json'), JSON.stringify({ tokens: v.tokens, structural: v.structural, sessions: jobs.filter((j) => j.train).map((j) => j.name) }));
        console.log(`vocabulary: ${v.tokens.length} tokens (${v.structural} structural, ${v.tokens.length - v.structural} learned from ${counts.size} distinct tokens seen)`);
        const vocab = V.load(JSON.parse(fs.readFileSync(path.join(outDir, 'vocab.json'), 'utf8')));
        const manifest = { vocab: path.resolve(path.join(outDir, 'vocab.json')), sessions: [] };
        for (const [i, j] of jobs.entries()) {
            const m = metas[i];
            const stats = { unk: new Map() };
            const out = fs.createWriteStream(path.join(outDir, `${j.name}.ticks.jsonl`));
            for (const line of fs.readFileSync(path.join(cache, `${j.name}.tokens.jsonl`), 'utf8').split('\n')) {
                if (!line) continue;
                const rec = JSON.parse(line);
                out.write(JSON.stringify({ t: rec.t, r: rec.r.map((row) => [row[0], ...V.encode(row.slice(1), vocab, stats)]) }) + '\n');
            }
            await new Promise((res) => out.end(res));
            const unk = [...stats.unk.values()].reduce((a, b) => a + b, 0);
            manifest.sessions.push({ name: j.name, phase: m.phase, firstTick: m.firstTick, lastTick: m.lastTick, ticks: m.ticks, ticksWithRows: m.ticksWithRows, rows: m.rows, terrain: m.terrain, unkTokens: unk, topUnk: [...stats.unk].sort((a, b) => b[1] - a[1]).slice(0, 8) });
        }
        fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
        // files of sessions that are no longer in the set
        const keep = new Set(jobs.map((j) => j.name));
        for (const f of fs.readdirSync(outDir)) {
            const m = /^(.*)\.(ticks\.jsonl|terrain\.u8)$/.exec(f);
            if (m && !keep.has(m[1])) fs.rmSync(path.join(outDir, f));
        }
        for (const f of fs.readdirSync(cache)) {
            const m = /^(.*)\.(tokens\.jsonl|meta\.json)$/.exec(f);
            if (m && !keep.has(m[1])) fs.rmSync(path.join(cache, f));
        }
        console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${jobs.filter((j) => j.train).length} training and ${jobs.filter((j) => !j.train).length} held-out sessions`);
    })().catch((e) => {
        console.error(e);
        process.exit(1);
    });
} else {
    console.error('usage: dataset.js vocab|export|build --out DIR [--vocab FILE] SESSION...');
    process.exit(2);
}
