'use strict';
// The /time path end to end: the command's tokens, the clock rows the reader writes from Update Time, the synthetic
// packets (reader/synth.js) and a full run where synthetic packets go through the Reader.

const test = require('node:test');
const assert = require('node:assert/strict');
const { TimeSynth } = require('../synth');
const { intTokens } = require('../tokens');
const { makeReader, pkt, run, startPackets } = require('./helpers');

const NAMED = { day: 1000, noon: 6000, night: 13000, midnight: 18000 };

// Every row of a set of closed ticks, flattened.
const allRows = (ticks) => ticks.flatMap((t) => t.rows);
const globals = (ticks, kind) => allRows(ticks).filter((r) => r.row === 'GLOBAL' && r.tokens[1] === kind);
const tickOf = (ticks, pred) => ticks.filter((t) => t.rows.some(pred)).map((t) => t.tick);
const update = (t, age, time) => pkt(t, 'S2C', 'update_time', { age, time });

// Feeds the packets, then closes every tick before time t (advanceTo) and the open one (flush).
function runTo(packets, t) {
    const r = makeReader();
    const ticks = [];
    for (const p of packets) ticks.push(...r.feedPacket(p));
    ticks.push(...r.advanceTo(t));
    ticks.push(...r.flush());
    return ticks;
}

// The tokens of the COMMAND row a typed command makes (the closed tick that holds it).
function commandTokens(text) {
    const ticks = run(makeReader(), [...startPackets(), pkt(200, 'C2S', 'chat_command', { command: text })]);
    const rows = allRows(ticks).filter((r) => r.io === 'in' && r.kind === 'COMMAND');
    assert.equal(rows.length, 1, `one COMMAND row for "${text}"`);
    return rows[0].tokens;
}

// ---- 1. command tokens -------------------------------------------------------------------------------------

test('time set noon: the keyword is its own token, no span', () => {
    const tokens = commandTokens('time set noon');
    assert.deepEqual(tokens, ['EVENT', 's0', 'COMMAND', 'cmd:time', 'argc2', 'arg:set', 'arg:noon']);
    assert.ok(!tokens.some((t) => t.startsWith('span')));
});

test('time set midnight and time set noon are different rows', () => {
    assert.notDeepEqual(commandTokens('time set midnight'), commandTokens('time set noon'));
});

test('time set 1000: the value is number tokens', () => {
    const tokens = commandTokens('time set 1000');
    assert.deepEqual(tokens.slice(5), ['arg:set', ...intTokens('v', 1000)]);
    assert.deepEqual(tokens.slice(6), ['v=', 'd1', 'd0', 'd0', 'd0', ';']);
});

test('time set 3d: value 3 then the unit', () => {
    assert.deepEqual(commandTokens('time set 3d').slice(5), ['arg:set', ...intTokens('v', 3), 'arg:d']);
});

test('time query daytime: keywords only', () => {
    assert.deepEqual(commandTokens('time query daytime').slice(5), ['arg:query', 'arg:daytime']);
});

test('a word that is not a keyword is a span', () => {
    const tokens = commandTokens('Hello World!');
    assert.deepEqual(tokens, ['EVENT', 's0', 'COMMAND', 'cmd:Hello', 'argc1', 'span0']);
});

// ---- 2. time rows from Update Time ---------------------------------------------------------------------------

test('a small drift in Update Time gives no timeset row; a jump past 2 ticks gives one with the exact time of day', () => {
    const ticks = run(makeReader(), [...startPackets(), update(100, 100n, 5000n), update(150, 101n, 5001n), update(200, 102n, 12000n)]);
    const sets = globals(ticks, 'g:timeset');
    assert.equal(sets.length, 1, 'only the jump makes a row');
    assert.equal(sets[0].io, 'out');
    assert.deepEqual(sets[0].tokens, ['GLOBAL', 'g:timeset', ...intTokens('v', 12000)]);
});

test('a locked clock: a repeat is no row, a new locked value is a timeset row and no timelock row', () => {
    const ticks = run(makeReader(), [
        ...startPackets(),
        update(100, 100n, -5000n),
        update(150, 101n, -5000n),
        update(200, 102n, -18000n),
    ]);
    // the first -5000 is itself a flip from the default (unlocked), so it is the only timelock row; -18000 is no flip
    assert.deepEqual(tickOf(ticks, (r) => r.row === 'GLOBAL' && r.tokens[1] === 'g:timelock'), [2]);
    const sets = globals(ticks, 'g:timeset');
    assert.equal(sets.length, 1);
    assert.deepEqual(sets[0].tokens, ['GLOBAL', 'g:timeset', ...intTokens('v', 18000)]);
});

