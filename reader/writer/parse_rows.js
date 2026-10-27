'use strict';
// Compiler front end: a row's tokens -> an intent with numbers in it. This is the inverse of the token
// builders in the reader, and it reads only tokens, as the model's output will be only tokens. Anything it
// does not recognise throws, so a bad row from the model is a counted rejection, not a guess.
//
// A row is read in two steps: the head (row type, then whatever names the kind: a slot, an offset, a channel)
// and the kind's own tail. The tails live in families/*.js, registered by '<ROW> <KIND>'.

const Q = require('../quant');

class Cursor {
    constructor(tokens) {
        this.t = tokens;
        this.i = 0;
    }

    eof() {
        return this.i >= this.t.length;
    }

    peek() {
        return this.t[this.i];
    }

    next() {
        if (this.eof()) throw new Error('row ended early');
        return this.t[this.i++];
    }

    expect(tok) {
        const t = this.next();
        if (t !== tok) throw new Error(`expected ${tok}, got ${t}`);
    }

    // intTokens(prefix, v): one token `<prefix><n>` for 0..255, otherwise `<prefix>=` digits `;`
    int(prefix) {
        const t = this.next();
        if (t === `${prefix}=`) {
            let s = '';
            for (;;) {
                const d = this.next();
                if (d === ';') break;
                s += d === 'neg' ? '-' : d.slice(1);
            }
            return Number(s);
        }
        const m = new RegExp(`^${prefix}(-?\\d+)$`).exec(t);
        if (!m) throw new Error(`expected ${prefix}<n>, got ${t}`);
        return Number(m[1]);
    }

    // a field tag, then a coarse token and (unless zero) a fine token -> integer wire units
    quant(tag) {
        this.expect(tag);
        const { q, used } = Q.fromTokens(this.t.slice(this.i));
        this.i += used;
        return Q.dequantize(q);
    }

    // a position relative to the focus: tag, whole-block offset, sixteenth -> 1/16 block units
    lattice(tag) {
        this.expect(tag);
        const b = /^ob(-?\d+)$/.exec(this.next());
        const f = /^of(\d+)$/.exec(this.next());
        if (!b || !f) throw new Error(`bad position tokens after ${tag}`);
        return Number(b[1]) * 16 + Number(f[1]);
    }

    angle(prefix) {
        return this.int(prefix) & 255;
    }

    // Everything left, for rows whose tail is optional.
    rest() {
        return this.t.slice(this.i);
    }
}

const slotNum = (t) => {
    const m = /^s(\d+)$/.exec(t);
    if (!m) throw new Error(`expected a slot token, got ${t}`);
    return Number(m[1]);
};

// head parsers: read what names the kind, return {row, kind, ...fields}
const HEADS = {
    ENTITY(c) {
        const slot = slotNum(c.next());
        return { row: 'ENTITY', slot, kind: c.next() };
    },
    BLOCK(c) {
        const offset = ['bx', 'by', 'bz'].map((p) => {
            const t = c.next();
            const m = new RegExp(`^${p}(-?\\d+)$`).exec(t);
            if (!m) throw new Error(`expected ${p}<n>, got ${t}`);
            return Number(m[1]);
        });
        const t = c.next();
        // a plain block change carries the block state directly, other kinds name themselves
        return t.startsWith('blk:') ? { row: 'BLOCK', offset, kind: 'SET', block: t.slice(4) } : { row: 'BLOCK', offset, kind: t };
    },
    SLOT(c) {
        return { row: 'SLOT', kind: c.next() };
    },
    EVENT(c) {
        // events about an entity name its slot first; room-wide ones (sounds, particles) go straight to the kind
        let slot = null;
        let kind = c.next();
        if (/^s\d+$/.test(kind)) {
            slot = slotNum(kind);
            kind = c.next();
        }
        return { row: 'EVENT', slot, kind };
    },
    TEXT(c) {
        const t = c.next();
        const m = /^ch:(.+)$/.exec(t);
        if (!m) throw new Error(`expected ch:<channel>, got ${t}`);
        return { row: 'TEXT', kind: m[1], channel: m[1] };
    },
    GLOBAL(c) {
        const f = c.next();
        if (!f.startsWith('g:')) throw new Error(`expected g:<field>, got ${f}`);
        return { row: 'GLOBAL', kind: f.slice(2), field: f.slice(2) };
    },
};

// '<ROW> <KIND>' -> fn(cursor, head) returning the kind's own fields; '<ROW> *' answers any kind of that row
const TAILS = new Map();

function registerParsers(table) {
    for (const [key, fn] of Object.entries(table)) TAILS.set(key, fn);
}

function parseRow(tokens) {
    const type = tokens[0];
    const headFn = HEADS[type];
    if (!headFn) throw new Error(`unsupported row type ${type}`);
    const c = new Cursor(tokens);
    c.next();
    const head = headFn(c);
    const tail = TAILS.get(`${type} ${head.kind}`) ?? TAILS.get(`${type} *`);
    if (!tail) throw new Error(`unsupported ${type} kind ${head.kind}`);
    const out = { ...head, ...tail(c, head) };
    if (!c.eof()) throw new Error(`trailing tokens: ${c.rest().join(' ')}`);
    return out;
}

module.exports = { parseRow, registerParsers, Cursor, slotNum };
