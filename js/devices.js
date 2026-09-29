// Interactive world devices: cameras, laser grids, terminals, breakers, lockers, vents, safes, loot, doors.
import * as THREE from 'three';
import * as Env from './envkit.js';
import { exposure } from './stealth.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
let _id = 0;

// ---- helpers ----------------------------------------------------------------------------------------------------
export function placeModel(game, name, x, y, { rot = 0, y0 = 0, scale = 1 } = {}) {
  const o = Env.cloneModel(name, { w: 0.6, d: 0.6, h: 0.6 });
  o.position.set(x, y0, y); o.rotation.y = rot; if (scale !== 1) o.scale.setScalar(scale);
  game.R.levelGroup.add(o); return o;
}
export function setEmissive(obj, matPrefix, value) {
  obj.traverse(o => { if (o.isMesh && o.material && o.material.name && o.material.name.startsWith(matPrefix)) { if (!o.material.userData._own) { o.material = o.material.clone(); o.material.userData._own = true; } o.material.emissiveIntensity = value; } });
}
export function findPart(o, n) { return Env.findPart(o, n); }

// ------------------------------------------------------------------------------------------------------------------
export class SecurityCamera {
  constructor(game, { x, y, face, amp = 0.9, speed = 0.55, range = 12, fov = 0.75, group = 'cam', phase = 0, mountH = 2.5 }) {
    this.game = game; this.id = ++_id; this.x = x; this.y = y; this.baseFace = face; this.face = face; this.amp = amp; this.speed = speed;
    this.range = range; this.fov = fov; this.group = group; this.phase = phase;
    this.on = true; this.disabled = false; this.disT = 0; this.tripped = false; this.tripT = 0; this.sus = 0; this.permOff = false;
    this.vRange = range; this.vFov = fov; this.vNear = 0; this.vNearBack = 0; this.torchOn = false; this.faction = 'camera';
    this.obj = placeModel(game, 'security_camera', x - Math.sin(face) * 0.25, y - Math.cos(face) * 0.25, { rot: face, y0: mountH, scale: 1.8 });
    this.head = findPart(this.obj, 'head');
    game.cameras.push(this); game.devices.push(this);
  }
  get ox() { return this.x + Math.sin(this.face) * 0.6; }
  get oy() { return this.y + Math.cos(this.face) * 0.6; }
  obs() { return { x: this.x + Math.sin(this.face) * 0.5, y: this.y + Math.cos(this.face) * 0.5, face: this.face, vRange: this.range, vFov: this.fov, vNear: 0, vNearBack: 0, torchOn: false, faction: 'camera' }; }
  light() { return { x: this.x + Math.sin(this.face) * 0.6, y: this.y + Math.cos(this.face) * 0.6, z: 2.6, color: this.tripped ? [1, 0.12, 0.08] : [0.75, 0.2, 0.18], intensity: this.tripped ? 0.55 : 0.28, range: this.range * 0.75, angle: this.fov / 2, penumbra: 0.6, dir: Math.PI / 2 - this.face }; }
  visibleToPlayer() { const g = this.game; return g.vision.visibleAt(this.x + Math.sin(this.face), this.y + Math.cos(this.face)) > 0.12 || Math.hypot(g.player.x - this.x, g.player.y - this.y) < 4; }
  disable(sec) { this.disabled = true; this.disT = sec; this.game.fx.sparks(this.x, this.y, 2.4, 10, 0x80e8ff, 3); setEmissive(this.obj, 'emit_led', 0.0); }
  emp(sec) { this.disable(sec); }
  update(dt) {
    const g = this.game;
    if (this.disabled) { if (!this.permOff) { this.disT -= dt; if (this.disT <= 0) { this.disabled = false; setEmissive(this.obj, 'emit_led', 3); } } if (this.head) this.head.rotation.y += 0; return; }
    if (this.tripped) { this.tripT -= dt; if (this.tripT <= 0) { this.tripped = false; this.sus = 0.4; } const P = g.player; this.face += (Math.atan2(P.x - this.x, P.y - this.y) - this.face) * Math.min(1, dt * 2.5); }
    else this.face = this.baseFace + Math.sin(g.time * this.speed + this.phase) * this.amp;
    if (this.head) this.head.rotation.y = this.face - this.baseFace;
    const P = g.player;
    if (P.state !== 'down' && !P.hidden) {
      let e = exposure(g, this.obs(), P);
      if (e > 0 && P.disguise !== 'none' && !P.busy) {
        // cameras only care about disguised players who behave oddly or stray out of bounds
        const zone = g.level.zoneTypeAt(P.x, P.y);
        const ok = g.disguiseOK ? g.disguiseOK(P, zone) : true; if (ok && !g.player.running && P.stance === 'stand' && !P.carrying) e = 0;
      }
      if (e > 0.03) { this.sus = clamp(this.sus + e * dt / 1.5, 0, 1.3); if (this.sus >= 1 && !this.tripped) this.trip(P); }
      else this.sus = Math.max(0, this.sus - 0.25 * dt);
    }
  }
  trip(P) {
    const g = this.game; this.tripped = true; this.tripT = 8; g.stats.camsTripped++;
    g.toast('A camera spotted you', 'bad'); g.raiseAlert(2, { x: P.x, y: P.y }, 'camera');
    g.audio && g.audio.beep && g.audio.beep();
  }
}

