'use strict';
// A reader -> writer round trip for one packet, for testing a family of rows. Everything is in memory.
//
//   const r = roundTrip({ before: [...], packets: [pkt('S2C', 'entity_metadata', {...})] });
//   r.rows        the rows the reader made for the tested packets' tick (io 'out' and 'eng' only)
//   r.out         the packets the writer produced for that tick, as {name, params}
//   r.writer      the Writer afterwards (its stats.rejected says what it could not compile)
//   r.reader      the Reader afterwards
//
// The scene always has the player (entity 1, slot 0) at (0, 64, 0) and, unless `entity: false`, one entity
// (id 7, a pig, slot 1) three blocks away. `before` packets arrive one tick earlier than `packets`.

const assert = require('node:assert/strict');
const { makeReader, pkt, startPackets, spawnPkt } = require('../helpers');
const { Writer } = require('../../writer/writer');
const { createCodec } = require('../../parse');
const { createCatalog } = require('../../catalog');

const codec = createCodec('1.21.1');
const cat = createCatalog();
const PIG = cat.md.entitiesByName.pig.id;

// packets: [{ dir?, name, params }] ; all of them land in the same tick
function roundTrip({ before = [], packets, entity = true, extraTicks = 1 } = {}) {
    const reader = makeReader();
    const writer = new Writer();
    const ticks = [];
    const handle = (tk) => {
        if (!tk.player.known) return;
        const rows = tk.rows.filter((r) => r.io !== 'in');
        const out = writer.step(rows, { playerId: tk.player.entityId, player: tk.player, names: tk.names, blobs: tk.blobs });
        ticks.push({ tick: tk.tick, rows, out });
    };
    const feed = (p) => {
        for (const tk of reader.feedPacket(p)) handle(tk);
    };
    for (const p of startPackets()) feed(p);
    if (entity) feed(spawnPkt(55, 7, 3, 64, 0, { type: PIG }));
    for (const p of before) feed(pkt(60, p.dir ?? 'S2C', p.name, p.params));
    for (const p of packets) feed(pkt(110, p.dir ?? 'S2C', p.name, p.params));
    // a later packet moves the clock on so the tested tick closes, then the rest
    feed(pkt(110 + 50 * extraTicks, 'S2C', 'update_time', { age: 0n, time: 0n }));
    for (const tk of reader.flush()) handle(tk);
    const tested = ticks.find((t) => t.tick === 2) ?? { rows: [], out: [] };
    // every packet the writer made must be valid on the wire
    for (const t of ticks) for (const p of t.out) checkWire(p);
    return { reader, writer, ticks, rows: tested.rows, out: tested.out, allOut: ticks.flatMap((t) => t.out), allRows: ticks.flatMap((t) => t.rows) };
}

function checkWire(p) {
    const back = codec.parse('S2C', codec.encode('S2C', p.name, p.params));
    assert.equal(back.name, p.name);
    return back.params;
}

// BigInt, [hi, lo] pairs and numbers compare as numbers; NaN equals NaN; undefined and missing are the same
function norm(v) {
    if (typeof v === 'bigint') return Number(v);
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, norm(x)]));
    return v;
}

// Deep equality of a rebuilt packet's params against the original's, ignoring `ignore` (dotted paths or plain keys)
// and allowing |a-b| <= tol[key] for numbers (tol keyed by the last path segment).
function sameParams(a, b, { ignore = [], tol = {} } = {}, path = '') {
    a = norm(a);
    b = norm(b);
    const last = path.split('.').pop();
    if (ignore.includes(path) || ignore.includes(last)) return;
    if (typeof a === 'number' && typeof b === 'number') {
        const t = tol[path] ?? tol[last] ?? 0;
        assert.ok(Math.abs(a - b) <= t || (Number.isNaN(a) && Number.isNaN(b)), `${path || 'value'}: ${a} vs ${b} (tolerance ${t})`);
    } else if (a && b && typeof a === 'object' && typeof b === 'object') {
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const k of keys) sameParams(a[k], b[k], { ignore, tol }, path ? `${path}.${k}` : k);
    } else assert.deepEqual(a, b, `${path || 'value'}`);
}

module.exports = { roundTrip, checkWire, sameParams, pkt, cat, codec, PIG, norm };
