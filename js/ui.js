// HUD, screens and minigames.
import { LM } from './config.js';
import { GADGETS } from './player.js';
import { DISGUISES } from './stealth.js';

const GADGET_INFO = { dart: { ic: '➤', nm: 'Dart', key: 'darts' }, coin: { ic: '◉', nm: 'Coin', key: 'coins' }, emp: { ic: '✦', nm: 'EMP', key: 'emp' } };
const $ = (r, s) => r.querySelector(s);

export class UI {
  constructor(game, root) {
    this.game = game; this.root = root; this.mg = null;
    root.innerHTML = `
      <div id="rotate">Rotate your device to landscape for the best view</div>
      <div id="hud" class="hidden">
        <div id="vig"></div>
        <div id="marks"></div>
        <div id="objs" class="panel"><h4>Objectives</h4><div id="objList"></div></div>
        <div id="alert">Undetected</div>
        <canvas id="mini" width="190" height="150"></canvas>
        <div id="zone" class="neutral">Outside</div>
        <div id="disg"></div>
        <div id="pips"><i></i><i></i><i></i></div>
        <div id="gem" class="panel"><div class="top"><div id="gemDot"></div><div><div class="lbl" id="gemLbl">HIDDEN</div><div class="sub" id="gemSub">Stealth: standing</div></div></div><div class="bar"><i id="noiseBar"></i></div></div>
        <div id="bar"></div>
        <div id="prompt"></div>
        <div id="toasts"></div>
      </div>
      <div id="screen" class="screen"><div class="card"><h2 class="serif">Loading</h2></div></div>`;
    this.hud = $(root, '#hud'); this.screenEl = $(root, '#screen');
    this.el = { objs: $(root, '#objList'), alert: $(root, '#alert'), mini: $(root, '#mini'), zone: $(root, '#zone'), disg: $(root, '#disg'), pips: $(root, '#pips'), gemDot: $(root, '#gemDot'), gemLbl: $(root, '#gemLbl'), gemSub: $(root, '#gemSub'), noiseBar: $(root, '#noiseBar'), bar: $(root, '#bar'), prompt: $(root, '#prompt'), toasts: $(root, '#toasts'), marks: $(root, '#marks'), vig: $(root, '#vig') };
    this.mctx = this.el.mini.getContext('2d');
    this.marks = new Map(); this.miniT = 0; this.objSig = ''; this.barSig = ''; this.noiseVis = 0; this.isTouch = false;
  }

  // ------------------------------------------------------------------------------------------ screens
  loading(t) { if (t === null) { this.screenEl.classList.add('hidden'); return; } this.screenEl.classList.remove('hidden'); this.screenEl.innerHTML = `<div class="card"><h2 class="serif">${t}</h2></div>`; }
  hideScreen() { this.screenEl.classList.add('hidden'); }
  showHud(v) { this.hud.classList.toggle('hidden', !v); }

  title(onStart) {
    this.showHud(false); this.screenEl.classList.remove('hidden');
    const seed = this.game.seedHint || (Math.floor(Math.random() * 900) + 100);
    this.screenEl.innerHTML = `<div class="card">
      <div style="color:var(--dim);letter-spacing:.4em;font-size:12px;margin-bottom:14px">AURELIAN PRIVATE BANK</div>
      <h1>GHOST LEDGER</h1><div class="tag">One vault. One night. Nobody gets hurt.</div>
      <div class="panel" style="text-align:left;margin:18px auto;max-width:560px"><h3>The job</h3><div style="line-height:1.6;color:#cfc9b9">The bank is hosting its charity gala. Upstairs the vault holds the night's real business. Get in, take the money, and get out without anyone knowing you were there. <b style="color:var(--gold2)">Non-lethal only</b>: choke, dart, distract, disguise.</div></div>
      <button class="btn" id="goBtn">Take the job</button><button class="btn ghost" id="ctlBtn">Controls</button>
      <div class="seedrow">Contract #<input id="seed" type="number" value="${seed}" min="1" max="99999"> <a href="#" id="rnd" style="color:var(--gold)">random</a><br><span style="opacity:.7">Guards, codes, patrols and laser patterns change with the contract number.</span></div>
    </div>`;
    const go = () => { const s = Math.max(1, Math.min(99999, +$(this.screenEl, '#seed').value || 1)); onStart(s); };
    $(this.screenEl, '#goBtn').onclick = go; $(this.screenEl, '#ctlBtn').onclick = () => this.controls(() => this.title(onStart));
    $(this.screenEl, '#rnd').onclick = e => { e.preventDefault(); $(this.screenEl, '#seed').value = Math.floor(Math.random() * 99000) + 1; };
  }

