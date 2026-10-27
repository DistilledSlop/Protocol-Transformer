'use strict';
// World rows: the BLOCK rows of changes, the NEAR context rows, the ground grid and the terrain patch. The world is a flat
// floor of stone at y=63 in chunk 0,0, injected straight into the store (no chunk packet), and the player stands at
// (8.5, 64, 8.5) unless a test says otherwise. Ticks are 50 ms with phase 0, so tick n covers t in [50n, 50n+50).

const test = require('node:test');
const assert = require('node:assert/strict');
const { Reader } = require('../reader');
const { NO_FLAGS, pkt } = require('./helpers');

const T = (n) => n * 50;
const rowsOf = (ticks, n) => ticks.filter((t) => t.tick === n).flatMap((t) => t.rows);
const feed = (ticks, r, p) => ticks.push(...r.feedPacket(p));
const until = (r, ticks, n) => ticks.push(...r.advanceTo(T(n))); // closes every tick before tick n
const blockChange = (t, x, y, z, type) => pkt(t, 'S2C', 'block_change', { location: { x, y, z }, type });
const position = (t, x, z) => pkt(t, 'S2C', 'position', { x, y: 64, z, yaw: 0, pitch: 0, flags: NO_FLAGS, teleportId: 1 });
const dig = (t, x, y, z, status = 0) => pkt(t, 'C2S', 'block_dig', { status, location: { x, y, z }, face: 1, sequence: 1 });
const place = (t, x, y, z) =>
    pkt(t, 'C2S', 'block_place', { hand: 0, location: { x, y, z }, direction: 1, cursorX: 0.5, cursorY: 0.5, cursorZ: 0.5, insideBlock: false, sequence: 1 });

// A reader with the flat floor loaded and the player placed at tick 1 (t=50). Login comes first: it clears the world.
function build(opts = {}, at = { x: 8.5, z: 8.5 }) {
    const r = new Reader({ phase: 0, ...opts });
    const ticks = [];
    feed(ticks, r, pkt(0, 'S2C', 'login', { entityId: 1, viewDistance: 10 }));
    r.S.world.chunks.set('0,0', { minY: -64, sections: Array.from({ length: 24 }, () => ({ single: 0 })) });
    const stone = r.cat.md.blocksByName.stone.defaultState;
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) r.S.world.set(x, 63, z, stone);
    feed(ticks, r, position(T(1), at.x, at.z));
    return { r, ticks, stone, air: r.cat.md.blocksByName.air.defaultState };
}

// the ground row's tokens for a player at (px, pz) on the flat floor: 7x7 columns, 3 apart, th-1 inside chunk 0,0 and thv outside
function groundTokens(px, pz) {
    const fx = Math.floor(px);
    const fz = Math.floor(pz);
    const out = [];
    for (let i = -3; i <= 3; i++) {
        for (let k = -3; k <= 3; k++) {
            const x = fx + i * 3;
            const z = fz + k * 3;
            out.push(x >= 0 && x <= 15 && z >= 0 && z <= 15 ? 'th-1' : 'thv');
        }
    }
    return ['GLOBAL', 'g:ground', ...out];
}

const isGround = (row) => row.kind === 'ground';
const isNear = (row) => row.kind === 'NEAR';

test('leaf rule: a distance-only change of oak_leaves gives no out BLOCK row; leaves to air does', () => {
    const { r, ticks, air } = build();
    const leaves = (distance) => {
        const b = r.cat.md.blocksByName.oak_leaves;
        for (let s = b.minStateId; s <= b.maxStateId; s++) {
            const p = r.info.parseState(s).props;
            if (p.distance === distance && p.persistent === 'false' && p.waterlogged === 'false') return s;
        }
        throw new Error(`no oak_leaves distance=${distance}`);
    };
    const L1 = leaves('1');
    const L2 = leaves('2');
    assert.notEqual(L1, L2);
    assert.equal(r.info.isInvisibleChange(L1, L2), true, 'sanity: the two states differ only in distance');

    feed(ticks, r, blockChange(T(2) + 10, 12, 64, 8, L1)); // tick 2: air to leaves
    feed(ticks, r, blockChange(T(3) + 10, 12, 64, 8, L2)); // tick 3: distance only
    feed(ticks, r, blockChange(T(4) + 10, 12, 64, 8, air)); // tick 4: leaves to air
    until(r, ticks, 5);

    const outBlocks = (n) => rowsOf(ticks, n).filter((x) => x.row === 'BLOCK' && x.io === 'out');
    assert.equal(outBlocks(2).length, 1, 'placing leaves is a visible change');
    assert.equal(outBlocks(3).length, 0, 'a distance-only change is not a row');
    const gone = outBlocks(4);
    assert.equal(gone.length, 1);
    assert.deepEqual(gone[0].tokens, ['BLOCK', 'bx4', 'by0', 'bz0', 'blk:air']);
});

