// The player: movement, stances, noise, gadgets and the context-interaction system.
import * as THREE from 'three';
import { Actor, angleDiff } from './actor.js';
import { TUNING } from './config.js';
import { DISGUISES, disguiseOfOutfit, outfitForDisguise } from './stealth.js';

const FLOOR_NOISE = { carpet: 0.55, marble: 1.2, tile: 1.1, concrete: 1.0, wood: 1.0, metal: 1.35 };
export const GADGETS = ['dart', 'coin', 'emp'];

export class Player extends Actor {
  constructor(game, spec, x, y, face = 0) {
    super(game, spec, x, y, face);
    this.kind = 'player'; this.faction = 'player';
    this.disguise = 'none'; this.disguiseBlown = false; this.cover = 1; this.coverT = 99;
    this.inv = { keycard: false, darts: 6, coins: 4, emp: 2, hackTool: true, lockpick: true, goggles: true, loot: 0, lootValue: 0, intel: {} };
    this.gadget = 0; this.nvg = false;
    this.running = false; this.slide = null; this.jump = null; this.carrying = null;
    this.busy = null; this.prompt = null; this.holdT = 0; this.holdTarget = null;
    this.inVent = false; this.footAcc = 0; this.light = 0; this.hp = 3; this.hurtT = 0; this.weaponOut = false;
    this.exposureNow = 0;
    this.radius = TUNING.playerRadius;
  }

  get nav() { return this.inVent && this.game.vent ? this.game.vent : this.game.level; }
  eyePos() { return { x: this.x, y: this.y }; }
  get zoneType() { return this.game.level.zoneTypeAt(this.x, this.y); }
  get height() { return this.slide ? 0.6 : this.stance === 'stand' ? 1.8 : this.stance === 'crouch' ? 1.15 : 0.55; }
  // z range covered by the body (for laser beams)
  bodyZ() {
    const j = this.jump ? this.jump.z : 0;
    return [j + 0.0, j + this.height];
  }
  canPass(d) { // may the player open this door automatically?
    if (!d.lock) return true;
    return d.unlocked === true;
  }

  // -------------------------------------------------------------------------------------------- disguise
  setDisguise(key, silent = false) {
    if (this.disguise === key) return;
    this.disguise = key; this.disguiseBlown = false; this.cover = 1; this.coverT = 99;
    const outfit = outfitForDisguise(key, this.spec.gender);
    this.char.setOutfit(outfit).then(() => { prepareRimLater(this); });
    this.game.stats.disguises++;
    if (!silent) this.game.toast(key === 'none' ? 'Back in your own gear' : `Disguised: ${DISGUISES[key].label}`, 'good');
  }

  coverHit(amount, why) {
    if (this.disguise === 'none' || this.disguiseBlown || this.inVent) return;
    this.cover = Math.max(0, this.cover - amount); this.coverT = 0; this.coverWhy = why;
    if (this.cover <= 0) {
      this.disguiseBlown = true; this.game.stats.ghost = false; this.game.stats.blown = (this.game.stats.blown || 0) + 1;
      this.game.toast(`Cover blown: ${why}. Change clothes or lie low`, 'bad');
    }
  }
  updateCover(dt) {
    if (this.disguise === 'none') return;
    this.coverT += dt;
    if (!this.disguiseBlown) { if (this.cover < 1 && this.coverT > 2.5) this.cover = Math.min(1, this.cover + 0.09 * dt); return; }
    // lying low (out of sight, no serious alarm) lets people forget the face
    if (this.coverT > 18 && this.game.alert.level < 2) { this.disguiseBlown = false; this.cover = 0.5; this.game.toast('Nobody is looking for that uniform any more', 'good'); }
  }