  controls(back) {
    const t = this.isTouch;
    this.screenEl.classList.remove('hidden');
    this.screenEl.innerHTML = `<div class="card"><h2 class="serif">Controls</h2><div class="panel"><div class="keys">${t ? `
      <b>Move</b><span>Drag on the left half of the screen (floating stick)</span>
      <b>Action</b><span>The big gold button: context action (take down, hack, hide, loot…). Hold for long actions</span>
      <b>Crouch / slide</b><span>Crouch button (tap while running to slide under lasers)</span>
      <b>Run</b><span>Toggle run (loud!)</span>
      <b>Gadget / Fire</b><span>Cycle gadgets, then Fire to throw or shoot in front of you</span>
      <b>Camera</b><span>Use ⟲ ⟳ or twist two fingers; pinch to zoom</span>` : `
      <b>WASD / arrows</b><span>Move (relative to the camera)</span>
      <b>Shift</b><span>Run (loud)</span><b>C</b><span>Crouch. While running: slide under laser beams</span>
      <b>Space</b><span>Jump (hop low laser beams)</span>
      <b>F</b><span>Context action: take down, hack, hide, loot… (hold for long actions)</span>
      <b>1 / 2 / 3, Tab</b><span>Dart pistol / Coin / EMP. Left-click fires at the cursor</span>
      <b>G</b><span>Night-vision goggles (reveal hidden lasers)</span>
      <b>Q / E, right-drag</b><span>Rotate camera. R/T tilt, wheel zoom</span>
      <b>M</b><span>Mute music</span><b>Esc</b><span>Pause</span>`}</div></div>
      <div class="panel" style="margin-top:10px"><h3>How to stay hidden</h3><ul><li>Light matters: the gem shows how visible you are. Stay in shadow, crouch, and move slowly.</li><li>Guards hear footsteps. Carpet is quiet, marble is loud. Coins and darts make distractions.</li><li>Disguises let you walk through the right zones: the panel on the map tells you if you belong.</li><li>Shoot out lamps with darts or cut the breaker to plunge a wing into darkness.</li></ul></div>
      <button class="btn" id="bk">Back</button></div>`;
    $(this.screenEl, '#bk').onclick = back;
  }

  briefing(game, onBegin) {
    const c = game.contract; this.showHud(false); this.screenEl.classList.remove('hidden');
    const rows = game.objectives.map(o => `<li class="${o.optional ? 'opt' : ''}">${o.text}</li>`).join('');
    this.screenEl.innerHTML = `<div class="card"><div style="color:var(--dim);letter-spacing:.4em;font-size:12px">CONTRACT #${c.seed}</div><h2 class="serif" style="margin-top:8px">${c.name}</h2>
      <div class="brief"><div class="panel"><h3>Objectives</h3><ul>${rows}</ul></div>
      <div class="panel"><h3>Ways in</h3><ul><li><b>Service door</b>: pick the kitchen lock in the alley</li><li><b>Front door</b>: walk in through the gala foyer</li><li><b>Rooftop</b>: fire escape ladder in the alley, then the roof door</li><li><b>Vents</b>: unscrew the alley wall grate</li></ul><h3 style="margin-top:12px">Intel</h3><ul><li>Uniforms in the staff lockers open doors that a thief's clothes cannot</li><li>The vault lasers can be shut down from the server room</li></ul></div></div>
      <button class="btn" id="beginBtn">Begin infiltration</button></div>`;
    $(this.screenEl, '#beginBtn').onclick = () => { this.hideScreen(); this.showHud(true); onBegin && onBegin(); };
  }

