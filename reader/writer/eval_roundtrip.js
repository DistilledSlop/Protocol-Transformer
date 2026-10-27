#!/usr/bin/env node
'use strict';
// Usage: node writer/eval_roundtrip.js <session base> [<session base> ...]
//
// The round trip with no model: capture -> reader -> rows -> writer -> packets. Two checks:
//   wire     every packet the writer emits must encode with minecraft-protocol and parse back
//   scene    the writer's belief about the visible entities must match the reader's true scene each tick
// The error you should see is quantization (about 1% of each step) plus the 1/16 block rounding of spawn
// positions, and it can grow with an entity's lifetime because the writer integrates the same rounded steps.

const { loadCapture, events } = require('../capture');
const { estimatePhase } = require('../phase');
const { Reader } = require('../reader');
const { createCodec } = require('../parse');
const { Writer } = require('./writer');

const pct = (arr, p) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const fmt = (m, n = 25) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, c]) => `  ${String(c).padStart(7)}  ${k}`).join('\n');
const angleErr = (a, b) => Math.min((a - b + 256) % 256, (b - a + 256) % 256);

function evaluate(base) {
    const cap = loadCapture(base);
    const reader = new Reader({ phase: estimatePhase(cap).phase, snapshot: true });
    const writer = new Writer();
    const codec = createCodec(cap.header.version);

    const wire = { ok: 0, bad: new Map() };
    const posErr = [];
    const posErrAge = new Map(); // age bucket (ticks since spawn) -> errors
    const rotErr = [];
    const exist = { truthOnly: 0, beliefOnly: 0, both: 0 };
    const ageOf = new Map(); // truth entity id -> first tick seen
    let ticks = 0;
    let packets = 0;

    const handle = (tk) => {
        if (!tk.player.known) return;
        ticks++;
        const pk = writer.step(tk.rows, { playerId: tk.player.entityId, player: tk.player, names: tk.names, blobs: tk.blobs });
        for (const p of pk) {
            packets++;
            try {
                const back = codec.parse('S2C', codec.encode('S2C', p.name, p.params));
                if (back.name !== p.name) throw new Error('parsed as another packet');
                wire.ok++;
            } catch (e) {
                const k = `${p.name}: ${String(e.message).split('\n')[0].slice(0, 70)}`;
                wire.bad.set(k, (wire.bad.get(k) || 0) + 1);
            }
        }
        const truth = new Map(tk.scene.map((e) => [e.slot, e]));
        for (const [slot, t] of truth) {
            if (!ageOf.has(t.id)) ageOf.set(t.id, tk.tick);
            const b = writer.bySlot.get(slot);
            if (!b) {
                exist.truthOnly++;
                continue;
            }
            exist.both++;
            const d = Math.hypot(b.x - t.x, b.y - t.y, b.z - t.z);
            posErr.push(d);
            const age = tk.tick - ageOf.get(t.id);
            const bucket = age < 20 ? '<1s' : age < 100 ? '1-5s' : age < 400 ? '5-20s' : '20s+';
            if (!posErrAge.has(bucket)) posErrAge.set(bucket, []);
            posErrAge.get(bucket).push(d);
            rotErr.push(Math.max(angleErr(b.yaw, t.yaw), angleErr(b.pitch, t.pitch), angleErr(b.headYaw, t.headYaw)));
        }
        for (const slot of writer.bySlot.keys()) if (!truth.has(slot)) exist.beliefOnly++;
    };

    for (const ev of events(cap)) for (const tk of reader.feed(ev)) handle(tk);
    for (const tk of reader.flush()) handle(tk);

    console.log(`session ${base}`);
    console.log(`ticks ${ticks}, packets emitted ${packets}`);
    console.log(`wire validity: ${wire.ok} encode+parse ok, ${[...wire.bad.values()].reduce((a, b) => a + b, 0)} failed`);
    if (wire.bad.size) console.log(fmt(wire.bad));
    console.log(`scene: ${exist.both} entity-ticks matched, ${exist.truthOnly} in the real scene but not in the writer's belief, ${exist.beliefOnly} the other way`);
    console.log(`position error (blocks): median ${pct(posErr, 50).toFixed(4)}  p95 ${pct(posErr, 95).toFixed(4)}  p99 ${pct(posErr, 99).toFixed(4)}  max ${Math.max(0, ...posErr).toFixed(3)}`);
    for (const k of ['<1s', '1-5s', '5-20s', '20s+']) {
        const a = posErrAge.get(k);
        if (a) console.log(`  entity age ${k.padEnd(5)} n=${String(a.length).padStart(6)}  median ${pct(a, 50).toFixed(4)}  p95 ${pct(a, 95).toFixed(4)}  max ${Math.max(...a).toFixed(3)}`);
    }
    console.log(`rotation error (1/256 turn, worst of yaw/pitch/head): p95 ${pct(rotErr, 95)}  max ${Math.max(0, ...rotErr)}`);
    console.log('rows compiled:');
    console.log(fmt(writer.stats.rows));
    console.log('rows rejected or not restored:');
    console.log(fmt(writer.stats.rejected) || '  none');
    console.log('packets by name:');
    console.log(fmt(writer.stats.packets));
}

for (const base of process.argv.slice(2)) evaluate(base);
