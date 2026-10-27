'use strict';
// Parses the wiki.vg-style protocol dump into wiki_packets.json.
const fs = require('fs');
const path = require('path');

const WIKI = '/home/nathan/protocol_ai_v4/1.21.1_reference.txt';
const OUT = path.join(__dirname, 'wiki_packets.json');
const PACKETS = path.join(__dirname, '..', 'packets.json');

const STATES = ['handshaking', 'status', 'login', 'configuration', 'play'];

// Strip wikitext markup, keep the words, numbers and units.
function plain(s) {
    let t = s;
    // [[target|text]] -> text; [[#Anchor]] -> Anchor
    for (let i = 0; i < 10; i++) {
        const before = t;
        t = t.replace(/\[\[([^\[\]]*)\]\]/g, (m, inner) => {
            if (inner.includes('|')) return inner.slice(inner.lastIndexOf('|') + 1);
            return inner.replace(/^#/, '').replace(/_/g, ' ');
        });
        if (t === before) break;
    }
    // {{Type|X}} -> X; other templates -> their parameters
    for (let i = 0; i < 10; i++) {
        const before = t;
        t = t.replace(/\{\{([^{}]*)\}\}/g, (m, body) => {
            const parts = body.split('|').map((x) => x.trim());
            return parts.slice(1).join(' ') || parts[0];
        });
        if (t === before) break;
    }
    // [https://url text] -> text
    t = t.replace(/\[(https?:\S+)\s+([^\]]*)\]/g, '$2');
    t = t.replace(/\[(https?:[^\]]*)\]/g, '$1');
    t = t.replace(/<br\s*\/?>/gi, ' ');
    t = t.replace(/<[^>]+>/g, '');
    t = t.replace(/'{2,}/g, '');
    t = t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
    return t.replace(/\s+/g, ' ').trim();
}

