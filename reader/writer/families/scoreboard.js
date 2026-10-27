'use strict';
// Text rows about the scoreboard and boss bars: TEXT bossbar, TEXT objective (and its display slot), TEXT score
// and TEXT team. Every one is a 'text' packet.
//
// Engine-owned names: a boss bar's UUID, an objective's name and a team's name are not in the row (the reader
// numbers them by first sight), so they are derived from the index. The same index always gives the same name,
// and the names live in maps on the Writer, so a score and the objective it names agree.
// LOSSY: the objective's number format and styling, and team members past the 16 the reader keeps.

const { Cursor } = require('../parse_rows');
const writerMethods = require('../writer_methods');

const BOSS_ACTION = { add: 0, remove: 1, health: 2, title: 3, style: 4, flags: 5 };
const OBJ_ACTION = { create: 0, remove: 1, update: 2 };
const TEAM_MODE = { create: 0, remove: 1, update: 2, add_players: 3, remove_players: 4 };
// which optional parts of a team row each mode carries (the packet's switch on mode)
const TEAM_CARRIES = {
    create: ['name', 'friendly', 'ntv', 'col', 'formatting', 'prefix', 'players'],
    update: ['name', 'friendly', 'ntv', 'col', 'formatting', 'prefix'],
    remove: [],
    add_players: ['players'],
    remove_players: ['players'],
};
const MAX_TEAM_PLAYERS = 16; // the reader keeps at most this many team members

// Is the next token there, and does it match?
const at = (c, pred) => !c.eof() && pred(c.peek());
const isText = (t) => t.startsWith('tpl:') || t.startsWith('tr:');

// Consume one text group now, so the tokens are known to end here, and keep them for compile (names are
// only known then). The shared helper knows how many value tokens a template takes.
function takeText(c) {
    const start = c.i;
    const m = writerMethods.methods;
    m._readText.call(m, c, null);
    return c.t.slice(start, c.i);
}

// 'bits0' for none, else bit<i> tokens; null when the row has neither
function readBits(c, width) {
    if (at(c, (t) => t === 'bits0')) {
        c.next();
        return 0;
    }
    let v = null;
    while (at(c, (t) => /^bit\d+$/.test(t))) {
        const i = Number(c.next().slice(3));
        if (i >= width) throw new Error(`bit${i} is past the ${width} bits of this field`);
        v = (v ?? 0) | (1 << i);
    }
    return v;
}

const needBits = (c, width) => {
    const v = readBits(c, width);
    if (v === null) throw new Error('expected bit tokens');
    return v;
};

// a name token, nm<k> -> k
function nameIndex(c) {
    const t = c.next();
    const m = /^nm(\d+)$/.exec(t);
    if (!m) throw new Error(`expected a name token, got ${t}`);
    return Number(m[1]);
}

const parse = {
    'TEXT bossbar': (c) => {
        const t = c.next();
        const m = /^act:(add|remove|health|title|style|flags)$/.exec(t);
        if (!m) throw new Error(`unknown boss bar action ${t}`);
        const act = m[1];
        const out = { act, bar: c.int('b') };
        if (act === 'add') {
            out.title = takeText(c);
            out.health = c.int('h');
            out.color = c.int('col');
            out.dividers = c.int('div');
            out.flags = needBits(c, 3);
        } else if (act === 'health') out.health = c.int('h');
        else if (act === 'title') out.title = takeText(c);
        else if (act === 'style') {
            out.color = c.int('col');
            out.dividers = c.int('div');
        } else if (act === 'flags') out.flags = needBits(c, 3);
        return out;
    },

    // 'display pos<n> o<index>' or 'act:<create|remove|update> o<index> [text] [ty<n>]'
    'TEXT objective': (c) => {
        if (at(c, (t) => t === 'display')) {
            c.next();
            return { form: 'display', position: c.int('pos'), index: c.int('o') };
        }
        const t = c.next();
        const m = /^act:(create|remove|update)$/.exec(t);
        if (!m) throw new Error(`unknown objective action ${t}`);
        const out = { form: 'action', action: m[1], index: c.int('o') };
        if (m[1] !== 'remove') {
            if (at(c, isText)) out.text = takeText(c);
            if (at(c, (x) => /^ty/.test(x))) out.type = c.int('ty');
        }
        return out;
    },

    // 'reset' nm<k> [o<index>]  or  o<index> nm<k> v<value> [text]
    'TEXT score': (c) => {
        if (at(c, (t) => t === 'reset')) {
            c.next();
            const name = nameIndex(c);
            const index = at(c, (t) => /^o/.test(t)) ? c.int('o') : null;
            return { form: 'reset', name, index };
        }
        const index = c.int('o');
        const name = nameIndex(c);
        const value = c.int('v');
        const out = { form: 'set', index, name, value };
        if (at(c, isText)) out.display = takeText(c);
        return out;
    },

    // mode:<m> t<index>, then whichever parts the mode carries, in this order
    'TEXT team': (c) => {
        const t = c.next();
        const m = /^mode:(create|remove|update|add_players|remove_players)$/.exec(t);
        if (!m) throw new Error(`unknown team mode ${t}`);
        const out = { mode: m[1], index: c.int('t') };
        if (at(c, isText)) out.name = takeText(c);
        const friendly = readBits(c, 2);
        if (friendly !== null) out.friendly = friendly;
        if (at(c, (x) => x.startsWith('ntv:'))) out.ntv = c.next().slice(4);
        if (at(c, (x) => x.startsWith('col:'))) out.col = c.next().slice(4);
        if (at(c, (x) => /^fmt/.test(x))) out.formatting = c.int('fmt');
        if (at(c, (x) => x === 'prefix')) {
            c.next();
            out.prefix = takeText(c);
            c.expect('suffix');
            out.suffix = takeText(c);
        }
        if (at(c, (x) => /^np/.test(x))) {
            const n = c.int('np');
            // the reader sends the true count but only the first 16 names
            out.players = [];
            for (let i = 0; i < Math.min(n, MAX_TEAM_PLAYERS); i++) out.players.push(nameIndex(c));
        }
        return out;
    },
};