  showPause(v) {
    if (!v) { const p = $(this.root, '#pauseEl'); p && p.remove(); return; }
    const d = document.createElement('div'); d.id = 'pauseEl'; d.className = 'screen'; d.style.zIndex = 26;
    d.innerHTML = `<div class="card"><h2 class="serif">Paused</h2><button class="btn" id="resume">Resume</button><button class="btn ghost" id="quit">Abandon contract</button></div>`;
    this.root.appendChild(d);
    $(d, '#resume').onclick = () => { this.game.paused = false; this.showPause(false); };
    $(d, '#quit').onclick = () => { this.showPause(false); this.game.paused = false; this.game.failMission && this.game.failMission('abandoned'); };
  }

  result(success, why) {
    const g = this.game, s = g.stats; g.audio && g.audio.stopMusic(); this.showHud(false); this.screenEl.classList.remove('hidden');
    const secs = Math.round(s.time), tm = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    let grade = 'F', pts = 0;
    if (success) {
      pts = 40 + Math.min(30, s.loot / 10000) - s.alerts * 8 - s.bodiesFound * 4 - Math.floor(s.time / 60) * 1.2 + (g.objectives.find(o => o.id === 'usb')?.done ? 8 : 0) + (s.ghost ? 18 : 0);
      grade = pts >= 78 ? 'S' : pts >= 62 ? 'A' : pts >= 46 ? 'B' : pts >= 30 ? 'C' : 'D';
    }
    const title = success ? 'Clean Getaway' : { captured: 'Captured', abandoned: 'Contract Abandoned' }[why] || 'Busted';
    const line = success ? (s.ghost ? 'Nobody will ever know you were there.' : 'You made it out, with some noise.') : 'The guards got you.';
    this.screenEl.innerHTML = `<div class="card"><div style="color:var(--dim);letter-spacing:.4em;font-size:12px">CONTRACT #${g.contract ? g.contract.seed : ''}</div><h2 class="serif" style="margin-top:8px;color:${success ? 'var(--gold2)' : 'var(--red)'}">${title}</h2><div class="tag" style="margin:6px 0">${line}</div>
      ${success ? `<div class="grade">${grade}</div>` : ''}
      <div class="panel"><div class="stats"><span>Take<b>$${s.loot.toLocaleString()}</b></span><span>Time<b>${tm}</b></span><span>Alarms raised<b>${s.alerts}</b></span><span>Times spotted<b>${s.spotted}</b></span><span>Guards downed<b>${s.knockouts}</b></span><span>Bodies found<b>${s.bodiesFound}</b></span><span>Cameras tripped<b>${s.camsTripped}</b></span><span>Lasers tripped<b>${s.lasersTripped}</b></span><span>Disguises worn<b>${s.disguises}</b></span><span>Ghost run<b>${s.ghost ? 'Yes' : 'No'}</b></span></div></div>
      <button class="btn" id="again">Same contract</button><button class="btn ghost" id="next">New contract</button></div>`;
    $(this.screenEl, '#again').onclick = () => this.onRetry && this.onRetry(g.contract.seed);
    $(this.screenEl, '#next').onclick = () => this.onRetry && this.onRetry(Math.floor(Math.random() * 99000) + 1);
  }

  toast(text, kind = 'info') {
    const d = document.createElement('div'); d.className = 'toast ' + kind; d.textContent = text;
    this.el.toasts.appendChild(d); setTimeout(() => d.remove(), 3500);
    while (this.el.toasts.children.length > 4) this.el.toasts.firstChild.remove();
  }
  noiseRing(r) { const g = this.game, p = g.player; if (r >= 3) g.fx.ring(p.x, p.y, 0.4, r, 0xdfe8ff, 0.7, 0.28); }