// ------------------------------------------------------------------------------------------------------------------
const BEAM_H = { high: 1.45, mid: 0.85, low: 0.3 };
export class LaserGrid {
  // beams: [{a:[x,y], b:[x,y], h:'high'|'mid'|'low', pattern:'static'|'blink'|'sweep'|'pulse', period, phase, amp, visible:true}]
  constructor(game, { beams, group = 'lasers', color = 0xff2a2a }) {
    this.game = game; this.id = ++_id; this.group = group; this.beams = []; this.disabled = false; this.disT = 0; this.permOff = false; this.cool = 0;
    this.cx = 0; this.cy = 0;
    this.mats = [];
    for (const b of beams) {
      const beam = { ...b, hz: BEAM_H[b.h || 'high'], on: true, x1: b.a[0], y1: b.a[1], x2: b.b[0], y2: b.b[1], visible: b.visible !== false, period: b.period || 2.4, phase: b.phase || 0, amp: b.amp || 0.6, speed: b.speed || 0.7 };
      const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 1, 6), m); mesh.frustumCulled = false; mesh.renderOrder = 5;
      const glow = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1, 8), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })); glow.renderOrder = 5;
      mesh.add(glow); game.R.levelGroup.add(mesh); beam.mesh = mesh; this.beams.push(beam);
      // emitter + receiver hardware
      const dx = beam.x2 - beam.x1, dy = beam.y2 - beam.y1, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
      beam.e1 = placeModel(game, 'laser_emitter', beam.x1 - ux * 0.12, beam.y1 - uy * 0.12, { rot: Math.atan2(ux, uy), y0: beam.hz - 0.2, scale: 1.7 });
      beam.e2 = placeModel(game, 'laser_receiver', beam.x2 + ux * 0.12, beam.y2 + uy * 0.12, { rot: Math.atan2(-ux, -uy), y0: beam.hz - 0.2, scale: 1.7 });
      this.cx += (beam.x1 + beam.x2) / 2; this.cy += (beam.y1 + beam.y2) / 2;
    }
    this.cx /= beams.length; this.cy /= beams.length;
    game.lasers.push(this); game.devices.push(this);
  }
  disable(sec, perm = false) { this.disabled = true; this.disT = sec; this.permOff = perm; }
  emp(sec) { this.disable(sec); }
  update(dt) {
    const g = this.game, P = g.player, t = g.time;
    if (this.disabled) { if (!this.permOff) { this.disT -= dt; if (this.disT <= 0) this.disabled = false; } }
    this.cool = Math.max(0, this.cool - dt);
    for (const b of this.beams) {
      let on = !this.disabled;
      if (on && b.pattern === 'blink') on = ((t + b.phase) % b.period) < b.period * 0.55;
      if (on && b.pattern === 'pulse') on = ((t + b.phase) % b.period) > 0.35;
      b.on = on;
      let x1 = b.x1, y1 = b.y1, x2 = b.x2, y2 = b.y2;
      if (b.pattern === 'sweep') {
        // rotate the far end around the emitter, clipped by the first wall
        const base = Math.atan2(b.x2 - b.x1, b.y2 - b.y1), len = Math.hypot(b.x2 - b.x1, b.y2 - b.y1), a = base + Math.sin(t * b.speed + b.phase) * b.amp;
        const hit = g.level.ray(x1, y1, x1 + Math.sin(a) * len, y1 + Math.cos(a) * len);
        const L2 = hit.hit ? Math.max(0.5, hit.t) : len; x2 = x1 + Math.sin(a) * L2; y2 = y1 + Math.cos(a) * L2;
        if (b.e2) { b.e2.visible = false; }
      }
      b.cx1 = x1; b.cy1 = y1; b.cx2 = x2; b.cy2 = y2;
      const m = b.mesh; const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 0.01;
      m.position.set((x1 + x2) / 2, b.hz, (y1 + y2) / 2); m.scale.set(1, len, 1);
      m.rotation.set(Math.PI / 2, 0, 0); m.rotation.order = 'YXZ'; m.rotation.y = Math.atan2(dx, dy);
      const seen = (b.visible || P.nvg) && g.vision.visibleAt((x1 + x2) / 2, (y1 + y2) / 2) > 0.12;
      m.visible = on && seen;
      if (on && P.state !== 'down' && !P.hidden && !P.inVent && this.cool <= 0) {
        const [z0, z1] = P.bodyZ();
        if (b.hz >= z0 - 0.02 && b.hz <= z1 + 0.02) {
          // distance from the player to the segment
          const px = P.x - x1, py = P.y - y1, t2 = clamp((px * dx + py * dy) / (len * len), 0, 1), qx = x1 + dx * t2 - P.x, qy = y1 + dy * t2 - P.y;
          if (Math.hypot(qx, qy) < P.radius + 0.06) this.trip(b, P);
        }
      }
    }
  }
  trip(b, P) {
    const g = this.game; this.cool = 3.5; g.stats.lasersTripped++;
    g.toast('Laser tripwire!', 'bad'); g.noise(P.x, P.y, 14, 'laser', P); g.raiseAlert(2, { x: P.x, y: P.y }, 'laser');
    g.fx.sparks(P.x, P.y, 1.0, 12, 0xff4040, 3); g.R.cam.shake = 0.5; g.audio && g.audio.beep && g.audio.beep(); g.audio && g.audio.alarm && g.audio.alarm();
  }
}

