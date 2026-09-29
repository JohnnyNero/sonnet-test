// Game core: owns the level, actors, systems and the main loop.
import * as THREE from 'three';
import { Renderer } from './renderer.js';
import { LightField, VisionMask } from './lighting.js';
import { ZONE_TYPES } from './config.js';
import { Input } from './input.js';
import * as Env from './envkit.js';
import { initCharacters, setBaseURL } from './characters.js';
import { RNG } from './util.js';
import { prepareObject, shared } from './materials.js';
import { FX } from './fx.js';
import { Audio } from './audio.js';
import { disguiseAllows } from './stealth.js';

export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.R = new Renderer(canvas);
    this.input = new Input(canvas, this);
    this.ui = null; this.audio = new Audio(this);
    this.fx = new FX(this.R);
    this.state = "loading";
    this.time = 0; this.paused = false;
    this.reset();
  }

  reset() {
    this.level = null; this.field = null; this.vision = null;
    this.player = null; this.guards = []; this.npcs = []; this.actors = []; this.devices = []; this.interactables = [];
    this.cameras = []; this.lasers = []; this.lightsById = new Map();
    this.noises = []; this.timers = [];
    this.alert = { level: 0, timer: 0, heat: 0, lastKnown: null, lockdown: 0 };
    this.stats = { alerts: 0, spotted: 0, knockouts: 0, bodiesFound: 0, camsTripped: 0, lasersTripped: 0, darts: 0, time: 0, loot: 0, ghost: true, disguises: 0 };
    this.mission = null; this.objectives = [];
    this.lightsOut = new Set(); this.reinforcements = 0;
    this.alert.exposedT = 0; this.alert.calmT = 0;
  }

  audioUnlock() { this.audio.init(); if (this.state === 'play') this.audio.startMusic(); }

  // ------------------------------------------------------------------------------------------------ loading
  async load(onProgress) {
    setBaseURL('assets/'); Env.setEnvBase('assets/');
    await Env.loadManifest();
    await initCharacters();
    const names = Object.keys(await Env.loadManifest());
    await Env.loadEnvModels(names.length ? names : [], onProgress);
  }

  // ------------------------------------------------------------------------------------------------ mission lifecycle
  async startMission(buildFn, seed) {
    this.reset();
    this.R.clearLevel();
    this.rng = new RNG(seed * 9973 + 17);
    const m = await buildFn(this, seed);           // populates level, lights, actors, devices, objectives
    this.mission = m;
    this.state = 'play';
    return m;
  }

  // Called by the mission once level geometry exists.
  setLevel(level) {
    this.level = level;
    this.field = new LightField(level, z => (ZONE_TYPES[z.type] || ZONE_TYPES.public).ambient);
    this.vision = new VisionMask(level);
  }
  addLight(l) {
    const light = this.field.addStatic(l);
    if (l.key) this.lightsById.set(l.key, light);
    return light;
  }
  finalizeLevel() {
    this.field.commit(true);
    this.R.buildLevel(this.level, this.field, this.vision);
  }

  // ------------------------------------------------------------------------------------------------ registry
  register(a) { this.actors.push(a); return a; }
  addInteractable(it) { this.interactables.push(it); return it; }
  removeInteractable(it) { const i = this.interactables.indexOf(it); if (i >= 0) this.interactables.splice(i, 1); }
  after(sec, fn) { this.timers.push({ t: sec, fn }); }

  // ------------------------------------------------------------------------------------------------ events
  noise(x, y, radius, type = 'noise', source = null) {
    if (source && source.inVent) return;                 // the ducts swallow every sound: nobody can hear you in there
    this.noises.push({ x, y, radius, type, source, t: this.time });
    if (source === this.player && radius > 1.2) this.ui && this.ui.noiseRing && this.ui.noiseRing(radius);
    if (this.debugNoise) console.log('noise', type, radius);
  }
  // is the player's current disguise legitimate (and unblown) in this zone type?
  disguiseOK(P, zone) { return P.disguise !== 'none' && !P.disguiseBlown && disguiseAllows(P.disguise, zone); }
  toast(text, kind = 'info') { this.ui && this.ui.toast(text, kind); }

  raiseAlert(level, pos, why) {
    const A = this.alert;
    if (level > A.level) {
      A.level = level; this.stats.alerts++;
      this.stats.ghost = false;
      this.toast(level >= 3 ? 'LOCKDOWN' : level === 2 ? 'You have been spotted' : 'Guards are on edge', level >= 2 ? 'bad' : 'warn');
      this.audio && this.audio.stinger && this.audio.stinger(level);
    }
    if (pos) A.lastKnown = { x: pos.x, y: pos.y };
    A.timer = level >= 2 ? Math.max(A.timer, 45) : Math.max(A.timer, 30);
    if (level >= 2) this.R.cam.shake = Math.max(this.R.cam.shake, 0.35);
    // notify nearby guards through the radio
    if (level >= 2 && pos) for (const g of this.guards) if (g.state !== 'down' && g.state !== 'alert') g.hearRadio && g.hearRadio(pos, why);
  }
  updateAlert(dt) {
    const A = this.alert;
    const seers = this.guards.filter(g => g.state === 'alert' && g.seesPlayer).length;
    A.exposedT = seers ? A.exposedT + dt : Math.max(0, A.exposedT - dt * 0.5);
    if (A.level === 2 && A.exposedT > 16) this.triggerLockdown('You were seen for too long');
    if (A.level > 0 && A.level < 3) {
      if (!seers) { A.timer -= dt; if (A.timer <= 0) { A.level = Math.max(0, A.level - 1); A.timer = A.level ? 30 : 0; this.toast(A.level ? 'They lost you. Still searching' : 'Things are calming down', 'info'); } }
      else A.timer = Math.max(A.timer, 20);
    }
    if (A.level === 3) {
      A.lockdown += dt;
      A.calmT = seers ? 0 : A.calmT + dt;
      if (A.calmT > 40) this.clearLockdown();
      if (A.lockdown > 12 && this.reinforcements < 1) this.spawnReinforcements(2);
      if (A.lockdown > 32 && this.reinforcements < 4) this.spawnReinforcements(2);
    }
    shared.uAlarm.value += ((A.level >= 3 ? 1 : A.level === 2 ? 0.45 : 0) - shared.uAlarm.value) * Math.min(1, dt * 3);
    this.R.grade.uniforms.uAlarm.value = shared.uAlarm.value;
  }
  triggerLockdown(why) {
    const A = this.alert; if (A.level >= 3) return;
    this.raiseAlert(3, A.lastKnown, why); A.lockdown = 0; A.calmT = 0; this.stats.lockdowns = (this.stats.lockdowns || 0) + 1;
    for (const d of this.level.doors) if (!d.vault) { d.alarm = true; }
    this.level.invalidateNav();
    this.audio && this.audio.alarm && this.audio.alarm();
  }
  clearLockdown() {
    const A = this.alert; if (A.level < 3) return;
    A.level = 1; A.timer = 30; A.lockdown = 0;
    for (const d of this.level.doors) d.alarm = false;
    this.level.invalidateNav(); this.toast('Lockdown lifted', 'good');
  }
  async spawnReinforcements(n) {
    this.reinforcements += n;
    const { Guard } = await import('./guard.js');
    for (let i = 0; i < n; i++) {
      const g = new Guard(this, { gender: i % 2 ? 'female' : 'male', skin: 'dark', hair: i % 2 ? 'buns' : 'buzzed', hairColor: 'black', outfit: 'guard_elite', width: 0.94 }, 47 + i * 1.2, 51, { route: [], name: 'Reinforcement', role: 'elite', vRange: 15 });
      await g.init(); this.guards.push(g); this.register(g);
      g.state = 'alert'; g.lastSeen = { x: this.player.x, y: this.player.y, t: this.time }; g.sus = 1;
    }
    this.toast('Reinforcements have arrived', 'bad');
  }

  // ------------------------------------------------------------------------------------------------ doors
  canOpenDoor(actor, d) {
    if (d.alarm && actor.kind !== 'guard') return false;         // lockdown: only security has keys
    if (!d.lock) return true;
    if (actor.canPass) return actor.canPass(d);
    return false;
  }
  updateDoors(dt) {
    const L = this.level;
    for (const d of L.doors) {
      let near = false;
      const cx = d.x + 0.5, cy = d.y + 0.5;
      for (const a of this.actors) {
        if (a.state !== 'active' || a.hidden || a.inVent) continue;
        if (Math.abs(a.x - cx) > 1.35 || Math.abs(a.y - cy) > 1.35) continue;
        if (Math.hypot(a.x - cx, a.y - cy) < 1.35 && this.canOpenDoor(a, d)) { near = true; break; }
      }
      // people standing in the doorway keep it open
      if (d.forced) near = true;
      if (near) { d.target = 1; d.hold = 0.7; }
      else if (d.hold > 0) d.hold -= dt; else d.target = 0;
      if (near && d._wasClosed) { d._wasClosed = false; this.noise(cx, cy, 2.2, 'door', null); }
      if (d.open < 0.05) d._wasClosed = true;
      const opaque = d.open < 0.35 && !d.glass;
      if (d._opaque !== opaque) { d._opaque = opaque; L.invalidateNav(); this.field.rebakeNear(d.x, d.y); }
    }
  }

  // ------------------------------------------------------------------------------------------------ dynamic lights
  dynamicLights() {
    const out = [];
    for (const g of this.guards) if (g.torchOn && g.state !== 'down') out.push(g.torchLight());
    for (const c of this.cameras) if (c.on && !c.disabled) out.push(c.light());
    if (this.player && this.player.inVent) out.push({ x: this.player.x, y: this.player.y, z: 1.6, color: [0.45, 0.8, 1.0], intensity: 0.4, range: 3.2, noShadow: true });
    if (this.alert.level >= 3) {
      const t = this.time * 3;
      for (const l of this.level.lights) if (l.alarm) out.push({ x: l.x, y: l.y, z: 2.5, color: [1, 0.1, 0.08], intensity: 0.6 * (0.5 + 0.5 * Math.sin(t + l.x)), range: 7 });
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------------ frame
  update(dt) {
    if (this.state !== 'play' || this.paused) { this.input.endFrame(); return; }
    dt = Math.min(dt, 0.05);
    this.time += dt; this.stats.time += dt;
    this.input.poll(dt);
    if (this.input.was('m')) this.audio.setMuted(!this.audio.muted);
    if (this.input.intent.pause) { this.paused = true; this.ui && this.ui.showPause && this.ui.showPause(true); this.input.endFrame(); return; }
    const P = this.player;
    for (let i = this.timers.length - 1; i >= 0; i--) { const t = this.timers[i]; t.t -= dt; if (t.t <= 0) { this.timers.splice(i, 1); t.fn(); } }

    P.update(dt, this.input.intent);
    for (const g of this.guards) g.update(dt);
    for (const n of this.npcs) n.update(dt);
    for (const d of this.devices) d.update && d.update(dt);
    this.updateDoors(dt);
    this.updateAlert(dt);
    this.noises.length = 0;

    // lights + vision
    this.field.beginFrame();
    for (const l of this.dynamicLights()) this.field.addDynamic(l);
    this.field.commit();
    const eye = P.eyePos();
    if (P.inVent) {
      // see along the ducts, and down into the room when passing under a grate
      let peek = null;
      for (const gr of Object.values(this.ventGrates || {})) { if (Math.hypot(P.x - (gr.ventCell.x + 0.5), P.y - (gr.ventCell.y + 0.5)) < 0.9) { peek = { x: gr.exitAt.x, y: gr.exitAt.y, radius: 9, level: this.level }; break; } }
      this.vision.update(eye.x, eye.y, 5.5, this.vent, peek, dt);
    } else this.vision.update(eye.x, eye.y, 15, null, null, dt);

    // rendering sync
    for (const a of this.actors) {
      a.syncVisual(dt);
      // only show people the player can currently perceive (or hear nearby)
      if (a !== P && a.group) {
        const v = this.vision.visibleAt(a.x, a.y);
        const near = Math.hypot(a.x - P.x, a.y - P.y) < 1.4;
        a.group.visible = (v > 0.25 || near) && !a.hidden;
      }
    }
    this.R.animateDoors(this.level, dt);
    const z = P.inVent ? 0.3 : 0.9;
    this.R.updateCamera(dt, P.x, P.y, z);
    this.R.updateWalls(dt, P.x, P.y);
    this.updateCones();
    this.fx.update(dt);
    this.ui && this.ui.update(this, dt);
    this.input.endFrame();
  }

  // Vision cones for everything that watches: shown for guards/cameras the player can currently see.
  updateCones() {
    const L = this.level, P = this.player;
    for (const g of this.guards) {
      const key = 'g' + g.id;
      if (g.state === 'down' || g.state === 'sedated' || !g.group || !g.group.visible) { this.fx.hideCone(key); continue; }
      const st = g.state === 'alert' ? [1, 0.16, 0.1] : (g.state === 'suspicious' || g.state === 'investigate' || g.state === 'search') ? [1, 0.68, 0.18] : [0.55, 0.72, 1.0];
      const o = g.obs();
      this.fx.cone(key, L, g.x, g.y, g.face, o.vFov, Math.min(o.vRange, 13), { color: st, alpha: g.state === 'alert' ? 0.2 : 0.12 + (g.exposureNow > 0.05 ? 0.06 : 0), visible: true });
    }
    for (const c of this.cameras) {
      const key = 'c' + c.id;
      if (!c.on || c.disabled || !c.visibleToPlayer()) { this.fx.hideCone(key); continue; }
      this.fx.cone(key, L, c.x, c.y, c.face, c.fov, c.range, { color: c.tripped ? [1, 0.15, 0.1] : [1, 0.35, 0.3], alpha: 0.13, visible: true });
    }
  }

  frame(dt) { this.update(dt); this.R.render(dt); }
}
