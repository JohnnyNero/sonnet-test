// Security guards: patrols, perception (sight/sound), suspicion, investigation, search, alert, non-lethal downing.
import { Actor, angleDiff } from './actor.js';
import { TUNING } from './config.js';
import { exposure, judgeDisguise } from './stealth.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const HEAR = { step: 1, slide: 1, jump: 1, land: 1, work: 1, vent: 0.7, door: 0.8, coin: 1.15, glass: 1.2, bodyfall: 1, dart: 0.4, alarm: 1.4, bang: 1.0, emp: 1.0, laser: 1.3, zap: 1 };
const WAKE_TIME = 110;

export class Guard extends Actor {
  constructor(game, spec, x, y, opts = {}) {
    super(game, spec, x, y, opts.face || 0);
    this.kind = 'guard'; this.faction = 'guard';
    this.role = opts.role || 'guard';
    this.route = opts.route || []; this.routeIdx = 0; this.post = opts.post || null;
    this.state = 'patrol'; this.sub = 'idle';
    this.vRange = opts.vRange || 13; this.vFov = opts.vFov || (105 * Math.PI / 180); this.vNear = opts.vNear || 2.0;
    this.torchOn = false; this.torchRange = 10; this.torchAngle = 0.36;
    this.sus = 0; this.susHold = 0; this.stimulus = null; this.seesPlayer = false; this.lastSeen = null; this.lostT = 0;
    this.lookT = 0; this.waitT = 0; this.searchPts = []; this.alertT = 0; this.shootCd = 1.0;
    this.wakeT = 0; this.sedT = 0; this.checkT = 20 + Math.random() * 25; this.reported = false;
    this.hasKeycard = !!opts.keycard; this.carriesIntel = opts.intel || null;
    this.name = opts.name || 'Guard';
    this.giveUpT = 0; this.speedMul = 1; this.bodyCheckT = 0; this.conv = null;
    this.state = 'patrol';
  }

  canPass(d) { return !d.vault; }

  // observer descriptor for perception code
  obs() { return { x: this.x, y: this.y, face: this.face, vRange: this.vRange * (this.game.alert.level >= 1 ? 1.15 : 1), vFov: this.vFov * (this.state === 'alert' ? 1.1 : 1), vNear: this.vNear, torchOn: this.torchOn, torchRange: this.torchRange, torchAngle: this.torchAngle, faction: 'guard' }; }
  torchLight() { return { x: this.x + this.fx * 0.5, y: this.y + this.fy * 0.5, z: 1.3, color: [1, 0.95, 0.78], intensity: 1.35, range: this.torchRange + 0.5, angle: this.torchAngle, penumbra: 0.45, dir: Math.PI / 2 - this.face }; }

  // -------------------------------------------------------------------------------------------- update
  update(dt) {
    if (this.state === 'down') return this.updateDown(dt);
    if (this.state === 'sedated') return this.updateSedated(dt);
    this.updateAction(dt);
    const g = this.game, P = g.player;

    // flashlight policy: dark places, or once anything is wrong
    const lum = g.field.sample(this.x, this.y).lum;
    this.torchOn = g.alert.level >= 1 || lum < 0.10 || this.state === 'search' || this.state === 'investigate' && lum < 0.16;

    const e = this.senseVision(dt, P);
    this.senseHearing();
    this.senseBodies(dt);
    this.runState(dt, e);
    this.integrate(dt);
    this.updateCheckIn(dt);
    this.animate();
  }

