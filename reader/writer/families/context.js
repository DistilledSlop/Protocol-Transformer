'use strict';
// Rows that only tell the model what the world looks like (neighbors of a changed block, the ground around the
// player, the time of day). The engine makes them from its world store; they are never packets, so a model that writes one is
// harmless: it is read and ignored.

const rest = (c) => {
    const out = [];
    while (!c.eof()) out.push(c.next());
    return out;
};

const none = () => {};

module.exports = {
    parse: { 'BLOCK NEAR': (c) => ({ near: rest(c) }), 'GLOBAL ground': (c) => ({ heights: rest(c) }), 'GLOBAL clock': (c) => ({ clock: rest(c) }),
        'GLOBAL abilities': (c) => ({ abilities: rest(c) }), 'GLOBAL op_level': (c) => ({ level: rest(c) }) },
    compile: { 'BLOCK NEAR': none, 'GLOBAL ground': none, 'GLOBAL clock': none, 'GLOBAL abilities': none, 'GLOBAL op_level': none },
    finish: [],
};