  // -------------------------------------------------------------------------------------------- update
  update(dt, I) {
    const g = this.game;
    this.updateCover(dt);
    this.hurtT = Math.max(0, this.hurtT - dt);
    if (this.state === 'down') { this.syncPose(dt); return; }
    this.updateAction(dt);
    this.updateBusy(dt, I);
    if (this.jump) this.updateJump(dt);
    if (this.slide) this.updateSlide(dt);

    // stance
    if (!this.locked && !this.slide && !this.jump) {
      if (I.crouchPressed) {
        if (this.running && this.speed > 2.6 && this.stance === 'stand') this.startSlide(I);
        else this.stance = this.stance === 'stand' ? 'crouch' : 'stand';
      }
      if (I.jump && this.stance === 'stand' && !this.carrying && !this.locked && !this.inVent) this.startJump(I);
    }
    this.running = !!(I.run && this.stance === 'stand' && !this.carrying && !this.inVent && I.mag > 0.3);
    if (this.running && this.stance !== 'stand') this.running = false;
    if (this.carrying && this.stance !== 'stand') this.stance = 'stand';

    // desired speed
    let sp = 0;
    if (!this.locked && !this.slide && !this.jump) {
      const base = this.inVent ? TUNING.crawlSpeed : this.carrying ? TUNING.carrySpeed : this.running ? TUNING.runSpeed : this.stance === 'crouch' ? TUNING.crouchSpeed : TUNING.walkSpeed;
      sp = base * I.mag;
      if (I.mag > 0.05) { this.moveToward(I.mx / Math.max(I.mag, 0.001), I.my / Math.max(I.mag, 0.001), sp, dt, 14); this.faceDir(I.mx, I.my, dt, this.running ? 12 : 9); }
      else { this.moveToward(0, 0, 0, dt, 16); }
    } else if (!this.slide && !this.jump) this.moveToward(0, 0, 0, dt, 20);

    // aim assist: face the cursor when using a gadget key
    this.integrate(dt);
    this.footsteps(dt);
    this.updateCarry();

    // animation
    this.syncPose(dt);
    this.light = g.field.sample(this.x, this.y).lum;

    // gadgets + interaction
    if (I.gadget !== null && I.gadget < GADGETS.length) { this.gadget = I.gadget; }
    if (I.cycle) this.gadget = (this.gadget + 1) % GADGETS.length;
    if (I.goggles && this.inv.goggles) this.toggleGoggles();
    if (I.fire && !this.locked && !this.slide && !this.jump && !this.inVent) this.useGadget();
    this.updateInteraction(dt, I);
    this.weaponOut = this.action && (this.action.clip === 'Pistol_Shoot' || this.action.clip === 'Pistol_Aim_Neutral');
  }

  syncPose(dt) {
    if (this.state === 'down' || this.locked) return;
    if (this.jump || this.slide) return;
    const v = this.speed;
    if (this.inVent) this.setPose(v > 0.15 ? 'crawl' : 'crawlIdle', Math.max(v, 0.4));
    else if (this.carrying) this.setPose(v > 0.15 ? 'carry' : 'idle', Math.max(v, 0.3));
    else if (this.stance === 'crouch') this.setPose(v > 0.15 ? 'crouchMove' : 'crouchIdle', Math.max(v, 0.3));
    else if (v > 3.0) this.setPose('run', v);
    else if (v > 0.15) this.setPose('walk', v);
    else this.setPose('idle');
  }

  // -------------------------------------------------------------------------------------------- noise
  footsteps(dt) {
    if (this.inVent) return;
    if (this.slide || this.jump || this.speed < 0.3) return;
    this.footAcc += this.speed * dt;
    const stride = this.running ? 1.9 : 1.0;
    if (this.footAcc >= stride) {
      this.footAcc = 0;
      const L = this.game.level, i = L.idx(Math.floor(this.x), Math.floor(this.y));
      const surf = FLOOR_NOISE[L.floorStyles[L.floor[i]]] || 1;
      this.game.audio && this.game.audio.step && this.game.audio.step(surf, this.running);
    }
  }