  // -------------------------------------------------------------------------------------------- senses
  senseVision(dt, P) {
    const g = this.game;
    let e = 0, reason = null;
    if (P.state !== 'down' && !P.hidden && !P.inVent && !g.mission?.ended) {
      e = exposure(g, this.obs(), P);
      if (e > 0) {
        const J = judgeDisguise(g, this.obs(), P, e, dt);
        e = J.e; reason = J.reason;
      }
    }
    this.seesPlayer = e > 0.03; this.exposureNow = e;
    if (this.seesPlayer) {
      this.lastSeen = { x: P.x, y: P.y, t: g.time }; this.lostT = 0;
      const gain = this.state === 'alert' ? 2.5 : 1 / 1.35;                    // seconds to notice at full exposure
      this.sus = clamp(this.sus + e * gain * dt, 0, 1.6);
      this.susHold = 1.1;
      if (this.sus > 0.28 && this.state !== 'alert') this.notice(P, reason);
      if (this.sus >= 1 && this.state !== 'alert') this.goAlert(P, reason || 'spotted');
    } else {
      this.lostT += dt;
      if (this.susHold > 0) this.susHold -= dt; else this.sus = Math.max(0, this.sus - 0.2 * dt);
    }
    return e;
  }

  notice(P, reason) {
    if (this.state === 'patrol' || this.state === 'return' || this.state === 'search' || this.state === 'investigate' || this.state === 'conversing') {
      this.prevState = this.state === 'suspicious' ? this.prevState : this.state;
      this.state = 'suspicious'; this.stimulus = { x: P.x, y: P.y, kind: 'sight' }; this.lookT = 0;
      this.noticeReason = reason;
    } else if (this.state === 'suspicious') this.stimulus = { x: P.x, y: P.y, kind: 'sight' };
  }

  senseHearing() {
    const g = this.game, L = g.level;
    if (this.state === 'alert') return;
    for (const n of g.noises) {
      if (n.source === this) continue;
      const d = Math.hypot(n.x - this.x, n.y - this.y);
      const eff = d + L.wallsBetween(this.x, this.y, n.x, n.y) * 3.2;
      const r = n.radius * (HEAR[n.type] ?? 1) * (this.state === 'patrol' ? 1 : 1.15);
      if (eff > r) continue;
      if (n.source === g.player && (n.type === 'step' || n.type === 'slide' || n.type === 'land' || n.type === 'jump') && eff < r * 0.45) this.sus = Math.min(1.2, this.sus + 0.3);
      if (this.state === 'patrol' || this.state === 'return' || this.state === 'conversing') { this.hear(n); }
      else if (this.state === 'investigate' || this.state === 'search') { this.hear(n, true); }
      else if (this.state === 'suspicious') { this.stimulus = { x: n.x, y: n.y, kind: 'noise' }; }
    }
  }
  hear(n, refresh = false) {
    this.prevState = this.state === 'investigate' ? this.prevState : this.state;
    this.state = 'suspicious'; this.stimulus = { x: n.x, y: n.y, kind: 'noise', type: n.type }; this.lookT = 0; this.sus = Math.max(this.sus, 0.25);
    this.game.audio && this.game.audio.huh && this.game.audio.huh(this);
  }
  hearRadio(pos, why) {
    if (this.state === 'down' || this.state === 'sedated') return;
    if (this.state === 'alert') return;
    this.state = 'alert'; this.alertT = 0; this.lastSeen = { x: pos.x, y: pos.y, t: this.game.time }; this.sus = 1;
    this.searchPts = [];
  }

  senseBodies(dt) {
    this.bodyCheckT -= dt; if (this.bodyCheckT > 0) return; this.bodyCheckT = 0.3;
    const g = this.game;
    for (const a of g.actors) {
      if (a === this || a.state !== 'down' || a.hidden || a.found) continue;
      if (a.z > 0.5) continue;                 // being carried
      const d = Math.hypot(a.x - this.x, a.y - this.y);
      if (d > this.vRange * 0.9) continue;
      const off = Math.abs(angleDiff(this.face, Math.atan2(a.x - this.x, a.y - this.y)));
      if (d > 2 && off > this.vFov / 2) continue;
      if (g.level.ray(this.x, this.y, a.x, a.y).hit) continue;
      if (g.field.sample(a.x, a.y).lum < 0.05 && d > 3) continue;
      a.found = true; g.stats.bodiesFound++; g.stats.ghost = false;
      g.toast('A guard found a body', 'warn');
      g.raiseAlert(1, { x: a.x, y: a.y }, 'body');
      this.state = 'suspicious'; this.stimulus = { x: a.x, y: a.y, kind: 'body' }; this.lookT = 0; this.sus = Math.max(this.sus, 0.6);
      // colleagues come to look
      for (const o of g.guards) if (o !== this && o.state === 'patrol' && Math.hypot(o.x - a.x, o.y - a.y) < 22) { o.stimulus = { x: a.x, y: a.y, kind: 'body' }; o.prevState = 'patrol'; o.state = 'investigate'; o.lookT = 0; }
      break;
    }
  }

