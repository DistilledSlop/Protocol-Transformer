'use strict';
// Helper methods a family wants on the Writer (they need `this`, so they cannot be plain functions in the family's
// compile table). Families call add() while they load; the Writer picks them up when its class is defined.

const methods = {};
module.exports = {
    add(m) {
        Object.assign(methods, m);
    },
    methods,
};
