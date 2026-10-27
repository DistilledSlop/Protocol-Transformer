'use strict';
// Rebuilding text from tokens, shared by every family that sends a text component (chat, titles, scoreboard,
// metadata). This is the inverse of the reader's _textTokens / _compTokens:
//   plain text      tpl:<template> then one value token per placeholder, in order ({n} -> v<digits>, {p} -> nm<index>)
//   translatable    tr:<key> a<n> then n arguments, each a plain group or a translatable of its own (older rows: tr:<key> and tpl: groups)
// Styling (colour, bold, click and hover events) is not in the tokens, so a rebuilt component is unstyled.

const path = require('path');
const nbt = require(path.join(__dirname, '..', '..', '..', 'proxy', 'node_modules', 'prismarine-nbt'));

const methods = {
    // Fill one template group from the cursor. ctx.names is the reader's player-name table.
    _readTemplate(c, ctx) {
        const t = c.next();
        if (!t.startsWith('tpl:')) throw new Error(`expected tpl:<text>, got ${t}`);
        return fillTemplate(t.slice(4), c, ctx);
    },

    // -> a node: {text} for a template group, {translate, args: [node]} for `tr:<key> a<n>` and its n arguments (each a node)
    _readText(c, ctx, depth = 0) {
        if (!c.eof() && c.peek().startsWith('tr:')) {
            if (depth > 4) throw new Error('text nested too deep');
            const key = c.next().slice(3);
            const args = [];
            if (!c.eof() && /^a\d+$/.test(c.peek())) {
                const n = c.int('a');
                if (n > 8) throw new Error(`too many text arguments: ${n}`);
                for (let i = 0; i < n; i++) args.push(this._readText(c, ctx, depth + 1));
            } else {
                // rows written before arguments were counted: plain template groups to the end
                while (!c.eof() && c.peek().startsWith('tpl:')) args.push({ text: this._readTemplate(c, ctx) });
            }
            return { translate: key, args };
        }
        return { text: this._readTemplate(c, ctx) };
    },

    // -> an anonymous NBT text component, as the 1.21.1 chat packets carry it
    _componentNbt(text) {
        if (text.translate !== undefined) {
            const withArgs = text.args.length ? { with: nbt.list(nbt.comp(text.args.map((a) => this._componentNbt(a).value))) } : {};
            return nbt.comp({ translate: nbt.string(text.translate), ...withArgs });
        }
        return nbt.comp({ text: nbt.string(text.text) });
    },

    // read a group of tokens and return the NBT component
    _readComponent(c, ctx) {
        return this._componentNbt(this._readText(c, ctx));
    },
};

function fillTemplate(tpl, c, ctx) {
    let out = '';
    for (let i = 0; i < tpl.length; i++) {
        if (tpl.startsWith('{n}', i)) {
            out += String(c.int('v'));
            i += 2;
        } else if (tpl.startsWith('{p}', i)) {
            const m = /^nm(\d+)$/.exec(c.next());
            if (!m) throw new Error('expected a name token');
            out += ctx?.names?.[Number(m[1])] ?? '?';
            i += 2;
        } else out += tpl[i];
    }
    return out;
}
require('../writer_methods').add(methods);

module.exports = { parse: {}, compile: {}, finish: [] };
