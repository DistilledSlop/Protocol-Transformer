'use strict';
// The frozen token vocabulary: what the model's embedding table is indexed by.
//
// Two kinds of token. Structural ones come from a fixed grammar, so they are listed in full whatever the data
// held: specials, row types, slots, number buckets, angles, position lattice, digits. Catalogue ones (block
// states, items, entity types, sounds, templates, metadata keys) come from the training data, most frequent
// first; anything not in the table encodes as <unk>, as the design says unseen content should.

const SPECIALS = ['<pad>', '<unk>', '<bos>', '<eos>', 'TICK', 'END', 'IN', 'OUT', 'ENG'];
const ROW_TYPES = ['ENTITY', 'BLOCK', 'SLOT', 'EVENT', 'TEXT', 'GLOBAL'];
const IO = { in: 'IN', out: 'OUT', eng: 'ENG' };

// structural tokens a row can contain, enumerated from the grammar of the token builders
function structural() {
    const t = [];
    const range = (prefix, a, b) => {
        for (let i = a; i <= b; i++) t.push(`${prefix}${i}`);
    };
    range('s', 0, 63); // slot tokens
    range('t', 0, 63); // target slots
    range('own', 0, 63);
    t.push('tUNKNOWN', 'ownNONE', 'ownUNKNOWN', 'none');
    t.push('0'); // zero movement
    for (const sign of ['+', '-']) range(`${sign}c`, 0, 31); // coarse log groups
    range('f', 0, 15); // fine steps
    range('yaw', 0, 255);
    range('pitch', 0, 255);
    range('hy', 0, 255);
    range('ob', -64, 63); // whole-block offset of a position
    range('of', 0, 15); // sixteenth within it
    for (const a of ['bx', 'by', 'bz']) range(a, -6, 6); // block offsets
    t.push('bFAR');
    range('d', 0, 9); // digits of numbers that do not fit one token
    t.push('neg', ';');
    range('bit', 0, 7);
    t.push('bits0', 'true', 'false');
    // field tags of the number tokens
    t.push('dx', 'dy', 'dz', 'vx', 'vy', 'vz', 'px', 'py', 'pz', 'ox', 'oy', 'oz');
    // small integers: the one-token form of intTokens for each prefix the builders use
    for (const p of ['w', 'i', 'n', 'v', 'st', 'dmg', 'a', 'k', 'um', 'u', 'o', 'pl', 'lat', 'b', 'h', 'col', 'div', 'pos', 'ty', 'fmt', 'np', 'argc', 'len', 'dig', 'fc', 'we', 'stage', 'xp', 'bet', 'eff', 'gm', 'ori', 'pi', 'mode', 'btn', 'c', 'in', 'out']) {
        range(p, 0, 255);
        t.push(`${p}=`);
    }
    return t;
}

// counts: Map token -> frequency. Returns {tokens: [...], index: Map}
function build(counts, { minCount = 1, maxSize = 60000 } = {}) {
    const fixed = [...SPECIALS, ...ROW_TYPES, ...structural()];
    const seen = new Set(fixed);
    const learned = [...counts]
        .filter(([tok, n]) => n >= minCount && !seen.has(tok))
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, Math.max(0, maxSize - fixed.length))
        .map(([tok]) => tok);
    const tokens = [...fixed, ...learned];
    return { tokens, structural: fixed.length };
}

function load(obj) {
    const index = new Map(obj.tokens.map((t, i) => [t, i]));
    return { tokens: obj.tokens, index, unk: index.get('<unk>'), pad: index.get('<pad>') };
}

// -> ids ; unknown tokens map to <unk> and are counted in stats.unk
function encode(tokens, vocab, stats) {
    return tokens.map((t) => {
        const i = vocab.index.get(t);
        if (i === undefined) {
            if (stats) stats.unk.set(t, (stats.unk.get(t) || 0) + 1);
            return vocab.unk;
        }
        return i;
    });
}

module.exports = { build, load, encode, structural, SPECIALS, ROW_TYPES, IO };