// bar UUIDs, objective and team names: one stable value per index, held on the Writer
const uuidFor = (idx) => `00000000-0000-4000-b000-${idx.toString(16).padStart(12, '0')}`;

const methods = {
    _barUuid(idx) {
        this.barUuids ??= new Map();
        if (!this.barUuids.has(idx)) this.barUuids.set(idx, uuidFor(idx));
        return this.barUuids.get(idx);
    },

    _objectiveName(idx) {
        this.objectiveNames ??= new Map();
        if (!this.objectiveNames.has(idx)) this.objectiveNames.set(idx, `obj${idx}`);
        return this.objectiveNames.get(idx);
    },

    _teamName(idx) {
        this.teamNames ??= new Map();
        if (!this.teamNames.has(idx)) this.teamNames.set(idx, `team${idx}`);
        return this.teamNames.get(idx);
    },

    // the NBT component a saved text group spells, with names from ctx
    _scoreText(raw, ctx) {
        return this._componentNbt(this._readText(new Cursor(raw), ctx));
    },
};
writerMethods.add(methods);

const EMPTY = { text: '' };

const compile = {
    'TEXT bossbar'(p, ctx, tick) {
        if (p.health !== undefined && p.health > 64) return this._reject('boss bar health past 64');
        const uuid = this._barUuid(p.bar);
        const action = BOSS_ACTION[p.act];
        const params = { entityUUID: uuid, action };
        if (p.act === 'add') Object.assign(params, { title: this._scoreText(p.title, ctx), health: p.health / 64, color: p.color, dividers: p.dividers, flags: p.flags });
        else if (p.act === 'health') params.health = p.health / 64;
        else if (p.act === 'title') params.title = this._scoreText(p.title, ctx);
        else if (p.act === 'style') Object.assign(params, { color: p.color, dividers: p.dividers });
        else if (p.act === 'flags') params.flags = p.flags;
        tick.add('text', { name: 'boss_bar', params });
    },

    'TEXT objective'(p, ctx, tick) {
        const name = this._objectiveName(p.index);
        if (p.form === 'display') {
            tick.add('text', { name: 'scoreboard_display_objective', params: { position: p.position, name } });
            return;
        }
        const action = OBJ_ACTION[p.action];
        if (p.action === 'remove') {
            tick.add('text', { name: 'scoreboard_objective', params: { name, action } });
            return;
        }
        // number_format and styling are not in the row: left out, which the client reads as the defaults (LOSSY)
        const displayText = p.text ? this._scoreText(p.text, ctx) : this._componentNbt(EMPTY);
        tick.add('text', { name: 'scoreboard_objective', params: { name, action, displayText, type: p.type ?? 0 } });
    },

    'TEXT score'(p, ctx, tick) {
        const itemName = ctx?.names?.[p.name];
        if (itemName === undefined) return this._reject('score for a name not in the table');
        const scoreName = p.index === null ? undefined : this._objectiveName(p.index);
        if (p.form === 'reset') {
            tick.add('text', { name: 'reset_score', params: { entity_name: itemName, objective_name: scoreName } });
            return;
        }
        const display_name = p.display ? this._scoreText(p.display, ctx) : undefined;
        tick.add('text', { name: 'scoreboard_score', params: { itemName, scoreName, value: p.value, display_name } });
    },

    'TEXT team'(p, ctx, tick) {
        const carried = TEAM_CARRIES[p.mode];
        const present = ['name', 'friendly', 'ntv', 'col', 'formatting', 'prefix', 'players'].filter((k) => p[k] !== undefined);
        const stray = present.find((k) => !carried.includes(k));
        if (stray) return this._reject(`team ${p.mode} with ${stray}`);
        const params = { team: this._teamName(p.index), mode: TEAM_MODE[p.mode] };
        if (p.mode === 'create' || p.mode === 'update') {
            // defaults for the fields a row leaves out: no colour, always visible, always collide
            Object.assign(params, {
                name: p.name ? this._scoreText(p.name, ctx) : this._componentNbt(EMPTY),
                friendlyFire: p.friendly ?? 0,
                nameTagVisibility: p.ntv ?? 'always',
                collisionRule: p.col ?? 'always',
                formatting: p.formatting ?? -1,
                prefix: p.prefix ? this._scoreText(p.prefix, ctx) : this._componentNbt(EMPTY),
                suffix: p.suffix ? this._scoreText(p.suffix, ctx) : this._componentNbt(EMPTY),
            });
        }
        if (carried.includes('players')) {
            const names = (p.players ?? []).map((k) => ctx?.names?.[k]);
            if (names.some((n) => n === undefined)) return this._reject('team member not in the name table');
            params.players = names;
        }
        tick.add('text', { name: 'teams', params });
    },
};

module.exports = { parse, compile, finish: [] };