test('NEAR rows after a change come one tick late by default, with the centre first and six neighbours in order', () => {
    const { r, ticks, stone } = build();
    feed(ticks, r, blockChange(T(2) + 10, 9, 64, 8, stone)); // tick 2
    until(r, ticks, 4);

    const t2 = rowsOf(ticks, 2);
    assert.equal(t2.filter((x) => x.row === 'BLOCK' && x.io === 'out').length, 1, 'the change itself is out in tick 2');
    assert.equal(t2.filter(isNear).length, 0, 'no NEAR row in the tick of the change');

    const near = rowsOf(ticks, 3).filter((x) => x.row === 'BLOCK' && x.io === 'eng');
    assert.equal(near.length, 1, 'exactly one NEAR row in the next tick');
    assert.equal(near[0].kind, 'NEAR');
    // centre (9,64,8) stone; up air; down the floor (stone); north (-z) air; south (+z) air; east (+x) air; west (-x) air
    assert.deepEqual(near[0].tokens, [
        'BLOCK', 'bx1', 'by0', 'bz0', 'NEAR',
        'nb:stone', 'nb:air', 'nb:stone', 'nb:air', 'nb:air', 'nb:air', 'nb:air',
    ]);
});

test('deferNear: false puts the NEAR row in the same tick as the change', () => {
    const { r, ticks, stone } = build({ deferNear: false });
    feed(ticks, r, blockChange(T(2) + 10, 9, 64, 8, stone));
    until(r, ticks, 4);

    const t2 = rowsOf(ticks, 2).filter((x) => x.row === 'BLOCK' && x.io === 'eng');
    assert.equal(t2.length, 1);
    assert.deepEqual(t2[0].tokens.slice(0, 5), ['BLOCK', 'bx1', 'by0', 'bz0', 'NEAR']);
    assert.equal(rowsOf(ticks, 3).filter(isNear).length, 0);
});

test('NEAR rows for the player: a dig and a place give one each in the same tick, a cancelled dig none', () => {
    const { r, ticks, stone, air } = build();
    r.S.world.set(9, 64, 8, stone); // the block the player digs is stone (set in the store, no packet)
    feed(ticks, r, dig(T(2) + 5, 9, 64, 8, 0)); // start digging stone at (9,64,8)
    feed(ticks, r, blockChange(T(2) + 20, 9, 64, 8, air)); // the server then breaks it, later in the same tick
    feed(ticks, r, place(T(3) + 5, 10, 64, 8)); // a place against (10,64,8)
    feed(ticks, r, dig(T(4) + 5, 11, 64, 8, 1)); // cancelled: no row
    feed(ticks, r, dig(T(5) + 5, 11, 64, 8, 0)); // a dig that is not cancelled
    until(r, ticks, 6);

    const near = (n) => rowsOf(ticks, n).filter((x) => x.row === 'BLOCK' && x.io === 'eng' && x.kind === 'NEAR');
    const t2 = near(2);
    assert.equal(t2.length, 1, 'the dig gives one NEAR row in its own tick');
    assert.equal(t2[0].tokens[5], 'nb:stone', 'computed when the dig arrived: the centre is still stone');
    // tick 3: the place's own row (10,64,8) and the deferred row of tick 2's change to air at (9,64,8)
    assert.deepEqual(near(3).map((x) => x.tokens[1]).sort(), ['bx1', 'bx2'], 'the place gives its NEAR row in its own tick, with the deferred one');
    assert.equal(near(4).length, 0, 'a cancelled dig gives none');
    assert.equal(near(5).length, 1, 'an ordinary dig gives one again');
});

test('NEAR rows for the player: a dig or place farther than 6 blocks gives none', () => {
    const { r, ticks, stone } = build();
    feed(ticks, r, dig(T(2) + 5, 15, 64, 8, 0)); // 7 blocks east of the feet block
    feed(ticks, r, place(T(2) + 6, 8, 64, 15)); // 7 blocks south
    feed(ticks, r, dig(T(3) + 5, 14, 64, 8, 0)); // 6 blocks: in range, one row
    until(r, ticks, 4);

    const near = (n) => rowsOf(ticks, n).filter((x) => x.row === 'BLOCK' && x.io === 'eng' && x.kind === 'NEAR');
    assert.equal(near(2).length, 0);
    assert.equal(near(3).length, 1);
});

test('NEAR rows are capped at 6 per tick', () => {
    const { r, ticks } = build();
    const spots = [[9, 64, 8], [10, 64, 8], [11, 64, 8], [12, 64, 8], [13, 64, 8], [14, 64, 8], [8, 64, 9], [8, 64, 10]];
    for (const [x, y, z] of spots) feed(ticks, r, dig(T(2) + 5, x, y, z, 0));
    until(r, ticks, 3);

    const near = rowsOf(ticks, 2).filter((x) => x.row === 'BLOCK' && x.kind === 'NEAR');
    assert.equal(near.length, 6);
});

