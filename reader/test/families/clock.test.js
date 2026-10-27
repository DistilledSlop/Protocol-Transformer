'use strict';
// Writer side of the clock: the GLOBAL time rows (timeset, timelock) -> Update Time packets, against the engine's clock.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { Writer } = require('../../writer/writer');
const { createCodec } = require('../../parse');
const { writerOwns } = require(path.join(__dirname, '..', '..', '..', 'engine', 'ownership'));
const { intTokens } = require('../../tokens');

const timeRow = (tokens) => ({ io: 'out', tokens });
// timeset carries the time of day in exact ticks (0..23999); values above 255 use the digit form
const TIMESET = (v) => timeRow(['GLOBAL', 'g:timeset', ...intTokens('v', v)]);
const TIMELOCK = (v) => timeRow(['GLOBAL', 'g:timelock', `v${v}`]);

// one tick with the given rows and clock; returns the packets and the writer
function tick(rows, clock) {
    const writer = new Writer();
    const out = writer.step(rows, { playerId: 1, player: { x: 0, y: 64, z: 0 }, clock });
    return { out, writer };
}

// the update_time packets in a tick's output
const updateTimes = (out) => out.filter((p) => p.name === 'update_time');

test('timeset keeps the day and sets the time of day in exact ticks', () => {
    const clock = { age: 1000, time: 5000, locked: false };
    const { out } = tick([TIMESET(12000)], clock);
    const ut = updateTimes(out);
    assert.equal(ut.length, 1);
    assert.equal(ut[0].params.age, 1000n);
    assert.equal(ut[0].params.time, 12000n);
    assert.equal(clock.time, 12000);
});

test('timeset on day 1 keeps day 1', () => {
    const clock = { age: 1000, time: 30000, locked: false };
    const { out } = tick([TIMESET(12000)], clock);
    assert.equal(updateTimes(out)[0].params.time, 36000n);
    assert.equal(clock.time, 36000);
});

test('timeset 6000 sent as v= digit tokens sets time of day 6000; v50 means 50 ticks', () => {
    const digits = timeRow(['GLOBAL', 'g:timeset', 'v=', 'd6', 'd0', 'd0', 'd0', ';']);
    const clock = { age: 1000, time: 0, locked: false };
    const { out } = tick([digits], clock);
    assert.equal(updateTimes(out)[0].params.time, 6000n);
    assert.equal(clock.time, 6000);

    const small = { age: 1000, time: 0, locked: false };
    const { out: out2 } = tick([timeRow(['GLOBAL', 'g:timeset', 'v50'])], small);
    assert.equal(updateTimes(out2)[0].params.time, 50n);
    assert.equal(small.time, 50);
});

test('timelock v1 sends the time as negative and locks; v0 sends it positive again', () => {
    const clock = { age: 2000, time: 12000, locked: false };
    const writer = new Writer();
    const ctx = { playerId: 1, player: { x: 0, y: 64, z: 0 }, clock };

    const locked = updateTimes(writer.step([TIMELOCK(1)], ctx));
    assert.equal(locked.length, 1);
    assert.equal(locked[0].params.time, -12000n);
    assert.equal(clock.locked, true);

    const unlocked = updateTimes(writer.step([TIMELOCK(0)], ctx));
    assert.equal(unlocked.length, 1);
    assert.equal(unlocked[0].params.time, 12000n);
    assert.equal(clock.locked, false);
});

test('a locked clock at time 0 sends -1, never -0', () => {
    const clock = { age: 0, time: 0, locked: false };
    const { out } = tick([TIMELOCK(1)], clock);
    const t = updateTimes(out)[0].params.time;
    assert.equal(t, -1n);
    assert.equal(Object.is(Number(t), -0), false);
});

test('timeset while locked keeps the clock locked (negative time)', () => {
    const clock = { age: 500, time: 5000, locked: true };
    const { out } = tick([TIMESET(12000)], clock);
    const ut = updateTimes(out);
    assert.equal(ut[0].params.time, -12000n);
    assert.equal(clock.locked, true);
    assert.equal(clock.time, 12000);
});

test('time rows without the engine clock are rejected', () => {
    const { out, writer } = tick([TIMESET(50), TIMELOCK(1)], undefined);
    assert.equal(updateTimes(out).length, 0);
    assert.equal(out.length, 0);
    assert.equal(writer.stats.rejected.get('time rows need the engine clock'), 2);
});

// the codec gives int64 as [hi, lo] pairs
const int64 = (v) => {
    if (Array.isArray(v)) return BigInt.asIntN(64, (BigInt(v[0]) << 32n) | BigInt(v[1] >>> 0));
    return BigInt(v);
};

test('update_time encodes with minecraft-protocol and parses back to the same age and time', () => {
    const codec = createCodec('1.21.1');
    const params = { age: 123456789n, time: -12000n };
    let buf;
    assert.doesNotThrow(() => {
        buf = codec.encode('S2C', 'update_time', params);
    });
    const back = codec.parse('S2C', buf);
    assert.equal(back.name, 'update_time');
    assert.equal(int64(back.params.age), 123456789n);
    assert.equal(int64(back.params.time), -12000n);
});

test('update_time is owned by the clock family only', () => {
    assert.equal(writerOwns('update_time', {}, new Set(['scene', 'clock']), 1), true);
    assert.equal(writerOwns('update_time', {}, new Set(['scene']), 1), false);
});
