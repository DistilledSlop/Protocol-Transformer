'use strict';
// Compares wiki field lists against minecraft-data protocol definitions for play packets.
const fs = require('fs');
const path = require('path');

const MC = require('/home/nathan/protocol_ai_v4/proxy/node_modules/minecraft-data')('1.21.1');
const WIKI = require('./wiki_packets.json');
const REF = require('../packets.json');
const OUT = path.join(__dirname, 'compare_report.md');

const TIER_ORDER = ['MODEL', 'HYBRID', 'INPUT', 'INPUT_ACK'];

// minecraft-data type name -> normalised name
const MD_MAP = {
    varint: 'varint', varlong: 'varlong', i8: 'i8', u8: 'u8', i16: 'i16', u16: 'u16',
    i32: 'i32', i64: 'i64', f32: 'f32', f64: 'f64', bool: 'bool', string: 'string',
    UUID: 'UUID', position: 'position', anonymousNbt: 'nbt', anonOptionalNbt: 'nbt',
    optionalNbt: 'nbt', nbt: 'nbt', buffer: 'array', restBuffer: 'array', ByteArray: 'array',
    array: 'array', pstring: 'string', ContainerID: 'u8', entityMetadata: 'entityMetadata',
    packedChunkPos: 'position', ItemSoundHolder: 'sound', soundSource: 'varint', vec2f: 'vec2:f32',
};

// wiki type text (lowercased, sizes and Enum suffix removed) -> normalised name
const WIKI_MAP = {
    varint: 'varint', varlong: 'varlong', int: 'i32', long: 'i64', short: 'i16', byte: 'i8',
    'unsigned byte': 'u8', 'unsigned short': 'u16', float: 'f32', double: 'f64',
    boolean: 'bool', string: 'string', uuid: 'UUID', angle: 'i8', position: 'position',
    identifier: 'string', 'text component': 'nbt', 'json text component': 'nbt',
    'compound tag': 'nbt', nbt: 'nbt', slot: 'Slot', 'entity metadata': 'entityMetadata',
    'id or sound event': 'sound', varies: 'varies',
};

// Wiki type text -> { type, optional }. "Optional X" and "Prefixed Optional X" are marked optional,
// arrays collapse to 'array', enums and bitmasks take their underlying integer.
function normWiki(text) {
    let t = text.replace(/\(\d+\)/g, '').replace(/\s+/g, ' ').trim();
    const optional = /\bOptional\b/i.test(t);
    t = t.replace(/^(Prefixed\s+)?Optional\s+/i, '');
    if (/(byte array|bitset)/i.test(t) && /\(\d+\)/.test(text)) return { type: 'fixedbuf', optional };
    if (/\bArray\b/.test(t) || /bitset/i.test(t)) return { type: 'array', optional };
    const key = t.replace(/\s+Enum$/i, '').toLowerCase();
    return { type: WIKI_MAP[key] || key, optional };
}

// Flatten a protodef type into entries. Containers are inlined; array/option/switch are one entry each,
// with their container contents appended as nested entries.
function fieldEntries(name, def, nested, optional, out) {
    if (typeof def === 'string') {
        // named aliases such as topBitSetTerminatedArray are arrays too
        const type = MD_MAP[def] || (/array$/i.test(def) ? 'array' : def);
        out.push({ name, type, optional, nested });
        return out;
    }
    const kind = def[0];
    const args = def[1];
    if (kind === 'container') {
        for (const f of args) fieldEntries(f.name, f.type, nested, optional, out);
    } else if (kind === 'array') {
        out.push({ name, type: 'array', optional, nested });
        if (typeof args.type !== 'string') fieldEntries(name, args.type, true, optional, out);
    } else if (kind === 'option') {
        // an option of a primitive or buffer is that type, optional; an option of a container inlines it
        if (typeof args === 'string' || args[0] !== 'container') fieldEntries(name, args, nested, true, out);
        else { out.push({ name, type: 'option', optional: true, nested }); fieldEntries(name, args, true, true, out); }
    } else if (kind === 'switch') {
        out.push({ name, type: 'switch', optional: true, nested });
        const seen = new Set();
        for (const caseType of Object.values(args.fields || {})) {
            const key = JSON.stringify(caseType);
            if (seen.has(key)) continue;
            seen.add(key);
            fieldEntries(name, caseType, true, true, out);
        }
    } else if (kind === 'mapper' || kind === 'bitflags') {
        // enums and bitflags are their underlying integer
        const under = typeof args.type === 'string' ? args.type : args.type[0];
        out.push({ name, type: MD_MAP[under] || under, optional, nested });
    } else if (kind === 'bitfield') {
        // a 64-bit bitfield is a packed position (x/z/y); smaller ones are plain unsigned integers
        const total = args.reduce((s, b) => s + b.size, 0);
        const type = total === 64 ? 'position' : total <= 8 ? 'u8' : total <= 16 ? 'u16' : total <= 32 ? 'i32' : 'i64';
        out.push({ name, type, optional, nested });
    } else {
        // a buffer with a fixed count is a fixed byte run; one with countType is length-prefixed
        const type = kind === 'buffer' ? (args && args.countType ? 'array' : 'fixedbuf') : /array$/i.test(kind) ? 'array' : kind;
        out.push({ name, type, optional, nested });
    }
    return out;
}