// ------------------------------------------------------------------------------------------------------------------
export class Terminal {
  // type: 'security' (cameras) | 'lasers' | 'doors' | 'intel' | 'alarm'
  constructor(game, { x, y, rot = 0, type, label, difficulty = 1, group = null, intel = null, model = 'terminal_hack', y0 = 0, scale = 1, wall = false, onDone = null }) {
    this.game = game; this.id = ++_id; this.x = x; this.y = y; this.type = type; this.label = label; this.difficulty = difficulty; this.group = group; this.intel = intel;
    this.done = false; this.disabled = false; this.onDone = onDone; this.r = 1.6;
    this.obj = placeModel(game, model, x, y, { rot, y0, scale });
    setEmissive(this.obj, 'emit_screen', 1.6);
    game.devices.push(this); game.addInteractable(this);
  }
  emp(sec) { this.disabled = true; setEmissive(this.obj, 'emit_screen', 0.05); this.game.after(sec, () => { this.disabled = false; setEmissive(this.obj, 'emit_screen', 1.6); }); }
  get(p) {
    if (this.done) return { label: this.label + ' (done)', enabled: false, reason: 'Already handled', pri: 2 };
    if (this.disabled) return { label: this.label, enabled: false, reason: 'The terminal is dead (EMP)', pri: 3 };
    if (!p.inv.hackTool) return { label: this.label, enabled: false, reason: 'Needs a hacking tool', pri: 3 };
    return { label: `Hack: ${this.label}`, pri: 6, hold: 0 };
  }
  run(p) {
    const g = this.game;
    p.startBusy('Hacking', 1e9, null, { illegal: 'hacking a terminal', anim: null });
    g.ui.minigame('hack', { difficulty: this.difficulty, title: this.label }).then(ok => {
      p.cancelBusy();
      if (!ok) { g.toast('Hack failed. Security noticed a glitch', 'warn'); g.noise(this.x, this.y, 7, 'alarm', p); return; }
      this.finish(p);
    });
  }
  finish(p) {
    const g = this.game; this.done = true;
    setEmissive(this.obj, 'emit_screen', 3.0);
    switch (this.type) {
      case 'security': for (const c of g.cameras) if (!this.group || c.group === this.group) { c.disable(1e9); c.permOff = true; } g.toast('Cameras offline', 'good'); break;
      case 'lasers': for (const l of g.lasers) if (!this.group || l.group === this.group) l.disable(1e9, true); g.toast('Laser grid deactivated', 'good'); break;
      case 'doors': for (const d of g.level.doors) if (d.group === this.group) { d.unlocked = true; } g.toast('Doors unlocked', 'good'); break;
      case 'intel': g.gainIntel(this.intel); break;
      case 'alarm': g.clearLockdown && g.clearLockdown(); break;
    }
    this.onDone && this.onDone(p);
    g.onItem && g.onItem('terminal:' + this.type);
  }
}

