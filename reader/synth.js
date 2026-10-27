'use strict';
// Synthetic /time examples for the training data.
//
// The captures hold three /time commands in all, far too few to learn one from. So at random moments in a session this
// adds what a server does when the player types one: the command (C2S), the Update Time that moves the clock and the chat
// feedback (S2C), as packets, so the reader turns them into rows exactly as it would real ones. The later real Update Time
// packets are shifted by what the command changed, so the clock stays consistent with them. Forms: `time set <day|noon|
// night|midnight|ticks>`, `time add <ticks>` and `time query <daytime|gametime|day>`. Only the training sessions get these,
// never the held-out ones.

const path = require('path');
const nbt = require(path.join(__dirname, '..', 'proxy', 'node_modules', 'prismarine-nbt'));
const { toInt64 } = require('./tokens');

const NAMED = { day: 1000, noon: 6000, night: 13000, midnight: 18000 };
const DAY = 24000n;
const REAL_JUMP = 200n; // ticks

function mulberry32(a) {
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const hash = (s) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);

const chat = (key, value) => ({
    content: nbt.comp({ translate: nbt.string(key), with: nbt.list(nbt.comp([{ text: nbt.string(String(value)) }])) }),
    isActionBar: false,
});

class TimeSynth {
    // everyTicks: about how often a command is typed
    constructor(seed, { everyTicks = 600 } = {}) {
        this.rnd = mulberry32(hash(seed));
        this.everyMs = everyTicks * 50;
        this.last = null; // the clock as the model is told it, last known: {t, age, locked, abs}
        this.real = null; // the last real Update Time, unshifted: {t, locked, abs}
        this.delta = 0n; // what the synthetic commands added to the real time
        this.nextAt = null;
        this.count = 0;
    }

    _gap() {
        return this.everyMs * (0.5 + this.rnd());
    }

    // A real Update Time went by: its numbers, shifted by what the commands changed. If the recording itself changed the time
    // (a real /time set, a jump of more than REAL_JUMP ticks from where the clock should be), the shift is dropped and the real
    // time is the truth again.
    adjust(params, t) {
        const age = toInt64(params.age);
        const time = toInt64(params.time);
        const locked = time < 0n;
        const realAbs = locked ? -time : time;
        if (this.real) {
            const expected = this.real.abs + (this.real.locked ? 0n : BigInt(Math.max(0, Math.floor((t - this.real.t) / 50))));
            const off = realAbs - expected;
            if (off > REAL_JUMP || off < -REAL_JUMP) this.delta = 0n;
        }
        this.real = { t, locked, abs: realAbs };
        const abs = realAbs + this.delta;
        const shifted = abs < 0n ? 0n : abs;
        this.last = { t, age, locked, abs: shifted };
        if (this.nextAt === null) this.nextAt = t + this._gap();
        return { ...params, age, time: locked ? -(shifted || 1n) : shifted };
    }

    // The synthetic packets due at or before time t, in order. Call before each real event.
    due(t) {
        const out = [];
        while (this.last && this.nextAt !== null && this.nextAt <= t) {
            out.push(...this._command(this.nextAt));
            this.nextAt += this._gap();
        }
        return out;
    }

    _command(t) {
        const r = this.rnd;
        const L = this.last;
        const elapsed = BigInt(Math.max(0, Math.floor((t - L.t) / 50)));
        const nowAbs = L.abs + (L.locked ? 0n : elapsed);
        const nowAge = L.age + elapsed;
        const lat = 30 + r() * 60;
        const at = t + lat;
        const ageThen = nowAge + BigInt(Math.floor(lat / 50));
        const sign = (v) => (L.locked ? -(v || 1n) : v);
        const events = [];
        const pick = r();
        let command;
        let after; // [key, shown value] for the feedback
        let newAbs = null;
        if (pick < 0.45) {
            const names = Object.keys(NAMED);
            const w = names[Math.floor(r() * names.length)];
            command = `time set ${w}`;
            newAbs = BigInt(NAMED[w]);
            after = ['commands.time.set', NAMED[w]];
        } else if (pick < 0.65) {
            const n = Math.floor(r() * 24000);
            const v = r() < 0.5 ? n : Math.round(n / 50) * 50 % 24000;
            command = `time set ${v}`;
            newAbs = BigInt(v);
            after = ['commands.time.set', v];
        } else if (pick < 0.8) {
            const n = (1 + Math.floor(r() * 60)) * 100;
            command = `time add ${n}`;
            newAbs = nowAbs + BigInt(n);
            after = ['commands.time.set', Number(newAbs % DAY)];
        } else {
            const what = ['daytime', 'gametime', 'day'][Math.floor(r() * 3)];
            command = `time query ${what}`;
            after = ['commands.time.query', what === 'daytime' ? Number(nowAbs % DAY) : what === 'day' ? Number(nowAbs / DAY) : Number(nowAge)];
        }
        events.push({ t, dir: 'C2S', name: 'chat_command', params: { command } });
        if (newAbs !== null) {
            this.delta += newAbs - nowAbs;
            this.last = { t: at, age: ageThen, locked: L.locked, abs: newAbs };
            events.push({ t: at, dir: 'S2C', name: 'update_time', params: { age: ageThen, time: sign(newAbs) } });
        }
        events.push({ t: at, dir: 'S2C', name: 'system_chat', params: chat(after[0], after[1]) });
        this.count++;
        return events;
    }
}

module.exports = { TimeSynth };
