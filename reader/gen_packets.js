'use strict';
// Joins classification.tsv to minecraft-data protocol names and writes packets.json.
// Run: node gen_packets.js

const fs = require('fs');
const path = require('path');

const TSV = path.join(__dirname, 'classification.tsv');
const OUT = path.join(__dirname, 'packets.json');
const protocol = require('../proxy/node_modules/minecraft-data')('1.21.1').protocol;

const STATE_ORDER = ['handshaking', 'status', 'login', 'configuration', 'play'];
const DIR_OF_BOUND = { C: 'toClient', S: 'toServer' };
const BOUND_ORDER = { C: 0, S: 1 };

// Parse '0x2E' or '0x2e' into a number; minecraft-data keys use lowercase hex.
function parseId(text) {
    return parseInt(text, 16);
}

function hexId(num) {
    return '0x' + num.toString(16).toUpperCase().padStart(2, '0');
}

// Build { state: { bound: Map<numericId, name> } } from minecraft-data.
function protocolMaps() {
    const out = {};
    for (const state of STATE_ORDER) {
        out[state] = {};
        for (const bound of ['C', 'S']) {
            const dir = DIR_OF_BOUND[bound];
            const packet = protocol[state] && protocol[state][dir] && protocol[state][dir].types;
            const mappings = packet && packet.packet && packet.packet[1][0].type[1].mappings;
            const map = new Map();
            for (const key of Object.keys(mappings || {})) {
                map.set(parseId(key), mappings[key]);
            }
            out[state][bound] = map;
        }
    }
    return out;
}

function readTsv() {
    const lines = fs.readFileSync(TSV, 'utf8').split(/\r?\n/).filter((l) => l.length > 0);
    const header = lines[0].split('\t');
    if (header.join('\t') !== 'state\tbound\tid\tname\ttier\trow_type\treview\tnotes') {
        throw new Error('unexpected TSV header: ' + header.join('\t'));
    }
    return lines.slice(1).map((line) => {
        const f = line.split('\t');
        return {
            state: f[0],
            bound: f[1],
            id: f[2],
            wikiName: f[3],
            tier: f[4],
            row_type: f[5],
            review: f[6],
            notes: f.slice(7).join('\t'),
        };
    });
}

function main() {
    const rows = readTsv();
    const maps = protocolMaps();

    const packets = rows.map((r) => {
        const num = parseId(r.id);
        const name = maps[r.state] && maps[r.state][r.bound] && maps[r.state][r.bound].get(num);
        return {
            state: r.state,
            bound: r.bound,
            id: hexId(num),
            wikiName: r.wikiName,
            name: name === undefined ? null : name,
            tier: r.tier,
            row: r.row_type === '-' || r.row_type === '' ? null : r.row_type,
            review: r.review.trim().toLowerCase() === 'y',
            notes: r.notes,
        };
    });

    packets.sort((a, b) =>
        STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) ||
        BOUND_ORDER[a.bound] - BOUND_ORDER[b.bound] ||
        parseId(a.id) - parseId(b.id));

    fs.writeFileSync(OUT, JSON.stringify(packets, null, 4) + '\n');

    // Summary: counts per state, per tier for play.
    console.log('Packets per state (TSV rows):');
    for (const state of STATE_ORDER) {
        const n = packets.filter((p) => p.state === state).length;
        console.log(`  ${state.padEnd(14)} ${n}`);
    }
    console.log('Play tiers:');
    const tiers = {};
    for (const p of packets.filter((q) => q.state === 'play')) {
        tiers[p.tier] = (tiers[p.tier] || 0) + 1;
    }
    for (const t of Object.keys(tiers).sort()) {
        console.log(`  ${t.padEnd(11)} ${tiers[t]}`);
    }

    // Duplicate (state, bound, id) keys would make the join ambiguous.
    const seen = new Set();
    for (const p of packets) {
        const key = `${p.state}/${p.bound}/${p.id}`;
        if (seen.has(key)) console.log(`DUPLICATE TSV KEY: ${key}`);
        seen.add(key);
    }

    // TSV rows with no protocol name.
    const unmatchedTsv = packets.filter((p) => p.name === null);
    console.log(`\nTSV rows with no protocol name (${unmatchedTsv.length}):`);
    for (const p of unmatchedTsv) {
        console.log(`  ${p.state} ${p.bound} ${p.id} ${p.wikiName}`);
    }

    // Protocol packets with no TSV row.
    const tsvKeys = new Set(packets.map((p) => `${p.state}/${p.bound}/${parseId(p.id)}`));
    const unmatchedProto = [];
    for (const state of STATE_ORDER) {
        for (const bound of ['C', 'S']) {
            for (const [num, name] of maps[state][bound]) {
                if (!tsvKeys.has(`${state}/${bound}/${num}`)) {
                    unmatchedProto.push(`${state} ${bound} ${hexId(num)} ${name}`);
                }
            }
        }
    }
    console.log(`\nProtocol packets with no TSV row (${unmatchedProto.length}):`);
    for (const line of unmatchedProto) console.log(`  ${line}`);

    console.log(`\nWrote ${packets.length} packets to ${OUT}`);
}

main();
