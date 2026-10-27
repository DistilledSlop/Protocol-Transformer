'use strict';
// Reads a proxy capture: <base>.jsonl (index + markers) and <base>.bin (concatenated raw packets).

const fs = require('fs');

function loadCapture(base) {
    const bin = fs.readFileSync(base + '.bin');
    const lines = fs.readFileSync(base + '.jsonl', 'utf8').split('\n').filter(Boolean);
    const header = {};
    const markers = [];
    const packets = [];
    for (const l of lines) {
        const o = JSON.parse(l);
        if (o.kind === 'header') Object.assign(header, o);
        else if (o.kind === 'state') markers.push(o);
        else packets.push(o);
    }
    return { base, bin, header, markers, packets };
}

// Packets in arrival order, with state markers interleaved as {kind:'state', ...}.
// Markers and packets are both stamped with t, so merge on t; a marker sorts before a packet with the same t.
function* events(cap) {
    let m = 0;
    for (const p of cap.packets) {
        while (m < cap.markers.length && cap.markers[m].t <= p.t) yield cap.markers[m++];
        yield { ...p, buf: cap.bin.subarray(p.off, p.off + p.len) };
    }
    while (m < cap.markers.length) yield cap.markers[m++];
}

module.exports = { loadCapture, events };
