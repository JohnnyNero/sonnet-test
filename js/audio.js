// Fully procedural audio: a smoky noir jazz combo playing in the gala (heard through walls), tension layers,
// and every sound effect synthesised on the fly. No audio files.
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

export class Audio {
  constructor(game) { this.game = game; this.ctx = null; this.muted = false; this.musicOn = false; this.tension = 0; this.lastSfx = {}; }

  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
    const c = this.ctx;
    this.master = c.createGain(); this.master.gain.value = 0.7; this.master.connect(c.destination);
    // noise buffer + reverb impulse
    this.noiseBuf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate); { const d = this.noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
    const len = c.sampleRate * 2.4, imp = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = imp.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6); }
    this.verb = c.createConvolver(); this.verb.buffer = imp; this.verbGain = c.createGain(); this.verbGain.gain.value = 0.34; this.verb.connect(this.verbGain); this.verbGain.connect(this.master);
    // music bus: lowpass (muffling by distance/walls) -> gain
    this.musicLP = c.createBiquadFilter(); this.musicLP.type = 'lowpass'; this.musicLP.frequency.value = 900; this.musicLP.Q.value = 0.5;
    this.musicGain = c.createGain(); this.musicGain.gain.value = 0.0; this.musicLP.connect(this.musicGain); this.musicGain.connect(this.master);
    this.musicSend = c.createGain(); this.musicSend.gain.value = 0.5; this.musicLP.connect(this.musicSend); this.musicSend.connect(this.verb);
    // ambience bed
    this.ambGain = c.createGain(); this.ambGain.gain.value = 0.0; this.ambGain.connect(this.master);
    this.wind = this.loopNoise(500, 0.6, this.ambGain); this.hum = this.osc('sawtooth', 55, 0.0, this.ambGain); this.hum.filter.frequency.value = 140;
    // tension drone
    this.tenGain = c.createGain(); this.tenGain.gain.value = 0; this.tenGain.connect(this.master);
    this.ten1 = this.osc('sawtooth', 55, 0.5, this.tenGain); this.ten1.filter.frequency.value = 220; this.ten2 = this.osc('sawtooth', 58.3, 0.5, this.tenGain); this.ten2.filter.frequency.value = 220;
    // siren (lockdown)
    this.sirenGain = c.createGain(); this.sirenGain.gain.value = 0; this.sirenGain.connect(this.master);
    this.siren = c.createOscillator(); this.siren.type = 'square'; this.siren.frequency.value = 660; const sf = c.createBiquadFilter(); sf.type = 'lowpass'; sf.frequency.value = 1400; this.siren.connect(sf); sf.connect(this.sirenGain); this.siren.start();
    this.beat = 0; this.nextT = c.currentTime + 0.3; this.bar = 0;
    this._tick = setInterval(() => this.schedule(), 90);
    this._upd = setInterval(() => this.updateMix(), 120);
  }
  osc(type, f, g, dest) { const c = this.ctx, o = c.createOscillator(), fl = c.createBiquadFilter(), gn = c.createGain(); o.type = type; o.frequency.value = f; fl.type = 'lowpass'; fl.frequency.value = 800; gn.gain.value = g; o.connect(fl); fl.connect(gn); gn.connect(dest); o.start(); return { o, filter: fl, gain: gn }; }
  loopNoise(freq, q, dest) { const c = this.ctx, s = c.createBufferSource(); s.buffer = this.noiseBuf; s.loop = true; const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q; s.connect(f); f.connect(dest); s.start(); return { s, f }; }

  setMuted(m) { this.muted = m; if (this.master) this.master.gain.value = m ? 0 : 0.7; }
  startMusic() { this.musicOn = true; if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
  stopMusic() { this.musicOn = false; if (this.musicGain) this.musicGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.4); if (this.sirenGain) this.sirenGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2); }

  // ------------------------------------------------------------------------------------------------ mix (distance / walls / alert)
  updateMix() {
    const g = this.game, c = this.ctx; if (!c || !g.player || !g.level || !this.musicOn) return;
    const P = g.player, t = c.currentTime;
    // the band is in the gala: how far/muffled is it?
    const bx = 56, by = 31;
    const d = Math.hypot(P.x - bx, P.y - by), walls = g.level.wallsBetween(P.x, P.y, bx, by);
    let vol = clamp(1 - d / 48, 0.05, 1) * Math.pow(0.52, walls);
    const zone = g.level.zoneTypeAt(P.x, P.y);
    if (P.inVent) vol *= 0.6;
    const cutoff = clamp(5500 * Math.pow(0.55, walls) * clamp(1.15 - d / 60, 0.2, 1), 320, 5500);
    const lvl = g.alert.level;
    this.musicGain.gain.setTargetAtTime(0.34 * vol * (lvl >= 2 ? 0.5 : 1), t, 0.25);
    this.musicLP.frequency.setTargetAtTime(cutoff, t, 0.25);
    // tension = worst guard state
    let ten = 0;
    for (const gd of g.guards) { if (gd.state === 'alert') ten = Math.max(ten, 1); else if (gd.state === 'suspicious' || gd.state === 'investigate' || gd.state === 'search') ten = Math.max(ten, 0.45 + gd.sus * 0.3); else ten = Math.max(ten, gd.sus * 0.5); }
    this.tension += (ten - this.tension) * 0.25;
    this.tenGain.gain.setTargetAtTime(0.11 * this.tension * (g.state === 'play' ? 1 : 0), t, 0.3);
    const pitch = 55 * (1 + this.tension * 0.35);
    this.ten1.o.frequency.setTargetAtTime(pitch, t, 0.5); this.ten2.o.frequency.setTargetAtTime(pitch * 1.06, t, 0.5);
    // ambience by zone
    const outside = zone === 'outside';
    this.ambGain.gain.setTargetAtTime(g.state === 'play' ? (outside ? 0.12 : 0.05) : 0, t, 0.6);
    this.wind.f.frequency.setTargetAtTime(outside ? 620 : 240, t, 0.8);
    this.hum.gain.gain.setTargetAtTime(outside ? 0 : 0.22, t, 0.8);
    // lockdown siren
    if (lvl >= 3 && g.state === 'play') { this.sirenGain.gain.setTargetAtTime(0.06, t, 0.2); const ph = (t * 1.1) % 1; this.siren.frequency.setTargetAtTime(ph < 0.5 ? 620 : 880, t, 0.02); }
    else this.sirenGain.gain.setTargetAtTime(0, t, 0.2);
  }

  // ------------------------------------------------------------------------------------------------ the band
  schedule() {
    const c = this.ctx; if (!c || !this.musicOn) return;
    const spb = 60 / 66;
    while (this.nextT < c.currentTime + 0.4) {
      this.playBeat(this.nextT, this.beat, spb);
      this.nextT += spb / 2 ; this.beat = (this.beat + 1) % 32;       // 8th-note grid, 4 bars of 8
    }
  }
  playBeat(t, step, spb) {
    const bar = Math.floor(step / 8), st = step % 8, q = st / 2;         // q: quarter-note position
    // Dm9 | G13 | Cmaj9 | A7b9 (dark turnaround)
    const roots = [50, 43, 48, 45], chords = [[53, 57, 60, 64], [53, 59, 62, 64], [52, 55, 59, 62], [55, 58, 61, 65]];
    const root = roots[bar], ch = chords[bar];
    // walking bass on the quarters
    if (st % 2 === 0) {
      const walk = [root, root + 7, root + 4 + (bar === 1 ? 0 : 0), root + 9 - (q === 3 ? 2 : 0)];
      this.bass(t, mtof(walk[q] - 12 * (walk[q] > 55 ? 1 : 0)), spb * 0.85);
    }
    // Rhodes comping: beat 1 and the "and" of 2
    if (st === 0 || st === 3 || (st === 6 && bar % 2)) this.rhodes(t + (st === 3 ? 0.04 : 0), ch, spb * (st === 0 ? 1.6 : 0.9));
    // brushes: swung 8ths on 2 and 4 + light ride
    if (st % 4 === 2) this.brush(t, 0.5); else if (st % 2 === 0) this.brush(t, 0.14); else if (Math.random() < 0.3) this.brush(t + spb * 0.08, 0.1);
    // muted trumpet: an occasional phrase from D dorian
    if (st === 0 && bar % 2 === 1 && Math.random() < 0.55) {
      const scale = [62, 64, 65, 67, 69, 71, 72, 74]; let time = t + spb * 0.5;
      const n = 3 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) { const m = scale[Math.floor(Math.random() * scale.length)]; this.trumpet(time, mtof(m), spb * (i === n - 1 ? 1.4 : 0.55)); time += spb * (0.5 + Math.random() * 0.4); }
    }
  }
  bass(t, f, dur) {
    const c = this.ctx, o = c.createOscillator(), o2 = c.createOscillator(), g = c.createGain(), lp = c.createBiquadFilter();
    o.type = 'triangle'; o2.type = 'sine'; o.frequency.value = f; o2.frequency.value = f * 2; lp.type = 'lowpass'; lp.frequency.setValueAtTime(700, t); lp.frequency.exponentialRampToValueAtTime(220, t + dur);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.5, t + 0.012); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(lp); o2.connect(lp); lp.connect(g); g.connect(this.musicLP); o.start(t); o2.start(t); o.stop(t + dur + 0.05); o2.stop(t + dur + 0.05);
  }
  rhodes(t, notes, dur) {
    const c = this.ctx;
    for (const m of notes) {
      const f = mtof(m + 12), g = c.createGain(), lp = c.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 2400;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.09, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
      for (const [mul, type, det] of [[1, 'sine', 0], [2.0, 'sine', 3], [4.02, 'triangle', 0]]) {
        const o = c.createOscillator(); o.type = type; o.frequency.value = f * mul; o.detune.value = det + (Math.random() - 0.5) * 6; const og = c.createGain(); og.gain.value = mul === 1 ? 1 : mul === 2 ? 0.35 : 0.08; o.connect(og); og.connect(lp); o.start(t); o.stop(t + dur + 0.1);
      }
      // tremolo
      const trem = c.createOscillator(), tg = c.createGain(); trem.frequency.value = 4.5; tg.gain.value = 0.02; trem.connect(tg); tg.connect(g.gain); trem.start(t); trem.stop(t + dur + 0.1);
      lp.connect(g); g.connect(this.musicLP);
    }
  }
  brush(t, vol) {
    const c = this.ctx, s = c.createBufferSource(); s.buffer = this.noiseBuf; const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 5200; const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 7500; bp.Q.value = 0.6; const g = c.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.09 * vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0008, t + 0.12);
    s.connect(hp); hp.connect(bp); bp.connect(g); g.connect(this.musicLP); s.start(t, Math.random() * 1.5, 0.15);
  }
  trumpet(t, f, dur) {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain(), lp = c.createBiquadFilter(), bp = c.createBiquadFilter();
    o.type = 'sawtooth'; o.frequency.setValueAtTime(f * 0.97, t); o.frequency.linearRampToValueAtTime(f, t + 0.06);
    const vib = c.createOscillator(), vg = c.createGain(); vib.frequency.value = 5.2; vg.gain.value = f * 0.008; vib.connect(vg); vg.connect(o.frequency); vib.start(t); vib.stop(t + dur + 0.1);
    lp.type = 'lowpass'; lp.frequency.value = 1900; bp.type = 'peaking'; bp.frequency.value = 1100; bp.gain.value = 5;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.11, t + 0.05); g.gain.setValueAtTime(0.1, t + dur * 0.7); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(lp); lp.connect(bp); bp.connect(g); g.connect(this.musicLP); o.start(t); o.stop(t + dur + 0.1);
  }

  // ------------------------------------------------------------------------------------------------ sfx helpers
  ok(name, gap = 0.04) { if (!this.ctx || this.muted) return false; const n = this.ctx.currentTime; if (this.lastSfx[name] && n - this.lastSfx[name] < gap) return false; this.lastSfx[name] = n; return true; }
  tone(f0, f1, dur, type = 'sine', vol = 0.2, delay = 0, dest = null) {
    const c = this.ctx, t = c.currentTime + delay, o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur); o.connect(g); g.connect(dest || this.master); o.start(t); o.stop(t + dur + 0.03);
  }
  noise(dur, vol, f0, f1 = f0, q = 1, type = 'bandpass', delay = 0, dest = null) {
    const c = this.ctx, t = c.currentTime + delay, s = c.createBufferSource(); s.buffer = this.noiseBuf; const f = c.createBiquadFilter(); f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur); const g = c.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f); f.connect(g); g.connect(dest || this.master); s.start(t, Math.random(), dur + 0.05);
  }
  voice(f0, f1, dur, vol, formants, delay = 0) {
    const c = this.ctx, t = c.currentTime + delay, o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.setValueAtTime(f0, t); o.frequency.linearRampToValueAtTime(f1, t + dur);
    const g = c.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.03); g.gain.setValueAtTime(vol, t + dur * 0.7); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    for (const [ff, gg] of formants) { const b = c.createBiquadFilter(); b.type = 'bandpass'; b.frequency.value = ff; b.Q.value = 6; const bg = c.createGain(); bg.gain.value = gg; o.connect(b); b.connect(bg); bg.connect(g); }
    g.connect(this.master); o.start(t); o.stop(t + dur + 0.05);
  }
  // distance/wall attenuation for sounds in the world
  near(x, y) { const g = this.game, P = g.player; if (!P || !g.level) return 1; const d = Math.hypot(P.x - x, P.y - y), w = g.level.wallsBetween(P.x, P.y, x, y); return clamp(1 - d / 26, 0, 1) * Math.pow(0.5, w); }

  // ------------------------------------------------------------------------------------------------ sfx
  step(surf = 1, running = false) { if (!this.ok('step', 0.1)) return; const carpet = surf < 0.8; this.noise(0.06, (running ? 0.14 : 0.07) * (carpet ? 0.5 : 1), carpet ? 600 : 1300 * surf, carpet ? 300 : 500, 1.2); if (!carpet) this.tone(120, 60, 0.05, 'sine', 0.05); }
  stinger(level) { if (!this.ok('sting', 0.5)) return; if (level >= 2) { this.tone(880, 880, 0.35, 'square', 0.06); this.tone(1320, 1320, 0.3, 'square', 0.04, 0.06); this.tone(70, 40, 0.7, 'sawtooth', 0.14); this.noise(0.4, 0.1, 3000, 800, 0.8); } else this.tone(520, 420, 0.4, 'triangle', 0.08); }
  huh(g) { if (!this.ok('huh', 0.4)) return; const v = this.near(g.x, g.y); if (v < 0.05) return; this.voice(130, 105, 0.32, 0.12 * v, [[600, 1], [1100, 0.7], [2400, 0.2]]); }
  shout(g) { if (!this.ok('shout', 0.5)) return; const v = Math.max(0.35, this.near(g.x, g.y)); this.voice(150, 190, 0.38, 0.2 * v, [[750, 1], [1250, 0.8], [2600, 0.25]]); this.voice(190, 130, 0.3, 0.2 * v, [[800, 1], [1300, 0.8]], 0.32); }
  scream() { if (!this.ok('scream', 1)) return; this.voice(520, 940, 0.55, 0.11, [[900, 1], [1800, 0.8], [3200, 0.3]]); }
  thud() { if (!this.ok('thud', 0.1)) return; this.tone(110, 40, 0.18, 'sine', 0.3); this.noise(0.1, 0.12, 900, 200, 0.7, 'lowpass'); }
  pickup() { if (!this.ok('pickup', 0.06)) return; this.tone(660, 990, 0.1, 'triangle', 0.14); this.tone(990, 1320, 0.14, 'triangle', 0.1, 0.07); }
  dart() { if (!this.ok('dart', 0.06)) return; this.noise(0.12, 0.06, 4000, 1200, 1.2); this.tone(300, 100, 0.08, 'triangle', 0.08); }
  glass() { if (!this.ok('glass', 0.1)) return; this.noise(0.35, 0.22, 6500, 2200, 1.5, 'highpass'); this.tone(2600, 900, 0.25, 'triangle', 0.08); this.noise(0.5, 0.1, 5000, 3000, 2, 'highpass', 0.12); }
  coin() { if (!this.ok('coin', 0.1)) return; this.tone(2400, 2350, 0.22, 'triangle', 0.11); this.tone(3600, 3500, 0.18, 'sine', 0.06, 0.03); this.tone(2000, 1900, 0.3, 'triangle', 0.06, 0.09); }
  emp() { if (!this.ok('emp', 0.2)) return; this.tone(1200, 60, 0.5, 'sawtooth', 0.14); this.noise(0.4, 0.14, 3000, 200, 0.7); }
  taser() { if (!this.ok('taser', 0.1)) return; this.noise(0.14, 0.14, 2600, 1200, 0.9); this.tone(1500, 800, 0.1, 'square', 0.06); }
  zap() { if (!this.ok('zap', 0.1)) return; this.tone(900, 90, 0.25, 'sawtooth', 0.16); this.noise(0.25, 0.16, 3500, 800, 1); }
  beep() { if (!this.ok('beep', 0.2)) return; this.tone(1400, 1400, 0.09, 'square', 0.06); this.tone(1400, 1400, 0.09, 'square', 0.06, 0.13); }
  alarm() { if (!this.ok('alarmSfx', 1)) return; for (let i = 0; i < 4; i++) this.tone(i % 2 ? 620 : 880, i % 2 ? 620 : 880, 0.22, 'square', 0.05, i * 0.24); }
  unlock() { if (!this.ok('unlock', 0.1)) return; this.tone(1000, 1000, 0.07, 'square', 0.05); this.tone(1500, 1500, 0.1, 'square', 0.05, 0.09); this.tone(90, 60, 0.12, 'sine', 0.2, 0.05); }
  blackout() { if (!this.ok('blackout', 0.3)) return; this.tone(300, 40, 0.7, 'sawtooth', 0.14); this.noise(0.5, 0.1, 2000, 200, 0.6); this.tone(60, 30, 0.9, 'sine', 0.3); }
  vault() { if (!this.ok('vaultSfx', 0.5)) return; for (let i = 0; i < 6; i++) this.tone(90 - i * 6, 50, 0.3, 'square', 0.07, i * 0.7); this.noise(4.0, 0.06, 240, 120, 0.7, 'lowpass'); this.tone(45, 30, 5, 'sine', 0.2); }
}
