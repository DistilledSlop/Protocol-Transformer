'use strict';
// Checks entity_classes.json against observed entity_metadata packets from proxy captures.
// Read-only on captures and reader modules; writes metadata_report.md next to this file.

const fs = require('fs');
const path = require('path');
const { loadCapture, events } = require('../capture');
const { createCodec } = require('../parse');
const { createCatalog } = require('../catalog');

const VERSION = '1.21.1';
const DATA_DIR = path.resolve(__dirname, '../../proxy/data');
const PAGE = require(path.join(__dirname, 'entity_classes.json'));
const MD = require(path.resolve(__dirname, '../../proxy/node_modules/minecraft-data'))(VERSION);
const OUT = path.join(__dirname, 'metadata_report.md');

// Wiki type name -> minecraft-protocol serializer names that can carry it.
// Liberal on purpose: where the page does not say which encoding is used, several are allowed.
const WIKI_TO_MC = {
    'Byte': ['byte'],
    'VarInt': ['int', 'varint'],
    'VarLong': ['long', 'varlong'],
    'Float': ['float'],
    'String': ['string'],
    'Text Component': ['component'],
    'Optional Text Component': ['optional_component'],
    'Slot': ['item_stack'],
    'Boolean': ['boolean'],
    'Rotations': ['rotations', 'vec3'],
    'Position': ['block_pos'],
    'Optional Position': ['optional_block_pos'],
    'Direction': ['direction', 'int', 'varint'],
    'Optional UUID': ['optional_uuid', 'uuid'],
    'Block State': ['block_state', 'int', 'varint'],
    'Optional Block State': ['optional_block_state'],
    'NBT': ['compound_tag', 'nbt'],
    'Particle': ['particle', 'particles'],
    'Particles': ['particles'],
    'Villager Data': ['villager_data'],
    'Optional VarInt': ['optional_unsigned_int', 'optional_varint'],
    'Pose': ['pose', 'entity_pose'],
    'Cat Variant': ['cat_variant', 'int', 'varint'],
    'Frog Variant': ['frog_variant', 'int', 'varint'],
    'Wolf Variant': ['wolf_variant'],
    'Optional Global Position': ['optional_global_pos', 'optional_global_position'],
    'Painting Variant': ['painting_variant', 'int', 'varint'],
    'Sniffer State': ['sniffer_state', 'int', 'varint'],
    'Armadillo State': ['armadillo_state', 'int', 'varint'],
    'Vector3': ['vector3', 'vec3'],
    'Quaternion': ['quaternion'],
};

// Every capture base name, once; the .parsed.jsonl siblings are derived output.
function captureBases() {
    const seen = new Set();
    for (const f of fs.readdirSync(DATA_DIR)) {
        if (!/^session_.*\.jsonl$/.test(f) || f.endsWith('.parsed.jsonl')) continue;
        seen.add(f.replace(/\.jsonl$/, ''));
    }
    return [...seen].sort().map((b) => path.join(DATA_DIR, b));
}

// Observed (entity, key, serializer) triples with counts, from S2C play packets only.
function observe() {
    const codec = createCodec(VERSION);
    const catalog = createCatalog(VERSION);
    const triples = new Map();
    const unknownIds = new Map();
    let entries = 0;
    for (const base of captureBases()) {
        const cap = loadCapture(base);
        let playerId = null;
        const idName = new Map();
        for (const ev of events(cap)) {
            if (ev.kind || ev.state !== 'play' || ev.dir !== 'S2C') continue;
            let p;
            try { p = codec.parse(ev.dir, ev.buf); } catch (e) { continue; }
            if (p.name === 'login') playerId = p.params.entityId;
            else if (p.name === 'spawn_entity') idName.set(p.params.entityId, catalog.entityName(p.params.type));
            else if (p.name === 'entity_metadata') {
                let name = p.params.entityId === playerId ? 'player' : idName.get(p.params.entityId);
                if (!name) {
                    name = '(unknown spawn)';
                    unknownIds.set(p.params.entityId, (unknownIds.get(p.params.entityId) || 0) + 1);
                }
                for (const m of p.params.metadata) {
                    const k = `${name}\t${m.key}\t${m.type}`;
                    triples.set(k, (triples.get(k) || 0) + 1);
                    entries++;
                }
            }
        }
    }
    return { triples, entries, unknownIds: unknownIds.size, bases: captureBases().length };
}

