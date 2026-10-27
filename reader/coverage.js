'use strict';
// Reports which play packets have a Reader handler (s2c_<name> / c2s_<name>).
// Run: node coverage.js [--strict]

const fs = require('fs');
const path = require('path');

const PACKETS = path.join(__dirname, 'packets.json');
const STRICT = process.argv.includes('--strict');
// Tiers that must produce rows or state, so a missing handler is a gap.
const NEEDS_HANDLER = new Set(['MODEL', 'HYBRID', 'INPUT', 'INPUT_ACK']);
const TIER_ORDER = ['ENGINE', 'BAKED', 'DERIVED', 'HYBRID', 'MODEL', 'INPUT', 'INPUT_ACK', 'DROP'];

if (!fs.existsSync(PACKETS)) {
    console.error(`missing ${PACKETS}; run gen_packets.js first`);
    process.exit(1);
}

const { Reader } = require('./reader');
const packets = JSON.parse(fs.readFileSync(PACKETS, 'utf8'));
const play = packets.filter((p) => p.state === 'play');

// Handler name depends on direction: C is server-to-client, S is client-to-server.
function handlerName(p) {
    if (!p.name) return null;
    return (p.bound === 'C' ? 's2c_' : 'c2s_') + p.name;
}

const rows = play.map((p) => {
    const hn = handlerName(p);
    const has = hn !== null && typeof Reader.prototype[hn] === 'function';
    return { ...p, handler: hn, has };
});

// Table grouped by tier.
for (const tier of TIER_ORDER) {
    const group = rows.filter((r) => r.tier === tier);
    if (group.length === 0) continue;
    console.log(`\n== ${tier} ==`);
    console.log('  bound  id     handler                                  ok');
    for (const r of group) {
        const label = r.handler || `(no name) ${r.wikiName}`;
        console.log(`  ${r.bound.padEnd(6)} ${r.id.padEnd(6)} ${label.padEnd(40)} ${r.has ? 'yes' : 'no'}`);
    }
}

console.log('\nSummary (play):');
for (const tier of TIER_ORDER) {
    const group = rows.filter((r) => r.tier === tier);
    if (group.length === 0) continue;
    const withHandler = group.filter((r) => r.has).length;
    console.log(`  ${tier.padEnd(10)} packets=${group.length} handlers=${withHandler}`);
}

const gaps = rows.filter((r) => NEEDS_HANDLER.has(r.tier) && !r.has);
console.log(`\nGAPS (${gaps.length}):`);
for (const g of gaps) {
    console.log(`  ${g.tier.padEnd(10)} ${g.bound} ${g.id} ${g.name || '(no name)'} [${g.wikiName}]`);
}

if (STRICT && gaps.length > 0) process.exit(1);
process.exit(0);
