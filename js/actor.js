// Actor: any character in the world (player, guards, guests). Handles movement, collision, stances and animation.
import * as THREE from 'three';
import { createCharacter } from './characters.js';
import { prepareObject } from './materials.js';
import { CLIP_SPEED, TUNING } from './config.js';

export const angleDiff = (a, b) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };

export class Actor {
  static _n = 0;
  constructor(game, spec, x, y, face = 0) {
    this.game = game; this.spec = spec; this.id = ++Actor._n;
    this.x = x; this.y = y; this.z = 0; this.vx = 0; this.vy = 0; this.face = face;
    this.radius = TUNING.playerRadius;
    this.stance = 'stand';               // stand | crouch | crawl
    this.speed = 0; this.targetSpeed = 0;
    this.locked = false;                 // busy with a one-shot action
    this.state = 'active';               // active | down (unconscious) | hidden
    this.pose = null; this.action = null;
    this.turnRate = 9;
    this.bodyScale = 1;
    this.kind = 'actor';
    this.hidden = false;                 // inside a locker etc.
    this.blob = null;
  }

  async init(render = true) {
    this.char = await createCharacter(this.spec);
    prepareObject(this.char.group);
    if (this.spec.scale) this.char.model.scale.setScalar(this.spec.scale);
    if (this.spec.width) this.char.model.scale.x *= this.spec.width;
    this.group = this.char.group;
    this.game.R.actors.add(this.group);
    this.group.position.set(this.x, 0, this.y); this.group.rotation.y = this.face;
    this.setPose('idle');
    // soft blob shadow so figures stay grounded on the dark floor
    this.blob = new THREE.Mesh(new THREE.CircleGeometry(0.42, 16), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.42, depthWrite: false }));
    this.blob.rotation.x = -Math.PI / 2; this.blob.position.y = 0.03; this.group.add(this.blob);
    return this;
  }

  get fx() { return Math.sin(this.face); }
  get fy() { return Math.cos(this.face); }

  // ---- animation ----------------------------------------------------------
  setPose(pose, speed = 0) {
    const c = this.char; if (!c || this.locked) return;
    let clip = 'Idle_Loop', ts = 1;
    switch (pose) {
      case 'idle': clip = 'Idle_Loop'; break;
      case 'walk': clip = 'Walk_Loop'; ts = speed / CLIP_SPEED.Walk_Loop; break;
      case 'walkFormal': clip = 'Walk_Formal_Loop'; ts = speed / CLIP_SPEED.Walk_Formal_Loop; break;
      case 'run': clip = 'Jog_Fwd_Loop'; ts = speed / CLIP_SPEED.Jog_Fwd_Loop; break;
      case 'crouchIdle': clip = 'Crouch_Idle_Loop'; break;
      case 'crouchMove': clip = 'Crouch_Fwd_Loop'; ts = speed / CLIP_SPEED.Crouch_Fwd_Loop; break;
      case 'carry': clip = 'Walk_Carry_Loop'; ts = speed / CLIP_SPEED.Walk_Carry_Loop; break;
      case 'torch': clip = 'Idle_Torch_Loop'; break;
      case 'phone': clip = 'Idle_TalkingPhone_Loop'; break;
      case 'talk': clip = 'Idle_Talking_Loop'; break;
      case 'arms': clip = 'Idle_FoldArms_Loop'; break;
      case 'rail': clip = 'Idle_Rail_Loop'; break;
      case 'sit': clip = 'Sitting_Idle_Loop'; break;
      case 'aim': clip = 'Pistol_Aim_Neutral'; break;
      case 'pistolIdle': clip = 'Pistol_Idle_Loop'; break;
      case 'kneel': clip = 'Fixing_Kneeling'; break;
      case 'dance': clip = 'Dance_Loop'; break;
      case 'slide': clip = 'Slide_Loop'; ts = 1; break;
      default: clip = pose;
    }
    c.play(clip, { fade: 0.2, speed: Math.max(0.2, Math.min(3, ts)) });
    this.pose = pose;
  }
  // One-shot animation that blocks locomotion until it finishes. Returns a promise-like via callback.
  act(clip, { speed = 1, hold = false, onDone = null, fade = 0.15, lock = true } = {}) {
    const c = this.char; if (!c) return;
    const a = c.action(clip); if (!a) { onDone && onDone(); return; }
    const dur = a.getClip().duration / speed;
    c.play(clip, { fade, loop: false, speed, clamp: hold });
    this.locked = lock; this.action = { clip, t: 0, dur, hold, onDone };
  }
  updateAction(dt) {
    const a = this.action; if (!a) return;
    a.t += dt;
    if (a.t >= a.dur) { const cb = a.onDone; this.action = null; this.locked = false; this.pose = null; cb && cb(); }
  }

  // ---- movement -----------------------------------------------------------
  // desired velocity in world space (already includes speed)
  moveToward(dx, dy, speed, dt, accel = 12) {
    const k = Math.min(1, accel * dt);
    this.vx += (dx * speed - this.vx) * k; this.vy += (dy * speed - this.vy) * k;
  }
  faceToward(a, dt, rate = this.turnRate) { this.face += angleDiff(this.face, a) * Math.min(1, dt * rate); }
  faceDir(dx, dy, dt, rate) { if (Math.abs(dx) + Math.abs(dy) > 0.001) this.faceToward(Math.atan2(dx, dy), dt, rate); }

  get nav() { return this.game.level; }
  // Walk toward a world point following the flow field. Returns remaining straight-line distance.
  walkTo(tx, ty, speed, dt, { keys = true, arrive = 0.3, accel = 10 } = {}) {
    const L = this.nav, d = Math.hypot(tx - this.x, ty - this.y);
    if (d < arrive) { this.moveToward(0, 0, 0, dt, 14); return d; }
    let dx, dy;
    if (d < 7 && L.los(this.x, this.y, tx, ty)) { dx = (tx - this.x) / d; dy = (ty - this.y) / d; }
    else {
      const c = L.nearestWalkable(tx, ty), f = L.flowField(c.x, c.y, { keys });
      const st = L.flowStep(f, this.x, this.y);
      if (!st.found) { dx = (tx - this.x) / d; dy = (ty - this.y) / d; }
      else { const sx = st.x - this.x, sy = st.y - this.y, l = Math.hypot(sx, sy) || 1; dx = sx / l; dy = sy / l; }
    }
    this.moveToward(dx, dy, speed, dt, accel); this.faceDir(dx, dy, dt);
    return d;
  }

  integrate(dt) {
    const L = this.nav;
    const r = L.moveCircle(this.x, this.y, this.vx * dt, this.vy * dt, this.radius);
    this.x = r.x; this.y = r.y; if (r.hitX) this.vx = 0; if (r.hitY) this.vy = 0;
    this.speed = Math.hypot(this.vx, this.vy);
  }

  syncVisual(dt) {
    if (!this.group) return;
    this.group.position.set(this.x, this.z, this.y);
    this.group.rotation.y = this.face;
    this.char.update(dt);
  }
}