  // ------------------------------------------------------------------------------------------ per-frame
  update(g, dt) {
    const p = g.player; if (!p) return;
    // objectives (rebuild only on change)
    const sig = g.objectives.map(o => (o.done ? 1 : 0)).join('') + g.objectives.length;
    if (sig !== this.objSig) {
      this.objSig = sig;
      const cur = g.objectives.find(o => !o.done && !o.optional);
      this.el.objs.innerHTML = g.objectives.map(o => `<div class="o ${o.done ? 'done' : ''} ${o.optional ? 'opt' : ''} ${o === cur ? 'cur' : ''}">${o.id === 'ghost' ? (g.stats.ghost || o.done ? o.text : '<s>' + o.text + '</s>') : o.text}</div>`).join('') + (this.isTouch ? '<div class="more">tap to expand</div>' : '');
      if (this.isTouch && !this.objBound) { this.objBound = true; const panel = $(this.root, '#objs'); panel.classList.add('compact'); panel.addEventListener('pointerdown', () => { panel.classList.toggle('compact'); }); }
    }
    // alert
    const A = g.alert, names = ['Undetected', 'Caution', 'ALERT', 'LOCKDOWN'];
    this.el.alert.className = 'l' + A.level; this.el.alert.textContent = names[A.level] + (A.level >= 3 ? ` ${Math.floor(A.lockdown)}s` : '');
    // zone + disguise
    const zt = g.level.zoneTypeAt(p.x, p.y), ok = p.disguise !== 'none' && g.disguiseOK(p, zt);
    const zname = p.inVent ? 'Ventilation' : ({ outside: 'Outside', public: 'Public area', staff: 'Staff only', restricted: 'Restricted', vault: 'Vault' })[zt];
    this.el.zone.textContent = zname; this.el.zone.className = p.inVent ? 'neutral' : zt === 'outside' ? 'neutral' : (zt === 'public' && p.disguise === 'none') ? 'bad' : ok ? 'ok' : 'bad';
    this.el.disg.textContent = p.disguise === 'none' ? 'Unknown intruder' : `Disguise: ${DISGUISES[p.disguise].label}`;
    this.el.disg.style.color = p.disguise === 'none' ? 'var(--dim)' : ok ? 'var(--good)' : 'var(--red)';
    // pips
    [...this.el.pips.children].forEach((e, i) => e.classList.toggle('off', i >= p.hp));
    this.el.vig.classList.toggle('hurt', p.hurtT > 0);
    // light gem
    const lum = p.light, expo = Math.min(1, lum / 0.55);
    const st = lum < 0.07 ? ['HIDDEN', '#6f8cff'] : lum < 0.2 ? ['SHADOWED', '#8aa0c8'] : lum < 0.45 ? ['DIM', '#d8d0a8'] : ['EXPOSED', '#ffd870'];
    this.el.gemLbl.textContent = st[0]; this.el.gemLbl.style.color = st[1];
    this.el.gemDot.style.background = `radial-gradient(circle, ${st[1]} ${Math.round(expo * 65)}%, #000 100%)`; this.el.gemDot.style.borderColor = st[1]; this.el.gemDot.style.color = st[1];
    this.el.gemSub.textContent = p.inVent ? 'In the vents' : p.carrying ? 'Carrying a body' : p.slide ? 'Sliding' : p.running ? 'Running: loud' : p.stance === 'crouch' ? 'Crouched: quiet' : p.speed > 0.3 ? 'Walking' : 'Standing still';
    const noise = p.inVent ? 0.08 : p.running ? 1 : p.speed < 0.3 ? 0 : p.stance === 'crouch' ? 0.18 : 0.42;
    this.noiseVis += (noise - this.noiseVis) * Math.min(1, dt * 8); this.el.noiseBar.style.width = (this.noiseVis * 100).toFixed(0) + '%'; this.el.noiseBar.style.background = this.noiseVis > 0.7 ? '#ff7a58' : '#7ab8ff';
    // gadget bar
    const bsig = GADGETS.map(n => p.inv[GADGET_INFO[n].key]).join(',') + '|' + p.gadget + '|' + p.nvg + '|' + p.inv.keycard + '|' + p.inv.loot + '|' + p.inv.lootValue;
    if (bsig !== this.barSig) {
      this.barSig = bsig;
      this.el.bar.innerHTML = GADGETS.map((n, i) => `<div class="gad ${p.gadget === i ? 'sel' : ''}"><span class="k">${i + 1}</span><div class="ic">${GADGET_INFO[n].ic}</div><div class="nm">${GADGET_INFO[n].nm}</div><span class="n">${p.inv[GADGET_INFO[n].key]}</span></div>`).join('')
        + `<div class="gad tool ${p.nvg ? 'on' : ''}"><div class="nm">NVG (G)</div></div><div class="gad tool ${p.inv.keycard ? 'on' : ''}"><div class="nm">Keycard</div></div><div class="gad tool ${p.inv.loot ? 'on' : ''}"><div class="nm">Bag ${p.inv.loot}/6</div><div class="nm" style="color:var(--gold2)">$${(p.inv.lootValue / 1000) | 0}k</div></div>`;
    }
    // prompt
    const pr = p.prompt, el = this.el.prompt;
    if (pr) {
      el.style.display = 'block'; el.className = pr.enabled === false ? 'dis' : '';
      const prog = pr.progress || (p.holdT && pr.hold ? p.holdT / pr.hold : 0);
      el.innerHTML = pr.busy ? `${pr.label}…<div class="prog"><i style="width:${Math.min(100, prog * 100)}%"></i></div>` : `<kbd>${this.isTouch ? '●' : pr.key || 'F'}</kbd>${pr.label}${pr.hold ? `<div class="prog"><i style="width:${Math.min(100, prog * 100)}%"></i></div>` : ''}`;
    } else el.style.display = 'none';
    // per-frame heavy things throttled
    this.updateMarks(g);
    this.miniT -= dt; if (this.miniT <= 0) { this.miniT = 0.12; this.drawMini(g); }
  }

