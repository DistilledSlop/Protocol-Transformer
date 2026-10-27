'use strict';
// Keeps an entity out of solid blocks. The model moves mobs by deltas without seeing the terrain, so the engine, which
// holds the world, stops a move at the first collision box in its way (the way the game does: up and down first, then
// along the longer of the two horizontal axes, then the other). Entities that start inside a block are not stopped by it,
// so one the model placed badly can still walk out.

const EPS = 1e-7;
const MAX_STEP = 4; // blocks: a move this long is a teleport, not walking

function dimensions(md, type) {
    const e = md.entitiesByName[type];
    return { w: e?.width ?? 0.6, h: e?.height ?? 1.8 };
}

// Collision boxes (world coordinates) of the blocks a box moving by d could touch, minus the ones it already overlaps.
function colliders(world, info, box, d) {
    const lo = [0, 1, 2].map((a) => Math.floor(Math.min(box[a], box[a] + d[a]) - EPS));
    const hi = [0, 1, 2].map((a) => Math.floor(Math.max(box[a + 3], box[a + 3] + d[a]) + EPS));
    const out = [];
    for (let x = lo[0]; x <= hi[0]; x++) {
        for (let y = lo[1]; y <= hi[1]; y++) {
            for (let z = lo[2]; z <= hi[2]; z++) {
                const st = world.get(x, y, z);
                if (st === undefined) continue;
                for (const b of info.collisionBoxes(st)) {
                    const w = [x + b[0], y + b[1], z + b[2], x + b[3], y + b[4], z + b[5]];
                    const inside = [0, 1, 2].every((a) => w[a] < box[a + 3] - EPS && w[a + 3] > box[a] + EPS);
                    if (!inside) out.push(w);
                }
            }
        }
    }
    return out;
}

// pos: feet centre [x,y,z]; d: the move in blocks. Returns the move after collisions.
function resolve(world, info, dims, pos, d) {
    if (d[0] === 0 && d[1] === 0 && d[2] === 0) return d;
    if (Math.max(Math.abs(d[0]), Math.abs(d[1]), Math.abs(d[2])) > MAX_STEP) return d;
    const hw = dims.w / 2;
    const box = [pos[0] - hw, pos[1], pos[2] - hw, pos[0] + hw, pos[1] + dims.h, pos[2] + hw];
    const solids = colliders(world, info, box, d);
    if (!solids.length) return d;
    const out = [d[0], d[1], d[2]];
    const order = Math.abs(d[0]) >= Math.abs(d[2]) ? [1, 0, 2] : [1, 2, 0];
    for (const a of order) {
        const o1 = (a + 1) % 3;
        const o2 = (a + 2) % 3;
        let v = out[a];
        for (const w of solids) {
            // only boxes the entity overlaps on the other two axes are in its way
            if (!(w[o1] < box[o1 + 3] - EPS && w[o1 + 3] > box[o1] + EPS && w[o2] < box[o2 + 3] - EPS && w[o2 + 3] > box[o2] + EPS)) continue;
            if (v > 0 && w[a] >= box[a + 3] - EPS) v = Math.min(v, w[a] - box[a + 3]);
            else if (v < 0 && w[a + 3] <= box[a] + EPS) v = Math.max(v, w[a + 3] - box[a]);
        }
        out[a] = v;
        box[a] += v;
        box[a + 3] += v;
    }
    return out;
}

module.exports = { resolve, dimensions };
