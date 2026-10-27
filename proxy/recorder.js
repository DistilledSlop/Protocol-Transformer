'use strict';
// Per-session recorder.
//
//   <base>.bin          every raw packet payload, concatenated (packet id + body, as emitted by the
//                       minecraft-protocol 'raw' event; no length prefix)
//   <base>.jsonl        one index line per packet: {t, dir, state, name, off, len}
//                       plus {kind:'header'} and {kind:'state'} marker lines
//   <base>.parsed.jsonl optional parsed play packets, same shape as the old recorder: {t, dir, name, data}
//
// Bytes are the source of truth; the parsed log is a convenience that can be regenerated.

const fs = require('fs');

// Safe JSON stringifier (64-bit values arrive as BigInt)
function safeStringify(obj) {
    return JSON.stringify(obj, (key, value) =>
        typeof value === 'bigint' ? value.toString() : value
    );
}

function createRecorder(base, { logParsed = true, skipParsed = new Set() } = {}) {
    const t0 = process.hrtime.bigint();
    const now = () => Number(process.hrtime.bigint() - t0) / 1e6; // monotonic ms, sub-ms resolution

    const bin = fs.createWriteStream(base + '.bin');
    const idx = fs.createWriteStream(base + '.jsonl');
    const parsedStream = logParsed ? fs.createWriteStream(base + '.parsed.jsonl') : null;

    let off = 0;
    let closePromise = null;
    const counts = new Map();
    const bump = (key) => counts.set(key, (counts.get(key) || 0) + 1);
    const line = (obj) => idx.write(safeStringify(obj) + '\n');

    const streams = [bin, idx, parsedStream].filter(Boolean);

    return {
        now,

        header(info) {
            line({ kind: 'header', wall: new Date().toISOString(), ...info });
        },

        // Call this at raw receipt, before any queueing or forwarding.
        raw(dir, meta, buf) {
            if (closePromise) return;
            line({ t: now(), dir, state: meta.state, name: meta.name, off, len: buf.length });
            bin.write(buf);
            off += buf.length;
            bump(`${dir} ${meta.state} ${meta.name}`);
        },

        // Connection state transitions, e.g. configuration -> play.
        mark(from, to, cause) {
            if (closePromise) return;
            line({ t: now(), kind: 'state', from, to, cause });
        },

        // Parsed play packet (optional convenience log).
        parsed(dir, name, data) {
            if (closePromise || !parsedStream || skipParsed.has(name)) return;
            parsedStream.write(safeStringify({ t: now(), dir, name, data }) + '\n');
        },

        // Free-form counter, e.g. packets the proxy had to drop.
        count(key) {
            bump(key);
        },

        // Idempotent. Resolves once every file is flushed. Prints a per-packet-name summary.
        close() {
            if (closePromise) return closePromise;
            const summary = [...counts.entries()].sort((a, b) => b[1] - a[1]);
            closePromise = Promise.all(
                streams.map((s) => new Promise((resolve) => s.end(resolve)))
            ).then(() => ({ bytes: off, summary }));
            return closePromise;
        },
    };
}

module.exports = { createRecorder, safeStringify };