test('an unlocked to locked flip gives a timelock row and no timeset row', () => {
    const ticks = run(makeReader(), [...startPackets(), update(100, 100n, 5000n), update(150, 101n, -5000n)]);
    const locks = globals(ticks, 'g:timelock');
    assert.equal(locks.length, 1);
    assert.deepEqual(locks[0].tokens, ['GLOBAL', 'g:timelock', 'v1']);
    assert.equal(globals(ticks, 'g:timeset').length, 0);
});

// ---- 3. clock context row ------------------------------------------------------------------------------------

test('the clock row is sent one tick after the update that set it, then every 40 ticks', () => {
    // updates at tick 2 (5000) and tick 3 (5001), then the stream runs on to tick 90 with no more updates
    const ticks = runTo([...startPackets(), update(100, 100n, 5000n), update(150, 101n, 5001n)], 4500);
    const clockTicks = tickOf(ticks, (r) => r.row === 'GLOBAL' && r.tokens[1] === 'g:clock');
    assert.deepEqual(clockTicks, [3, 43, 83]);
    assert.equal(tickOf(ticks, (r) => r.row === 'GLOBAL' && r.tokens[1] === 'g:clock').includes(2), false, 'tick 2 holds no clock row');

    const rowsAt = (n) => ticks.filter((t) => t.tick === n).flatMap((t) => t.rows.filter((r) => r.tokens[1] === 'g:clock'));
    // the clock as it stood when each row was taken: 5000 at tick 2, then 5001 at tick 3 running on one tick per tick
    assert.deepEqual(rowsAt(3)[0].tokens, ['GLOBAL', 'g:clock', ...intTokens('v', 5000), 'free']);
    assert.deepEqual(rowsAt(43)[0].tokens, ['GLOBAL', 'g:clock', ...intTokens('v', 5040), 'free']);
    assert.deepEqual(rowsAt(83)[0].tokens, ['GLOBAL', 'g:clock', ...intTokens('v', 5080), 'free']);
});

test('a locked clock row says locked and carries the magnitude', () => {
    const ticks = run(makeReader(), [...startPackets(), update(100, 100n, -5000n), update(150, 101n, -5000n)]);
    const rows = allRows(ticks).filter((r) => r.tokens[1] === 'g:clock');
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].tokens, ['GLOBAL', 'g:clock', ...intTokens('v', 5000), 'locked']);
});

test('a timeset makes the next clock row come one tick later, not 40', () => {
    const ticks = runTo([...startPackets(), update(100, 100n, 5000n), update(150, 101n, 5001n), update(200, 102n, 12000n)], 260);
    const clockTicks = tickOf(ticks, (r) => r.tokens[1] === 'g:clock');
    assert.deepEqual(clockTicks.slice(0, 2), [3, 5]);
    const row = ticks.find((t) => t.tick === 5).rows.find((r) => r.tokens[1] === 'g:clock');
    assert.deepEqual(row.tokens, ['GLOBAL', 'g:clock', ...intTokens('v', 12000), 'free']);
});

// ---- 4. TimeSynth ---------------------------------------------------------------------------------------------

// A real Update Time stream: unlocked, 20 ticks of time per second, age on the same count.
const real = (t) => ({ age: 1000n + BigInt(Math.floor(t / 50)), time: 5000n + BigInt(Math.floor(t / 50)) });
const lockedReal = (t) => ({ age: 1000n + BigInt(Math.floor(t / 50)), time: -5000n });

// Runs the synth over a stream for horizonMs; returns every synthetic event in order.
function synthRun(seed, horizonMs, stream = real) {
    const s = new TimeSynth(seed);
    const events = [];
    s.adjust(stream(0), 0);
    for (let t = 50; t <= horizonMs; t += 50) {
        events.push(...s.due(t));
        if (t % 1000 === 0) s.adjust(stream(t), t);
    }
    return events;
}

const COMMAND_FORM = /^time (set (day|noon|night|midnight|\d+)|add \d+|query (daytime|gametime|day))$/;

test('TimeSynth (seed a, 10 minutes): events come, each command is followed by its feedback, and the forms are the expected ones', () => {
    const events = synthRun('a', 600000);
    assert.ok(events.length >= 5, `got ${events.length} events`);
    const commands = events.map((e, i) => [e, i]).filter(([e]) => e.name === 'chat_command');
    assert.ok(commands.length >= 2);
    for (const [e, i] of commands) {
        const cmd = e.params.command;
        assert.match(cmd, COMMAND_FORM);
        let j = i + 1;
        if (!cmd.startsWith('time query')) {
            assert.equal(events[j].name, 'update_time', `update_time after "${cmd}"`);
            j++;
        }
        assert.equal(events[j].name, 'system_chat', `system_chat after "${cmd}"`);
    }
});