  // -------------------------------------------------------------------------------------------- goal state machine
  goAlert(P, reason) {
    this.state = 'alert'; this.alertT = 0; this.sus = 1.2; this.lastSeen = { x: P.x, y: P.y, t: this.game.time }; this.searchPts = [];
    this.game.stats.spotted++;
    this.game.raiseAlert(2, { x: P.x, y: P.y }, reason);
    this.game.audio && this.game.audio.shout && this.game.audio.shout(this);
  }

  runState(dt, e) {
    const g = this.game, P = g.player;
    const speedMul = g.alert.level >= 1 ? 1.12 : 1;
    switch (this.state) {
      case 'patrol': this.doPatrol(dt, speedMul); break;
      case 'conversing': this.doPatrol(dt, speedMul); break;
      case 'suspicious': {
        this.moveToward(0, 0, 0, dt, 12);
        const s = this.stimulus;
        if (s) this.faceToward(Math.atan2(s.x - this.x, s.y - this.y), dt, 8);
        this.lookT += dt;
        if (this.sus >= 1) { this.goAlert(P, 'spotted'); break; }
        const needed = s && s.kind === 'body' ? 0.6 : 1.4;
        if (this.lookT > needed) {
          if (s && (s.kind === 'noise' || s.kind === 'body' || (s.kind === 'sight' && this.sus > 0.25))) { this.state = 'investigate'; this.lookT = 0; this.waitT = 0; this.investigatePhase = 0; }
          else { this.state = this.prevState || 'patrol'; }
        }
        break;
      }
      case 'investigate': this.doInvestigate(dt, speedMul); break;
      case 'search': this.doSearch(dt, speedMul); break;
      case 'return': {
        const w = this.currentWaypoint();
        if (!w) { this.state = 'patrol'; break; }
        const d = this.walkTo(w.x, w.y, TUNING.guardWalk * speedMul, dt);
        if (d < 0.45) this.state = 'patrol';
        break;
      }
      case 'alert': this.doAlert(dt, e); break;
    }
    if (this.sus >= 1.0 && this.state !== 'alert' && this.state !== 'suspicious') { /* handled in senseVision */ }
  }

  currentWaypoint() { if (this.route.length) return this.route[this.routeIdx % this.route.length]; return this.post; }

  doPatrol(dt, speedMul) {
    const w = this.currentWaypoint();
    if (!w) { this.moveToward(0, 0, 0, dt, 12); return; }
    if (this.waitT > 0) {
      this.waitT -= dt; this.moveToward(0, 0, 0, dt, 12);
      if (w.face !== undefined) this.faceToward(w.face + (w.sweep ? Math.sin(this.game.time * 0.6) * w.sweep : 0), dt, 5);
      if (this.waitT <= 0 && this.route.length) { this.routeIdx = (this.routeIdx + 1) % this.route.length; this.state = 'patrol'; }
      return;
    }
    const d = this.walkTo(w.x, w.y, TUNING.guardWalk * speedMul, dt, { arrive: 0.25 });
    if (d < 0.35) { this.waitT = w.wait !== undefined ? w.wait : 1.5; this.arrivePose = w.pose || 'idle'; if (!this.route.length) this.waitT = 1e9; }
  }