  // suspicion markers above guards / cameras
  updateMarks(g) {
    const R = g.R, seen = new Set();
    const add = (key, x, y, z, sus, state, cls) => {
      let m = this.marks.get(key);
      if (!m) { m = document.createElement('div'); m.className = 'mk ' + cls; m.innerHTML = '<span class="ring"><b></b></span>'; this.el.marks.appendChild(m); this.marks.set(key, m); }
      seen.add(key);
      const sp = R.screenPos ? R.screenPos(x, y, z) : null; if (!sp || sp.behind) { m.style.display = 'none'; return; }
      const alert = state === 'alert', p = Math.min(100, sus * 100);
      m.style.display = (p > 2 || alert || state === 'suspicious' || state === 'investigate' || state === 'search') ? 'block' : 'none';
      m.style.left = sp.x + 'px'; m.style.top = sp.y + 'px';
      const c = alert ? '#ff5a48' : sus > 0.55 || state === 'investigate' || state === 'search' ? '#ffb642' : '#ffe08a';
      m.style.setProperty('--c', c); m.style.setProperty('--p', alert ? 100 : p);
      m.firstChild.firstChild.textContent = alert ? '!' : '?';
    };
    for (const gd of g.guards) { if (gd.state === 'down' || gd.state === 'sedated' || !gd.group || !gd.group.visible) continue; add('g' + gd.id, gd.x, gd.y, 2.35, gd.sus, gd.state, 'guard'); }
    for (const n of g.npcs) { if (n.state !== 'active' || !n.group || !n.group.visible || n.sus < 0.15) continue; add('n' + n.id, n.x, n.y, 2.3, n.sus, 'suspicious', 'guard'); }
    for (const c of g.cameras) { if (c.disabled || !c.on || !c.visibleToPlayer() || c.sus < 0.05) continue; add('c' + c.id, c.x, c.y, 2.9, c.sus, c.tripped ? 'alert' : 'suspicious', 'cam'); }
    for (const [k, m] of this.marks) if (!seen.has(k)) { m.remove(); this.marks.delete(k); }
  }