// ------------------------------------------------------------------------------------------------------------------
export class Breaker {
  constructor(game, { x, y, rot = 0, wing, y0 = 1.0, scale = 1.4 }) {
    this.game = game; this.x = x; this.y = y; this.wing = wing; this.off = false; this.r = 1.5;
    this.obj = placeModel(game, 'breaker_panel', x, y, { rot, y0, scale }); this.door = findPart(this.obj, 'door');
    game.devices.push(this); game.addInteractable(this);
  }
  get(p) {
    return this.off ? { label: 'Restore power', hold: 1.0, pri: 6 } : { label: 'Cut power to this wing', hold: 1.4, pri: 6 };
  }
  run(p) { this.off ? this.restore(false) : this.cut(); }
  update() { if (this.door) this.door.rotation.y = THREE.MathUtils.lerp(this.door.rotation.y, this.off ? -1.7 : 0, 0.15); }
  cut() {
    const g = this.game; this.off = true; g.lightsOut.add(this.wing);
    for (const l of g.level.lights) if (l.wing === this.wing && !l.broken && l.on !== false && !l.emergency) g.field.setOn(l, false);
    for (const l of g.level.lights) if (l.wing === this.wing && l.emergency) g.field.setOn(l, true);
    g.toast('Power cut. The wing goes dark', 'good'); g.noise(this.x, this.y, 5, 'work', g.player); g.audio && g.audio.blackout && g.audio.blackout();
    // a guard is sent to restore power
    g.after(9 + Math.random() * 6, () => {
      if (!this.off) return;
      const gs = g.guards.filter(x => x.state === 'patrol' || x.state === 'return').sort((a, b) => Math.hypot(a.x - this.x, a.y - this.y) - Math.hypot(b.x - this.x, b.y - this.y));
      const gd = gs[0]; if (!gd) return;
      gd.stimulus = { x: this.x, y: this.y + 0.8, kind: 'breaker', ref: this }; gd.prevState = 'patrol'; gd.state = 'investigate'; gd.investigatePhase = 0; gd.giveUpT = 0;
      g.raiseAlert(1, { x: this.x, y: this.y }, 'blackout');
    });
  }
  restore(byGuard = true) {
    const g = this.game; if (!this.off) return; this.off = false; g.lightsOut.delete(this.wing);
    for (const l of g.level.lights) if (l.wing === this.wing && !l.broken && !l.emergency) g.field.setOn(l, true);
    g.toast(byGuard ? 'A guard restored the power' : 'Power restored', byGuard ? 'warn' : 'info');
  }
}