  // -------------------------------------------------------------------------------------------- slide + jump
  startSlide(I) {
    const dx = Math.sin(this.face), dy = Math.cos(this.face);
    this.slide = { t: 0, dur: 0.95, dx, dy };
    this.stance = 'crouch';
    this.game.noise(this.x, this.y, 3.2, 'slide', this);
    this.char.play('Slide_Loop', { fade: 0.08, speed: 1.3 });
    this.pose = 'slide';
  }
  updateSlide(dt) {
    const s = this.slide; s.t += dt;
    const k = 1 - s.t / s.dur, sp = TUNING.slideSpeed * Math.max(0, k) + 0.4;
    this.vx = s.dx * sp; this.vy = s.dy * sp;
    if (s.t >= s.dur) { this.slide = null; this.pose = null; }
  }
  startJump(I) {
    const dx = Math.sin(this.face), dy = Math.cos(this.face);
    const sp = Math.max(this.speed, 2.4);
    this.jump = { t: 0, dur: 0.75, dx, dy, sp, z: 0 };
    this.char.play('NinjaJump_Start', { fade: 0.05, loop: false, speed: 1.6 });
    this.pose = 'jump';
    this.game.noise(this.x, this.y, 3.5, 'jump', this);
  }
  updateJump(dt) {
    const j = this.jump; j.t += dt;
    const u = j.t / j.dur;
    j.z = Math.max(0, 4 * 0.85 * u * (1 - u)) * 1.0;          // parabola, apex ~0.85 m
    this.z = j.z;
    this.vx = j.dx * j.sp; this.vy = j.dy * j.sp;
    if (u > 0.55 && this.pose === 'jump') { this.char.play('NinjaJump_Land', { fade: 0.08, loop: false, speed: 1.9 }); this.pose = 'land'; }
    if (j.t >= j.dur) { this.jump = null; this.z = 0; this.pose = null; this.game.noise(this.x, this.y, 4.2, 'land', this); }
  }

  // -------------------------------------------------------------------------------------------- gadgets
  aimAt(gx, gy) { this.face = Math.atan2(gx - this.x, gy - this.y); }
  useGadget() {
    const g = this.game, I = g.input.mouse;
    const name = GADGETS[this.gadget];
    const tx = g.input.mouse.gx, ty = g.input.mouse.gy;
    if (g.input.touch && g.input.touch.aimTarget) { const t = g.input.touch.aimTarget(); if (t) { return this.fireGadget(name, t.x, t.y); } }
    this.fireGadget(name, tx, ty);
  }
  fireGadget(name, tx, ty) {
    const g = this.game;
    if (name === 'dart') {
      if (this.inv.darts <= 0) { g.toast('Out of darts', 'warn'); return; }
      this.inv.darts--; this.aimAt(tx, ty); g.stats.darts++;
      this.act('Pistol_Shoot', { speed: 1.5, onDone: () => { } });
      this.weaponOut = true;
      g.after(0.12, () => g.fireDart(this, tx, ty));
    } else if (name === 'coin') {
      if (this.inv.coins <= 0) { g.toast('No coins left', 'warn'); return; }
      this.inv.coins--; this.aimAt(tx, ty);
      const d = Math.min(9.5, Math.hypot(tx - this.x, ty - this.y));
      const px = this.x + Math.sin(this.face) * d, py = this.y + Math.cos(this.face) * d;
      this.act('OverhandThrow', { speed: 1.6 });
      g.after(0.25, () => g.throwObject(this, px, py, 'coin'));
    } else if (name === 'emp') {
      if (this.inv.emp <= 0) { g.toast('No EMP charges', 'warn'); return; }
      this.inv.emp--; this.aimAt(tx, ty);
      const d = Math.min(8, Math.hypot(tx - this.x, ty - this.y));
      const px = this.x + Math.sin(this.face) * d, py = this.y + Math.cos(this.face) * d;
      this.act('OverhandThrow', { speed: 1.4 });
      g.after(0.25, () => g.throwObject(this, px, py, 'emp'));
    }
  }
  toggleGoggles() {
    this.nvg = !this.nvg;
    this.game.R.grade.uniforms.uNV.value = this.nvg ? 1 : 0;
    this.game.toast(this.nvg ? 'Night vision on: hidden lasers revealed' : 'Night vision off', 'info');
  }

