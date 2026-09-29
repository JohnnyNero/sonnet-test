// Tiny WebAudio synth: no audio files, everything generated.
let ctx = null, master = null, noiseBuf = null;

export function initAudio() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = 0.35; master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  } catch (e) { ctx = null; }
}

function tone(f0, f1, dur, type = 'sine', vol = 0.3, delay = 0) {
  if (!ctx) return;
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.02);
}
function noise(dur, vol, f0, f1 = f0, q = 1, type = 'bandpass', delay = 0) {
  if (!ctx) return;
  const t = ctx.currentTime + delay;
  const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
  const f = ctx.createBiquadFilter(); f.type = type; f.Q.value = q;
  f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
  const g = ctx.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  s.connect(f); f.connect(g); g.connect(master); s.start(t); s.stop(t + dur + 0.02);
}

const last = {};
export function sfx(name) {
  if (!ctx) return;
  const now = ctx.currentTime;
  if (last[name] && now - last[name] < 0.05) return; // avoid stacking
  last[name] = now;
  switch (name) {
    case 'swing': noise(0.12, 0.25, 1800, 500, 1.2); break;
    case 'hit': tone(160, 60, 0.12, 'square', 0.22); noise(0.08, 0.2, 1200, 400); break;
    case 'hurt': tone(220, 90, 0.2, 'sawtooth', 0.25); break;
    case 'fire': noise(0.35, 0.35, 700, 250, 0.8); tone(300, 110, 0.25, 'sawtooth', 0.12); break;
    case 'boom': tone(90, 30, 0.5, 'sine', 0.5); noise(0.5, 0.45, 500, 80, 0.6, 'lowpass'); break;
    case 'ignite': noise(0.25, 0.18, 900, 300, 0.7); break;
    case 'frost': tone(1400, 500, 0.5, 'triangle', 0.18); tone(2100, 800, 0.4, 'sine', 0.1, 0.03); noise(0.4, 0.15, 5000, 2500, 2, 'highpass'); break;
    case 'shatter': noise(0.18, 0.35, 5000, 1500, 1.5, 'highpass'); tone(2500, 400, 0.15, 'triangle', 0.15); break;
    case 'zap': tone(900, 90, 0.18, 'sawtooth', 0.28); noise(0.2, 0.3, 3500, 800, 1); tone(1800, 200, 0.12, 'square', 0.12, 0.04); break;
    case 'arc': noise(0.25, 0.14, 3000, 600, 1.4); tone(500, 120, 0.2, 'sawtooth', 0.1); break;
    case 'flask': tone(200, 400, 0.15, 'sine', 0.2); break;
    case 'splash': noise(0.3, 0.3, 900, 300, 0.7, 'lowpass'); break;
    case 'steam': noise(0.5, 0.12, 4000, 2000, 0.6, 'highpass'); break;
    case 'pickup': tone(660, 990, 0.12, 'triangle', 0.25); tone(990, 1320, 0.14, 'triangle', 0.2, 0.08); break;
    case 'rare': tone(523, 523, 0.14, 'triangle', 0.25); tone(659, 659, 0.14, 'triangle', 0.25, 0.1); tone(784, 784, 0.25, 'triangle', 0.25, 0.2); break;
    case 'heal': tone(400, 800, 0.3, 'sine', 0.25); break;
    case 'die': tone(200, 40, 0.4, 'sawtooth', 0.25); noise(0.35, 0.2, 800, 100, 0.8); break;
    case 'roar': tone(90, 45, 0.8, 'sawtooth', 0.4); noise(0.8, 0.3, 300, 100, 0.6, 'lowpass'); break;
    case 'arrow': noise(0.1, 0.18, 2500, 1200, 1.4); break;
    case 'portal': tone(200, 800, 0.8, 'sine', 0.3); tone(300, 1200, 0.8, 'triangle', 0.15); break;
    case 'chest': tone(300, 500, 0.2, 'square', 0.15); tone(600, 900, 0.3, 'triangle', 0.2, 0.1); break;
    case 'wood': noise(0.18, 0.3, 600, 200, 0.8); tone(120, 60, 0.12, 'square', 0.18); break;
  }
}