function mdFields(bound, wikiName) {
    const dir = bound === 'C' ? MC.protocol.play.toClient : MC.protocol.play.toServer;
    const def = dir.types['packet_' + wikiName];
    if (!def) return null;
    return fieldEntries('', def, false, false, []);
}

const lastLetter = (name) => (name.trim().match(/([A-Za-z])$/) || [])[1] || '';
const isXYZ = (run) => ['x', 'y', 'z'].every((c, i) => lastLetter(run[i].name).toLowerCase() === c);
const isPYH = (run) => /pitch/i.test(run[0].name) && /yaw/i.test(run[1].name) && /head/i.test(run[2].name);

// Representation-only normalisation applied to both sides before comparing.
// mdArrays: number of array fields in minecraft-data's top level.
function canon(entries, side, mdArrays) {
    // packed positions: 64-bit ints named as positions match the position type
    let list = entries
        .filter((e) => e.type !== 'switch' && e.type !== 'option')
        .map((e) => {
            let type = e.type;
            if (side === 'wiki' && type === 'i64' && /pos|location/i.test(e.name)) type = 'position';
            // window ids and bitmask bytes: wiki's signed/VarInt spelling is the same byte as minecraft-data's u8
            if (/window[ _]?id/i.test(e.name)) type = 'winid';
            if (type === 'i8' && /(flags|actions?)$/i.test(e.name.trim())) type = 'u8';
            // wiki rows named 'Array ...' carry the array's element type; the array itself is one field
            if (side === 'wiki' && /\barray\b/i.test(e.name) && !/\b(count|length|size)\b/i.test(e.name)) type = 'array';
            if (type === 'position') type = 'pos';
            const vec = type.match(/^vec3(f64|i16|f32|i32)$/);
            if (vec) type = 'vec3:' + vec[1];
            return { ...e, type };
        });

    // (f) a wiki 'Has X' presence flag before an optional field is the option itself
    if (side === 'wiki') list = list.filter((e, i) => !(e.type === 'bool' && /^Has\b/i.test(e.name) && list[i + 1] && list[i + 1].optional));

    // wiki 'Particle ID' + 'Data' (varies) is one minecraft-data Particle; Yaw+Pitch is one vec2
    {
        const merged = [];
        for (let i = 0; i < list.length; i++) {
            const nx = list[i + 1];
            if (side === 'wiki' && list[i].type === 'varint' && nx && nx.type === 'varies') { merged.push({ ...list[i], type: 'Particle' }); i++; continue; }
            if (list[i].type === 'f32' && nx && nx.type === 'f32' && /^(yaw|pitch)$/i.test(list[i].name.trim()) && /^(yaw|pitch)$/i.test(nx.name.trim())) { merged.push({ ...list[i], type: 'vec2:f32' }); i++; continue; }
            merged.push(list[i]);
        }
        list = merged;
    }

    // (a) wiki length prefix ('Passenger Count', 'Array length') before an array field
    if (side === 'wiki' && mdArrays === 1) {
        list = list.filter((e, i) => !(e.type === 'varint' && /\b(count|length|size|number)\b/i.test(e.name) &&
            list[i + 1] && (list[i + 1].type === 'array' || /\barray\b/i.test(list[i + 1].name))));
    }

    // (b) three consecutive same-typed components (X/Y/Z or Pitch/Yaw/Head) are one vec3 / rot3
    const out = [];
    for (let i = 0; i < list.length; i++) {
        const run = list.slice(i, i + 3);
        if (run.length === 3 && run.every((e) => e.type === run[0].type)) {
            if (isXYZ(run)) { out.push({ ...run[0], type: 'vec3:' + run[0].type, optional: run.some((e) => e.optional) }); i += 2; continue; }
            if (isPYH(run)) { out.push({ ...run[0], type: 'rot3:' + run[0].type, optional: run.some((e) => e.optional) }); i += 2; continue; }
        }
        out.push(list[i]);
    }
    return out;
}