  // -------------------------------------------------------------------------------------------- carrying bodies
  updateCarry() {
    const b = this.carrying; if (!b) return;
    b.x = this.x - Math.sin(this.face) * 0.15; b.y = this.y - Math.cos(this.face) * 0.15; b.face = this.face;
    b.z = 0.95; b.hidden = false;
  }
  dropBody() {
    const b = this.carrying; if (!b) return;
    b.z = 0; this.carrying = null;
    b.x = this.x + Math.sin(this.face) * 0.7; b.y = this.y + Math.cos(this.face) * 0.7;
    if (this.game.level.circleBlocked(b.x, b.y, 0.3)) { b.x = this.x; b.y = this.y; }
    b.settleBody && b.settleBody();
  }

  // -------------------------------------------------------------------------------------------- hit points
  hit(from) {
    if (this.hurtT > 0 || this.state === 'down') return;
    this.hp--; this.hurtT = 1.2; this.game.R.cam.shake = 0.5; this.game.audio && this.game.audio.zap && this.game.audio.zap();
    this.game.toast(this.hp > 0 ? 'Tasered!' : 'Captured', 'bad');
    this.act('Hit_Chest', { speed: 1.2 });
    if (this.hp <= 0) this.game.failMission && this.game.failMission('captured');
  }

  // -------------------------------------------------------------------------------------------- busy (timed actions)
  // Timed interaction with a progress bar. cb runs when it completes; cancelled if the player moves away.
  startBusy(label, dur, cb, { illegal = null, anim = null, noise = 0, cancelDist = 1.6, near = null, hold = false } = {}) {
    this.busy = { label, t: 0, dur, cb, illegal, noise, cancelDist, near, anim, hold, x0: this.x, y0: this.y };
    if (anim) this.act(anim, { speed: 1, hold: true, lock: true });
    else this.locked = true;
  }
  updateBusy(dt, I) {
    const b = this.busy; if (!b) return;
    if (b.hold && !I.actionHeld) return this.cancelBusy();
    if (Math.hypot(this.x - b.x0, this.y - b.y0) > 0.4) return this.cancelBusy();
    b.t += dt;
    if (b.noise && Math.random() < dt * 1.2) this.game.noise(this.x, this.y, b.noise, 'work', this);
    if (b.t >= b.dur) { const cb = b.cb; this.busy = null; this.locked = false; this.action = null; this.pose = null; this.stance = this.stance; cb && cb(); }
  }
  cancelBusy() {
    if (!this.busy) return; this.busy = null; this.locked = false; this.action = null; this.pose = null;
    if (this.char) this.char.play('Idle_Loop', { fade: 0.15 });
  }

  // -------------------------------------------------------------------------------------------- interaction
  updateInteraction(dt, I) {
    if (this.busy || this.locked) { this.prompt = this.busy ? { label: this.busy.label, progress: this.busy.t / this.busy.dur, busy: true } : null; return; }
    const cands = this.game.findInteractions(this);
    const best = cands[0] || null;
    this.prompt = best ? { label: best.label, key: 'F', hold: best.hold || 0, enabled: best.enabled !== false, reason: best.reason, ref: best } : null;
    if (!best) { this.holdT = 0; return; }
    if (best.enabled === false) { if (I.action) this.game.toast(best.reason || 'Not possible right now', 'warn'); return; }
    if (best.hold > 0) {
      if (I.actionHeld) { this.holdT += dt; this.prompt.progress = this.holdT / best.hold; if (this.holdT >= best.hold) { this.holdT = 0; best.run(this); } }
      else this.holdT = 0;
    } else if (I.action) best.run(this);
  }
}

function prepareRimLater(p) { if (p.game.applyPlayerRim) p.game.applyPlayerRim(); }