  doInvestigate(dt, speedMul) {
    const s = this.stimulus; if (!s) { this.state = 'return'; return; }
    if (this.investigatePhase === 0) {
      const d = this.walkTo(s.x, s.y, TUNING.guardWalk * 1.15 * speedMul, dt, { arrive: 0.7 });
      if (d < 0.8 || this.giveUpT > 12) { this.investigatePhase = 1; this.lookT = 0; this.giveUpT = 0; } else this.giveUpT += dt;
    } else {
      // look around
      this.moveToward(0, 0, 0, dt, 12);
      this.lookT += dt;
      const sweep = Math.sin(this.lookT * 1.7) * 1.0;
      this.face += angleDiff(this.face, this.face + sweep * dt * 2.2) * 1;
      this.face += sweep * dt * 1.2;
      if (this.lookT > 4.0) {
        // found something? bodies escalate
        if (s.kind === 'body') { this.state = 'search'; this.searchPts = this.genSearchPoints(s.x, s.y, 3); this.searchT = 0; }
        else if (this.game.alert.level >= 1) { this.state = 'search'; this.searchPts = this.genSearchPoints(s.x, s.y, 2); this.searchT = 0; }
        else { this.state = 'return'; this.stimulus = null; }
      }
    }
  }
  genSearchPoints(x, y, n) {
    const L = this.game.level, pts = [];
    for (let i = 0; i < n * 6 && pts.length < n; i++) {
      const a = Math.random() * Math.PI * 2, r = 3 + Math.random() * 6;
      const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
      if (L.walkable(Math.floor(px), Math.floor(py), { keys: true }) && L.zoneTypeAt(px, py) !== 'vault') pts.push({ x: px, y: py });
    }
    return pts;
  }
  doSearch(dt, speedMul) {
    this.searchT = (this.searchT || 0) + dt;
    if (!this.searchPts.length || this.searchT > 26) { this.state = 'return'; this.stimulus = null; this.sus = 0; return; }
    const p = this.searchPts[0];
    const d = this.walkTo(p.x, p.y, TUNING.guardWalk * 1.1 * speedMul, dt, { arrive: 0.8 });
    if (d < 0.9) {
      this.lookT = (this.lookT || 0) + dt; this.moveToward(0, 0, 0, dt, 12);
      this.face += Math.sin(this.lookT * 2.0) * dt * 1.6;
      if (this.lookT > 2.2) { this.searchPts.shift(); this.lookT = 0; }
    }
  }

  doAlert(dt, e) {
    const g = this.game, P = g.player; this.alertT += dt;
    const ls = this.lastSeen;
    if (this.seesPlayer) { this.searchPts = []; }
    const target = this.seesPlayer ? { x: P.x, y: P.y } : ls;
    if (!target) { this.state = 'search'; this.searchPts = this.genSearchPoints(this.x, this.y, 3); return; }
    const d = Math.hypot(target.x - this.x, target.y - this.y);
    const canShoot = this.seesPlayer && d < 9.5 && !g.mission?.ended;
    if (canShoot) {
      this.moveToward(0, 0, 0, dt, 12);
      this.faceToward(Math.atan2(P.x - this.x, P.y - this.y), dt, 12);
      this.shootCd -= dt;
      if (this.shootCd <= 0 && Math.abs(angleDiff(this.face, Math.atan2(P.x - this.x, P.y - this.y))) < 0.25) {
        this.shootCd = 1.35 + Math.random() * 0.4; this.shooting = 0.3; g.fireTaser && g.fireTaser(this);
      }
      this.aimPose = true;
    } else {
      this.aimPose = false;
      const dd = this.walkTo(target.x, target.y, TUNING.guardRun * (g.alert.level >= 3 ? 1.08 : 1), dt, { arrive: 1.1 });
      if (!this.seesPlayer && dd < 1.4) {
        this.lookT = (this.lookT || 0) + dt; this.moveToward(0, 0, 0, dt, 12);
        if (this.lookT > 1.6) { this.state = 'search'; this.searchPts = this.genSearchPoints(target.x, target.y, 4); this.searchT = 0; this.lookT = 0; this.sus = 0.5; }
      } else this.lookT = 0;
    }
    // lost them for a long time
    if (!this.seesPlayer && this.lostT > 12) { this.state = 'search'; this.searchPts = this.genSearchPoints(target.x, target.y, 4); this.searchT = 0; this.sus = 0.4; }
    if (g.alert.level < 2 && !this.seesPlayer && this.lostT > 3) { this.state = 'search'; this.searchPts = this.genSearchPoints(target.x, target.y, 3); this.searchT = 0; }
  }

