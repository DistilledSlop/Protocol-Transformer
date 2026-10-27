'use strict';
// Raw payloads and the existing {t,dir,state,name,off,len} index remain reader-compatible.
const fs = require('fs');
const { finished } = require('stream/promises');

function safeStringify(obj) {
    return JSON.stringify(obj, (_key, value) => typeof value === 'bigint' ? value.toString() : value);
}

function createRecorder(base, {
    logParsed = true, skipParsed = new Set(), maxQueuedBytes = 8 * 1024 * 1024,
    maxBytes = Number.MAX_SAFE_INTEGER, onError = () => {},
} = {}) {
    if (!Number.isSafeInteger(maxQueuedBytes) || maxQueuedBytes < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
        throw new Error('Recorder byte limits must be positive safe integers');
    }
    const t0 = process.hrtime.bigint();
    const now = () => Number(process.hrtime.bigint() - t0) / 1e6;
    const status = (value) => {
        fs.writeFileSync(base + '.status.json.tmp', safeStringify(value) + '\n');
        fs.renameSync(base + '.status.json.tmp', base + '.status.json');
    };
    // A killed process leaves this marker incomplete. A complete marker only means files flushed.
    status({ complete: false, started: new Date().toISOString() });
    const bin = fs.createWriteStream(base + '.bin', { flags: 'wx' });
    const idx = fs.createWriteStream(base + '.jsonl', { flags: 'wx' });
    const parsedStream = logParsed ? fs.createWriteStream(base + '.parsed.jsonl', { flags: 'wx' }) : null;
    const streams = [bin, idx, parsedStream].filter(Boolean);
    let off = 0, error = null, closePromise = null;
    const counts = new Map();
    const bump = (key) => counts.set(key, (counts.get(key) || 0) + 1);
    const fail = (cause) => {
        if (error) return false;
        error = cause;
        for (const stream of streams) stream.destroy(cause);
        try { status({ complete: false, bytes: off, error: cause.message }); } catch (_) { /* original error wins */ }
        // Avoid reentrancy while the caller is installing session handlers.
        queueMicrotask(() => onError(cause));
        return false;
    };
    // Install finished() listeners immediately, including before close(), to handle open/write errors.
    const completions = streams.map((stream) => {
        stream.on('error', fail);
        return finished(stream).then(() => null, (cause) => { fail(cause); return cause; });
    });
    const write = (parts) => {
        if (error || closePromise) return false;
        const pending = streams.reduce((n, stream) => n + stream.writableLength, 0);
        const bytes = parts.reduce((n, [, data]) => n + Buffer.byteLength(data), 0);
        if (pending + bytes > maxQueuedBytes) return fail(new Error('Recorder queue byte limit exceeded'));
        for (const [stream, data] of parts) stream.write(data);
        return true;
    };
    const line = (obj) => safeStringify(obj) + '\n';
    return {
        now,
        header(info) { return write([[idx, line({ kind: 'header', wall: new Date().toISOString(), ...info })]]); },
        raw(dir, meta, buf) {
            if (error || closePromise) return false;
            if (off + buf.length > maxBytes) return fail(new Error('Recorder capture byte limit exceeded'));
            if (!write([[idx, line({ t: now(), dir, state: meta.state, name: meta.name, off, len: buf.length })], [bin, buf]])) return false;
            off += buf.length;
            bump(`${dir} ${meta.state} ${meta.name}`);
            return true;
        },
        mark(from, to, cause) { return write([[idx, line({ t: now(), kind: 'state', from, to, cause })]]); },
        parsed(dir, name, data) {
            if (!parsedStream || skipParsed.has(name)) return true;
            return write([[parsedStream, line({ t: now(), dir, name, data })]]);
        },
        count: bump,
        close() {
            if (closePromise) return closePromise;
            if (!error) for (const stream of streams) stream.end();
            closePromise = Promise.all(completions).then(() => {
                if (error) throw error;
                const summary = [...counts.entries()].sort((a, b) => b[1] - a[1]);
                // Stream completion drains userspace buffers; fsync before publishing completeness.
                for (const file of [base + '.bin', base + '.jsonl', ...(logParsed ? [base + '.parsed.jsonl'] : [])]) {
                    const fd = fs.openSync(file, 'r');
                    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
                }
                status({ complete: true, bytes: off, summary, closed: new Date().toISOString() });
                return { bytes: off, summary };
            });
            return closePromise;
        },
    };
}
module.exports = { createRecorder, safeStringify };
