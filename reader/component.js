'use strict';
// Text components (NBT on the 1.21.1 wire) to plain strings, and strings to templates.
//
// A template replaces numbers and known player names with placeholders, so "Welcome back, Steve!" and
// "Welcome back, Alex!" are one token. The values that were cut out travel beside the row.

const path = require('path');
const nbt = require(path.join(__dirname, '..', 'proxy', 'node_modules', 'prismarine-nbt'));

// -> { text, translate, args } ; translate is the key of a translatable component, args its flattened arguments
function flatten(comp) {
    if (comp === undefined || comp === null) return { text: '', translate: null, args: [] };
    let js = comp;
    if (typeof comp === 'object' && comp.type !== undefined && comp.value !== undefined) js = nbt.simplify(comp);
    return flat(js);
}

function flat(js) {
    if (js === undefined || js === null) return { text: '', translate: null, args: [] };
    if (typeof js === 'string') return { text: js, translate: null, args: [] };
    if (typeof js === 'number' || typeof js === 'boolean' || typeof js === 'bigint') return { text: String(js), translate: null, args: [] };
    if (Array.isArray(js)) return { text: js.map((x) => flat(x).text).join(''), translate: null, args: [] };
    let text = '';
    let translate = null;
    let args = [];
    if (typeof js.text === 'string') text = js.text;
    else if (typeof js.translate === 'string') {
        translate = js.translate;
        args = (js.with || []).map((a) => flat(a).text);
        text = translate;
    }
    const extra = js.extra ? js.extra.map((x) => flat(x).text).join('') : '';
    return { text: text + extra, translate, args };
}

// names: iterable of player names to cut out. Returns { tpl, values } with values as [{kind, v}] in order.
function template(text, names) {
    const list = [...names].filter((n) => n && n.length >= 3).sort((a, b) => b.length - a.length);
    const esc = list.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(`${esc.length ? esc.join('|') + '|' : ''}\\d+`, 'g');
    const values = [];
    const tpl = text.replace(re, (m) => {
        if (/^\d+$/.test(m) && !list.includes(m)) {
            values.push({ kind: 'num', v: m });
            return '{n}';
        }
        values.push({ kind: 'name', v: m });
        return '{p}';
    });
    return { tpl, values };
}

// The plain JS form of a component (NBT from the wire, or already JSON), for walking its structure.
function simplify(comp) {
    if (comp !== null && typeof comp === 'object' && comp.type !== undefined && comp.value !== undefined) return nbt.simplify(comp);
    return comp;
}

module.exports = { flatten, template, simplify };