  // -------------------------------------------------------------------------------------------- animation
  animate() {
    if (this.locked) return;
    const v = this.speed;
    if (this.state === 'alert') {
      if (this.aimPose && v < 0.5) this.setPose('pistolIdle');
      else if (v > 2.5) this.setPose('run', v); else if (v > 0.15) this.setPose('walk', v); else this.setPose('idle');
      return;
    }
    if (v > 2.6) this.setPose('run', v);
    else if (v > 0.15) this.setPose(this.torchOn ? 'walk' : 'walk', v);
    else {
      const w = this.currentWaypoint();
      if (this.state === 'patrol' && this.waitT > 0 && w && w.pose) this.setPose(w.pose);
      else if (this.torchOn && (this.state === 'investigate' || this.state === 'search' || this.state === 'suspicious')) this.setPose('torch');
      else if (this.state === 'suspicious') this.setPose('arms' === 'x' ? 'arms' : 'idle');
      else this.setPose(this.torchOn ? 'torch' : 'idle');
    }
  }

  // -------------------------------------------------------------------------------------------- radio check-ins
  updateCheckIn(dt) {
    if (this.state === 'down') return;
    this.checkT -= dt;
    if (this.checkT <= 0) this.checkT = 30 + Math.random() * 25;
  }

  // -------------------------------------------------------------------------------------------- non-lethal outcomes
  sedate(source) {
    if (this.state === 'down' || this.state === 'sedated') return;
    this.state = 'sedated'; this.sedT = 2.1;
    this.locked = false; this.action = null;
    this.act('Hit_Chest', { speed: 1.4, fade: 0.05 });
    this.game.stats.knockouts++;
    if (this.state === 'sedated' && !this.seesPlayer) { this.stimulus = { x: source.x, y: source.y, kind: 'noise' }; }
  }
  updateSedated(dt) {
    this.sedT -= dt; this.updateAction(dt);
    // stumble forward a little, groggy
    this.moveToward(Math.sin(this.face), Math.cos(this.face), 0.35, dt, 6); this.integrate(dt);
    if (this.sedT <= 0) this.knockout(true);
  }
  knockout(silent = false) {
    if (this.state === 'down') return;
    this.state = 'down'; this.locked = false; this.action = null; this.torchOn = false; this.wakeT = WAKE_TIME; this.found = false;
    this.moveToward(0, 0, 0, 1, 20); this.vx = this.vy = 0;
    this.char.play('Death01', { fade: 0.08, loop: false, clamp: true, speed: 1.3 });
    this.game.noise(this.x, this.y, 2.6, 'bodyfall', this);
    this.game.stats.knockouts += silent ? 0 : 1;
    this.fallT = 0;
  }
  updateDown(dt) {
    this.fallT = (this.fallT || 0) + dt;
    this.wakeT -= dt;
    if (this.hidden) {
      // muffled banging from inside a locker after a while
      this.bangT = (this.bangT || 0) + dt;
      if (this.wakeT < 45 && this.bangT > 4) { this.bangT = 0; this.game.noise(this.x, this.y, 7, 'bang', this); }
    }
    if (this.wakeT <= 0) this.wakeUp();
  }
  settleBody() { this.char.play('Death01', { fade: 0.05, loop: false, clamp: true, speed: 8 }); }
  wakeUp() {
    this.state = 'alert'; this.alertT = 0; this.hidden = false; this.z = 0;
    this.char.play('LayToIdle', { fade: 0.1, loop: false, speed: 1.2 });
    this.locked = true; this.action = { clip: 'LayToIdle', t: 0, dur: 1.1, onDone: () => { } };
    this.game.toast('A guard woke up', 'warn');
    const P = this.game.player;
    this.lastSeen = { x: this.x, y: this.y, t: this.game.time };
    this.game.raiseAlert(1, { x: this.x, y: this.y }, 'guard awake');
    this.state = 'search'; this.searchPts = this.genSearchPoints(this.x, this.y, 3); this.searchT = 0;
  }
}