// Compare two type sequences ignoring optional entries; equal means the disagreement is conditional.
function sameIgnoringOptional(a, b) {
    const f = (xs) => xs.filter((e) => !e.optional).map((e) => e.type);
    const x = f(a);
    const y = f(b);
    return x.length === y.length && x.every((t, i) => t === y[i]);
}

// Side-by-side rendering of two lists, row i is wiki[i] vs md[i].
function sideBySide(wikiList, mdList) {
    const rows = Math.max(wikiList.length, mdList.length);
    const lines = ['| # | wiki (name:type) | minecraft-data (name:type) |', '|---|---|---|'];
    for (let i = 0; i < rows; i++) {
        const w = wikiList[i] ? wikiList[i].name + ':' + wikiList[i].type + (wikiList[i].optional ? ' (opt)' : '') : '';
        const m = mdList[i] ? mdList[i].name + ':' + mdList[i].type + (mdList[i].optional ? ' (opt)' : '') : '';
        lines.push(`| ${i + 1} | ${w.replace(/\|/g, '\\|')} | ${m.replace(/\|/g, '\\|')} |`);
    }
    return lines.join('\n');
}

// Notes-filter for the unit/encoding section.
const UNIT_RE = /unit|fixed[- ]point|scal|bit ?mask|enum|registry|\b\d+\s*[:=]\s|\b0x[0-9a-f]+|\/\s*\d|\d\s*\/\s*\d|divid|multipl|per tick|degree/i;
const UNIT_PACKETS = ['Spawn Entity', 'Teleport Entity', 'Update Entity Position', 'Set Entity Velocity',
    'Entity Event', 'Entity Animation', 'Set Equipment', 'Set Entity Metadata', 'Entity Effect',
    'Sound Effect', 'Entity Sound Effect', 'Particle', 'World Event', 'Explosion', 'Game Event',
    'Update Time', 'Set Experience', 'Block Update', 'Update Section Blocks', 'Player Info Update',
    'Boss Bar', 'Update Teams', 'Update Objectives', 'Update Score', 'Player Action', 'Player Command',
    'Player Input', 'Click Container', 'Use Item On', 'Interact'];

