'use strict';
// Chat, titles, the action bar, death messages and the tab list. The text itself is rebuilt by textutil
// (_readComponent); what is left here is the channel's own shape.
//
// Parse functions have no Writer, so they only split the row: a text body is kept as tokens and read in
// compile, where the name table (ctx.names) is available.

const { Cursor } = require('../parse_rows');

// everything left in the row, unread
const rest = (c) => {
    const out = [];
    while (!c.eof()) out.push(c.next());
    return out;
};
const body = (c) => ({ body: rest(c) });

// read n components from a body, in order; anything left over means the row is malformed
function components(w, tokens, ctx, n) {
    const c = new Cursor(tokens);
    const out = [];
    for (let i = 0; i < n; i++) out.push(w._readComponent(c, ctx));
    if (!c.eof()) throw new Error(`trailing text tokens: ${c.rest().join(' ')}`);
    return out;
}

// tab rows: the player list header and footer, or one player's info update (the 'pl<idx>' form)
function tabParse(c) {
    if (c.peek() === 'header') {
        c.next();
        return { form: 'header', ...body(c) };
    }
    const out = { form: 'player', idx: c.int('pl') };
    while (!c.eof()) {
        const t = c.peek();
        if (t === 'add') {
            c.next();
            const m = /^nm(\d+)$/.exec(c.next() ?? '');
            if (!m) throw new Error('tab add without a name token');
            out.add = Number(m[1]);
        } else if (t.startsWith('gm')) out.gm = c.int('gm');
        else if (t === 'listed' || t === 'unlisted') {
            c.next();
            out.listed = t === 'listed';
        } else if (t.startsWith('lat')) out.lat = c.int('lat');
        else if (t === 'dn:none') {
            c.next();
            out.dn = true;
        } else if (t.startsWith('tpl:') || t.startsWith('tr:')) {
            // the reader keeps only the first token of a display name, so its text cannot be restored
            throw new Error('tab display name not restored (LOSSY)');
        } else throw new Error(`unexpected tab token ${t}`);
    }
    return out;
}

const parse = {
    'TEXT chat': body,
    'TEXT actionbar': body,
    'TEXT chatfrom': body,
    'TEXT subtitle': body,
    'TEXT death': body,
    'TEXT title': (c) => (c.peek() === 'reset' || c.peek() === 'clear' ? { clear: true, reset: c.next() === 'reset' } : body(c)),
    'TEXT titletimes': (c) => ({ fadeIn: c.int('in'), stay: c.int('st'), fadeOut: c.int('out') }),
    'TEXT tab': tabParse,
};

// Own UUID per player-list index. Not the real one: the row does not carry it.
function playerUuid(w, idx) {
    if (!w.playerUuids) w.playerUuids = new Map();
    let u = w.playerUuids.get(idx);
    if (u === undefined) {
        u = `00000000-0000-4000-9000-${(idx + 1).toString(16).padStart(12, '0')}`;
        w.playerUuids.set(idx, u);
    }
    return u;
}

function playerInfo(w, p, ctx, tick) {
    const action = {};
    const entry = { uuid: playerUuid(w, p.idx) };
    if (p.add !== undefined) {
        const name = ctx.names?.[p.add];
        if (name === undefined) throw new Error('tab add with an unknown name');
        action.add_player = true;
        entry.player = { name, properties: [] };
    }
    if (p.gm !== undefined) {
        action.update_game_mode = true;
        entry.gamemode = p.gm;
    }
    if (p.listed !== undefined) {
        action.update_listed = true;
        entry.listed = p.listed;
    }
    if (p.lat !== undefined) {
        action.update_latency = true;
        entry.latency = p.lat * 10; // the row keeps latency in 10 ms steps
    }
    if (p.dn) action.update_display_name = true; // no display name: the row said dn:none
    tick.add('text', { name: 'player_info', params: { action, data: [entry] } });
}

const compile = {
    'TEXT chat'(p, ctx, tick) {
        const [content] = components(this, p.body, ctx, 1);
        tick.add('text', { name: 'system_chat', params: { content, isActionBar: false } });
    },

    'TEXT actionbar'(p, ctx, tick) {
        const [text] = components(this, p.body, ctx, 1);
        tick.add('text', { name: 'action_bar', params: { text } });
    },

    // the name comes first; the chat type and any target are not in the row, so they are not sent
    'TEXT chatfrom'(p, ctx, tick) {
        // a separator token sits between the sender and the message, since a translatable name's arguments look like more groups
        const c = new Cursor(p.body);
        const name = this._readComponent(c, ctx);
        c.expect('msg');
        const message = this._readComponent(c, ctx);
        if (!c.eof()) throw new Error(`trailing text tokens: ${c.rest().join(' ')}`);
        tick.add('text', { name: 'profileless_chat', params: { message, type: { chatType: 0 }, name } });
    },

    'TEXT title'(p, ctx, tick) {
        if (p.clear) return tick.add('text', { name: 'clear_titles', params: { reset: p.reset } });
        const [text] = components(this, p.body, ctx, 1);
        tick.add('text', { name: 'set_title_text', params: { text } });
    },

    'TEXT subtitle'(p, ctx, tick) {
        const [text] = components(this, p.body, ctx, 1);
        tick.add('text', { name: 'set_title_subtitle', params: { text } });
    },

    'TEXT titletimes'(p, ctx, tick) {
        tick.add('text', { name: 'set_title_time', params: { fadeIn: p.fadeIn, stay: p.stay, fadeOut: p.fadeOut } });
    },

    // the row does not say who died: the engine's player is the only one it names
    'TEXT death'(p, ctx, tick) {
        const [message] = components(this, p.body, ctx, 1);
        tick.add('text', { name: 'death_combat_event', params: { playerId: ctx.playerId, message } });
    },

    'TEXT tab'(p, ctx, tick) {
        if (p.form === 'player') return playerInfo(this, p, ctx, tick);
        const c = new Cursor(p.body);
        const header = this._readComponent(c, ctx);
        c.expect('footer');
        const footer = this._readComponent(c, ctx);
        if (!c.eof()) throw new Error(`trailing tab tokens: ${c.rest().join(' ')}`);
        tick.add('text', { name: 'playerlist_header', params: { header, footer } });
    },
};

module.exports = { parse, compile, finish: [] };
