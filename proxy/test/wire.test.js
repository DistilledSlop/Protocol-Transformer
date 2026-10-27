'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const mc = require('minecraft-protocol');
const { installWireTap } = require('../wire');

const varint = (value) => {
    const result = [];
    do { const byte = value & 0x7f; value >>>= 7; result.push(byte | (value ? 0x80 : 0)); } while (value);
    return Buffer.from(result);
};
const framed = (payload) => Buffer.concat([varint(payload.length), payload]);
const pause = () => new Promise((resolve) => setImmediate(resolve));
const keepAlive = Buffer.concat([Buffer.from([0x26]), Buffer.alloc(8, 1)]);
function fixture(t) {
    const client = new mc.Client(false, '1.21.1', undefined, true);
    client.state = mc.states.PLAY;
    const errors = [];
    client.on('error', (error) => errors.push(error));
    const captured = [], forwarded = [];
    const stop = installWireTap(client, (bytes, meta) => { captured.push({ bytes, meta }); forwarded.push(Buffer.from(bytes)); });
    t.after(stop);
    return { client, captured, forwarded, errors, stop };
}

test('malformed parsed packets are still captured and forwarded exactly once', async (t) => {
    const f = fixture(t);
    let parsedRaw = 0;
    f.client.on('raw', () => parsedRaw++);
    const missingRecipeBody = Buffer.from([0x77, 0x01]);
    f.client.splitter.write(framed(missingRecipeBody));
    await pause();
    assert.equal(parsedRaw, 0);
    assert.equal(f.captured.length, 1);
    assert.equal(f.forwarded.length, 1);
    assert.equal(f.captured[0].meta.name, 'declare_recipes');
    assert.deepEqual(f.captured[0].bytes, missingRecipeBody);
    assert.deepEqual(f.forwarded[0], missingRecipeBody);
});

test('parser callbacks cannot mutate recorded or forwarded buffers', async (t) => {
    const f = fixture(t);
    f.client.on('packet', (_data, _meta, buffer) => buffer.fill(0));
    f.client.splitter.write(framed(keepAlive));
    await pause();
    assert.deepEqual(f.captured[0].bytes, keepAlive);
    assert.deepEqual(f.forwarded[0], keepAlive);
});

test('bundle delimiters and contents retain original wire arrival order', async (t) => {
    const f = fixture(t);
    let parsedRaw = 0;
    f.client.on('raw', () => parsedRaw++);
    f.client.splitter.write(framed(Buffer.from([0])));
    await pause();
    assert.equal(f.captured.length, 1);
    assert.equal(parsedRaw, 0);
    f.client.splitter.write(framed(keepAlive));
    await pause();
    assert.equal(f.captured.length, 2);
    assert.equal(parsedRaw, 0);
    f.client.splitter.write(framed(Buffer.from([0])));
    await pause();
    assert.equal(f.captured.length, 3);
    assert.equal(parsedRaw, 3);
    assert.deepEqual(f.captured.map((row) => row.meta.name), ['bundle_delimiter', 'keep_alive', 'bundle_delimiter']);
});

test('compression changes switch to decompressed frames without duplicate capture', async (t) => {
    const f = fixture(t);
    f.client.splitter.write(framed(keepAlive));
    f.client.setCompressionThreshold(1);
    const compressed = Buffer.concat([varint(keepAlive.length), zlib.deflateSync(keepAlive)]);
    f.client.splitter.write(framed(compressed));
    await pause();
    f.client.setCompressionThreshold(1024);
    f.client.splitter.write(framed(Buffer.concat([Buffer.from([0]), keepAlive])));
    await pause();
    assert.equal(f.captured.length, 3);
    for (const row of f.captured) assert.deepEqual(row.bytes, keepAlive);
});

test('state changes resolve packet names from the current phase and cleanup is idempotent', async (t) => {
    const f = fixture(t);
    f.client.state = mc.states.CONFIGURATION;
    f.client.splitter.write(framed(Buffer.from([3])));
    await pause();
    assert.equal(f.captured[0].meta.state, 'configuration');
    assert.equal(f.captured[0].meta.name, 'finish_configuration');
    f.client.state = mc.states.PLAY;
    f.client.splitter.write(framed(keepAlive));
    await pause();
    assert.equal(f.captured[1].meta.state, 'play');
    f.stop(); f.stop();
    f.client.splitter.write(framed(keepAlive));
    await pause();
    assert.equal(f.captured.length, 2);
});
