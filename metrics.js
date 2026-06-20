// Lightweight in-memory latency metrics for the voice relay.
//
// For a real-time voice agent, two numbers matter most:
//   • ttfa — time-to-first-audio: user stops talking → first audio byte streamed back.
//            This is what the user actually feels as "responsiveness".
//   • turn — full turn latency:   user stops talking → the model's turn completes.
//
// We keep a small ring buffer of samples per channel (no dependency, no storage),
// so /api/metrics reflects this relay instance since it started. It resets on
// deploy/restart — that's fine; it's a live health signal, not an analytics store.

const MAX_SAMPLES = 200;
const startedAt = Date.now();

function makeChannel() {
  return { samples: [], count: 0 };
}

const channels = {
  ttfa: makeChannel(),
  turn: makeChannel(),
};

export function record(channel, ms) {
  const c = channels[channel];
  if (!c || !Number.isFinite(ms) || ms < 0) return;
  c.count += 1;
  c.samples.push(ms);
  if (c.samples.length > MAX_SAMPLES) c.samples.shift();
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, idx))];
}

function summarize(c) {
  const n = c.samples.length;
  if (!n) return { count: 0, window: 0, p50: null, p95: null, min: null, max: null, avg: null };
  const sorted = [...c.samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: c.count, // total recorded since start
    window: n, // samples in the rolling window the percentiles use
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    min: sorted[0],
    max: sorted[n - 1],
    avg: Math.round(sum / n),
  };
}

export function snapshot() {
  return {
    unit: 'ms',
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    windowSize: MAX_SAMPLES,
    timeToFirstAudio: summarize(channels.ttfa),
    turnLatency: summarize(channels.turn),
  };
}