// ------------------------------------------------------------------------------------------------------------------
export class Locker {
  // A hiding spot for the player AND for bodies. door pivot opens while in use. contains: null | {disguise}
  constructor(game, { x, y, rot = 0, model = 'locker_tall', contains = null, kind = 'locker', doorPart = 'door', doorAngle = -1.7, tall = true }) {
    this.game = game; this.x = x; this.y = y; this.rot = rot; this.contains = contains; this.kind = kind; this.occupant = null; this.body = null; this.r = 1.55;
    this.obj = placeModel(game, model, x, y, { rot }); this.door = findPart(this.obj, doorPart); this.doorAngle = doorAngle; this.openT = 0; this.tall = tall;
    this.front = { x: x + Math.sin(rot) * 0.95, y: y + Math.cos(rot) * 0.95 };
    game.devices.push(this); game.addInteractable(this);
  }
  update(dt) {
    const want = this.occupant || this.body ? 0 : 0; // doors stay closed when occupied
    const target = this.openT > 0 ? this.doorAngle : 0; this.openT = Math.max(0, this.openT - dt);
    if (this.door) { const p = this.kind === 'dumpster' ? 'x' : 'y'; this.door.rotation[p] += (target - this.door.rotation[p]) * Math.min(1, dt * 8); }
  }
  get(p) {
    if (p.hidden && p.hiddenIn === this) return { label: 'Step out', pri: 9, hold: 0 };
    if (p.hidden) return null;
    if (p.carrying) return { label: this.kind === 'dumpster' ? 'Dump body' : 'Stash body', hold: 0.8, pri: 8 };
    if (this.body || this.occupant) return { label: 'Occupied', enabled: false, reason: 'There is a body in there', pri: 1 };
    if (this.contains) return { label: `Take ${this.contains.label}`, hold: 1.5, pri: 7 };
    return { label: this.kind === 'dumpster' ? 'Hide in dumpster' : 'Hide inside', hold: 0, pri: 5 };
  }
  run(p) {
    const g = this.game;
    if (p.hidden && p.hiddenIn === this) { this.openT = 0.8; p.hidden = false; p.hiddenIn = null; this.occupant = null; p.x = this.front.x; p.y = this.front.y; p.z = 0; if (p.group) p.group.visible = true; return; }
    if (p.carrying) {
      const b = p.carrying; p.carrying = null; b.hidden = true; b.z = 0; b.x = this.x; b.y = this.y; this.body = b; this.openT = 0.9; g.noise(this.x, this.y, 2.0, 'bodyfall', p);
      g.toast('Body hidden', 'good'); g.stats.bodiesHidden = (g.stats.bodiesHidden || 0) + 1; return;
    }
    if (this.contains) { const c = this.contains; this.contains = null; this.openT = 1.0; p.setDisguise(c.disguise); g.applyPlayerRim && setTimeout(() => g.applyPlayerRim(), 400); return; }
    // hide inside
    this.openT = 0.7; p.hidden = true; p.hiddenIn = this; this.occupant = p; p.x = this.x; p.y = this.y; p.vx = p.vy = 0; if (p.group) p.group.visible = false;
    g.toast('Hidden. Press F to step out', 'info');
  }
}

// ------------------------------------------------------------------------------------------------------------------
export class VentGrate {
  constructor(game, { x, y, rot = 0, wall = false, y0 = 0, id, link = null }) {
    this.game = game; this.x = x; this.y = y; this.rot = rot; this.vid = id; this.r = 1.7; this.wall = wall; this.link = link; this.open = false;
    this.obj = placeModel(game, wall ? 'vent_grate_wall' : 'vent_grate_floor', x, y, { rot, y0, scale: wall ? 1.0 : 1.0 });
    this.grate = findPart(this.obj, 'grate');
    game.devices.push(this); game.addInteractable(this);
    this.ventCell = { x: Math.floor(x), y: Math.floor(y) };
  }
  update(dt) { if (this.grate && this.open) { this.grate.position.z += (0.9 - this.grate.position.z) * Math.min(1, dt * 6); this.grate.position.y += (-0.3 - this.grate.position.y) * Math.min(1, dt * 6); } }
  get(p) {
    if (p.inVent) return this.game.vent && this.game.ventExit(p, this) ? { label: 'Climb out of the vent', hold: 1.0, pri: 8 } : null;
    if (p.carrying) return null;
    return { label: this.open ? 'Enter vent' : 'Unscrew vent', hold: this.open ? 0.4 : 2.4, pri: 6 };
  }
  run(p) {
    const g = this.game;
    if (p.inVent) { g.exitVent(p, this); return; }
    if (!this.open) { this.open = true; g.noise(this.x, this.y, 3.5, 'work', p); g.toast('Grate removed', 'info'); return; }
    g.enterVent(p, this);
  }
}

