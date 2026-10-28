'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork, spawnSync } = require('node:child_process');
const V = require('../dataset/vocab');
const script = path.join(__dirname, '../dataset/dataset.js');

test('streamed encoder preserves row order and unknown-token tie order', async (t) => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dataset-encode-'));
    t.after(() => fs.rmSync(out, { recursive: true, force: true }));
    fs.mkdirSync(path.join(out, '.cache'));
    const obj = V.build(new Map([['known', 1]]));
    fs.writeFileSync(path.join(out, 'vocab.json'), JSON.stringify(obj));
    const records = [
        { t: 4, r: [[1, 'known', 'missing-b', 'missing-a'], [2, 'known']] },
        { t: 9, r: [[0, 'missing-a', 'missing-b']] },
    ];
    fs.writeFileSync(path.join(out, '.cache', 'test.tokens.jsonl'), records.map(JSON.stringify).join('\n') + '\n');
    const result = await new Promise((resolve, reject) => {
        const child = fork(script, ['encode-worker', '--out', out, '--name', 'test'], { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] });
        let msg;
        child.on('message', (m) => { msg = m; });
        child.on('error', reject);
        child.on('exit', (code) => code === 0 ? resolve(msg) : reject(new Error(`worker exited ${code}`)));
    });
    const vocab = V.load(obj);
    const stats = { unk: new Map() };
    const expected = records.map(({ t, r }) => JSON.stringify({ t, r: r.map((row) => [row[0], ...V.encode(row.slice(1), vocab, stats)]) })).join('\n') + '\n';
    assert.equal(fs.readFileSync(path.join(out, 'test.ticks.jsonl'), 'utf8'), expected);
    assert.deepEqual(result, { unk: 4, topUnk: [['missing-b', 2], ['missing-a', 2]] });
});

test('build rejects colliding output names before starting workers', (t) => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dataset-collision-'));
    t.after(() => fs.rmSync(out, { recursive: true, force: true }));
    const result = spawnSync(process.execPath, [script, 'build', '--out', out, '/first/session', '/second/session'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /session names must be unique/);
});
