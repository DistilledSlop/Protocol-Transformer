'use strict';
// Every play-state packet, not only the ones in captures: each is synthesized (synth.js), encoded and
// parsed with the codec, then fed to the Reader. Run with:
//   node --test reader/test/packets.test.js

const test = require('node:test');
const assert = require('node:assert');
const { Reader } = require('../reader');
const { createCodec } = require('../parse');
const PACKETS = require('../packets.json');
const { synthesize, UNSYNTHESIZABLE } = require('./synth');
const { startPackets, spawnPkt, pkt } = require('./helpers');

// The protocol the codec uses; the same minecraft-data the proxy depends on.
const protocol = require('../../proxy/node_modules/minecraft-data')('1.21.1').protocol;
const codec = createCodec('1.21.1');

const MODES = ['min', 'rich'];
const HANDLED_TIERS = new Set(['MODEL', 'HYBRID', 'INPUT', 'INPUT_ACK']);
const ROW_KINDS = new Set(['ENTITY', 'BLOCK', 'SLOT', 'EVENT', 'TEXT', 'GLOBAL']);
const IOS = new Set(['in', 'out', 'eng']);

// Rich-mode packets in HANDLED_TIERS that are allowed to make no row and no counted drop. Each entry is
// a state-only update, checked by reading the handler; the reason is one line.
const NO_ROW_OK = {
    // Stores the client's onGround flag on S.player; nothing reads it into a row or token (grep onGround).
    'C2S flying': 'stores S.player.onGround, which no row or token reads',
};

// Play packets with a name, as the Reader sees them: bound 'C' is server to client (S2C).
const PLAY = PACKETS.filter((p) => p.state === 'play' && p.name).map((p) => {
    const bound = p.bound === 'C' ? { dir: 'S2C', md: 'toClient' } : { dir: 'C2S', md: 'toServer' };
    return { ...p, dir: bound.dir, md: bound.md, key: `${bound.dir} ${p.name}` };
});

const handlerName = (p) => `${p.dir === 'S2C' ? 's2c' : 'c2s'}_${p.name}`;

// A value listed as unsynthesizable applies to both modes when keyed 'S2C name', or to one mode when
// keyed 'S2C name rich'.
function skipReason(p, mode) {
    return UNSYNTHESIZABLE[`${p.key} ${mode}`] || UNSYNTHESIZABLE[p.key];
}

// Feed the setup packets, then one synthesized packet at tick 2, then advance time to tick 4 so tick 2
// closes; collect every closed tick, and the rows of tick 2 alone (the setup closes ticks 0 and 1).
function runSynthesized(p, mode) {
    const reader = new Reader({ phase: 0 });
    const ticks = [];
    for (const setup of [...startPackets(), spawnPkt(2, 7, 1, 64, 1)]) ticks.push(...reader.feedPacket(setup));

    const params = synthesize(protocol, 'play', p.md, p.name, mode);
    const parsed = codec.parse(p.dir, codec.encode(p.dir, p.name, params));
    assert.strictEqual(parsed.name, p.name, 'the encoded packet parses back under its own name');

    // a packet the reader deliberately leaves to the engine (byDesign) is counted, like a drop
    const countedBefore = sumMap(reader.stats.dropped) + sumMap(reader.stats.byDesign);
    ticks.push(...reader.feedPacket(pkt(100, p.dir, p.name, parsed.params)));
    // update_time is a harmless packet whose only job is to move the clock past tick 2.
    ticks.push(...reader.feedPacket(pkt(200, 'S2C', 'update_time', { age: 0n, time: 0n })));
    ticks.push(...reader.flush());

    return {
        reader,
        ticks,
        targetRows: ticks.filter((t) => t.tick === 2).flatMap((t) => t.rows),
        dropped: sumMap(reader.stats.dropped) + sumMap(reader.stats.byDesign) - countedBefore,
    };
}

function sumMap(map) {
    let n = 0;
    for (const v of map.values()) n += v;
    return n;
}

// Coverage: every handled packet has the method the Reader dispatches to.
for (const p of PLAY.filter((q) => HANDLED_TIERS.has(q.tier))) {
    test(`coverage: ${p.key} (${p.tier}) has a ${handlerName(p)} handler`, () => {
        assert.strictEqual(typeof Reader.prototype[handlerName(p)], 'function');
    });
}

// Smoke: the synthesized packet survives the Reader, and every row it returns is well-formed.
for (const p of PLAY) {
    for (const mode of MODES) {
        test(`smoke: ${p.key} [${mode}] feeds without throwing and yields well-formed rows`, (t) => {
            const reason = skipReason(p, mode);
            if (reason) {
                t.diagnostic(`skipped, cannot synthesize: ${reason}`);
                return;
            }
            const { ticks } = runSynthesized(p, mode);
            for (const { rows } of ticks) {
                for (const row of rows) {
                    assert.ok(Array.isArray(row.tokens) && row.tokens.length > 0, `row ${row.row} has no tokens`);
                    assert.ok(row.tokens.every((tok) => typeof tok === 'string'), `row ${row.row} has a non-string token`);
                    assert.ok(IOS.has(row.io), `row io ${row.io} is not in/out/eng`);
                    assert.ok(ROW_KINDS.has(row.row), `row kind ${row.row} is not a known kind`);
                }
            }
        });
    }
}

// Rich-mode packets that the Reader is meant to act on must say something: a row, a counted drop, or an
// entry in NO_ROW_OK with the reason they are state-only.
for (const p of PLAY.filter((q) => HANDLED_TIERS.has(q.tier))) {
    test(`rows: ${p.key} [rich] makes a row, a counted drop, or is NO_ROW_OK`, (t) => {
        const reason = skipReason(p, 'rich');
        if (reason) {
            t.diagnostic(`skipped, cannot synthesize: ${reason}`);
            return;
        }
        const { targetRows, dropped } = runSynthesized(p, 'rich');
        if (NO_ROW_OK[p.key]) {
            t.diagnostic(`state-only: ${NO_ROW_OK[p.key]}`);
            return;
        }
        assert.ok(targetRows.length > 0 || dropped > 0, `no row and no counted drop from ${p.key}`);
    });
}