// ------------------------------------------------------------------------------------------------------------------
export class Safe {
  constructor(game, { x, y, rot = 0, code, contains, label = 'Safe', y0 = 0 }) {
    this.game = game; this.x = x; this.y = y; this.code = code; this.contains = contains; this.label = label; this.opened = false; this.r = 1.6;
    this.obj = placeModel(game, 'safe_small', x, y, { rot, y0 }); this.door = findPart(this.obj, 'door');
    game.devices.push(this); game.addInteractable(this);
  }
  update() { if (this.door) this.door.rotation.y = THREE.MathUtils.lerp(this.door.rotation.y, this.opened ? -1.6 : 0, 0.12); }
  get(p) { if (this.opened) return null; return { label: `Open ${this.label}`, pri: 6, hold: 0 }; }
  run(p) {
    const g = this.game; const known = p.inv.intel[this.codeKey || 'safe'];
    p.startBusy('Cracking the safe', 1e9, null, { illegal: 'cracking a safe' });
    g.ui.minigame('keypad', { title: this.label, code: this.code, hint: known ? `Known code: ${known}` : 'Find the code: it is written down somewhere', attempts: 3 }).then(ok => {
      p.cancelBusy();
      if (!ok) { g.noise(this.x, this.y, 8, 'alarm', p); g.toast('Wrong code. The safe beeped loudly', 'warn'); return; }
      this.opened = true; g.audio && g.audio.unlock && g.audio.unlock();
      const c = this.contains; if (c) { if (c.type === 'intel') g.gainIntel(c.intel); else if (c.type === 'keycard') { p.inv.keycard = true; g.toast('Keycard acquired', 'good'); g.onItem && g.onItem('keycard'); } else if (c.type === 'item') { p.inv[c.key] = true; g.toast(c.label, 'good'); g.onItem && g.onItem('item:' + c.key); } }
    });
  }
}

// ------------------------------------------------------------------------------------------------------------------
export class Loot {
  constructor(game, { x, y, model, value, label, rot = 0, y0 = 0, scale = 1, weight = 1, tag = 'cash', secondary = false }) {
    this.game = game; this.x = x; this.y = y; this.value = value; this.label = label; this.taken = false; this.weight = weight; this.r = 1.5; this.tag = tag; this.secondary = secondary;
    this.obj = placeModel(game, model, x, y, { rot, y0, scale });
    game.devices.push(this); game.addInteractable(this);
  }
  get(p) {
    if (this.taken) return null;
    if (this.tag === 'cash' && p.inv.loot + this.weight > 6) return { label: `Grab ${this.label}`, enabled: false, reason: 'Your bag is full', pri: 5 };
    return { label: `Take ${this.label}  ($${this.value.toLocaleString()})`, hold: 0.9 + this.weight * 0.4, pri: 6 };
  }
  run(p) {
    this.taken = true; this.obj.visible = false; const g = this.game;
    if (this.tag === 'cash') { p.inv.loot += this.weight; p.inv.lootValue += this.value; g.stats.loot += this.value; g.toast(`+$${this.value.toLocaleString()}`, 'good'); }
    else { p.inv[this.tag] = true; g.toast(`Got: ${this.label}`, 'good'); }
    g.onItem && g.onItem(this.tag === 'cash' ? 'loot' : 'item:' + this.tag);
    g.audio && g.audio.pickup && g.audio.pickup();
  }
}