// Field lookup by index along the class chain (own fields and inherited ones).
function fieldsForEntity(entity) {
    const cls = PAGE.entities[entity];
    const byIndex = new Map();
    for (let c = cls; c && PAGE.classes[c]; c = PAGE.classes[c].extends) {
        for (const f of PAGE.classes[c].fields) {
            if (!byIndex.has(f.index)) byIndex.set(f.index, { ...f, cls: c });
        }
    }
    return byIndex;
}

// Returns { status, field } where status is 'explained' or the reason it is not.
function explain(entity, key, ser, cache) {
    if (!cache.has(entity)) cache.set(entity, PAGE.entities.hasOwnProperty(entity) ? fieldsForEntity(entity) : null);
    const byIndex = cache.get(entity);
    if (byIndex === null) return { status: 'entity not on page' };
    if (PAGE.entities[entity] === null) return { status: 'entity has no class on page' };
    const f = byIndex.get(key);
    if (!f) return { status: 'no field at index' };
    const allowed = WIKI_TO_MC[f.type];
    if (!allowed) return { status: 'unmapped wiki type', field: f };
    if (allowed.includes(ser)) return { status: 'explained', field: f };
    return { status: 'type mismatch', field: f };
}

const cell = (s) => String(s).replace(/\|/g, '\\|');

