'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRecorder } = require('../recorder');
function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, 'session');
}
test('bytes and offsets survive close and close is idempotent', async (t) => {
    const base = fixture(t);
    const rec = createRecorder(base, { logParsed: false });
    assert.equal(JSON.parse(fs.readFileSync(base + '.status.json')).complete, false);
    rec.header({ version: '1.21.1' });
    rec.raw('C2S', { state: 'play', name: 'one' }, Buffer.from([1, 2, 3]));
    rec.raw('S2C', { state: 'configuration', name: 'two' }, Buffer.from([4, 5]));
    const close = rec.close();
    assert.equal(close, rec.close());
    const result = await close;
    assert.equal(result.bytes, 5);
    assert.deepEqual([...fs.readFileSync(base + '.bin')], [1, 2, 3, 4, 5]);
    const rows = fs.readFileSync(base + '.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(rows.slice(1).map(r => [r.off, r.len]), [[0, 3], [3, 2]]);
    assert.equal(JSON.parse(fs.readFileSync(base + '.status.json')).complete, true);
    assert.equal(rec.raw('C2S', { state: 'play', name: 'late' }, Buffer.from([6])), false);
});
test('bounded queue fails closed with an incomplete marker', async (t) => {
    const base = fixture(t);
    let cause;
    const rec = createRecorder(base, { logParsed: false, maxQueuedBytes: 10, onError: e => { cause = e; } });
    assert.equal(rec.raw('C2S', { state: 'play', name: 'oversize' }, Buffer.alloc(20)), false);
    await assert.rejects(rec.close(), /queue byte limit/);
    assert.match(cause.message, /queue byte limit/);
    assert.equal(JSON.parse(fs.readFileSync(base + '.status.json')).complete, false);
});
test('capture size cap does not silently discard packets', async (t) => {
    const base = fixture(t);
    const rec = createRecorder(base, { logParsed: false, maxBytes: 2 });
    assert.equal(rec.raw('C2S', { state: 'play', name: 'oversize' }, Buffer.alloc(3)), false);
    await assert.rejects(rec.close(), /capture byte limit/);
    assert.equal(JSON.parse(fs.readFileSync(base + '.status.json')).complete, false);
});
test('file open errors settle close rather than hanging or crashing', async (t) => {
    const base = fixture(t);
    fs.mkdirSync(base + '.bin');
    const rec = createRecorder(base, { logParsed: false });
    rec.header({ test: true });
    await assert.rejects(rec.close());
    assert.equal(JSON.parse(fs.readFileSync(base + '.status.json')).complete, false);
});
