'use strict';
// Names for the ids the reader turns into catalogue tokens (block states, items, entity types).

const { minecraftData } = require('./deps');

function createCatalog(version = '1.21.1') {
    const md = minecraftData(version);
    const blockCache = new Map();

    // "minecraft:oak_stairs[facing=east,half=bottom]" for a block state id.
    function blockState(stateId) {
        let s = blockCache.get(stateId);
        if (s !== undefined) return s;
        const b = md.blocksByStateId[stateId];
        if (!b) {
            s = `unknown_state_${stateId}`;
        } else {
            let off = stateId - b.minStateId;
            const props = [];
            // the last property varies fastest
            for (let i = b.states.length - 1; i >= 0; i--) {
                const st = b.states[i];
                const idx = off % st.num_values;
                off = Math.floor(off / st.num_values);
                const val = st.type === 'bool' ? (idx === 0 ? 'true' : 'false') : st.values ? st.values[idx] : String(idx);
                props.unshift(`${st.name}=${val}`);
            }
            s = props.length ? `${b.name}[${props.join(',')}]` : b.name;
        }
        blockCache.set(stateId, s);
        return s;
    }

    return {
        md,
        blockState,
        blockName: (id) => md.blocks[id]?.name ?? `unknown_block_${id}`,
        itemName: (id) => md.items[id]?.name ?? `unknown_item_${id}`,
        entityName: (id) => md.entities[id]?.name ?? `unknown_entity_${id}`,

        // Inverse of blockState: "name" or "name[prop=val,...]" to a numeric state id.
        blockStateId(str) {
            const m = /^(?:minecraft:)?([a-z0-9_]+)(?:\[([^\]]*)\])?$/.exec(str);
            if (!m) throw new Error(`bad block state string: ${str}`);
            const b = md.blocksByName[m[1]];
            if (!b) throw new Error(`unknown block: ${m[1]}`);
            // start from the default state's property indices; listed props override them
            let off = b.defaultState - b.minStateId;
            const idx = new Array(b.states.length);
            for (let i = b.states.length - 1; i >= 0; i--) {
                const n = b.states[i].num_values;
                idx[i] = off % n;
                off = Math.floor(off / n);
            }
            const pairs = m[2] ? m[2].split(',') : [];
            for (const pair of pairs) {
                const parts = pair.split('=');
                if (parts.length !== 2) throw new Error(`bad property "${pair}" in ${str}`);
                const [key, val] = parts;
                const i = b.states.findIndex((st) => st.name === key);
                if (i < 0) throw new Error(`unknown property "${key}" for block ${b.name}`);
                const st = b.states[i];
                let k;
                if (st.type === 'bool') {
                    // same mapping as blockState: index 0 is 'true'
                    k = val === 'true' ? 0 : val === 'false' ? 1 : -1;
                } else if (st.values) {
                    k = st.values.indexOf(val);
                } else {
                    // int-like properties are written as their index
                    k = /^\d+$/.test(val) ? Number(val) : -1;
                    if (k >= st.num_values) k = -1;
                }
                if (k < 0) throw new Error(`unknown value "${val}" for ${b.name}[${key}]`);
                idx[i] = k;
            }
            // last property varies fastest, so it has multiplier 1
            let id = b.minStateId;
            let mul = 1;
            for (let i = b.states.length - 1; i >= 0; i--) {
                id += idx[i] * mul;
                mul *= b.states[i].num_values;
            }
            return id;
        },

        itemId(name) {
            const it = md.itemsByName[name];
            // 'empty' is a slot marker, not an item; callers must handle empty slots themselves
            if (!it || name === 'empty') throw new Error(`unknown item: ${name}`);
            return it.id;
        },

        entityTypeId(name) {
            const e = md.entitiesByName[name];
            if (!e) throw new Error(`unknown entity type: ${name}`);
            return e.id;
        },

        blockId(name) {
            const b = md.blocksByName[name];
            if (!b) throw new Error(`unknown block: ${name}`);
            return b.id;
        },
    };
}

module.exports = { createCatalog };