test('ground grid: sent one tick after the position is known, then only again after 40 ticks', () => {
    const { r, ticks } = build();
    until(r, ticks, 46);

    const withGround = [];
    for (let n = 0; n < 46; n++) if (rowsOf(ticks, n).some(isGround)) withGround.push(n);
    assert.deepEqual(withGround, [2, 42], 'grid computed at the close of tick 1 goes out in tick 2; next one 40 ticks later');

    const row = rowsOf(ticks, 2).find(isGround);
    assert.equal(row.io, 'eng');
    assert.equal(row.tokens.length, 51);
    assert.deepEqual(row.tokens, groundTokens(8.5, 8.5));
    assert.equal(row.tokens.filter((t) => t === 'th-1').length, 25, 'five columns each way over the floor');
    assert.equal(row.tokens.filter((t) => t === 'thv').length, 24, 'the rest are outside chunk 0,0');
});

test('ground grid: a move of 5 blocks sends a fresh grid; a move of 2 does not', () => {
    // 5 blocks east
    const far = build();
    until(far.r, far.ticks, 3);
    feed(far.ticks, far.r, position(T(10) + 10, 13.5, 8.5));
    until(far.r, far.ticks, 13);
    const farGround = [];
    for (let n = 0; n < 13; n++) if (rowsOf(far.ticks, n).some(isGround)) farGround.push(n);
    assert.deepEqual(farGround, [2, 11]);
    assert.deepEqual(rowsOf(far.ticks, 11).find(isGround).tokens, groundTokens(13.5, 8.5));

    // 2 blocks east
    const near = build();
    until(near.r, near.ticks, 3);
    feed(near.ticks, near.r, position(T(10) + 10, 10.5, 8.5));
    until(near.r, near.ticks, 13);
    const nearGround = [];
    for (let n = 0; n < 13; n++) if (rowsOf(near.ticks, n).some(isGround)) nearGround.push(n);
    assert.deepEqual(nearGround, [2]);
});

test('terrain patch: a patch on every 4th tick, from the world at the end of the tick before it', () => {
    const { r, ticks, stone } = build({ terrain: true });
    feed(ticks, r, blockChange(T(4) + 10, 9, 64, 8, stone)); // placed during tick 4: patch 4 does not see it
    until(r, ticks, 9);

    const out = (n) => ticks.find((t) => t.tick === n);
    for (const n of [4, 8]) {
        assert.ok(out(n).terrain instanceof Uint8Array, `tick ${n} has a patch`);
        assert.equal(out(n).terrain.length, 2197);
    }
    for (const n of [1, 2, 3, 5, 6, 7]) assert.equal(out(n).terrain, undefined, `tick ${n} has no patch`);

    const cell = (patch, dx, dy, dz) => patch[((dy + 6) * 13 + (dz + 6)) * 13 + (dx + 6)];
    assert.equal(cell(out(4).terrain, 1, 0, 0), 0, 'tick 4 patch: the block placed in tick 4 is not there yet');
    assert.equal(cell(out(8).terrain, 1, 0, 0), r.info.category(stone), 'tick 8 patch: the block placed in tick 4 is there');
});

test('terrain patch: the cell under the feet is stone, the feet cell is air, outside the chunks is 16', () => {
    const { r, ticks } = build({ terrain: true });
    until(r, ticks, 5);
    const patch = ticks.find((t) => t.tick === 4).terrain;
    const cell = (dx, dy, dz) => patch[((dy + 6) * 13 + (dz + 6)) * 13 + (dx + 6)];
    assert.equal(cell(0, -1, 0), r.info.category(r.cat.md.blocksByName.stone.defaultState));
    assert.equal(cell(0, 0, 0), 0, 'feet cell is air');
    assert.equal(r.info.category(r.cat.md.blocksByName.stone.defaultState), 1, 'sanity: stone is solid_cube');
});

test('terrain patch: cells outside the loaded chunks are 16', () => {
    // feet block x=2: dx -6..-3 reach x=-4..-1, outside chunk 0,0; dx=-2 is x=0, inside
    const { r, ticks } = build({ terrain: true }, { x: 2.5, z: 8.5 });
    until(r, ticks, 5);
    const patch = ticks.find((t) => t.tick === 4).terrain;
    const cell = (dx, dy, dz) => patch[((dy + 6) * 13 + (dz + 6)) * 13 + (dx + 6)];
    assert.equal(cell(-3, -1, 0), 16);
    assert.equal(cell(-6, 0, 0), 16);
    assert.equal(cell(-2, -1, 0), 1, 'x=0 is inside the chunk: the stone floor');
});
