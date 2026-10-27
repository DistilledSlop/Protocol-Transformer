'use strict';
// The live pipeline between a real server and a real client: server packets feed the reader, the entity scene
// (and optionally blocks, slots, globals) is rebuilt by the writer and sent to the client in place of the
// server's own packets; everything else passes through untouched.
//
// The tick phase is not known in advance (it depends on when the proxy session started), so the first
// couple of seconds of server entity packets are buffered, the phase is estimated from them, and the reader
// is then fed the backlog in order.

const path = require('path');
const R = (p) => path.join(__dirname, '..', 'reader', p);
const { createCodec } = require(R('parse'));
const { Reader } = require(R('reader'));
const { Writer } = require(R('writer/writer'));
const { phaseFromTimes, TICK_NAMES } = require(R('phase'));
const { ownedNames, dropForWriter, writerOwns } = require('./ownership');

const CALIBRATE_PACKETS = 150;
const CALIBRATE_MAX_MS = 2500;
const WRITER_ID_MIN = 10000;

class Live {
    // send(buf): hands a packet to the client. now(): monotonic ms.
    constructor({ also = [], send, now, version = '1.21.1', log = () => {} }) {
        this.families = new Set(['scene', ...also]);
        this.owned = ownedNames(this.families);
        this.send = send;
        this.now = now;
        this.log = log;
        this.codec = createCodec(version);
        this.stats = { forwarded: 0, dropped: 0, injected: 0, ticks: 0, rewritten: 0, parseErrors: 0 };
        this.reset();
    }

    reset() {
        this.playerId = null;
        this.reader = null;
        this.writer = null;
        this.buffer = [];
        this.times = [];
        this.firstT = null;
        this.phase = null;
    }

    _calibrate() {
        const est = phaseFromTimes(this.times);
        this.phase = this.times.length >= 20 ? est.phase : 25;
        this.reader = new Reader({ phase: this.phase });
        this.writer = new Writer();
        this.log(`phase calibrated: tick boundary ${this.phase.toFixed(1)} ms from ${this.times.length} entity packets (concentration ${est.concentration.toFixed(2)}); replaying ${this.buffer.length} buffered packets`);
        const backlog = this.buffer;
        this.buffer = [];
        for (const ev of backlog) this._feed(ev);
    }

    _feed(ev) {
        for (const tk of this.reader.feed(ev)) this._emit(tk);
    }

    _event(ev) {
        if (this.reader) return this._feed(ev);
        this.buffer.push(ev);
        if (this.firstT === null) this.firstT = ev.t;
        if (ev.dir === 'S2C' && TICK_NAMES.has(ev.name)) this.times.push(ev.t);
        if (this.times.length >= CALIBRATE_PACKETS || ev.t - this.firstT > CALIBRATE_MAX_MS) this._calibrate();
    }

    _emit(tk) {
        if (!tk.player.known) return;
        this.stats.ticks++;
        for (const pk of this.writer.step(tk.rows, { playerId: tk.player.entityId, player: tk.player, names: tk.names, blobs: tk.blobs })) {
            if (!writerOwns(pk.name, pk.params, this.families, tk.player.entityId)) continue;
            this.send(this.codec.encode('S2C', pk.name, pk.params));
            this.stats.injected++;
        }
    }

    // A server play packet. Returns true to forward it to the client as it is.
    onServerPacket(name, buf) {
        const t = this.now();
        let parsed = null;
        const parse = () => (parsed ??= this.codec.parse('S2C', buf).params);
        if (name === 'login') {
            this.reset();
            this.playerId = parse().entityId;
        }
        try {
            this._event({ t, dir: 'S2C', state: 'play', name, buf });
        } catch (e) {
            this.stats.parseErrors++;
            this.log(`reader error on ${name}: ${e.message}`);
        }
        let drop = false;
        try {
            drop = this.playerId !== null && dropForWriter(name, this.owned, this.playerId, parse, this.families);
        } catch (e) {
            this.log(`could not classify ${name}: ${e.message}`);
        }
        drop ? this.stats.dropped++ : this.stats.forwarded++;
        return !drop;
    }

    // A client play packet. Returns the buffer to forward to the server, or null to swallow it.
    onClientPacket(name, buf) {
        try {
            this._event({ t: this.now(), dir: 'C2S', state: 'play', name, buf });
        } catch (e) {
            this.stats.parseErrors++;
        }
        // the client may act on an entity by the id the writer gave it; the server knows it by the real one
        if (name === 'use_entity' && this.writer) {
            const p = this.codec.parse('C2S', buf);
            if (p.params.target >= WRITER_ID_MIN) {
                const slot = [...this.writer.bySlot].find(([, e]) => e.id === p.params.target)?.[0];
                const real = slot === undefined ? undefined : this.reader.S.slotToId[slot];
                if (real === undefined || real === null) return null;
                this.stats.rewritten++;
                return this.codec.encode('C2S', 'use_entity', { ...p.params, target: real });
            }
        }
        return buf;
    }

    // Called on a short timer: time passes and ticks close even when the server is quiet.
    tick() {
        if (!this.reader) {
            if (this.firstT !== null && this.now() - this.firstT > CALIBRATE_MAX_MS) this._calibrate();
            return;
        }
        try {
            for (const tk of this.reader.advanceTo(this.now())) this._emit(tk);
        } catch (e) {
            this.log(`tick error: ${e.message}`);
        }
    }

    summary() {
        const w = this.writer?.stats.rejected;
        return `${JSON.stringify(this.stats)} writer rejected: ${w ? JSON.stringify([...w].sort((a, b) => b[1] - a[1]).slice(0, 5)) : 'n/a'}`;
    }
}

module.exports = { Live };