// A keycard lying around or a simple pickup
export class Pickup {
  constructor(game, { x, y, model = 'keycard', key = 'keycard', label = 'Keycard', y0 = 0.9, scale = 2.4, onTake = null }) {
    this.game = game; this.x = x; this.y = y; this.key = key; this.label = label; this.taken = false; this.r = 1.4; this.onTake = onTake;
    this.obj = placeModel(game, model, x, y, { y0, scale });
    game.devices.push(this); game.addInteractable(this);
  }
  update(dt) { if (!this.taken) this.obj.rotation.y += dt * 1.4; }
  get(p) { return this.taken ? null : { label: `Take ${this.label}`, hold: 0, pri: 7 }; }
  run(p) { this.taken = true; this.obj.visible = false; p.inv[this.key] = true; this.game.toast(`${this.label} acquired`, 'good'); this.game.onItem && this.game.onItem(this.key === 'keycard' ? 'keycard' : 'item:' + this.key); this.onTake && this.onTake(); }
}

// ------------------------------------------------------------------------------------------------------------------
// Locked doors get an interactable so the player can pick / hack / key them.
export function registerDoorLock(game, d, { label = 'Door', difficulty = 1, codeInfo = null } = {}) {
  const cx = d.x + 0.5, cy = d.y + 0.5;
  const it = {
    x: cx, y: cy, r: 1.9,
    get(p) {
      if (d.unlocked) return null;
      switch (d.lock) {
        case 'keycard': return p.inv.keycard ? { label: 'Swipe keycard', hold: 0, pri: 7 } : { label: `${label}: keycard required`, enabled: false, reason: 'You need a keycard for this door', pri: 3 };
        case 'lockpick': return p.inv.lockpick ? { label: `Pick the lock (${label})`, hold: 0, pri: 6 } : null;
        case 'hack': return { label: `Hack the door (${label})`, hold: 0, pri: 6 };
        case 'code': return { label: `Enter code (${label})`, hold: 0, pri: 6 };
        default: return null;
      }
    },
    run(p) {
      if (d.lock === 'keycard') { d.unlocked = true; game.toast('Access granted', 'good'); game.audio && game.audio.unlock && game.audio.unlock(); game.onItem && game.onItem('door:' + (d.tag || '')); return; }
      if (d.lock === 'lockpick') {
        p.startBusy('Picking the lock', 1e9, null, { illegal: 'picking a lock' });
        game.ui.minigame('lockpick', { difficulty, title: label }).then(ok => { p.cancelBusy(); if (ok) { d.unlocked = true; game.toast('Lock picked', 'good'); game.onItem && game.onItem('door:' + (d.tag || '')); } else { game.noise(cx, cy, 6, 'work', p); game.toast('The pick snapped. That made noise', 'warn'); } });
      } else if (d.lock === 'hack') {
        p.startBusy('Hacking', 1e9, null, { illegal: 'hacking a lock' });
        game.ui.minigame('hack', { difficulty, title: label }).then(ok => { p.cancelBusy(); if (ok) { d.unlocked = true; game.toast('Door unlocked', 'good'); game.onItem && game.onItem('door:' + (d.tag || '')); } else { game.noise(cx, cy, 7, 'alarm', p); game.toast('Hack failed', 'warn'); } });
      } else if (d.lock === 'code') {
        p.startBusy('Entering a code', 1e9, null, { illegal: 'forcing a keypad' });
        const known = p.inv.intel[d.codeKey || 'code'];
        game.ui.minigame('keypad', { title: label, code: d.codeValue, hint: known ? `Known code: ${known}` : (codeInfo || 'You need the code'), attempts: 3 }).then(ok => { p.cancelBusy(); if (ok) { d.unlocked = true; game.toast('Access granted', 'good'); game.onItem && game.onItem('door:' + (d.tag || '')); } else { game.noise(cx, cy, 8, 'alarm', p); game.toast('Wrong code', 'warn'); } });
      }
    },
  };
  game.addInteractable(it); d.interactable = it; return it;
}
