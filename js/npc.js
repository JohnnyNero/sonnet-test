// Civilians and staff: guests, waiters, chefs, executives. They mingle, and they WITNESS suspicious things.
import { Actor, angleDiff } from './actor.js';
import { TUNING } from './config.js';
import { exposure, judgeDisguise } from './stealth.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class Npc extends Actor {
  constructor(game, spec, x, y, opts = {}) {
    super(game, spec, x, y, opts.face || 0);
    this.kind = 'npc'; this.faction = opts.faction || 'guest';
    this.behavior = opts.behavior || 'idle';      // idle | wander | route | dance
    this.pose = null; this.idlePose = opts.pose || 'idle';
    this.route = opts.route || []; this.routeIdx = 0; this.home = opts.home || null; this.waitT = Math.random() * 3;
    this.vRange = 9; this.vFov = 2.2; this.vNear = 1.5;
    this.sus = 0; this.state = 'active'; this.fleeT = 0; this.wakeT = 0; this.hasKeycard = !!opts.keycard; this.carriesIntel = opts.intel || null;
    this.name = opts.name || 'Guest'; this.walkSpeed = opts.speed || TUNING.npcWalk; this.important = !!opts.important;
    this.partner = opts.partner || null; this.witnessed = false;
  }
  canPass(d) { return !d.lock || this.faction === 'chef' || this.faction === 'staff' || this.faction === 'exec'; }
  obs() { return { x: this.x, y: this.y, face: this.face, vRange: this.vRange, vFov: this.vFov, vNear: this.vNear, torchOn: false, faction: this.faction }; }

  update(dt) {
    const g = this.game;
    if (this.state === 'down') { this.wakeT -= dt; if (this.wakeT <= 0) this.wakeUp(); return; }
    if (this.state === 'sedated') { this.sedT -= dt; this.updateAction(dt); if (this.sedT <= 0) this.knockout(); return; }
    this.updateAction(dt);
    const P = g.player;
    // ---- witness logic
    if (this.fleeT > 0) { this.fleeT -= dt; this.flee(dt); this.integrate(dt); this.animateMove(); return; }
    if (P.state !== 'down' && !P.hidden && !P.inVent) {
      let e = exposure(g, this.obs(), P);
      if (e > 0) {
        const J = judgeDisguise(g, this.obs(), P, e, dt, { odd: 0.5, see: 0.2, tres: 0.75 });
        e = J.e;
        // crowds are forgiving for a stranger at range
        if (this.faction === 'guest' && J.v === 'naked' && Math.hypot(P.x - this.x, P.y - this.y) > 7) e *= 0.5;
      }
      if (e > 0.05) { this.sus = clamp(this.sus + e * dt / 1.8, 0, 1.2); this.faceToward(Math.atan2(P.x - this.x, P.y - this.y), dt, 4); }
      else this.sus = Math.max(0, this.sus - dt * 0.15);
      if (this.sus >= 1 && !this.witnessed) this.witness(P, 'intruder');
    }
    // bodies
    this.bodyT = (this.bodyT || 0) - dt;
    if (this.bodyT <= 0) {
      this.bodyT = 0.5;
      for (const a of g.actors) {
        if (a === this || a.state !== 'down' || a.hidden || a.z > 0.5) continue;
        const d = Math.hypot(a.x - this.x, a.y - this.y);
        if (d > 7 || g.level.ray(this.x, this.y, a.x, a.y).hit) continue;
        if (Math.abs(angleDiff(this.face, Math.atan2(a.x - this.x, a.y - this.y))) > this.vFov / 2 && d > 2) continue;
        if (!a.found) { a.found = true; g.stats.bodiesFound++; g.stats.ghost = false; }
        this.witness(a, 'body'); break;
      }
    }
    // ---- behaviour
    if (this.sus > 0.3) { this.moveToward(0, 0, 0, dt, 10); this.integrate(dt); this.setPose('idle'); return; }
    switch (this.behavior) {
      case 'wander': this.doWander(dt); break;
      case 'route': this.doRoute(dt); break;
      default: this.moveToward(0, 0, 0, dt, 10); if (this.waitT <= 0 || true) this.setPose(this.idlePose); break;
    }
    this.integrate(dt);
    if (this.behavior === 'wander' || this.behavior === 'route') this.animateMove();
  }

  animateMove() {
    if (this.locked) return;
    const v = this.speed;
    if (this.fleeT > 0) this.setPose('run', Math.max(v, 3));
    else if (v > 0.15) this.setPose('walkFormal', v);
    else this.setPose(this.idlePose);
  }

  doWander(dt) {
    if (this.waitT > 0) { this.waitT -= dt; this.moveToward(0, 0, 0, dt, 10); this.setPose(this.idlePose); return; }
    if (!this.target) {
      const L = this.game.level, r = this.home || L.roomAt(this.x, this.y);
      const c = r && L.randomCellIn(r, this.game.rng, (x, y) => L.walkable(x, y));
      if (!c) { this.waitT = 2; return; } this.target = c;
    }
    const d = this.walkTo(this.target.x, this.target.y, this.walkSpeed, dt, { keys: this.faction !== 'guest' });
    this.animateMove();
    if (d < 0.5) { this.target = null; this.waitT = 3 + Math.random() * 8; this.idlePose = Math.random() < 0.35 ? 'phone' : Math.random() < 0.6 ? 'talk' : 'idle'; }
  }
  doRoute(dt) {
    if (!this.route.length) { this.behavior = 'idle'; return; }
    const w = this.route[this.routeIdx % this.route.length];
    if (this.waitT > 0) { this.waitT -= dt; this.moveToward(0, 0, 0, dt, 10); this.setPose(w.pose || 'idle'); if (w.face !== undefined) this.faceToward(w.face, dt, 4); return; }
    const d = this.walkTo(w.x, w.y, this.walkSpeed, dt, { keys: this.faction !== 'guest' });
    this.animateMove();
    if (d < 0.4) { this.waitT = w.wait ?? 2; this.routeIdx++; }
  }

  witness(what, kind) {
    const g = this.game;
    this.witnessed = true; this.fleeT = 6;
    this.act('Hit_Head', { speed: 1.3 });
    const pos = { x: what.x, y: what.y };
    g.toast(kind === 'body' ? 'A guest saw the body!' : 'A witness is raising the alarm', 'warn');
    g.raiseAlert(kind === 'body' ? 1 : 2, pos, 'witness');
    // send the nearest guards
    const gs = g.guards.filter(x => x.state !== 'down' && x.state !== 'sedated').sort((a, b) => Math.hypot(a.x - this.x, a.y - this.y) - Math.hypot(b.x - this.x, b.y - this.y)).slice(0, 2);
    for (const gd of gs) { gd.stimulus = { x: pos.x, y: pos.y, kind: kind === 'body' ? 'body' : 'sight' }; if (gd.state !== 'alert') { gd.prevState = 'patrol'; gd.state = 'investigate'; gd.investigatePhase = 0; gd.giveUpT = 0; } }
    g.audio && g.audio.scream && g.audio.scream();
    setTimeout(() => { this.witnessed = false; }, 20000);
  }
  flee(dt) {
    const g = this.game, P = g.player;
    const dx = this.x - P.x, dy = this.y - P.y, d = Math.hypot(dx, dy) || 1;
    this.moveToward(dx / d, dy / d, 3.4, dt, 10); this.faceDir(dx, dy, dt, 10);
  }

  sedate() { if (this.state === 'down' || this.state === 'sedated') return; this.state = 'sedated'; this.sedT = 1.6; this.act('Hit_Chest', { speed: 1.3 }); this.game.stats.knockouts++; }
  knockout() {
    if (this.state === 'down') return;
    this.state = 'down'; this.locked = false; this.action = null; this.wakeT = 150; this.found = false; this.vx = this.vy = 0;
    this.char.play('Death01', { fade: 0.08, loop: false, clamp: true, speed: 1.3 });
    this.game.noise(this.x, this.y, 2.4, 'bodyfall', this);
  }
  settleBody() { this.char.play('Death01', { fade: 0.05, loop: false, clamp: true, speed: 8 }); }
  wakeUp() {
    this.state = 'active'; this.hidden = false; this.z = 0; this.witnessed = false;
    this.char.play('LayToIdle', { fade: 0.1, loop: false, speed: 1.2 }); this.locked = true; this.action = { clip: 'LayToIdle', t: 0, dur: 1.1, onDone: () => { this.witness(this, 'body'); } };
  }
}
