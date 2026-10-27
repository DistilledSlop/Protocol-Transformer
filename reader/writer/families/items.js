'use strict';
// Shared by every family that sends an item: rebuild a Slot from the tokens' item name, count and blob id.

const methods = {
    // item: name or 'empty'; blob: the id of stored components, or null. ctx.blobs is the reader's blob store.
    // Returns a Slot as minecraft-protocol writes it, or null if the item is unknown (the caller rejects).
    _item(item, count, blob, ctx) {
        if (item === 'empty' || count === 0) return { itemCount: 0 };
        let itemId;
        try {
            itemId = this.cat.itemId(item);
        } catch (e) {
            return null;
        }
        let components = [];
        let removeComponents = [];
        if (blob) {
            const b = ctx?.blobs?.get(blob);
            if (b?.kind === 'item_components') ({ components = [], removeComponents = [] } = b.value);
            else this._reject('item components not restored (blob not in the store)');
        }
        return { itemCount: count, itemId, addedComponentCount: components.length, removedComponentCount: removeComponents.length, components, removeComponents };
    },
};
require('../writer_methods').add(methods);

module.exports = { parse: {}, compile: {}, finish: [] };
