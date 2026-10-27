'use strict';
// Tick phase. The server sends a tick's entity packets as one burst, so the burst peak is the middle of
// a tick, not its edge: putting the boundary at the peak cuts every burst in half. The boundary goes half
// a tick away, in the quiet gap. Tick = floor((t - phase) / 50) with phase = peak + 25 ms (mod 50).

const TICK_NAMES = new Set(['rel_entity_move', 'entity_move_look', 'entity_look', 'entity_teleport', 'entity_head_rotation', 'entity_velocity']);

// times: arrival times (ms) of server entity packets
function phaseFromTimes(times, tickMs = 50) {
    const BINS = tickMs * 2; // 0.5 ms bins
    const hist = new Array(BINS).fill(0);
    const n = times.length;
    for (const t of times) hist[Math.floor(((t % tickMs) / tickMs) * BINS)]++;
    if (n === 0) return { phase: 0, peak: 0, n: 0, concentration: 0 };
    let peak = 0;
    for (let i = 1; i < BINS; i++) if (hist[i] > hist[peak]) peak = i;
    // circular mean within +/-3 ms of the peak
    const centre = ((peak + 0.5) / BINS) * tickMs;
    let sum = 0;
    let cnt = 0;
    for (const t of times) {
        let d = (t % tickMs) - centre;
        if (d > tickMs / 2) d -= tickMs;
        if (d < -tickMs / 2) d += tickMs;
        if (Math.abs(d) <= 3) {
            sum += d;
            cnt++;
        }
    }
    const peakMs = (centre + sum / cnt + tickMs) % tickMs;
    return { phase: (peakMs + tickMs / 2) % tickMs, peak: peakMs, n, concentration: cnt / n };
}

function estimatePhase(cap, tickMs = 50) {
    const times = cap.packets.filter((p) => p.dir === 'S2C' && p.state === 'play' && TICK_NAMES.has(p.name)).map((p) => p.t);
    return phaseFromTimes(times, tickMs);
}

module.exports = { estimatePhase, phaseFromTimes, TICK_NAMES };
