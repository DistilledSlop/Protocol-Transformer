'use strict';
// Per-state block facts for the reader: liquids, collision boxes, and a coarse class for net inputs.

const { minecraftData } = require('./deps');

// Index = category id. Keep in step with the table in category() below.
const CATEGORY_NAMES = [
    'air', 'solid_cube', 'partial_solid', 'liquid_water', 'liquid_lava', 'leaves', 'log_wood', 'plant',
    'redstone', 'ore', 'sand_gravel', 'ice_snow', 'container', 'glass', 'other_no_collision', 'other',
];

const AIR = new Set(['air', 'cave_air', 'void_air']);
const LIQUID = new Set(['water', 'lava', 'bubble_column']);
const REDSTONE = /^(redstone_wire|repeater|comparator|lever|redstone_lamp|redstone_torch|redstone_wall_torch|piston|sticky_piston|piston_head|moving_piston|observer|dispenser|dropper|hopper|target|note_block|tripwire|tripwire_hook|daylight_detector)$|_button$|^button$|_pressure_plate$/;
const CONTAINER = /^(chest|trapped_chest|ender_chest|barrel|furnace|blast_furnace|smoker|crafting_table|enchanting_table|jukebox|brewing_stand|composter|lectern|loom|smithing_table|stonecutter|grindstone|cartography_table|fletching_table|beacon)$|anvil$|cauldron$|_bed$|shulker_box$/;
const SAND = /^(red_)?sand$|^gravel$|_concrete_powder$/;
const ICE = /(^|_)ice$|^snow|^powder_snow$/;
const GLASS = /glass$|glass_pane$/;
// Thin collision but meant as "no collision" in the spec: ladders, vines, signs, banners, rails, torches.
const NO_COLLISION_NAMED = /^(ladder|vine|torch|wall_torch|soul_torch|soul_wall_torch)$|(^|_)(rail|sign|banner)$/;
// Plants may have a thin collision box (bamboo), so they are matched by name, not by collision.
// Anchored where a plain substring would also catch slabs, stairs or paths (bamboo_slab, grass_path).
const PLANT = /grass$|fern$|flower$|tulip$|orchid$|allium$|daisy$|dandelion$|poppy$|lily|rose|peony|lilac|sunflower|bluet|cornflower|torchflower|pitcher|mushroom$|sapling|propagule|seagrass|kelp|bush$|sugar_cane|^bamboo$|wheat|carrots|potatoes|beetroots|sweet_berry|sprouts|roots|azalea|fungus$|lichen|cocoa|chorus_flower|spore_blossom|dripleaf|sea_pickle/;

const EMPTY_BOXES = Object.freeze([]);

// True when the boxes cover the whole 0..1 cube. Samples 32^3 cell centres; the data's
// boundaries are multiples of 1/32 at most, so centres at odd/64 never sit on an edge.
function coversCube(boxes) {
    if (boxes.length === 0) return false;
    const n = 32;
    for (let x = 0; x < n; x++) {
        for (let y = 0; y < n; y++) {
            for (let z = 0; z < n; z++) {
                const cx = (x + 0.5) / n;
                const cy = (y + 0.5) / n;
                const cz = (z + 0.5) / n;
                const hit = boxes.some((b) => cx >= b[0] && cx <= b[3] && cy >= b[1] && cy <= b[4] && cz >= b[2] && cz <= b[5]);
                if (!hit) return false;
            }
        }
    }
    return true;
}

