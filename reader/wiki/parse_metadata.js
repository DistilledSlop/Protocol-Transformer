'use strict';
// Parses the wiki.vg 'Entity metadata' page dump into entity_classes.json.
// The page writes no explicit metadata indexes ({{Metadata id|}} is always empty),
// so indexes follow the page's own rule: a class continues from its parent's last index.

const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '../../entity_metadata_reference.txt');
const OUT = path.join(__dirname, 'entity_classes.json');

// Entities whose page class has a different name, or no section of its own.
// Null means the page has no metadata class for that entity.
const ALIASES = {
    tnt: 'Primed TNT',
    egg: 'Thrown Egg',
    ender_pearl: 'Thrown Ender Pearl',
    experience_bottle: 'Thrown Bottle o\' Enchanting',
    chest_minecart: 'Minecart with Chest',
    furnace_minecart: 'Minecart with Furnace',
    hopper_minecart: 'Minecart with Hopper',
    tnt_minecart: 'Minecart with TNT',
    command_block_minecart: 'Minecart with Command Block',
    spawner_minecart: 'Minecart with Monster Spawner',
};

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// Strips wiki markup so names and notes read as plain text.
function clean(s) {
    return s
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/\{\{Metadata id\|\}\}/g, '')
        .replace(/\{\{(?:Type|Metadata type|Minecraft Wiki|Metadata type definition)\|([^{}]*)\}\}/g, '$1')
        .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
        .replace(/'''|''/g, '')
        .replace(/<[^>]+>/g, '')
        .replace(/[ \t]+/g, ' ')
        .split('\n').map((x) => x.trim()).filter(Boolean).join('\n');
}

// Splits on sep only where it is outside a {{template}} or [[link]], so pipes inside them survive.
function splitTop(s, sep) {
    const out = [];
    let depth = 0;
    let cur = '';
    for (let i = 0; i < s.length; i++) {
        const two = s.substr(i, 2);
        if (two === '{{' || two === '[[') { depth++; cur += two; i++; continue; }
        if (two === '}}' || two === ']]') { depth--; cur += two; i++; continue; }
        if (depth === 0 && s.startsWith(sep, i)) { out.push(cur); cur = ''; i += sep.length - 1; continue; }
        cur += s[i];
    }
    out.push(cur);
    return out;
}

// One table cell: optional attributes (rowspan/colspan/style) before a single top-level '|'.
function parseCell(piece, header) {
    const parts = splitTop(piece, '|');
    let attrs = '';
    let text = piece;
    if (parts.length > 1 && /^\s*\w+="[^"]*"(\s+\w+="[^"]*")*\s*$/.test(parts[0])) {
        attrs = parts[0];
        text = parts.slice(1).join('|');
    }
    const span = (name) => {
        const m = attrs.match(new RegExp(name + '="(\\d+)"'));
        return m ? Number(m[1]) : 1;
    };
    return { header, text: text.trim(), rowspan: span('rowspan'), colspan: span('colspan') };
}

// Rows of a wikitable body (lines between '{|' and '|}'). Continuation lines extend the last cell.
function tableRows(lines) {
    const rows = [];
    let cur = null;
    for (const raw of lines) {
        const line = raw.trim();
        if (line.startsWith('|}')) break;
        if (line.startsWith('|-')) { cur = []; rows.push(cur); continue; }
        if (/^[|!]/.test(line)) {
            if (!cur) { cur = []; rows.push(cur); }
            const header = line[0] === '!';
            const body = line.slice(1);
            for (const piece of splitTop(body, header ? '!!' : '||')) {
                cur.push(parseCell(piece.trim(), header));
            }
        } else if (cur && cur.length) {
            cur[cur.length - 1].text += '\n' + line;
        }
    }
    return rows;
}

// Places cells on a grid, honouring rowspan/colspan carried from earlier rows.
function layout(rows) {
    const pending = new Map(); // column -> { cell, left }
    return rows.map((cells) => {
        const out = [];
        let col = 0;
        let i = 0;
        while (i < cells.length || [...pending.keys()].some((k) => k >= col)) {
            if (pending.has(col)) {
                const p = pending.get(col);
                out.push({ col, cell: p.cell, carried: true });
                if (--p.left === 0) pending.delete(col);
                col++;
            } else if (i < cells.length) {
                const cell = cells[i++];
                out.push({ col, cell, carried: false });
                if (cell.rowspan > 1) {
                    for (let c = col; c < col + cell.colspan; c++) pending.set(c, { cell, left: cell.rowspan - 1 });
                }
                col += cell.colspan;
            } else {
                col++;
            }
        }
        return out;
    });
}

// Fields of one metadata table. A field starts on a row with its own {{Metadata id}} cell;
// bitmask rows that follow it (0x.. in column 2) are folded into its notes.
function fieldsFromTable(rows) {
    const fields = [];
    let cur = null;
    for (const row of layout(rows)) {
        const own = row.filter((e) => !e.carried);
        if (own.some((e) => /Metadata id/.test(e.cell.text))) {
            const typeEntry = row.find((e) => e.col === 1);
            const def = own.reduce((a, e) => (e.col > a.col ? e : a));
            const meaning = own.filter((e) => e.col >= 2 && e.col < def.col && !e.cell.header);
            const typeText = typeEntry ? typeEntry.cell.text : '';
            const tm = typeText.match(/Metadata type\|([^}]+)\}\}/);
            cur = {
                type: tm ? tm[1].trim() : clean(typeText),
                meaning: meaning.length ? clean(meaning.map((e) => e.cell.text).join('\n')) : 'Bit mask',
                def: clean(def.cell.text),
                bits: [],
            };
            fields.push(cur);
            continue;
        }
        if (!cur) continue;
        const bit = own.find((e) => e.col === 2 && /^0x[0-9a-f]+$/i.test(e.cell.text));
        const bitMeaning = own.find((e) => e.col === 3);
        if (bit) cur.bits.push(clean(bit.cell.text) + ': ' + (bitMeaning ? clean(bitMeaning.cell.text) : ''));
    }
    return fields.map((f) => {
        const [name, ...rest] = f.meaning.split('\n');
        const notes = [...rest, 'default: ' + f.def];
        if (f.bits.length) notes.push('bits: ' + f.bits.join('; '));
        return { name, type: f.type, notes: notes.join(' | ') };
    });
}

function parseEntities(text) {
    const section = text.split(/^== Entities ==$/m)[1].split(/^== Entity Metadata Format ==$/m)[0];
    const rows = tableRows(section.split('\n').slice(section.indexOf('{|') >= 0 ? section.split('\n').findIndex((l) => l.startsWith('{|')) + 1 : 0));
    const entities = {};
    for (const row of rows) {
        if (row.length < 5) continue;
        const idCode = row[4].text.match(/minecraft:(\w+)/);
        if (!idCode) continue;
        entities[idCode[1]] = clean(row[1].text);
    }
    return entities;
}

function parseSerializers(text) {
    const section = text.split(/^== Entity Metadata Format ==$/m)[1].split(/^== Entity Metadata ==$/m)[0];
    const lines = section.split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^\{\{Metadata type definition\|([^}]+)\}\}$/);
        if (!m) continue;
        // Ids are the list order on the page; the notes follow the value cell.
        const body = [];
        for (let j = i + 1; j < lines.length; j++) {
            const l = lines[j].trim();
            if (l.startsWith('{{Metadata type definition') || l.startsWith('|}')) break;
            if (l.startsWith('|') && !l.startsWith('|-')) body.push(l.slice(1));
        }
        out.push({ id: out.length, name: m[1].trim(), notes: clean(body.slice(1).join('\n')) });
    }
    return out;
}

function parseClasses(text) {
    const section = text.split(/^== Entity Metadata ==$/m)[1];
    const classes = {};
    const zero = [];
    const duplicates = [];
    const parts = section.split(/^===\s*(.+?)\s*===\s*$/m);
    // parts: [preamble, name1, body1, name2, body2, ...]
    for (let k = 1; k < parts.length; k += 2) {
        const name = parts[k].trim();
        const body = parts[k + 1];
        const inh = body.match(/\{\{[Mm]etadata inherit\|[^}]*?inherits=([^|}]+)/);
        const inhTxt = body.match(/Extends\s+\[\[#([^|\]]+)/);
        const extendsName = inh ? inh[1].trim() : (inhTxt ? inhTxt[1].trim() : null);
        const lines = body.split('\n');
        const fields = [];
        let hasTable = false;
        for (let i = 0; i < lines.length; i++) {
            if (!lines[i].trim().startsWith('{|')) continue;
            hasTable = true;
            const end = lines.findIndex((l, j) => j > i && l.trim().startsWith('|}'));
            fields.push(...fieldsFromTable(tableRows(lines.slice(i + 1, end < 0 ? undefined : end + 1))));
            i = end < 0 ? lines.length : end;
        }
        if (classes[name]) { duplicates.push(name); continue; }
        classes[name] = { extends: extendsName, fields, _hasTable: hasTable };
        if (fields.length === 0) zero.push({ name, hasTable });
    }
    return { classes, zero, duplicates };
}

// Index = parent's last index + 1 for each own field, as the page's rule states.
function assignIndexes(classes) {
    const memo = {};
    const lastIndex = (name, seen = new Set()) => {
        if (name in memo) return memo[name];
        const c = classes[name];
        if (!c || seen.has(name)) return -1;
        seen.add(name);
        const base = c.extends && classes[c.extends] ? lastIndex(c.extends, seen) : -1;
        memo[name] = base + c.fields.length;
        return memo[name];
    };
    const missingParents = [];
    for (const [name, c] of Object.entries(classes)) {
        if (c.extends && !classes[c.extends]) missingParents.push(`${name} -> ${c.extends}`);
        const base = c.extends && classes[c.extends] ? lastIndex(c.extends) : -1;
        c.fields.forEach((f, k) => { f.index = base + 1 + k; });
        delete c._hasTable;
    }
    return missingParents;
}

function main() {
    const text = fs.readFileSync(SRC, 'utf8');
    const { classes, zero, duplicates } = parseClasses(text);
    const missingParents = assignIndexes(classes);
    const rawEntities = parseEntities(text);
    const classNames = Object.keys(classes);
    const byNorm = new Map(classNames.map((n) => [norm(n), n]));

    const entities = {};
    const unmapped = [];
    for (const [key, name] of Object.entries(rawEntities)) {
        const k = key.replace(/_/g, '');
        let cls = null;
        if (key in ALIASES) cls = ALIASES[key];
        else cls = byNorm.get(norm(name)) || byNorm.get(k) || null;
        if (cls && !classes[cls]) cls = null;
        if (!cls) unmapped.push(key);
        entities[key] = cls;
    }

    const serializers = parseSerializers(text);
    const out = { classes, entities, serializers };
    fs.writeFileSync(OUT, JSON.stringify(out, null, 4) + '\n');

    const fieldCount = classNames.reduce((n, c) => n + classes[c].fields.length, 0);
    console.log(`classes: ${classNames.length}`);
    console.log(`fields: ${fieldCount}`);
    console.log(`entities: ${Object.keys(entities).length} (no class: ${unmapped.length})`);
    console.log(`serializers: ${serializers.length}`);
    console.log(`zero-field classes: ${zero.length}`);
    for (const z of zero) console.log(`  ${z.name}${z.hasTable ? ' (table, no rows)' : ' (no table)'}`);
    if (duplicates.length) console.log(`duplicate class sections skipped: ${duplicates.join(', ')}`);
    if (missingParents.length) console.log(`parents not on page: ${missingParents.join(', ')}`);
    console.log(`entities without class: ${unmapped.join(', ')}`);
}

main();