// Parse the attribute prefix of a cell ("rowspan="3"| text") and split multi-cell lines.
function parseCellLine(line) {
    const kind = line[0];
    const body = line.slice(1);
    const parts = kind === '|' ? body.split(/\s\|\|\s/) : body.split(/\s!!\s|\s\|\|\s/);
    return parts.map((part) => {
        const m = part.match(/^\s*((?:[a-zA-Z]+="[^"]*"\s*)+)\|(?!\|)([\s\S]*)$/);
        const attrs = {};
        let text = part;
        if (m) {
            text = m[2];
            for (const a of m[1].matchAll(/([a-zA-Z]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
        }
        return { header: kind === '!', attrs, text: text.trim() };
    });
}

// Turn a list of rows (each an array of cells) into a grid, honouring rowspan/colspan.
function layout(rows) {
    const occ = [];
    const rowsOut = [];
    rows.forEach((cells, r) => {
        occ[r] = occ[r] || [];
        let c = 0;
        for (const cell of cells) {
            while (occ[r][c]) c++;
            const cs = parseInt(cell.attrs.colspan, 10) || 1;
            const rs = parseInt(cell.attrs.rowspan, 10) || 1;
            for (let dr = 0; dr < rs; dr++) {
                occ[r + dr] = occ[r + dr] || [];
                for (let dc = 0; dc < cs; dc++) occ[r + dr][c + dc] = cell;
            }
            c += cs;
        }
    });
    rows.forEach((_, r) => rowsOut.push(occ[r] || []));
    return rowsOut;
}

// Extract the wikitable blocks that appear after a packet heading.
function parseTable(lines, start) {
    let i = start;
    while (i < lines.length && !lines[i].trimStart().startsWith('{|')) {
        if (/^==/.test(lines[i])) return { error: 'heading before table' };
        i++;
    }
    if (i >= lines.length) return { error: 'no table' };
    i++;
    const rows = [];
    let cur = null;
    for (; i < lines.length; i++) {
        // table rows are indented by one space in the dump
        const line = lines[i].replace(/^\s+/, '');
        if (line.startsWith('|}')) break;
        if (line.startsWith('|-')) {
            cur = [];
            rows.push(cur);
            continue;
        }
        if (/^[|!]/.test(line)) {
            if (!cur) { cur = []; rows.push(cur); }
            cur.push(...parseCellLine(line));
            continue;
        }
        // continuation of the previous cell's text
        if (cur && cur.length) cur[cur.length - 1].text += '\n' + lines[i];
    }
    return { rows, end: i };
}

function parseIdCell(text) {
    // serverbound tables give a bare <code>0x02</code> with no protocol: prefix
    const id = text.match(/<code>(0x[0-9A-Fa-f]+)<\/code>/) || text.match(/(0x[0-9A-Fa-f]+)/);
    const res = text.match(/resource:[\s\S]*?<code>([^<]+)<\/code>/);
    return {
        id: id ? '0x' + id[1].slice(2).toUpperCase().padStart(2, '0') : null,
        resource: res ? res[1].trim() : null,
    };
}

function parsePacketTable(rows) {
    if (!rows.length) return { error: 'empty table' };
    const grid = layout(rows);
    if (grid.length < 2) return { error: 'no data rows' };
    // Header rows are unreliable (colspan on Field Name does not match the data rows),
    // so columns are read from the data rows: the id columns are fixed at the front and
    // Field Name / Field Type / Notes are the last three columns (Sector-style extras sit before them).
    const idCell = grid[1][0];
    if (!idCell || !/protocol:|0x[0-9A-Fa-f]/.test(idCell.text)) return { error: 'no packet id cell' };
    const ids = parseIdCell(idCell.text);
    const result = {
        id: ids.id,
        resource: ids.resource,
        boundText: grid[1][2] ? plain(grid[1][2].text) : null,
        stateText: grid[1][1] ? plain(grid[1][1].text) : null,
        fields: [],
    };
    // Column counts differ between rows (colspan/rowspan in the source), so take the
    // distinct cells of each row from left to right: the last is Notes, the one before Field Type,
    // the one before that Field Name. Rows with a rowspanned group label still resolve this way.
    for (let r = 1; r < grid.length; r++) {
        // sub-header rows inside a table ('! Action ! Field Name') are not fields
        if (rows[r].length && rows[r].every((c) => c.header)) continue;
        // the packet id/state/bound cells span the first rows; they are never fields
        const idCells = new Set([grid[1][0], grid[1][1], grid[1][2]]);
        const cells = [...new Set(grid[r].filter(Boolean))].filter((c) => !idCells.has(c));
        // rows with an empty notes cell have no trailing cell at all: name, type only
        if (cells.length < 2) continue;
        const noNotes = cells.length === 2;
        const nameCell = cells[cells.length - (noNotes ? 2 : 3)];
        const name = plain(nameCell.text);
        const typeCell = cells[cells.length - (noNotes ? 1 : 2)];
        if (/^no fields$/i.test(name) || !name || /^no fields$/i.test(plain(typeCell.text))) continue;
        // a colspan name cell covers several columns; only emit it once
        const last = result.fields[result.fields.length - 1];
        if (last && nameCell === last._nameCell) continue;
        result.fields.push({
            name,
            type: plain(typeCell.text),
            notes: noNotes ? '' : plain(cells[cells.length - 1].text),
            _nameCell: nameCell,
        });
    }
    for (const f of result.fields) delete f._nameCell;
    return result;
}

function main() {
    const lines = fs.readFileSync(WIKI, 'utf8').split('\n');
    const packets = [];
    const problems = [];
    let state = null;
    let bound = null; // from "=== Clientbound/Serverbound ===" context
    let heading = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const h = line.match(/^(={2,6})\s*(.+?)\s*\1\s*$/);
        if (!h) continue;
        const level = h[1].length;
        const text = h[2].trim();
        if (level === 2) {
            state = STATES.includes(text.toLowerCase()) ? text.toLowerCase() : null;
            bound = null;
            heading = null;
            continue;
        }
        if (level === 3) {
            bound = /^clientbound$/i.test(text) ? 'C' : /^serverbound$/i.test(text) ? 'S' : null;
            heading = null;
            continue;
        }
        if (level !== 4 || !state) continue;
        // a packet heading inside a state section
        const t = lines.slice(i + 1);
        const nextHeading = t.findIndex((l) => /^={2,4}\s*.+\s*={2,4}\s*$/.test(l));
        const block = nextHeading < 0 ? t : t.slice(0, nextHeading);
        const hasTable = block.some((l) => l.trimStart().startsWith('{| class="wikitable'));
        if (!hasTable) {
            problems.push({ state, bound, name: text, reason: 'no table before next heading' });
            continue;
        }
        const tStart = i + 1;
        const tbl = parseTable(lines, tStart);
        if (tbl.error) {
            problems.push({ state, bound, name: text, reason: tbl.error });
            continue;
        }
        const parsed = parsePacketTable(tbl.rows);
        if (parsed.error) {
            problems.push({ state, bound, name: text, reason: parsed.error });
            continue;
        }
        const pBound = parsed.boundText ? (/^client/i.test(parsed.boundText) ? 'C' : /^server/i.test(parsed.boundText) ? 'S' : null) : bound;
        if (!parsed.id) problems.push({ state, bound: pBound, name: text, reason: 'no packet id' });
        if (!pBound) problems.push({ state, bound, name: text, reason: 'no bound' });
        packets.push({
            state,
            bound: pBound || bound,
            id: parsed.id,
            resource: parsed.resource,
            name: text,
            fields: parsed.fields,
        });
    }

    fs.writeFileSync(OUT, JSON.stringify(packets, null, 2) + '\n');

    // summary per state/bound
    const counts = {};
    for (const p of packets) {
        const k = p.state + ' ' + p.bound;
        counts[k] = (counts[k] || 0) + 1;
    }
    console.log('parsed packets:', packets.length);
    for (const k of Object.keys(counts).sort()) console.log('  ' + k + ': ' + counts[k]);
    console.log('unparsed packet headings:', problems.length);
    for (const p of problems) console.log('  ' + p.state + ' ' + p.bound + ' ' + p.name + ' -- ' + p.reason);

    // join against packets.json on state+bound+id
    const ref = JSON.parse(fs.readFileSync(PACKETS, 'utf8'));
    const key = (p) => p.state + '|' + p.bound + '|' + p.id;
    const wikiKeys = new Map(packets.map((p) => [key(p), p]));
    const refKeys = new Map(ref.map((p) => [key(p), p]));
    const playWiki = packets.filter((p) => p.state === 'play');
    console.log('play packets in wiki:', playWiki.length, '(C ' + playWiki.filter((p) => p.bound === 'C').length + ', S ' + playWiki.filter((p) => p.bound === 'S').length + ')');
    const onlyWiki = [...wikiKeys.keys()].filter((k) => !refKeys.has(k) && k.startsWith('play'));
    const onlyRef = [...refKeys.keys()].filter((k) => !wikiKeys.has(k) && k.startsWith('play'));
    console.log('play packets only in wiki (' + onlyWiki.length + '):', onlyWiki.map((k) => k + ' ' + wikiKeys.get(k).name).join('; ') || 'none');
    console.log('play packets only in packets.json (' + onlyRef.length + '):', onlyRef.map((k) => k + ' ' + refKeys.get(k).name).join('; ') || 'none');
}

main();