function createBlockInfo(version = '1.21.1') {
    const md = minecraftData(version);
    const shapeTable = md.blockCollisionShapes.shapes;
    const shapeByBlock = md.blockCollisionShapes.blocks;

    // Lazy per-state caches; Maps are keyed by state id.
    const nameCache = new Map();
    const propsCache = new Map();
    const boxCache = new Map();
    const topCache = new Map();
    const solidCache = new Map();
    const catCache = new Map();
    // Full-cube results are shared by every state that uses the same shape list.
    const coverCache = new WeakMap();

    function blockOf(state) {
        return Number.isInteger(state) ? md.blocksByStateId[state] : undefined;
    }

    // Shared shape list for a state, or EMPTY_BOXES. Shape ids are a number or an array indexed by state offset.
    function boxesFor(state) {
        let boxes = boxCache.get(state);
        if (boxes !== undefined) return boxes;
        const b = blockOf(state);
        boxes = EMPTY_BOXES;
        if (b) {
            const entry = shapeByBlock[b.name];
            const sid = Array.isArray(entry) ? entry[state - b.minStateId] : entry;
            if (sid !== undefined && shapeTable[sid]) boxes = shapeTable[sid];
        }
        boxCache.set(state, boxes);
        return boxes;
    }

    function propsOf(state) {
        let p = propsCache.get(state);
        if (p !== undefined) return p;
        const b = blockOf(state);
        p = {};
        if (b) {
            let off = state - b.minStateId;
            // same mixed-radix layout as reader/catalog.js: last property varies fastest
            const vals = new Array(b.states.length);
            for (let i = b.states.length - 1; i >= 0; i--) {
                const st = b.states[i];
                const idx = off % st.num_values;
                off = Math.floor(off / st.num_values);
                if (st.type === 'bool') vals[i] = idx === 0 ? 'true' : 'false';
                else if (st.values) vals[i] = st.values[idx];
                else vals[i] = String(idx);
            }
            b.states.forEach((st, i) => { p[st.name] = vals[i]; });
        }
        propsCache.set(state, p);
        return p;
    }

    function collisionTop(state) {
        let top = topCache.get(state);
        if (top !== undefined) return top;
        top = 0;
        for (const box of boxesFor(state)) top = Math.max(top, box[4]);
        topCache.set(state, top);
        return top;
    }

    function isSolid(state) {
        let v = solidCache.get(state);
        if (v !== undefined) return v;
        const boxes = boxesFor(state);
        let cover = coverCache.get(boxes);
        if (cover === undefined) {
            cover = coversCube(boxes);
            coverCache.set(boxes, cover);
        }
        v = cover;
        solidCache.set(state, v);
        return v;
    }

    // Order of checks decides the class; the first match wins.
    function computeCategory(state) {
        const b = blockOf(state);
        if (!b) return 15;
        const name = b.name;
        if (AIR.has(name)) return 0;
        if (name === 'water' || name === 'bubble_column') return 3;
        if (name === 'lava') return 4;
        if (name.endsWith('_leaves')) return 5;
        if (/_(log|wood|stem|hyphae)$/.test(name)) return 6;
        // before solid/partial so pistons, hoppers, chests and furnaces land here, not in 1 or 2
        if (REDSTONE.test(name)) return 8;
        if (CONTAINER.test(name)) return 12;
        if (name.endsWith('_ore')) return 9;
        if (SAND.test(name)) return 10;
        if (ICE.test(name)) return 11;
        if (GLASS.test(name)) return 13;
        if (isSolid(state)) return 1;
        if (NO_COLLISION_NAMED.test(name)) return 14;
        // flower_pot is a container for a plant, not a plant
        if (name !== 'flower_pot' && PLANT.test(name)) return 7;
        if (collisionTop(state) > 0) return 2;
        return 14;
    }

    function category(state) {
        let c = catCache.get(state);
        if (c !== undefined) return c;
        c = computeCategory(state);
        catCache.set(state, c);
        return c;
    }

    function blockName(state) {
        let n = nameCache.get(state);
        if (n !== undefined) return n;
        n = blockOf(state)?.name ?? 'unknown';
        nameCache.set(state, n);
        return n;
    }

    function parseState(state) {
        const name = blockName(state);
        return { name, props: name === 'unknown' ? {} : { ...propsOf(state) } };
    }

    // Only distance and persistent are invisible to the client, and only on leaves.
    const INVISIBLE_LEAF_PROPS = new Set(['distance', 'persistent']);
    function isInvisibleChange(oldState, newState) {
        if (oldState == null || newState == null || oldState === newState) return false;
        const a = blockOf(oldState);
        const b = blockOf(newState);
        if (!a || !b || a.name !== b.name || !a.name.endsWith('_leaves')) return false;
        const pa = propsOf(oldState);
        const pb = propsOf(newState);
        for (const key of Object.keys(pa)) {
            if (!INVISIBLE_LEAF_PROPS.has(key) && pa[key] !== pb[key]) return false;
        }
        return true;
    }

    return {
        md,
        category,
        isAir: (state) => category(state) === 0,
        isLiquid: (state) => LIQUID.has(blockName(state)),
        isSolid,
        collisionTop,
        collisionBoxes: (state) => boxesFor(state).map((box) => box.slice()),
        blockName,
        parseState,
        isInvisibleChange,
    };
}

module.exports = { createBlockInfo, CATEGORY_NAMES };