test('TimeSynth: a set to a named time gives that exact time in the update_time that follows', () => {
    // seed b types `time set noon` about 42 s in
    const events = synthRun('b', 60000);
    const i = events.findIndex((e) => e.name === 'chat_command' && e.params.command === 'time set noon');
    assert.ok(i >= 0, 'seed b types time set noon within a minute');
    assert.equal(events[i + 1].name, 'update_time');
    assert.equal(events[i + 1].params.time, 6000n);
    // the same holds for every named set in seed a's ten minutes
    const all = synthRun('a', 600000);
    for (let k = 0; k < all.length; k++) {
        const m = /^time set (day|noon|night|midnight)$/.exec(all[k].name === 'chat_command' ? all[k].params.command : '');
        if (m) assert.equal(all[k + 1].params.time, BigInt(NAMED[m[1]]), `after "${m[0]}"`);
    }
});

test('TimeSynth: a locked stream gives negative synthetic times', () => {
    const events = synthRun('a', 600000, lockedReal);
    const updates = events.filter((e) => e.name === 'update_time');
    assert.ok(updates.length >= 1, 'a locked stream still gets commands');
    for (const u of updates) assert.ok(u.params.time < 0n, `time ${u.params.time}`);
});

test('TimeSynth is deterministic: the same seed gives the same events, another seed different ones', () => {
    assert.deepEqual(synthRun('a', 300000), synthRun('a', 300000));
    assert.notDeepEqual(synthRun('a', 300000), synthRun('b', 300000));
});

// ---- 5. a real jump drops the synthetic shift ---------------------------------------------------------------

// A synth that has just typed its first `time set`. Returns it with the ms of the next whole-second real update.
function afterFirstSet(seed = 'a') {
    const s = new TimeSynth(seed);
    s.adjust(real(0), 0);
    for (let t = 50; t <= 120000; t += 50) {
        const evs = s.due(t);
        if (evs.some((e) => e.name === 'chat_command' && e.params.command.startsWith('time set'))) {
            return { s, t: Math.ceil(t / 1000) * 1000 };
        }
        if (t % 1000 === 0) s.adjust(real(t), t);
    }
    throw new Error('no time set within two minutes');
}

test('a real jump of more than 200 ticks drops the shift: the adjusted time is the real one', () => {
    const { s, t } = afterFirstSet();
    const first = s.adjust(real(t), t);
    const shift = first.time - real(t).time;
    assert.notEqual(shift, 0n, 'the command moved the clock');

    const jt = t + 1000;
    const jumped = real(jt);
    jumped.time += 300n;
    const out = s.adjust(jumped, jt);
    assert.equal(out.time, jumped.time);
});

test('a jump of 50 ticks (jitter) keeps the shift', () => {
    const { s, t } = afterFirstSet();
    const shift = s.adjust(real(t), t).time - real(t).time;
    assert.notEqual(shift, 0n);

    const jt = t + 1000;
    const jittered = real(jt);
    jittered.time += 50n;
    const out = s.adjust(jittered, jt);
    assert.equal(out.time, jittered.time + shift);
});

// ---- 6. end to end --------------------------------------------------------------------------------------------

test('a synthetic time set midnight goes through the Reader: the command, the chat feedback and the timeset', () => {
    // seed a types `time set midnight` at about 300 s; the packets are merged in time order, as a live stream would be
    const H = 320000;
    const s = new TimeSynth('a');
    const packets = [...startPackets()];
    const synth = [];
    packets.push(pkt(0, 'S2C', 'update_time', s.adjust(real(0), 0)));
    for (let t = 50; t <= H; t += 50) {
        synth.push(...s.due(t));
        if (t % 1000 === 0) {
            const adjusted = s.adjust(real(t), t);
            packets.push(pkt(t, 'S2C', 'update_time', adjusted));
        }
    }
    const merged = [...packets, ...synth.map((e) => pkt(e.t, e.dir, e.name, e.params))].sort((a, b) => a.t - b.t);

    const midnight = synth.find((e) => e.name === 'chat_command' && e.params.command === 'time set midnight');
    assert.ok(midnight, 'seed a types time set midnight within 320 s');

    const ticks = run(makeReader(), merged);
    const command = allRows(ticks).filter((r) => r.io === 'in' && r.kind === 'COMMAND' && r.tokens.includes('arg:midnight'));
    assert.equal(command.length, 1);

    const feedback = allRows(ticks).filter((r) => r.row === 'TEXT' && r.io === 'out' && r.tokens.includes('tr:commands.time.set'));
    assert.ok(feedback.length >= 1, 'the chat feedback is a TEXT out row');

    const sets = globals(ticks, 'g:timeset').filter((r) => r.io === 'out' && JSON.stringify(r.tokens.slice(2)) === JSON.stringify(intTokens('v', 18000)));
    assert.equal(sets.length, 1, 'a timeset row with 18000');
    assert.ok(tickOf(ticks, (r) => r === sets[0])[0] >= Math.floor(midnight.t / 50), 'the timeset comes after the command');
});
