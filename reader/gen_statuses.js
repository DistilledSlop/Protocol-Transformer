#!/usr/bin/env node
'use strict';
// entity_statuses_reference.txt (wiki source) -> statuses.json: { class: { extends, codes: { code: description } } }
// Meaning of a status code depends on the entity class; the class tree comes from the "Extends" lines.

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'entity_statuses_reference.txt'), 'utf8');
const body = src.slice(src.indexOf('== Entity statuses =='));
const out = {};
for (const sec of body.split(/^=== /m).slice(1)) {
    const cls = /\|([^\]]+)\]\]/.exec(sec.split('\n')[0])?.[1]?.trim() ?? sec.split('\n')[0].replace(/[\[\]= ]/g, '');
    const ext = /Extends \[\[#([^|\]]+)/.exec(sec)?.[1]?.replace(/_/g, ' ') ?? null;
    const codes = {};
    // rows look like:  | 29 \n |colspan="2"| description
    const re = /^\s*\|\s*(\d+)\s*\n\s*\|colspan="2"\|\s*([\s\S]*?)(?=\n\s*\|-|\n\s*\|\})/gm;
    let m;
    while ((m = re.exec(sec))) codes[m[1]] = m[2].replace(/\{\{[^|}]*\|([^}|]*)(\|[^}]*)?\}\}/g, '$1').replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1').replace(/\s+/g, ' ').trim();
    out[cls] = { extends: ext, codes };
}
fs.writeFileSync(path.join(__dirname, 'statuses.json'), JSON.stringify(out, null, 1));
const n = Object.values(out).reduce((a, c) => a + Object.keys(c.codes).length, 0);
console.log(`${Object.keys(out).length} classes, ${n} status codes -> statuses.json`);
console.log('Living Entity:', Object.keys(out['Living Entity']?.codes ?? {}).join(','), '| Player:', Object.keys(out['Player']?.codes ?? {}).join(','));