function main() {
    const refKey = (p) => p.state + '|' + p.bound + '|' + p.id;
    const refMap = new Map(REF.map((p) => [refKey(p), p]));
    const play = WIKI.filter((p) => p.state === 'play');

    const flagged = [];
    let compared = 0;
    const missingMd = [];
    for (const w of play) {
        const ref = refMap.get(refKey(w));
        if (!ref) continue;
        const md = mdFields(w.bound, ref.name);
        if (!md) { missingMd.push(w.name); continue; }
        compared++;
        const mdTop = md.filter((e) => !e.nested);
        const mdArrays = mdTop.filter((e) => e.type === 'array').length;
        const wiki = canon(w.fields.map((f) => ({ name: f.name, ...normWiki(f.type) })), 'wiki', mdArrays);
        const mdN = canon(mdTop, 'md', mdArrays);
        const countDiff = wiki.length !== mdN.length;
        const seqDiff = !countDiff && wiki.some((e, i) => e.type !== mdN[i].type);
        if (!countDiff && !seqDiff) continue;
        // a disagreement is benign when removing optional entries makes the sequences match
        const benign = sameIgnoringOptional(wiki, mdN);
        flagged.push({ w, ref, wiki, mdTop: mdN, benign, reason: [countDiff ? 'count ' + wiki.length + ' vs ' + mdN.length : '', seqDiff ? 'type order' : ''].filter(Boolean).join('; ') });
    }

    flagged.sort((a, b) => {
        const ta = TIER_ORDER.indexOf(a.ref.tier);
        const tb = TIER_ORDER.indexOf(b.ref.tier);
        const ra = ta < 0 ? 99 : ta;
        const rb = tb < 0 ? 99 : tb;
        return ra - rb || a.ref.tier.localeCompare(b.ref.tier) || a.w.bound.localeCompare(b.w.bound) || a.w.id.localeCompare(b.w.id);
    });

    const out = [];
    out.push('# Play packet comparison: wiki vs minecraft-data (1.21.1)');
    out.push('');
    out.push('Generated by `reader/wiki/compare.js` from `reader/wiki/wiki_packets.json` and minecraft-data `protocol.play`.');
    out.push('');
    out.push('Only disagreements are listed. Both sides are first normalised for representation only: enums and bitmasks take their integer type, Optional/Prefixed Optional and option are marked optional, switch entries are dropped, a wiki length prefix before a single array is dropped, a same-typed X/Y/Z triple (or Pitch/Yaw/Head) becomes one vec3/rot3 entry, and 64-bit packed positions match position/bitfield. A packet is flagged when the normalised top-level field counts differ or the type sequences differ in order. Top-level minecraft-data fields are the container fields with anonymous containers inlined; array/option/switch count as one field each, and the contents of arrays, options and switches are kept as nested entries (not counted at top level). A flag is marked **likely benign** when the two sequences match once optional entries are removed (so only conditional fields disagree).');
    out.push('');
    out.push(`Compared ${compared} play packets. Flagged ${flagged.length}, of which ${flagged.filter((f) => f.benign).length} likely benign and ${flagged.filter((f) => !f.benign).length} not benign.`);
    if (missingMd.length) out.push('', 'No minecraft-data definition found for: ' + missingMd.join(', '));
    out.push('');

    let lastTier = null;
    for (const f of flagged) {
        if (f.ref.tier !== lastTier) {
            out.push(`## Tier ${f.ref.tier}`, '');
            lastTier = f.ref.tier;
        }
        out.push(`### ${f.w.bound === 'C' ? 'Clientbound' : 'Serverbound'} ${f.w.id} ${f.w.name}`);
        out.push('');
        out.push(`- minecraft-data: \`packet_${f.ref.name}\` (${f.ref.bound === 'C' ? 'toClient' : 'toServer'})`);
        out.push(`- reason: ${f.reason}`);
        out.push(`- verdict: ${f.benign ? '**likely benign** (only optional/conditional fields differ)' : 'not benign'}`);
        out.push('');
        out.push(sideBySide(f.wiki, f.mdTop));
        out.push('');
    }

    // Task 3: notes for unit / encoding fields
    out.push('## Unit and encoding notes', '');
    out.push('Verbatim wiki notes (markup stripped) for fields whose note mentions a unit, fixed-point scale, bitmask, enum values or an id registry. Matched by regex: `' + UNIT_RE.source + '`.', '');
    for (const name of UNIT_PACKETS) {
        const matches = play.filter((p) => p.name === name);
        if (!matches.length) { out.push(`### ${name}`, '', '_not found in wiki_', ''); continue; }
        for (const p of matches) {
            out.push(`### ${p.bound === 'C' ? 'Clientbound' : 'Serverbound'} ${name}`, '');
            const hits = p.fields.filter((f) => UNIT_RE.test(f.notes));
            if (!hits.length) out.push('_no matching field notes_');
            for (const f of hits) out.push(`- **${f.name}**: ${f.notes}`);
            out.push('');
        }
    }

    fs.writeFileSync(OUT, out.join('\n') + '\n');
    console.log('compared', compared, 'play packets; flagged', flagged.length,
        '(benign', flagged.filter((f) => f.benign).length + ', not benign', flagged.filter((f) => !f.benign).length + ')');
    if (missingMd.length) console.log('no md definition:', missingMd.join(', '));
    for (const f of flagged.filter((x) => !x.benign && TIER_ORDER.includes(x.ref.tier))) {
        console.log(`NB ${f.ref.tier} ${f.w.bound}${f.w.id} ${f.w.name}: ${f.reason}`);
    }
    console.log('non-benign (all tiers):', flagged.filter((f) => !f.benign).length);
}

main();