  drawMini(g) {
    const c = this.mctx, W = g.level.W, H = g.level.H, cw = this.el.mini.width, ch = this.el.mini.height, S = Math.min(cw / W, ch / H);
    const ox = (cw - W * S) / 2, oy = (ch - H * S) / 2, L = g.level, V = g.vision;
    c.clearRect(0, 0, cw, ch);
    // explored floor
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x; if (!L.carved[i]) continue;
      const ti = (y * LM + 1) * V.tw + (x * LM + 1);
      if (!V.explored[ti]) continue;
      const z = L.zones[L.zone[i]].type;
      c.fillStyle = z === 'outside' ? '#26303e' : z === 'public' ? '#4a4258' : z === 'staff' ? '#3d4650' : z === 'restricted' ? '#5a3a40' : '#63583a';
      c.fillRect(ox + x * S, oy + y * S, S + 0.4, S + 0.4);
    }
    // vents when inside
    if (g.player.inVent && g.vent) { c.fillStyle = 'rgba(140,200,255,.6)'; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (g.vent.carved[y * W + x]) c.fillRect(ox + x * S, oy + y * S, S, S); }
    for (const d of L.doors) { const ti = (d.y * LM + 1) * V.tw + (d.x * LM + 1); if (V.explored[ti]) { c.fillStyle = d.lock && !d.unlocked ? '#ff8a5a' : '#c9a23a'; c.fillRect(ox + d.x * S - 0.5, oy + d.y * S - 0.5, S + 1, S + 1); } }
    // objective hint
    const next = g.objectives.find(o => !o.done && !o.optional && o.hint);
    if (next) { const t = (performance.now() / 600) % 2, r = 2 + t * 3; c.strokeStyle = 'rgba(231,198,106,' + (1 - t / 2) + ')'; c.lineWidth = 1.4; c.beginPath(); c.arc(ox + next.hint.x * S, oy + next.hint.y * S, r, 0, 7); c.stroke(); c.fillStyle = '#e7c66a'; c.fillRect(ox + next.hint.x * S - 1.5, oy + next.hint.y * S - 1.5, 3, 3); }
    // watchers the player can currently see
    for (const gd of g.guards) { if (gd.state === 'down' || !gd.group || !gd.group.visible) continue; c.fillStyle = gd.state === 'alert' ? '#ff5a48' : gd.state === 'patrol' ? '#e0a860' : '#ffb642'; c.fillRect(ox + gd.x * S - 1.6, oy + gd.y * S - 1.6, 3.2, 3.2); c.strokeStyle = c.fillStyle; c.beginPath(); c.moveTo(ox + gd.x * S, oy + gd.y * S); c.lineTo(ox + (gd.x + gd.fx * 2.4) * S, oy + (gd.y + gd.fy * 2.4) * S); c.stroke(); }
    for (const n of g.npcs) { if (n.state !== 'active' || !n.group || !n.group.visible) continue; c.fillStyle = '#8a86a0'; c.fillRect(ox + n.x * S - 1, oy + n.y * S - 1, 2, 2); }
    for (const cam of g.cameras) { if (cam.disabled || !cam.visibleToPlayer()) continue; c.fillStyle = '#ff4a3a'; c.fillRect(ox + cam.x * S - 1.5, oy + cam.y * S - 1.5, 3, 3); }
    // player
    const p = g.player; c.save(); c.translate(ox + p.x * S, oy + p.y * S); c.rotate(-p.face + Math.PI); c.fillStyle = '#7dffb0'; c.beginPath(); c.moveTo(0, -4.5); c.lineTo(3.2, 3.5); c.lineTo(-3.2, 3.5); c.closePath(); c.fill(); c.restore();
  }

  // ------------------------------------------------------------------------------------------ minigames
  minigame(kind, opts = {}) {
    const g = this.game;
    return new Promise(resolve => {
      const el = document.createElement('div'); el.id = 'mg'; this.root.appendChild(el);
      g.input.captured = true; this.mg = { el };
      const done = ok => { if (this.mg && this.mg.el === el) { cancelAnimationFrame(this.mg.raf); document.removeEventListener('keydown', this.mg.key, true); el.remove(); this.mg = null; g.input.captured = false; resolve(ok); } };
      if (kind === 'lockpick') this.mgLockpick(el, opts, done); else if (kind === 'hack') this.mgHack(el, opts, done); else this.mgKeypad(el, opts, done);
    });
  }
  mgFrame(el, title, sub) { el.innerHTML = `<div class="box panel"><h3>${title}</h3><div class="sub">${sub}</div><div id="mgBody"></div><div class="mgbtn" id="mgCancel">Cancel (Esc)</div></div>`; return $(el, '#mgBody'); }

  mgLockpick(el, o, done) {
    const diff = o.difficulty || 1;
    const body = this.mgFrame(el, o.title || 'Lock', 'Set each pin: press SPACE / tap when the marker is in the green');
    body.innerHTML = `<div class="pins"><i></i><i></i><i></i></div><div class="track"><div class="zoneb" id="zn"></div><div class="cursor" id="cu"></div></div><button class="btn" id="setBtn" style="margin:0">Set pin</button><div class="tries" id="tr"></div>`;
    let pin = 0, tries = 3 + (diff < 2 ? 1 : 0), x = 0, dir = 1, zone = { c: 0.5, w: 0.24 };
    const pins = [...body.querySelectorAll('.pins i')], zn = $(body, '#zn'), cu = $(body, '#cu'), tr = $(body, '#tr');
    const newZone = () => { const w = [0.22, 0.16, 0.11][pin] * (diff > 2 ? 0.8 : 1); zone = { c: 0.15 + Math.random() * 0.7, w }; zn.style.left = (zone.c - w / 2) * 100 + '%'; zn.style.width = w * 100 + '%'; pins.forEach((p, i) => { p.className = i < pin ? 'ok' : i === pin ? 'cur' : ''; }); tr.textContent = `Picks left: ${tries}`; };
    newZone();
    const set = () => { const hit = Math.abs(x - zone.c) <= zone.w / 2; if (hit) { pin++; if (pin >= 3) { pins.forEach(p => p.className = 'ok'); setTimeout(() => done(true), 250); return; } newZone(); } else { tries--; if (tries <= 0) { done(false); return; } tr.textContent = `Picks left: ${tries}`; } };
    let last = performance.now();
    const loop = now => { const dt = (now - last) / 1000; last = now; x += dir * dt * (0.75 + pin * 0.35 + diff * 0.15); if (x > 1) { x = 1; dir = -1; } if (x < 0) { x = 0; dir = 1; } cu.style.left = `calc(${x * 100}% - 3px)`; this.mg.raf = requestAnimationFrame(loop); };
    this.mg.raf = requestAnimationFrame(loop);
    this.mg.key = e => { if (e.key === ' ' || e.key.toLowerCase() === 'f' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); set(); } else if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
    document.addEventListener('keydown', this.mg.key, true);
    $(body, '#setBtn').onpointerdown = e => { e.preventDefault(); set(); };
    $(el, '#mgCancel').onclick = () => done(false);
  }

  mgHack(el, o, done) {
    const diff = o.difficulty || 1, n = 4 + diff, sym = ['↑', '→', '↓', '←'];
    const body = this.mgFrame(el, o.title || 'Terminal', 'Memorise the sequence, then repeat it');
    body.innerHTML = `<div class="seq" id="seq"></div><div class="tmr"><i id="tm"></i></div><div class="dirs"><button data-d="0">↑</button><button data-d="1">→</button><button data-d="2">↓</button><button data-d="3">←</button></div>`;
    const seq = Array.from({ length: n }, () => Math.floor(Math.random() * 4)), row = $(body, '#seq'), tm = $(body, '#tm');
    row.innerHTML = seq.map(() => '<i>·</i>').join(''); const cells = [...row.children];
    let phase = 'show', idx = 0, t0 = performance.now(), entered = 0, limit = 7 + n * 1.2 / (1 + diff * 0.1);
    const step = 620;
    const loop = now => {
      const t = now - t0;
      if (phase === 'show') { const k = Math.floor(t / step); cells.forEach((c, i) => { c.className = i === k && (t % step) < step * 0.75 ? 'lit' : ''; c.textContent = i === k && (t % step) < step * 0.75 ? sym[seq[i]] : '·'; }); if (k >= n) { phase = 'input'; t0 = now; cells.forEach(c => { c.className = ''; c.textContent = '?'; }); $(el, '.sub').textContent = 'Enter the sequence'; } tm.style.width = '100%'; }
      else { const left = 1 - (now - t0) / 1000 / limit; tm.style.width = Math.max(0, left * 100) + '%'; if (left <= 0) return done(false); }
      this.mg.raf = requestAnimationFrame(loop);
    };
    const press = d => { if (phase !== 'input') return; if (d === seq[entered]) { cells[entered].className = 'ok'; cells[entered].textContent = sym[d]; entered++; if (entered >= n) setTimeout(() => done(true), 250); } else done(false); };
    body.querySelectorAll('.dirs button').forEach(b => { b.onpointerdown = e => { e.preventDefault(); press(+b.dataset.d); }; });
    this.mg.key = e => { const m = { arrowup: 0, w: 0, arrowright: 1, d: 1, arrowdown: 2, s: 2, arrowleft: 3, a: 3 }[e.key.toLowerCase()]; if (m !== undefined) { e.preventDefault(); e.stopPropagation(); press(m); } else if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
    document.addEventListener('keydown', this.mg.key, true);
    this.mg.raf = requestAnimationFrame(loop); $(el, '#mgCancel').onclick = () => done(false);
  }

  mgKeypad(el, o, done) {
    let attempts = o.attempts || 3, entry = '';
    const body = this.mgFrame(el, o.title || 'Keypad', o.hint || 'Enter the 4-digit code');
    body.innerHTML = `<div class="disp" id="disp">····</div><div class="pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9, '⌫', 0, '✔'].map(k => `<button data-k="${k}">${k}</button>`).join('')}</div><div class="tries" id="tr"></div>`;
    const disp = $(body, '#disp'), tr = $(body, '#tr');
    const render = () => { disp.textContent = (entry + '····').slice(0, 4).split('').join(' '); tr.textContent = `Attempts left: ${attempts}`; };
    render();
    const submit = () => { if (entry === o.code) { disp.style.color = '#8ee0a0'; setTimeout(() => done(true), 300); } else { attempts--; entry = ''; disp.style.color = '#ff5a48'; setTimeout(() => { disp.style.color = ''; }, 300); if (attempts <= 0) return done(false); render(); } };
    const press = k => { if (k === '⌫') entry = entry.slice(0, -1); else if (k === '✔') { if (entry.length === 4) submit(); return render(); } else if (entry.length < 4) entry += k; render(); if (entry.length === 4 && k !== '⌫') submit(); };
    body.querySelectorAll('.pad button').forEach(b => { b.onpointerdown = e => { e.preventDefault(); press(b.dataset.k); }; });
    this.mg.key = e => { if (/^[0-9]$/.test(e.key)) { e.preventDefault(); e.stopPropagation(); press(e.key); } else if (e.key === 'Backspace') { e.stopPropagation(); press('⌫'); } else if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
    document.addEventListener('keydown', this.mg.key, true);
    $(el, '#mgCancel').onclick = () => done(false);
  }
}