function main() {
    const obs = observe();
    const triples = [...obs.triples].map(([k, count]) => {
        const [entity, key, ser] = k.split('\t');
        return { entity, key: Number(key), ser, count };
    });
    const total = triples.reduce((n, t) => n + t.count, 0);

    const cache = new Map();
    for (const t of triples) Object.assign(t, explain(t.entity, t.key, t.ser, cache));

    const explained = triples.filter((t) => t.status === 'explained').reduce((n, t) => n + t.count, 0);
    const byStatus = {};
    for (const t of triples) byStatus[t.status] = (byStatus[t.status] || 0) + t.count;

    // (a) observed entity names that the page does not list
    const entityTotals = new Map();
    for (const t of triples) entityTotals.set(t.entity, (entityTotals.get(t.entity) || 0) + t.count);
    const notOnPage = [...entityTotals].filter(([e]) => !PAGE.entities.hasOwnProperty(e)).sort((a, b) => b[1] - a[1]);

    // (b) entity names: page vs minecraft-data 1.21.1
    const mdNames = Object.keys(MD.entitiesByName);
    const pageNames = Object.keys(PAGE.entities);
    const addedAfter = pageNames.filter((n) => !MD.entitiesByName[n]);
    const missingFromPage = mdNames.filter((n) => !PAGE.entities.hasOwnProperty(n));

    // (c) unexplained triples, most frequent first
    const unexplained = triples.filter((t) => t.status !== 'explained').sort((a, b) => b.count - a.count);

    // (e) per most frequent entity: keys and serializers seen
    const top15 = [...entityTotals].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([e]) => e);
    const perEntity = new Map(top15.map((e) => [e, new Map()]));
    for (const t of triples) {
        if (!perEntity.has(t.entity)) continue;
        const keys = perEntity.get(t.entity);
        const cur = keys.get(t.key) || { sers: new Map(), count: 0 };
        cur.sers.set(t.ser, (cur.sers.get(t.ser) || 0) + t.count);
        cur.count += t.count;
        keys.set(t.key, cur);
    }

    // Wiki type names that the page uses on fields we actually checked, but that have no mapping.
    const unmappedTypes = new Set();
    for (const t of triples) if (t.field && !WIKI_TO_MC[t.field.type]) unmappedTypes.add(t.field.type);

    const pct = (n) => (total ? ((100 * n) / total).toFixed(1) : '0.0');
    const L = [];
    L.push('# Entity metadata page vs. captures', '');
    L.push(`Generated by validate_metadata.js. Captures: ${obs.bases} sessions in proxy/data, ${obs.entries} metadata entries, ${triples.length} distinct triples, ${total} weighted. Target version ${VERSION}.`);
    L.push(`Page: ${pageNames.length} entities, ${Object.keys(PAGE.classes).length} classes. Page metadata indexes are implicit on the page, so indexes are derived from table order.`);
    if (obs.unknownIds) L.push(`Entity ids seen in metadata without a spawn packet in the same capture: ${obs.unknownIds}, counted as "(unknown spawn)".`);
    L.push('');
    L.push('## (a) Observed entity names not on the page', '');
    L.push(notOnPage.length ? notOnPage.map(([e, c]) => `- ${cell(e)}: ${c}`).join('\n') : 'None.');
    L.push('');
    L.push(`## (b) Entity names vs minecraft-data ${VERSION}`, '');
    L.push(`Page entities not in ${VERSION} (added after ${VERSION}): ${addedAfter.length}`, '');
    L.push(addedAfter.length ? addedAfter.map((n) => `- ${n}`).join('\n') : 'None.', '');
    L.push(`${VERSION} entities missing from the page: ${missingFromPage.length}`, '');
    L.push(missingFromPage.length ? missingFromPage.map((n) => `- ${n}`).join('\n') : 'None.');
    L.push('');
    L.push('## (c) Observed triples the page does not explain (top 40)', '');
    L.push('| count | entity | key | serializer | status | page field |');
    L.push('|---:|---|---:|---|---|---|');
    for (const t of unexplained.slice(0, 40)) {
        const f = t.field ? `${t.field.cls}: ${cell(t.field.name)} (${cell(t.field.type)})` : '';
        L.push(`| ${t.count} | ${cell(t.entity)} | ${t.key} | ${t.ser} | ${t.status} | ${f} |`);
    }
    L.push('');
    L.push('## (d) Share of observed entries explained by the page', '');
    L.push(`Explained: ${explained} of ${total} entries (${pct(explained)}%).`, '');
    L.push('| status | entries | share |');
    L.push('|---|---:|---:|');
    for (const [s, c] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) L.push(`| ${s} | ${c} | ${pct(c)}% |`);
    L.push('');
    L.push('Wiki type names used on checked fields with no mapping: ' + ([...unmappedTypes].join(', ') || 'none') + '.');
    L.push('');
    L.push('## (e) Keys and serializers for the 15 most frequent entities', '');
    for (const e of top15) {
        L.push(`### ${cell(e)} (${entityTotals.get(e)} entries)`, '');
        L.push('| key | serializer(s) seen | count | page field |');
        L.push('|---:|---|---:|---|');
        const keys = [...perEntity.get(e)].sort((a, b) => a[0] - b[0]);
        for (const [key, v] of keys) {
            const sers = [...v.sers].map(([s, c]) => `${s} (${c})`).join(', ');
            const hit = explain(e, key, [...v.sers.keys()][0], cache);
            const f = hit.field ? `${hit.field.cls}: ${cell(hit.field.name)} (${cell(hit.field.type)})` : hit.status;
            L.push(`| ${key} | ${sers} | ${v.count} | ${f} |`);
        }
        L.push('');
    }
    fs.writeFileSync(OUT, L.join('\n') + '\n');

    console.log(`captures: ${obs.bases}, entries: ${obs.entries}, triples: ${triples.length}`);
    console.log(`(a) observed names not on page: ${notOnPage.length}`);
    console.log(`(b) page names not in ${VERSION}: ${addedAfter.length}, ${VERSION} names missing from page: ${missingFromPage.length}`);
    console.log(`(c) unexplained triples: ${unexplained.length}`);
    console.log(`(d) explained: ${explained}/${total} (${pct(explained)}%)`);
    console.log(`wrote ${OUT}`);
}

main();
