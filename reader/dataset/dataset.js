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
const readline = require('readline');
// Encoding does not need the heavy protocol codecs and registries.
const encodingOnly = process.argv[2] === 'encode-worker';
const { loadCapture, events } = encodingOnly ? {} : require('../capture');
const { estimatePhase } = encodingOnly ? {} : require('../phase');
const { Reader, TERRAIN_EVERY, TERRAIN_SIDE } = encodingOnly ? {} : require('../reader');
const V = require('./vocab');
const { createAugmenter } = encodingOnly ? {} : require('../augment');
const { TimeSynth } = encodingOnly ? {} : require('../synth');

const IO_CODE = { in: 0, out: 1, eng: 2 };

// Account for a container memory limit when Linux reports host-wide free memory.
function availableMemory() {
    let free = os.freemem();
    try {
        const limit = Number(fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim());
        const used = Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim());
        if (Number.isFinite(limit) && Number.isFinite(used)) free = Math.min(free, Math.max(0, limit - used));
    } catch (_) { /* non-cgroup or cgroup v1: use OS free memory */ }
    return free;
}

// Synchronous batched writes keep memory bounded even when tokenization outpaces disk.
class BufferedWriter {
    constructor(file) { this.fd = fs.openSync(file, 'w'); this.parts = []; this.size = 0; }
    write(data) {
        const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
        this.parts.push(b); this.size += b.length;
        if (this.size >= 256 * 1024) this.flush();
    }
    flush() {
        if (!this.size) return;
        const b = Buffer.concat(this.parts, this.size);
        let pos = 0;
        while (pos < b.length) pos += fs.writeSync(this.fd, b, pos, b.length - pos);
        this.parts = []; this.size = 0;
    }
    end() { this.flush(); fs.closeSync(this.fd); }
}


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
        const tokens = new BufferedWriter(path.join(cache, `${name}.tokens.jsonl`));
        const terrainFile = new BufferedWriter(path.join(outDir, `${name}.terrain.u8`));
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
        tokens.end();
        terrainFile.end();
        const meta = {
            key: arg('--key'), name, phase, firstTick: first, lastTick: last, ticks: last - first + 1, ticksWithRows: withRows, rows, counts,
            terrain: { file: `${name}.terrain.u8`, firstTick: terrainFirst, every: TERRAIN_EVERY, side: TERRAIN_SIDE, patches: terrainCount },
        };
        fs.writeFileSync(path.join(cache, `${name}.meta.json`), JSON.stringify(meta));
    })().then(() => process.exit(0), (e) => {
        console.error(e);
        process.exit(1);
    });
} else if (cmd === 'encode-worker') {
    (async () => {
        const name = arg('--name');
        const vocab = V.load(JSON.parse(fs.readFileSync(path.join(outDir, 'vocab.json'), 'utf8')));
        const stats = { unk: new Map() };
        const out = new BufferedWriter(path.join(outDir, `${name}.ticks.jsonl`));
        const input = fs.createReadStream(path.join(outDir, '.cache', `${name}.tokens.jsonl`));
        const lines = readline.createInterface({ input, crlfDelay: Infinity });
        input.on('error', (error) => lines.emit('error', error));
        for await (const line of lines) {
            if (!line) continue;
            const rec = JSON.parse(line);
            out.write(JSON.stringify({ t: rec.t, r: rec.r.map((row) => [row[0], ...V.encode(row.slice(1), vocab, stats)]) }) + '\n');
        }
        out.end();
        const unk = [...stats.unk.values()].reduce((a, b) => a + b, 0);
        if (process.send) process.send({ unk, topUnk: [...stats.unk].sort((a, b) => b[1] - a[1]).slice(0, 8) });
    })().catch((e) => { console.error(e); process.exitCode = 1; });
} else if (cmd === 'build') {
    (async () => {
        const augment = +arg('--augment', 0);
        const val = (arg('--val', '') || '').split(',').filter(Boolean);

        const jobs = [
            ...sessions().flatMap((base) => copies(augment).map((k) => ({ base, k, train: true }))),
            ...val.map((base) => ({ base, k: 0, train: false })),
        ];
        const cache = path.join(outDir, '.cache');
        fs.mkdirSync(cache, { recursive: true });
        const names = jobs.map((j) => copyName(j.base, j.k));
        if (new Set(names).size !== names.length) throw new Error('session names must be unique, including training and validation copies');
        // Capture parsing loads the binary and index in memory. Budget four times the
        // largest input plus 512 MiB per worker, leaving 30% of free memory for the OS.
        const largest = Math.max(0, ...jobs.map((j) => fs.statSync(j.base + '.bin').size + fs.statSync(j.base + '.jsonl').size));
        const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
        const automatic = Math.max(1, Math.min(Math.max(1, cpus - 2), Math.floor(availableMemory() * 0.7 / (512 * 1024 * 1024 + 4 * largest))));
        const pool = +arg('--jobs', automatic);
        if (!Number.isSafeInteger(pool) || pool < 1) throw new Error('--jobs must be a positive integer');

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
        // Abort outstanding workers on the first error, so none keep writing after failure.
        const children = new Set();
        const runChild = (args, result = false) => new Promise((resolve, reject) => {
            const c = fork(__filename, args, { stdio: result ? ['ignore', 'inherit', 'inherit', 'ipc'] : 'inherit' });
            children.add(c);
            let message;
            if (result) c.on('message', (m) => { message = m; });
            c.on('error', reject);
            c.on('exit', (code, signal) => {
                children.delete(c);
                if (code === 0 && (!result || message)) resolve(message);
                else reject(new Error(`worker failed (${signal || code})`));
            });
        });
        let aborted = false;
        const runPool = async (count, task) => {
            const tasks = Array.from({ length: count }, task);
            try { await Promise.all(tasks); }
            catch (e) {
                aborted = true;
                for (const c of children) c.kill();
                await Promise.allSettled(tasks);
                throw e;
            }
        };
        let next = 0;
        let done = 0;
        const t0 = Date.now();
        const worker = async () => {
            while (!aborted && next < stale.length) {
                const j = stale[next++];
                // Invalidate before overwriting, so an interrupted rewrite cannot look fresh.
                fs.rmSync(path.join(cache, `${j.name}.meta.json`), { force: true });
                await runChild(['worker', '--out', outDir, '--base', j.base, '--k', String(j.k), '--key', j.key, ...(j.train ? ['--synth'] : [])]);
                done++;
                if (done % 10 === 0 || done === stale.length) console.log(`  ${done}/${stale.length} tokenized (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
            }
        };
        await runPool(Math.min(pool, stale.length), worker);

        // vocabulary from the training sessions only, then every session encoded with it
        const metas = jobs.map((j) => JSON.parse(fs.readFileSync(path.join(cache, `${j.name}.meta.json`), 'utf8')));
        const counts = new Map();
        jobs.forEach((j, i) => {
            if (j.train) for (const [t, n] of Object.entries(metas[i].counts)) counts.set(t, (counts.get(t) || 0) + n);
        });
        const v = V.build(counts, { minCount: +arg('--min-count', 1) });
        fs.writeFileSync(path.join(outDir, 'vocab.json'), JSON.stringify({ tokens: v.tokens, structural: v.structural, sessions: jobs.filter((j) => j.train).map((j) => j.name) }));
        console.log(`vocabulary: ${v.tokens.length} tokens (${v.structural} structural, ${v.tokens.length - v.structural} learned from ${counts.size} distinct tokens seen)`);
        const manifest = { vocab: path.resolve(path.join(outDir, 'vocab.json')), sessions: new Array(jobs.length) };
        let encodeNext = 0;
        console.log(`encoding ${jobs.length} sessions on ${Math.min(pool, jobs.length)} processes`);
        const encodeWorker = async () => {
            while (!aborted && encodeNext < jobs.length) {
                const i = encodeNext++;
                const j = jobs[i];
                const result = await runChild(['encode-worker', '--out', outDir, '--name', j.name], true);
                const m = metas[i];
                manifest.sessions[i] = { name: j.name, phase: m.phase, firstTick: m.firstTick, lastTick: m.lastTick, ticks: m.ticks, ticksWithRows: m.ticksWithRows, rows: m.rows, terrain: m.terrain, unkTokens: result.unk, topUnk: result.topUnk };
            }
        };
        await runPool(Math.min(pool, jobs.length), encodeWorker);
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
