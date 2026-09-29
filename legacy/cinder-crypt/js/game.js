// Game logic: hero, skills, monsters + AI, status/reaction rules, projectiles, props, loot.
import * as THREE from 'three';
import { RNG, clamp, dist, angleDiff } from './util.js';
import { generate, distanceField, hasLOS, W, H } from './dungeon.js';
import { Surfaces } from './surfaces.js';
import { rollItem, computeStats, SLOTS, RARITY } from './loot.js';
import { sfx } from './audio.js';
import { animateRig, setTint, makeRig } from './models.js';

export const FLOORS = 3;
const BAG_SIZE = 18;

// ------------------------------------------------------------------ monster definitions
const MON = {
  skeleton: { name: 'Skeleton', model: 'skeleton', hp: 30, speed: 2.7, r: 0.3, dmg: 8, ai: 'melee', range: 1.15, cd: 1.1, wind: 0.5, sight: 12 },
  archer: { name: 'Skeleton Archer', model: 'archer', hp: 22, speed: 2.5, r: 0.3, dmg: 7, ai: 'archer', sight: 13 },
  brute: { name: 'Ghoul Brute', model: 'brute', hp: 120, speed: 2.0, r: 0.6, dmg: 20, ai: 'brute', range: 1.9, cd: 2.2, wind: 1.0, sight: 11, scale: 1.1, fireRes: 0.35, heavy: true },
  shaman: { name: 'Tar Shaman', model: 'shaman', hp: 32, speed: 2.4, r: 0.32, dmg: 11, ai: 'shaman', sight: 13 },
  bat: { name: 'Grave Bat', model: 'bat', hp: 10, speed: 5.0, r: 0.22, dmg: 4, ai: 'bat', flying: true, sight: 12, hover: 0.15 },
  boss: { name: 'The Grave King', model: 'boss', hp: 800, speed: 2.3, r: 0.85, dmg: 24, ai: 'boss', sight: 30, scale: 1.0, heavy: true, boss: true },
};
const COST = { skeleton: 1, archer: 1.6, bat: 2.2, shaman: 2.6, brute: 3.2 };
const MODS = {
  leaky: { label: 'Leaking', color: '#8a6cff' },
  ember: { label: 'Ember-touched', color: '#ff7a2a' },
  storm: { label: 'Storm-charged', color: '#66e6ff' },
};

const SK = {
  q: { name: 'Firebolt', cd: 0.9 },
  w: { name: 'Frost Nova', cd: 8 },
  e: { name: 'Chain Lightning', cd: 3 },
  r: { name: 'Oil Flask', cd: 6 },
};

export class Game {
  constructor(world, ui) {
    this.world = world; this.ui = ui;
    this.state = 'title';
    this.mouse = { x: 0, y: 0, down: false, gx: 0, gy: 0 };
    this.keys = new Set();
    this.touch = { active: false, mx: 0, my: 0, attack: false };
    this.time = 0;
    this.hoverEnemy = null;
    this.paused = false;
  }

  // ------------------------------------------------------------------ run / floor lifecycle
  newRun(seed) {
    this.seed = seed ?? ((Math.random() * 99999) | 0) + 1;
    this.floor = 1;
    this.equipped = {}; this.bag = [];
    this.hero = {
      kind: 'hero', x: 0, y: 0, vx: 0, vy: 0, r: 0.3, face: 0, hp: 100, maxHp: 100, dead: false,
      st: { burn: 0, wet: 0, oil: 0, frozen: 0, chill: 0, stun: 0 }, shockCd: 0, flash: 0,
      cd: { q: 0, w: 0, e: 0, r: 0, atk: 0 }, atk: null, cast: 0, stats: computeStats({}), trail: 0, burnAcc: 0, burnDps: 6, hurtT: 0,
    };
    this.run = { kills: 0, items: 0, burned: 0, arcs: 0, frozen: 0, time: 0 };
    this.startFloor();
    this.state = 'play';
    this.ui.overlay(null);
    this.ui.toast('Floor 1 — Find the stairs down', '#ffd9a0');
    this.ui.renderInventory(this);
  }

  startFloor() {
    const boss = this.floor === FLOORS;
    this.level = generate(this.seed, this.floor, boss);
    this.surf = new Surfaces(W, H, this.level.tiles);
    this.world.buildLevel(this.level, this.surf);
    this.rng = new RNG(this.seed * 13 + this.floor * 977);
    this.enemies = []; this.projectiles = []; this.barrels = []; this.chests = []; this.braziers = []; this.loot = [];
    this.pendingSpawns = [];
    const h = this.hero;
    h.x = this.level.start.x + 0.5; h.y = this.level.start.y + 0.5; h.vx = h.vy = 0;
    h.st = { burn: 0, wet: 0, oil: 0, frozen: 0, chill: 0, stun: 0 };
    h.rig = this.world.spawnActor('hero', 1);
    this.world.camTarget.set(h.x, 0, h.y);
    this.exploredMap = new Uint8Array(W * H);
    this.flowTile = -1; this.flow = null;
    this.moveField = null; this.moveFieldTile = -1;
    this.populate();
    // exit portal
    const ex = this.level.exit;
    this.exit = null;
    if (!boss) {
      const rig = this.world.spawnActor('exit', 1);
      rig.group.position.set(ex.x, 0, ex.y);
      this.exit = { x: ex.x, y: ex.y, rig, t: 0 };
    }
    this.exitLock = 1.0;
    this.recalcStats();
  }

  // ------------------------------------------------------------------ level population
  populate() {
    const { level, rng, surf } = this;
    const floor = this.floor;
    level.rooms.forEach((r, i) => { r.index = i; });
    level.rooms.forEach((room, ri) => {
      const cells = room.cells;
      if (!cells.length) return;
      const rc = () => rng.pick(cells);
      const inside = (x, y) => cells.some(c => c.x === x && c.y === y);
      const start = room.kind === 'start', boss = room.kind === 'boss';
      const cx = room.cx, cy = room.cy, rad = Math.min(room.w, room.h) / 2;

      // ---- terrain flavour
      const flavour = boss ? 'boss' : start ? 'start' : rng.pick(['flooded', 'oil', 'braziers', 'barrels', 'mixed', 'plain', 'oil', 'flooded', 'mixed']);
      const blob = (kind, x, y, r) => surf.pour(kind, x, y, r);
      const barrel = (type, c) => this.addBarrel(type, c.x + 0.5, c.y + 0.5);
      const farFromStart = c => dist(c.x, c.y, level.start.x, level.start.y) > 7;
      if (flavour === 'start') {
        const a = rc(), b = rc();
        blob('water', a.x + 0.5, a.y + 0.5, 1.8);
        for (let i = 0; i < 2; i++) { const c = rng.pick(cells.filter(c => dist(c.x, c.y, level.start.x, level.start.y) > 2.5 && dist(c.x, c.y, a.x, a.y) > 3)); if (c) barrel(i ? 'water' : 'oil', c); }
        blob('oil', b.x + 0.5, b.y + 0.5, 1.3);
      } else if (flavour === 'flooded') {
        blob('water', cx, cy, rad * 0.55 + rng.range(0, 1));
        for (let i = rng.int(1, 2); i > 0; i--) { const c = rc(); blob('water', c.x + 0.5, c.y + 0.5, rng.range(1, 1.8)); }
      } else if (flavour === 'oil') {
        for (let i = rng.int(1, 3); i > 0; i--) { const c = rc(); blob('oil', c.x + 0.5, c.y + 0.5, rng.range(1.2, 2.4)); }
        for (let i = rng.int(1, 3); i > 0; i--) barrel('oil', rc());
      } else if (flavour === 'braziers') {
        const spots = rng.shuffle(cells.filter(c => dist(c.x + 0.5, c.y + 0.5, cx, cy) > rad * 0.6)).slice(0, 2);
        spots.forEach(c => this.addBrazier(c.x, c.y));
        const far = cells.filter(c => spots.every(s => dist(c.x, c.y, s.x, s.y) > 4));
        if (far.length) { const c = rng.pick(far); blob('oil', c.x + 0.5, c.y + 0.5, 2.0); if (rng.chance(0.6)) blob('water', cx, cy, 1.4); }
        barrel('oil', rng.pick(far.length ? far : cells));
      } else if (flavour === 'barrels') {
        for (let i = rng.int(3, 5); i > 0; i--) barrel(rng.chance(0.55) ? 'oil' : 'water', rc());
      } else if (flavour === 'mixed') {
        const a = rc(), b = rc();
        blob('water', a.x + 0.5, a.y + 0.5, rng.range(1.6, 2.6));
        blob('oil', b.x + 0.5, b.y + 0.5, rng.range(1.4, 2.4));
        barrel(rng.chance(0.5) ? 'oil' : 'water', rc());
      } else if (flavour === 'boss') {
        // arena: a ring of water, oil channels, four braziers
        for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2 + 0.3; blob('water', cx + Math.cos(a) * rad * 0.62, cy + Math.sin(a) * rad * 0.62 * (room.h / room.w), 1.6); }
        for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2 + Math.PI / 4; for (let k = 1; k <= 3; k++) blob('oil', cx + Math.cos(a) * k * 1.7, cy + Math.sin(a) * k * 1.7 * 0.8, 0.9); }
        for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2; const bx = Math.round(cx + Math.cos(a) * rad * 0.9), by = Math.round(cy + Math.sin(a) * rad * 0.7); if (inside(bx, by)) this.addBrazier(bx, by); }
        for (let i = 0; i < 5; i++) barrel(rng.chance(0.5) ? 'oil' : 'water', rc());
      }

      // ---- chests
      if (!start && !boss && rng.chance(0.4)) {
        const c = rng.pick(cells.filter(c => dist(c.x, c.y, level.start.x, level.start.y) > 5));
        if (c) this.addChest(c.x + 0.5, c.y + 0.5);
      }

      // ---- monsters
      if (start) return;
      if (boss) {
        this.spawnEnemy('boss', cx, cy);
        for (let i = 0; i < 4; i++) { const c = rc(); this.spawnEnemy('skeleton', c.x + 0.5, c.y + 0.5); }
        return;
      }
      let budget = (3.5 + floor * 2.4 + rng.range(0, 3)) * clamp(cells.length / 70, 0.6, 1.4) * (room.kind === 'exit' ? 0.8 : 1);
      let guard = 0;
      while (budget > 0.9 && guard++ < 30) {
        const affordable = Object.keys(COST).filter(k => COST[k] <= budget + 0.4);
        if (!affordable.length) break;
        const t = rng.pick(affordable);
        const pool = cells.filter(farFromStart);
        if (!pool.length) break;
        const c = rng.pick(pool);
        const n = t === 'bat' ? rng.int(3, 4) : t === 'skeleton' ? rng.int(1, 3) : 1;
        for (let i = 0; i < n; i++) {
          const jx = c.x + 0.5 + rng.range(-0.8, 0.8), jy = c.y + 0.5 + rng.range(-0.8, 0.8);
          if (!this.blocked(jx, jy, 0.3)) this.spawnEnemy(t, jx, jy, rng.chance(0.09 + 0.035 * floor) && t !== 'bat' ? rng.pick(Object.keys(MODS)) : null);
        }
        budget -= COST[t] * (t === 'bat' ? 1.4 : Math.max(1, n * 0.7));
      }
    });
  }

  addBarrel(type, x, y) {
    if (this.blocked(x, y, 0.38)) return;
    const rig = makeRig('barrel_' + type);
    rig.group.position.set(x, 0, y); rig.group.rotation.y = this.rng.range(0, 6);
    this.world.actors.add(rig.group);
    this.barrels.push({ type, x, y, r: 0.38, rig, dead: false });
  }
  addBrazier(x, y) {
    const rig = makeRig('brazier'); rig.group.position.set(x + 0.5, 0, y + 0.5); this.world.actors.add(rig.group);
    this.surf.brazier(x, y);
    this.braziers.push({ x: x + 0.5, y: y + 0.5, rig });
  }
  addChest(x, y) {
    const rig = makeRig('chest'); rig.group.position.set(x, 0, y); rig.group.rotation.y = this.rng.pick([0, Math.PI / 2, Math.PI, -Math.PI / 2]);
    this.world.actors.add(rig.group);
    this.chests.push({ x, y, rig, open: 0, opened: false });
  }

  spawnEnemy(type, x, y, mod = null) {
    const def = MON[type];
    const f = 1 + 0.45 * (this.floor - 1), df = 1 + 0.2 * (this.floor - 1);
    const elite = !!mod;
    const scale = (def.scale || 1) * (elite ? 1.25 : 1);
    const hp = def.hp * f * (elite ? 2.8 : 1);
    const e = {
      kind: 'enemy', type, def, x, y, vx: 0, vy: 0, r: def.r * (elite ? 1.15 : 1), hp, maxHp: hp, dmg: def.dmg * df * (elite ? 1.3 : 1),
      speed: def.speed * (elite ? 1.08 : 1), face: this.rng.range(0, 6.28), mod, elite, flying: !!def.flying, hover: def.hover || 0,
      st: { burn: 0, wet: 0, oil: 0, frozen: 0, chill: 0, stun: 0 }, shockCd: 0, flash: 0, atk: null, aware: false, dead: false, deadT: 0,
      cd: { atk: this.rng.range(0.3, 1.2), skill: this.rng.range(0.5, 2), s2: this.rng.range(3, 6), s3: 12 }, phase: this.rng.range(0, 6), burnAcc: 0, burnDps: 0, moveAmt: 0,
      fireImmune: mod === 'ember', panicT: 0, panicTarget: null, modT: 0, room: this.roomAt(x, y), enraged: false, retreat: 0,
    };
    e.rig = this.world.spawnActor(def.model, scale);
    if (mod) {
      const c = new THREE.Color(MODS[mod].color);
      e.rig.mats.forEach(m => { m.userData.baseE.copy(c).multiplyScalar(0.25); m.emissive.copy(m.userData.baseE); m.emissiveIntensity = Math.max(m.userData.baseI, 0.6); m.userData.baseI = m.emissiveIntensity; });
    }
    this.enemies.push(e);
    return e;
  }
  roomAt(x, y) {
    let best = -1, bd = 1e9;
    for (const r of this.level.rooms) { const d = Math.hypot(r.cx - x, r.cy - y); if (d < bd) { bd = d; best = r.index; } }
    return best;
  }

  // ------------------------------------------------------------------ collision helpers
  solidTile(ix, iy) { return ix < 0 || iy < 0 || ix >= W || iy >= H || !this.level.tiles[iy * W + ix]; }
  blocked(x, y, r) {
    for (let iy = Math.floor(y - r); iy <= Math.floor(y + r); iy++)
      for (let ix = Math.floor(x - r); ix <= Math.floor(x + r); ix++)
        if (this.solidTile(ix, iy)) return true;
    return false;
  }
  moveEntity(e, dt) {
    let nx = e.x + e.vx * dt;
    if (this.blocked(nx, e.y, e.r)) { e.vx *= e.onIce ? -0.35 : 0; } else e.x = nx;
    let ny = e.y + e.vy * dt;
    if (this.blocked(e.x, ny, e.r)) { e.vy *= e.onIce ? -0.35 : 0; } else e.y = ny;
    for (const b of this.barrels) {
      if (b.dead) continue;
      const d = Math.hypot(e.x - b.x, e.y - b.y), min = e.r + b.r;
      if (d < min && d > 0.001) { const push = (min - d); const nx2 = e.x + (e.x - b.x) / d * push, ny2 = e.y + (e.y - b.y) / d * push; if (!this.blocked(nx2, ny2, e.r)) { e.x = nx2; e.y = ny2; } }
    }
  }

  // ------------------------------------------------------------------ navigation
  heroFlow() {
    const t = Math.floor(this.hero.y) * W + Math.floor(this.hero.x);
    if (t !== this.flowTile) { this.flowTile = t; this.flow = distanceField(this.level.tiles, Math.floor(this.hero.x), Math.floor(this.hero.y)); }
    return this.flow;
  }
  // direction from (x,y) toward (tx,ty) following a distance field when walls are in the way
  dirToward(x, y, tx, ty, field) {
    if (hasLOS(this.level.tiles, x, y, tx, ty)) { const d = Math.hypot(tx - x, ty - y) || 1; return [(tx - x) / d, (ty - y) / d]; }
    const cx = Math.floor(x), cy = Math.floor(y);
    let best = field[cy * W + cx] < 0 ? 9999 : field[cy * W + cx], bx = 0, by = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = cx + dx, ny = cy + dy;
      if (this.solidTile(nx, ny)) continue;
      if (dx && dy && (this.solidTile(cx + dx, cy) || this.solidTile(cx, cy + dy))) continue;
      const v = field[ny * W + nx];
      if (v >= 0 && v + (dx && dy ? 0.4 : 0) < best) { best = v + (dx && dy ? 0.4 : 0); bx = dx; by = dy; }
    }
    if (!bx && !by) { const d = Math.hypot(tx - x, ty - y) || 1; return [(tx - x) / d, (ty - y) / d]; }
    // aim at the centre of the chosen neighbour tile
    const px = cx + bx + 0.5 - x, py = cy + by + 0.5 - y, d = Math.hypot(px, py) || 1;
    return [px / d, py / d];
  }

  hazardAt(e, x, y) {
    if (e.flying) return 0;
    const c = this.surf.at(x, y);
    if (!c) return 1;
    let hz = 0;
    if (c.fire && !e.fireImmune && !(e.st.burn > 0)) hz = 1;
    else if (c.elec) hz = 0.9;
    else if (c.oil && !e.fireImmune && this.surf.fireNear(x, y, 2.4)) hz = 0.75;
    return hz;
  }
  // hazard-aware steering: enemies route around flames and live puddles, and won't wade into oil near fire
  steer(e, dir) {
    let [dx, dy] = dir, best = -9, bx = 0, by = 0;
    const a0 = Math.atan2(dy, dx);
    for (const off of [0, 0.5, -0.5, 1.0, -1.0, 1.6, -1.6]) {
      const a = a0 + off, ux = Math.cos(a), uy = Math.sin(a);
      let score = Math.cos(off) * 1.0;
      score -= 2.6 * Math.max(this.hazardAt(e, e.x + ux * 0.8, e.y + uy * 0.8), this.hazardAt(e, e.x + ux * 1.5, e.y + uy * 1.5) * 0.6);
      if (this.blocked(e.x + ux * 0.5, e.y + uy * 0.5, e.r)) score -= 1.2;
      if (score > best) { best = score; bx = ux; by = uy; }
    }
    if (best < -0.4) { e.hazardWait = true; return [0, 0]; }   // nowhere safe to go: hold position
    e.hazardWait = false;
    return [bx, by];
  }

  // ------------------------------------------------------------------ stats
  recalcStats() {
    const h = this.hero, old = h.maxHp;
    h.stats = computeStats(this.equipped);
    h.maxHp = 100 + h.stats.life;
    if (h.maxHp > old) h.hp += h.maxHp - old;
    h.hp = Math.min(h.hp, h.maxHp);
  }
  cdMul() { return 1 - clamp(this.hero.stats.cdr, 0, 60) / 100; }
  skillCd(k) { return SK[k].cd * this.cdMul(); }

  // ------------------------------------------------------------------ status effects + reactions
  ignite(e, dur = 3.2, mult = 1) {
    if (e.dead || e.fireImmune) return false;
    if (e.st.frozen > 0) { e.st.frozen = 0; this.popText(e, 'THAWED', 'frost'); return false; }
    if (e.st.wet > 0) { e.st.wet = 0; this.steamAt(e.x, e.y); this.popText(e, 'STEAM', 'steam'); sfx('steam'); return false; }
    if (e.st.burn <= 0) { sfx('ignite'); if (e.kind === 'enemy') this.popText(e, 'BURNING', 'fire'); }
    e.st.burn = Math.max(e.st.burn, e.st.oil > 0 ? dur * 2 : dur);
    e.burnDps = Math.max(e.burnDps, mult);
    return true;
  }
  chill(e) {
    if (e.dead) return;
    if (e.st.burn > 0) { e.st.burn = 0; this.steamAt(e.x, e.y); this.popText(e, 'DOUSED', 'frost'); }
    if (e.st.wet > 0) { e.st.wet = 0; e.st.frozen = e.def?.boss ? 1.2 : 2.4; e.st.chill = 3; this.popText(e, 'FROZEN', 'frost'); sfx('frost'); }
    else e.st.chill = 3.5;
  }
  steamAt(x, y) { this.world.burst(x, y, 0.3, 6, { c0: 0xbbccdd, c1: 0x445566, s0: 0.35, s1: 0.9, life: 1.1, up: 1.2, speed: 0.8, grav: -0.6, drag: 1 }); }

  updateStatus(e, dt) {
    const s = e.st, surf = this.surf;
    e.onIce = false;
    const c = e.flying ? null : surf.at(e.x, e.y);
    if (c) {
      if (c.fire) this.ignite(e, 3.2, 1);
      if (c.water) { s.wet = Math.max(s.wet, 4.5); if (s.burn > 0) { s.burn = 0; this.steamAt(e.x, e.y); sfx('steam'); this.popText(e, 'DOUSED', 'frost'); } }
      if (c.oil) s.oil = Math.max(s.oil, 5);
      if (c.ice) e.onIce = true;
      if (c.elec && e.shockCd <= 0) { e.shockCd = 0.55; this.shockHit(e, (e.kind === 'hero' ? 9 : 11) * (1 + 0.2 * (this.floor - 1)), e.kind === 'hero' ? 'enemy' : 'hero'); }
    }
    if (e.kind === 'hero' && this.hero.stats.ironsole) e.onIce = false;
    e.shockCd -= dt;
    for (const k in s) s[k] = Math.max(0, s[k] - dt);
    if (e.fireImmune && e.mod === 'ember') s.burn = 0;
    if (s.burn > 0) {
      // burning creatures set fire to any oil they touch (and to oil-soaked neighbours)
      e.igniteT = (e.igniteT || 0) - dt;
      if (e.igniteT <= 0 && !e.flying) { e.igniteT = 0.2; surf.ignite(e.x, e.y, 0.55, false); }
      e.burnAcc += dt;
      if (e.burnAcc >= 0.5) {
        e.burnAcc -= 0.5;
        const base = e.kind === 'hero' ? 3.5 + 0.8 * this.floor : (7 + 2 * this.floor) * (e.burnDps || 1);
        this.hurt(e, base * 0.5 * (e.st.oil > 0 ? 1.6 : 1), 'fire', e.kind === 'hero' ? 'enemy' : 'hero', { dot: true });
      }
      if (Math.random() < dt * 14) this.world.particles.emit({ x: e.x + (Math.random() - 0.5) * 0.4, y: 0.4 + Math.random() * 1.0, z: e.y + (Math.random() - 0.5) * 0.4, vy: 1.2, life: 0.5, s0: 0.2, s1: 0.03, c0: 0xffa040, c1: 0xff2000, drag: 0.5, grav: -0.5 });
      if (s.oil > 0 && e.kind === 'enemy') s.oil = Math.max(s.oil, 0.5);
    } else { e.burnDps = 0; }
    if (e.kind === 'enemy' && e.mod === 'ember') { e.modT -= dt; if (e.modT <= 0) { e.modT = 0.25; surf.ignite(e.x, e.y, 0.6, false); } }
    if (s.wet > 0 && Math.random() < dt * 3) this.world.particles.emit({ x: e.x + (Math.random() - 0.5) * 0.4, y: 0.9, z: e.y + (Math.random() - 0.5) * 0.4, vy: -0.5, life: 0.5, s0: 0.08, s1: 0.04, c0: 0x4a8ad0, c1: 0x203050, drag: 0.2, grav: 4 });
  }

  shockHit(e, dmg, src, visited) {
    if (e.dead) return;
    visited = visited || new Set(); visited.add(e);
    this.world.bolt(e.x, e.y, 0, e.x, e.y, 1.4, 0x9df0ff, 0.12);
    e.st.stun = Math.max(e.st.stun, e.def?.heavy ? 0.1 : 0.35);
    e.tintShock = 0.15;
    this.hurt(e, dmg, 'shock', src);
    // conduction: wet creatures pass the current on
    if (e.st.wet > 0) {
      const pool = [this.hero, ...this.enemies];
      for (const o of pool) {
        if (o === e || o.dead || visited.has(o) || o.st.wet <= 0) continue;
        if (dist(e.x, e.y, o.x, o.y) < 3.2) {
          visited.add(o);
          this.world.bolt(e.x, e.y, 1.0, o.x, o.y, 1.0, 0x9df0ff, 0.18);
          if ((o.kind === 'enemy' && src === 'hero') || (o.kind === 'hero' && src !== 'hero')) this.shockHit(o, dmg * 0.7, src, visited);
        }
      }
    }
    if (this.surf.shock(e.x, e.y)) sfx('arc');
  }

  // central damage function. amount = raw; bonuses applied here.
  hurt(t, amount, type, src, opts = {}) {
    if (t.dead) return 0;
    let a = amount, tag = null;
    const hs = this.hero.stats;
    if (t.kind === 'enemy') {
      if (src === 'hero') {
        a *= 1 + hs.dmg / 100;
        if (type === 'fire') a *= 1 + hs.fire / 100;
        if (type === 'shock') a *= 1 + hs.shock / 100;
        if (type === 'frost') a *= 1 + hs.frost / 100;
        if (t.st.burn > 0) a *= 1 + hs.vsBurn / 100;
        if (t.st.wet > 0) a *= 1 + hs.vsWet / 100;
        if (t.st.frozen > 0) a *= 1 + hs.vsFrozen / 100;
      }
      if (type === 'fire') a *= 1 - (t.def.fireRes || 0);
      if (t.fireImmune && type === 'fire') a = 0;
      if (t.mod === 'storm' && type === 'shock') a *= 0.5;
    } else {
      if (type === 'phys') a *= 1 - hs.armor / (hs.armor + 35);
      if (type === 'fire') a *= 1 - clamp(hs.fireRes, 0, 75) / 100;
      if (type === 'shock') a *= 1 - clamp(hs.shockRes, 0, 75) / 100;
    }
    // reactions
    if (type === 'shock' && t.st.wet > 0) { a *= 2; tag = 'CONDUCTED'; }
    if (type === 'phys' && t.st.frozen > 0) { a *= 2.2; t.st.frozen = 0; tag = 'SHATTER'; sfx('shatter'); this.world.burst(t.x, t.y, 0.8, 14, { c0: 0xbfeaff, c1: 0x5599cc, s0: 0.22, s1: 0.04, life: 0.7, speed: 4, up: 3 }); }
    if (type === 'fire' && t.st.oil > 0 && !opts.dot) { a *= 1.35; }
    if (a <= 0) return 0;
    a = Math.round(a);
    if (t.kind === 'enemy' && !t.aware) this.wake(t);
    t.hp -= a; t.flash = 0.1;
    if (t.kind === 'hero') { this.world.shake = Math.max(this.world.shake, Math.min(0.5, a / 60)); t.hurtT = 0.3; sfx('hurt'); }
    else sfx(type === 'phys' ? 'hit' : type === 'shock' ? 'arc' : 'hit');
    if (opts.dot) {
      t.dotAcc = (t.dotAcc || 0) + a;
      if (this.time - (t.dotShown || 0) > 0.9 || t.hp <= 0) { this.popDamage(t, t.dotAcc, type, null); t.dotAcc = 0; t.dotShown = this.time; }
    } else this.popDamage(t, a, type, tag);
    if (t.hp <= 0) this.kill(t, type);
    return a;
  }

  popDamage(t, a, type, tag) {
    const cls = { phys: 'phys', fire: 'fire', shock: 'shock', frost: 'frost' }[type] || 'phys';
    this.ui.floater(t.x, t.y, tag ? `${a} ${tag}` : `${a}`, tag ? cls + ' big' : cls, t.kind === 'hero' ? 1.9 : 1.5 * (t.rig?.group.scale.x || 1) + 0.3);
  }
  popText(t, text, cls) {
    t.tagT = t.tagT || {};
    if (this.time - (t.tagT[text] || -9) < 1.3) return;
    t.tagT[text] = this.time;
    this.ui.floater(t.x, t.y, text, cls + ' tag', 2.2 * (t.rig?.group.scale.x || 1) + 0.2); }

  wake(e) {
    if (e.aware) return;
    e.aware = true;
    for (const o of this.enemies) if (!o.aware && !o.dead && (o.room === e.room || dist(o.x, o.y, e.x, e.y) < 6)) { o.aware = true; }
    if (e.def.boss) { sfx('roar'); this.world.shake = 0.6; this.ui.toast('The Grave King awakens', '#ff8a70'); }
  }

  kill(t, type) {
    t.dead = true; t.hp = 0;
    if (t.kind === 'hero') { this.heroDied(); return; }
    t.atk = null; t.deadT = 0;
    this.run.kills++;
    sfx('die');
    this.world.burst(t.x, t.y, 0.6, 8, { c0: 0xd8cfb8, c1: 0x555046, s0: 0.2, s1: 0.04, life: 0.7, speed: 2.5, up: 2.2 });
    // loot
    const r = this.rng;
    const eliteBoost = t.elite ? 1 : 0;
    if (t.def.boss) { for (let i = 0; i < 3; i++) this.dropItem(t.x + r.range(-1, 1), t.y + r.range(-1, 1), rollItem(r, this.floor, { minRarity: 2 })); }
    else {
      const chance = t.elite ? 1 : { skeleton: 0.16, archer: 0.18, brute: 0.55, shaman: 0.35, bat: 0.05 }[t.type] || 0.1;
      if (r.chance(chance)) this.dropItem(t.x, t.y, rollItem(r, this.floor, { minRarity: eliteBoost ? 1 : 0, boost: eliteBoost * 4 }));
      if (r.chance(t.elite ? 0.8 : 0.14)) this.dropGlobe(t.x + 0.3, t.y);
    }
    if (t.def.boss) { this.state = 'winning'; this.winT = 2.4; this.ui.toast('The Grave King falls', '#ffd24a'); this.world.shake = 0.9; }
  }

  heroDied() {
    this.state = 'dead'; this.deadT = 0;
    sfx('die');
    this.ui.overlay('dead', this.summary());
  }
  summary() { const s = this.surf.stats; return { floor: this.floor, kills: this.run.kills, items: this.run.items, seed: this.seed, burned: s.burned, arcs: s.arcs, frozen: s.frozen }; }

  // ------------------------------------------------------------------ loot
  dropItem(x, y, item) {
    const col = RARITY[item.rarity].color;
    const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.2), new THREE.MeshBasicMaterial({ color: col, fog: false }));
    mesh.position.set(x, 0.5, y); this.world.effects.add(mesh);
    this.loot.push({ x, y, item, mesh, t: Math.random() * 6, col });
  }
  dropGlobe(x, y) {
    const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.2, 1), new THREE.MeshBasicMaterial({ color: 0xff3a3a, fog: false }));
    mesh.position.set(x, 0.5, y); this.world.effects.add(mesh);
    this.loot.push({ x, y, globe: true, mesh, t: 0, col: '#ff4040' });
  }
  pickup(l) {
    if (l.globe) {
      const h = this.hero; h.hp = Math.min(h.maxHp, h.hp + h.maxHp * 0.22); sfx('heal');
      this.ui.floater(h.x, h.y, '+' + Math.round(h.maxHp * 0.22), 'heal', 1.9);
    } else {
      const it = l.item;
      if (!this.equipped[it.slot]) { this.equipped[it.slot] = it; this.recalcStats(); this.ui.toast(`Equipped ${it.name}`, RARITY[it.rarity].color); }
      else if (this.bag.length < BAG_SIZE) { this.bag.push(it); this.ui.toast(`${RARITY[it.rarity].name}: ${it.name}  (press I)`, RARITY[it.rarity].color); }
      else { this.ui.toast('Backpack full', '#ff8080'); return false; }
      this.run.items++;
      sfx(it.rarity === 2 ? 'rare' : 'pickup');
      this.ui.renderInventory(this);
    }
    this.world.effects.remove(l.mesh);
    return true;
  }
  equip(uid) {
    const i = this.bag.findIndex(it => it.uid === uid);
    if (i < 0) return;
    const it = this.bag[i], old = this.equipped[it.slot];
    this.equipped[it.slot] = it; this.bag.splice(i, 1);
    if (old) this.bag.push(old);
    this.recalcStats(); sfx('pickup'); this.ui.renderInventory(this);
  }
  unequip(slot) {
    const it = this.equipped[slot];
    if (!it || this.bag.length >= BAG_SIZE) return;
    delete this.equipped[slot]; this.bag.push(it); this.recalcStats(); this.ui.renderInventory(this);
  }
  discard(uid) { const i = this.bag.findIndex(it => it.uid === uid); if (i >= 0) { this.bag.splice(i, 1); this.ui.renderInventory(this); } }

  // ------------------------------------------------------------------ barrels
  damageBarrel(b, type) {
    if (b.dead) return;
    b.dead = true; this.world.actors.remove(b.rig.group);
    const fire = type === 'fire';
    if (b.type === 'oil') {
      this.surf.pour('oil', b.x, b.y, 1.7);
      if (fire) { sfx('boom'); this.world.shake = 0.5; this.world.lightFlash(b.x, b.y, 0xff8030, 120, 0.4); this.world.ring(b.x, b.y, 0.5, 2.6, 0xff8a30, 0.4); this.explode(b.x, b.y, 2.1, 24, 'fire', 'hero', { barrelSafe: true }); this.surf.ignite(b.x, b.y, 1.6, true); }
      else { sfx('wood'); this.world.burst(b.x, b.y, 0.5, 8, { c0: 0x7a4b32, c1: 0x201010, s0: 0.15, s1: 0.03, life: 0.6, speed: 3 }); }
    } else {
      this.surf.pour('water', b.x, b.y, 1.7); sfx('splash');
      this.world.burst(b.x, b.y, 0.5, 14, { c0: 0x6ab0ff, c1: 0x1a3a60, s0: 0.2, s1: 0.04, life: 0.7, speed: 3, up: 3 });
    }
  }

  // ------------------------------------------------------------------ combat helpers
  explode(x, y, r, dmg, type, src, opts = {}) {
    this.world.burst(x, y, 0.5, 16, { c0: type === 'fire' ? 0xffb040 : 0xa0e8ff, c1: type === 'fire' ? 0xff2000 : 0x2060ff, s0: 0.35, s1: 0.05, life: 0.6, speed: 4, up: 3 });
    const targets = src === 'hero' ? this.enemies : [this.hero];
    for (const t of targets) {
      if (t.dead) continue;
      const d = dist(x, y, t.x, t.y);
      if (d > r + t.r) continue;
      if (type === 'fire') { this.hurt(t, dmg * (1 - 0.4 * d / (r + t.r)), 'fire', src); this.ignite(t, 3.2, src === 'hero' ? 1 + this.hero.stats.fire / 100 : 1); }
      else this.hurt(t, dmg, type, src);
    }
    if (type === 'fire') for (const b of this.barrels) if (!b.dead && !opts.barrelSafe && dist(x, y, b.x, b.y) < r + b.r) this.damageBarrel(b, 'fire');
    if (opts.barrelSafe) for (const b of this.barrels) if (!b.dead && dist(x, y, b.x, b.y) < r) this.damageBarrel(b, 'fire');
  }

  fireProjectile(p) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(p.size || 0.2, 8, 6), new THREE.MeshBasicMaterial({ color: p.color, fog: false }));
    mesh.position.set(p.x, p.z ?? 1.1, p.y); this.world.effects.add(mesh);
    p.mesh = mesh; p.age = 0;
    this.projectiles.push(p);
  }

  // ------------------------------------------------------------------ hero skills
  useSkill(k) {
    const h = this.hero;
    if (h.dead || this.state !== 'play') return;
    if (h.st.frozen > 0 || h.st.stun > 0) return;
    if (h.cd[k] > 0) return;
    if (this.touch.active) this.aimAssist();
    const gx = this.mouse.gx, gy = this.mouse.gy;
    let dx = gx - h.x, dy = gy - h.y; const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
    h.face = Math.atan2(dx, dy); h.cast = 0.35;
    const cd = SK[k].cd * this.cdMul();
    if (k === 'q') {
      h.cd.q = cd; sfx('fire');
      this.fireProjectile({ team: 'hero', kind: 'firebolt', x: h.x + dx * 0.5, y: h.y + dy * 0.5, vx: dx * 15, vy: dy * 15, r: 0.25, life: 1.4, dmg: 18, color: 0xff8a20, size: 0.2 });
    } else if (k === 'w') {
      h.cd.w = cd; sfx('frost');
      const R = 3.7;
      this.world.ring(h.x, h.y, 0.5, R, 0x9fe4ff, 0.55, 0.9); this.world.ring(h.x, h.y, 0.3, R * 0.7, 0xffffff, 0.4, 0.5);
      this.world.burst(h.x, h.y, 0.5, 26, { c0: 0xd0f4ff, c1: 0x4a90d0, s0: 0.25, s1: 0.04, life: 0.8, speed: 6, up: 1.5, drag: 2.5, grav: 2 });
      this.world.lightFlash(h.x, h.y, 0x80d0ff, 50, 0.3);
      this.surf.freeze(h.x, h.y, R);
      if (h.st.burn > 0) { h.st.burn = 0; this.popText(h, 'DOUSED', 'frost'); }
      for (const e of this.enemies) if (!e.dead && dist(h.x, h.y, e.x, e.y) < R + e.r) { this.hurt(e, 10, 'frost', 'hero'); this.chill(e); }
      for (const b of this.barrels) if (!b.dead && b.type === 'water' && dist(h.x, h.y, b.x, b.y) < R) this.damageBarrel(b, 'frost');
    } else if (k === 'e') {
      h.cd.e = cd;
      this.castLightning(dx, dy);
    } else if (k === 'r') {
      h.cd.r = cd; sfx('flask');
      const d = Math.min(10, dl);
      const tx = h.x + dx * d, ty = h.y + dy * d;
      this.fireProjectile({ team: 'hero', kind: 'flask', lob: true, sx: h.x, sy: h.y, tx, ty, x: h.x, y: h.y, dur: 0.35 + d * 0.04, t: 0, color: 0x6a4a8a, size: 0.17, dmg: 0, r: 0.1, life: 5 });
    }
  }

  // Touch has no cursor: aim at the best nearby enemy (prefer the one we're facing), else straight ahead.
  aimAssist() {
    const h = this.hero, fx = Math.sin(h.face), fy = Math.cos(h.face);
    let best = null, bs = -1e9;
    for (const e of this.enemies) {
      if (e.dead) continue;
      const d = dist(h.x, h.y, e.x, e.y);
      if (d > 11 || !hasLOS(this.level.tiles, h.x, h.y, e.x, e.y)) continue;
      const facing = ((e.x - h.x) * fx + (e.y - h.y) * fy) / (d || 1);
      const score = facing * 6 - d;
      if (score > bs) { bs = score; best = e; }
    }
    if (best && (bs > -9)) { this.mouse.gx = best.x; this.mouse.gy = best.y; }
    else { this.mouse.gx = h.x + fx * 6; this.mouse.gy = h.y + fy * 6; }
  }

  castLightning(dx, dy) {
    const h = this.hero;
    sfx('zap');
    // primary target: closest to the cursor, in line of sight
    let best = null, bd = 1e9;
    for (const e of this.enemies) {
      if (e.dead) continue;
      const dm = dist(this.mouse.gx, this.mouse.gy, e.x, e.y), dh = dist(h.x, h.y, e.x, e.y);
      if (dh > 11 || !hasLOS(this.level.tiles, h.x, h.y, e.x, e.y)) continue;
      if (dm < bd && dm < 3.5) { bd = dm; best = e; }
    }
    if (!best) { // no target: a crackle in the aimed direction that still shocks any puddle it lands in
      const ex = h.x + dx * 7, ey = h.y + dy * 7;
      let tx = ex, ty = ey; for (let d = 1; d <= 7; d += 0.5) { if (this.blocked(h.x + dx * d, h.y + dy * d, 0.05)) { tx = h.x + dx * (d - 0.5); ty = h.y + dy * (d - 0.5); break; } }
      this.world.bolt(h.x, h.y, 1.4, tx, ty, 0.8, 0xa8f0ff, 0.2);
      if (this.surf.shock(tx, ty)) sfx('arc');
      return;
    }
    const hit = new Set(); let cur = best, fromX = h.x, fromY = h.y, fromZ = 1.4, dmg = 17;
    for (let i = 0; i < 4 && cur; i++) {
      hit.add(cur);
      this.world.bolt(fromX, fromY, fromZ, cur.x, cur.y, 1.0, 0xa8f0ff, 0.22);
      this.shockHit(cur, dmg, 'hero', hit);
      fromX = cur.x; fromY = cur.y; fromZ = 1.0; dmg *= 0.85;
      let nxt = null, nd = 4.8;
      for (const e of this.enemies) { if (e.dead || hit.has(e)) continue; const d = dist(cur.x, cur.y, e.x, e.y); if (d < nd) { nd = d; nxt = e; } }
      cur = nxt;
    }
  }

  meleeAttack() {
    const h = this.hero;
    h.atk = { t: 0, dur: 0.42, fired: false };
    h.cd.atk = 0.5;
    sfx('swing');
  }
  meleeHit() {
    const h = this.hero;
    const fx = Math.sin(h.face), fy = Math.cos(h.face);
    const dmg = 10 + h.stats.weaponDmg;
    let hitAny = false;
    for (const e of this.enemies) {
      if (e.dead) continue;
      const dx = e.x - h.x, dy = e.y - h.y, d = Math.hypot(dx, dy);
      if (d > 1.9 + e.r || (dx * fx + dy * fy) / (d || 1) < 0.2) continue;
      this.hurt(e, dmg, 'phys', 'hero'); hitAny = true;
      if (!e.def.heavy) { e.vx += (dx / (d || 1)) * 3.2; e.vy += (dy / (d || 1)) * 3.2; }
      if (h.stats.ignite && this.rng.chance(h.stats.ignite / 100)) this.ignite(e, 3.2, 1 + h.stats.fire / 100);
    }
    for (const b of this.barrels) {
      if (b.dead) continue;
      const dx = b.x - h.x, dy = b.y - h.y, d = Math.hypot(dx, dy);
      if (d < 1.9 && (dx * fx + dy * fy) / (d || 1) > 0.2) this.damageBarrel(b, 'phys');
    }
    if (hitAny) this.world.shake = Math.max(this.world.shake, 0.08);
  }

  // ------------------------------------------------------------------ main update
  update(dt) {
    if (this.state === 'title' || this.paused) return;
    dt = Math.min(dt, 0.05);
    this.time += dt;
    if (this.state === 'dead') { this.deadT += dt; this.animateActors(dt); this.surf.update(dt); this.drainSurfaceEvents(); return; }
    if (this.state === 'winning') { this.winT -= dt; if (this.winT <= 0) { this.state = 'won'; this.ui.overlay('won', this.summary()); } }
    this.run.time += dt;
    const h = this.hero;

    this.surf.update(dt);
    this.drainSurfaceEvents();
    this.updateHero(dt);
    for (const e of this.enemies) this.updateEnemy(e, dt);
    this.enemies = this.enemies.filter(e => { if (e.dead && e.deadT > 3.2) { this.world.removeActor(e.rig); return false; } return true; });
    this.updateProjectiles(dt);
    this.updateProps(dt);
    this.updatePickups(dt);
    this.spreadFireToBarrels();
    this.explore(dt);
    this.animateActors(dt);

    // exit
    if (this.exit) {
      this.exit.t += dt; this.exitLock -= dt;
      if (Math.random() < dt * 20) this.world.particles.emit({ x: this.exit.x + (Math.random() - 0.5) * 1.2, y: 0.2, z: this.exit.y + 0.1, vy: 1.4, life: 1.0, s0: 0.2, s1: 0.02, c0: 0xaa88ff, c1: 0x4422aa, drag: 0.5, grav: -0.3 });
      if (this.exitLock <= 0 && dist(h.x, h.y, this.exit.x, this.exit.y) < 1.3) this.nextFloor();
    }
  }

  drainSurfaceEvents() {
    const ev = this.surf.events; if (!ev.length) return;
    for (const e of ev) {
      if (e.type === 'steam') { if (Math.random() < 0.4) this.steamAt(e.x, e.y); if (Math.random() < 0.15) sfx('steam'); }
      else if (e.type === 'ignite') { if (Math.random() < 0.35) sfx('ignite'); this.world.burst(e.x, e.y, 0.2, 2, { c0: 0xffc060, c1: 0xff3000, s0: 0.12, s1: 0.02, life: 0.5, speed: 1.5, up: 2.2 }); }
    }
    ev.length = 0;
  }

  nextFloor() {
    this.floor++;
    sfx('portal');
    const h = this.hero; h.hp = Math.min(h.maxHp, h.hp + h.maxHp * 0.3);
    this.run.burned += this.surf.stats.burned;
    this.startFloor();
    this.ui.toast(this.floor === FLOORS ? `Floor ${this.floor} — The Grave King's arena` : `Floor ${this.floor}`, '#ffd9a0');
  }

  explore() {
    const h = this.hero, R = 8;
    const hx = Math.floor(h.x), hy = Math.floor(h.y);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const x = hx + dx, y = hy + dy;
      if (x < 0 || y < 0 || x >= W || y >= H || dx * dx + dy * dy > R * R) continue;
      this.exploredMap[y * W + x] = 1;
    }
  }

  spreadFireToBarrels() {
    for (const b of this.barrels) {
      if (b.dead) continue;
      const c = this.surf.at(b.x, b.y);
      if (c && c.fire) this.damageBarrel(b, 'fire');
      else if (c && c.elec && b.type === 'water') { /* conducts, but is harmless */ }
    }
  }

  // ------------------------------------------------------------------ hero update
  updateHero(dt) {
    const h = this.hero;
    for (const k in h.cd) h.cd[k] = Math.max(0, h.cd[k] - dt);
    h.flash = Math.max(0, h.flash - dt); h.cast = Math.max(0, h.cast - dt); h.hurtT = Math.max(0, h.hurtT - dt);
    h.stats = h.stats || computeStats(this.equipped);
    this.updateStatus(h, dt);
    h.onIce = h.onIce && !h.stats.ironsole;
    if (h.st.frozen > 0 || h.st.stun > 0) { h.vx *= 0.8; h.vy *= 0.8; this.moveEntity(h, dt); return; }

    // input
    let wx = 0, wy = 0, moving = false, attackTarget = null;
    const kx = (this.keys.has('d') || this.keys.has('arrowright') ? 1 : 0) - (this.keys.has('a') || this.keys.has('arrowleft') ? 1 : 0);
    const ky = (this.keys.has('s') || this.keys.has('arrowdown') ? 1 : 0) - (this.keys.has('w') || this.keys.has('arrowup') ? 1 : 0);
    const T = this.touch;
    if (T.active && !this.ui.invOpen) {
      if (T.attack) {
        let best = null, bd = 7;
        for (const e of this.enemies) { if (e.dead) continue; const d = dist(h.x, h.y, e.x, e.y); if (d < bd && hasLOS(this.level.tiles, h.x, h.y, e.x, e.y)) { bd = d; best = e; } }
        for (const b of this.barrels) { if (b.dead) continue; const d = dist(h.x, h.y, b.x, b.y); if (d < 2.2 && d < bd) { bd = d; best = b; } }
        if (best) attackTarget = best;
      }
      if (!attackTarget && (T.mx || T.my)) { wx = T.mx; wy = T.my; moving = true; }
    }
    if (this.mouse.down && !this.ui.invOpen && !T.active) {
      // enemy or barrel under the cursor?
      let best = null, bd = 1.0;
      for (const e of this.enemies) { if (e.dead) continue; const d = dist(this.mouse.gx, this.mouse.gy, e.x, e.y) - e.r; if (d < bd) { bd = d; best = e; } }
      for (const b of this.barrels) { if (b.dead) continue; const d = dist(this.mouse.gx, this.mouse.gy, b.x, b.y) - b.r; if (d < bd * 0.8) { bd = d; best = b; } }
      if (this.mouse.shift) { h.face = Math.atan2(this.mouse.gx - h.x, this.mouse.gy - h.y); attackTarget = { x: h.x + Math.sin(h.face), y: h.y + Math.cos(h.face), r: 0, standing: true }; }
      else if (best) attackTarget = best;
      else {
        const tx = this.mouse.gx, ty = this.mouse.gy, d = dist(h.x, h.y, tx, ty);
        if (d > 0.35) {
          const t = Math.floor(ty) * W + Math.floor(tx);
          if (t !== this.moveFieldTile && !this.solidTile(Math.floor(tx), Math.floor(ty))) { this.moveFieldTile = t; this.moveField = distanceField(this.level.tiles, Math.floor(tx), Math.floor(ty)); }
          const [dx, dy] = this.moveField && !this.solidTile(Math.floor(tx), Math.floor(ty)) ? this.dirToward(h.x, h.y, tx, ty, this.moveField) : [(tx - h.x) / d, (ty - h.y) / d];
          wx = dx; wy = dy; moving = true;
        }
      }
    }
    if (attackTarget) {
      const d = dist(h.x, h.y, attackTarget.x, attackTarget.y);
      const reach = 1.55 + (attackTarget.r || 0);
      if (d > reach && !attackTarget.standing) {
        const t = Math.floor(attackTarget.y) * W + Math.floor(attackTarget.x);
        if (t !== this.moveFieldTile) { this.moveFieldTile = t; this.moveField = distanceField(this.level.tiles, Math.floor(attackTarget.x), Math.floor(attackTarget.y)); }
        const [dx, dy] = this.dirToward(h.x, h.y, attackTarget.x, attackTarget.y, this.moveField);
        wx = dx; wy = dy; moving = true;
      } else {
        h.face = Math.atan2(attackTarget.x - h.x, attackTarget.y - h.y);
        if (h.cd.atk <= 0 && !h.atk) this.meleeAttack();
      }
    }
    if (!moving && !attackTarget && (kx || ky)) { const l = Math.hypot(kx, ky); wx = kx / l; wy = ky / l; moving = true; }

    let speed = 4.7 * (1 + h.stats.speed / 100);
    if (h.st.chill > 0) speed *= 0.6;
    if (h.st.oil > 0) speed *= 0.85;
    const control = h.onIce ? 1.4 : 14;
    const tvx = moving && !h.atk ? wx * speed : 0, tvy = moving && !h.atk ? wy * speed : 0;
    h.vx += (tvx - h.vx) * Math.min(1, control * dt);
    h.vy += (tvy - h.vy) * Math.min(1, control * dt);
    if (moving && !h.atk) { const ta = Math.atan2(wx, wy); h.face += angleDiff(h.face, ta) * Math.min(1, dt * 16); }
    this.moveEntity(h, dt);
    h.moveAmt = clamp(Math.hypot(h.vx, h.vy) / 4.7, 0, 1);

    // melee swing timing
    if (h.atk) {
      h.atk.t += dt;
      if (!h.atk.fired && h.atk.t >= h.atk.dur * 0.55) { h.atk.fired = true; this.meleeHit(); }
      if (h.atk.t >= h.atk.dur) h.atk = null;
    }
    // oil trail item
    if (h.stats.oilTrail && moving) { h.trail -= dt; if (h.trail <= 0) { h.trail = 0.12; this.surf.pour('oil', h.x - Math.sin(h.face) * 0.4, h.y - Math.cos(h.face) * 0.4, 0.55); } }
    // regen out of combat is deliberately absent: globes + floor transitions heal.
  }

  // ------------------------------------------------------------------ enemy AI
  updateEnemy(e, dt) {
    const h = this.hero;
    if (e.dead) { e.deadT += dt; return; }
    for (const k in e.cd) e.cd[k] = Math.max(0, e.cd[k] - dt);
    e.flash = Math.max(0, e.flash - dt);
    this.updateStatus(e, dt);
    if (e.dead) return;
    const s = e.st;
    if (s.frozen > 0 || s.stun > 0) { e.vx *= 0.85; e.vy *= 0.85; e.atk = null; this.moveEntity(e, dt); e.moveAmt = 0; return; }
    const d = dist(e.x, e.y, h.x, h.y);
    if (!e.aware) {
      if (d < e.def.sight && (d < 5 || hasLOS(this.level.tiles, e.x, e.y, h.x, h.y)) && !h.dead) this.wake(e);
      e.moveAmt = 0; e.vx *= 0.8; e.vy *= 0.8; return;
    }
    if (h.dead) { e.moveAmt = 0; return; }

    let speed = e.speed * (s.chill > 0 ? 0.55 : 1) * (s.oil > 0 && !e.flying ? 0.85 : 1) * (e.enraged ? 1.3 : 1);
    let dir = null, wish = [0, 0];

    // storm-charged champions zap the hero at range
    if (e.mod === 'storm') {
      e.modT -= dt;
      if (e.modT <= 0 && d < 8 && hasLOS(this.level.tiles, e.x, e.y, h.x, h.y)) {
        e.modT = 3.2; this.world.bolt(e.x, e.y, 1.6, h.x, h.y, 1.1, 0xa8f0ff, 0.2); sfx('zap'); this.shockHit(h, e.dmg * 0.6, 'enemy');
      }
    }
    if (e.mod === 'leaky') { e.trailT = (e.trailT || 0) - dt; if (e.trailT <= 0) { e.trailT = 0.35; this.surf.pour('oil', e.x, e.y, 0.7); } }

    // burning + not oil-proof: run for the nearest water (an exploitable habit!)
    if (s.burn > 0 && !e.flying && !e.fireImmune) {
      e.panicT -= dt;
      if (e.panicT <= 0) { e.panicT = 0.6; e.panicTarget = this.findWater(e); }
      if (e.panicTarget) {
        const dv = this.dirToward(e.x, e.y, e.panicTarget.x, e.panicTarget.y, this.fieldTo(e.panicTarget));
        wish = [dv[0] * speed * 1.25, dv[1] * speed * 1.25]; e.atk = null;
        this.applyMove(e, wish, dt); return;
      }
    }

    if (e.atk) { this.tickAtk(e, dt); this.applyMove(e, [0, 0], dt); return; }

    switch (e.def.ai) {
      case 'melee': case 'brute': case 'boss': wish = this.aiMelee(e, d, speed, dt); break;
      case 'archer': wish = this.aiArcher(e, d, speed, dt); break;
      case 'shaman': wish = this.aiShaman(e, d, speed, dt); break;
      case 'bat': wish = this.aiBat(e, d, speed, dt); break;
    }
    this.applyMove(e, wish, dt);
  }

  fieldTo(p) {
    const t = Math.floor(p.y) * W + Math.floor(p.x);
    if (!this._fc) this._fc = new Map();
    if (this._fcFloor !== this.level) { this._fc.clear(); this._fcFloor = this.level; }
    let f = this._fc.get(t);
    if (!f) { f = distanceField(this.level.tiles, Math.floor(p.x), Math.floor(p.y)); if (this._fc.size > 40) this._fc.clear(); this._fc.set(t, f); }
    return f;
  }
  findWater(e) {
    const R = 8; let best = null, bd = 1e9;
    const ex = Math.floor(e.x), ey = Math.floor(e.y);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const x = ex + dx, y = ey + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = y * W + x;
      if (this.surf.water[i] > 0.15 && this.surf.elec[i] <= 0 && this.surf.fire[i] <= 0 && this.surf.oil[i] <= 0.05) { const d = dx * dx + dy * dy; if (d < bd) { bd = d; best = { x: x + 0.5, y: y + 0.5 }; } }
    }
    return best;
  }

  applyMove(e, wish, dt) {
    const c = e.flying ? null : this.surf.at(e.x, e.y);
    e.onIce = !!(c && c.ice);
    const control = e.onIce ? 1.4 : 10;
    e.vx += (wish[0] - e.vx) * Math.min(1, control * dt);
    e.vy += (wish[1] - e.vy) * Math.min(1, control * dt);
    // separation
    for (const o of this.enemies) {
      if (o === e || o.dead) continue;
      const dx = e.x - o.x, dy = e.y - o.y, dd = Math.hypot(dx, dy), min = (e.r + o.r) * 0.95;
      if (dd < min && dd > 0.001) { e.vx += (dx / dd) * (min - dd) * 6; e.vy += (dy / dd) * (min - dd) * 6; }
    }
    this.moveEntity(e, dt);
    e.moveAmt = clamp(Math.hypot(wish[0], wish[1]) / (e.speed || 1), 0, 1) * (e.hazardWait ? 0 : 1);
  }

  startAtk(e, kind, dur) { e.atk = { kind, t: 0, dur, fired: false }; e.face = Math.atan2(this.hero.x - e.x, this.hero.y - e.y); }
  tickAtk(e, dt) {
    const a = e.atk; a.t += dt;
    e.face += angleDiff(e.face, Math.atan2(this.hero.x - e.x, this.hero.y - e.y)) * Math.min(1, dt * (a.fired ? 0 : 6));
    if (!a.fired && a.t >= a.dur * 0.62) { a.fired = true; this.fireAtk(e, a.kind); }
    if (a.t >= a.dur) e.atk = null;
  }

  aiMelee(e, d, speed, dt) {
    const h = this.hero, def = e.def;
    const isBoss = def.boss;
    if (isBoss) {
      if (!e.enraged && e.hp < e.maxHp * 0.5) { e.enraged = true; this.ui.toast('The Grave King is enraged', '#ff6a50'); sfx('roar'); this.world.shake = 0.7; }
      if (e.cd.s2 <= 0 && hasLOS(this.level.tiles, e.x, e.y, h.x, h.y)) { this.startAtk(e, 'volley', 1.1); e.cd.s2 = e.enraged ? 7 : 10.5; return [0, 0]; }
      if (e.cd.s3 <= 0) { this.startAtk(e, 'summon', 1.3); e.cd.s3 = e.enraged ? 15 : 20; return [0, 0]; }
    }
    const range = isBoss ? 2.5 : def.range;
    if (d < range && e.cd.atk <= 0) {
      this.startAtk(e, isBoss ? 'sweep' : 'melee', def.wind ? def.wind + 0.15 : 0.95);
      e.cd.atk = def.cd || 1.6; return [0, 0];
    }
    if (d < range * 0.85) return [0, 0];
    const dir = this.dirToward(e.x, e.y, h.x, h.y, this.heroFlow());
    e.face += angleDiff(e.face, Math.atan2(dir[0], dir[1])) * Math.min(1, dt * 8);
    const sv = this.steer(e, dir);
    return [sv[0] * speed, sv[1] * speed];
  }
  aiArcher(e, d, speed, dt) {
    const h = this.hero;
    const los = hasLOS(this.level.tiles, e.x, e.y, h.x, h.y);
    e.face += angleDiff(e.face, Math.atan2(h.x - e.x, h.y - e.y)) * Math.min(1, dt * 8);
    if (los && d < 11 && e.cd.atk <= 0) { this.startAtk(e, 'arrow', 0.85); e.cd.atk = 1.8 + Math.random() * 0.6; return [0, 0]; }
    let dir;
    if (d < 4.2 && los) { dir = [(e.x - h.x) / d, (e.y - h.y) / d]; return this.scaled(this.steer(e, dir), speed); }
    if (d > 7.5 || !los) { dir = this.dirToward(e.x, e.y, h.x, h.y, this.heroFlow()); return this.scaled(this.steer(e, dir), speed); }
    // strafe
    const sx = -(h.y - e.y) / d, sy = (h.x - e.x) / d, sgn = Math.sin(this.time * 0.7 + e.phase) > 0 ? 1 : -1;
    return this.scaled(this.steer(e, [sx * sgn, sy * sgn]), speed * 0.5);
  }
  scaled(v, k) { return [v[0] * k, v[1] * k]; }
  aiShaman(e, d, speed, dt) {
    const h = this.hero;
    const los = hasLOS(this.level.tiles, e.x, e.y, h.x, h.y);
    e.face += angleDiff(e.face, Math.atan2(h.x - e.x, h.y - e.y)) * Math.min(1, dt * 8);
    const heroOily = h.st.oil > 0 || this.surf.at(h.x, h.y)?.oil;
    if (los && d < 12) {
      // the combo: tar the hero, then set them alight
      if (heroOily && e.cd.s2 <= 0) { this.startAtk(e, 'ember', 0.7); e.cd.s2 = 2.4; return [0, 0]; }
      if (!heroOily && e.cd.skill <= 0) { this.startAtk(e, 'tar', 0.9); e.cd.skill = 6.5; return [0, 0]; }
    }
    if (d < 4.5 && los) return this.scaled(this.steer(e, [(e.x - h.x) / d, (e.y - h.y) / d]), speed);
    if (d > 8.5 || !los) return this.scaled(this.steer(e, this.dirToward(e.x, e.y, h.x, h.y, this.heroFlow())), speed);
    return [0, 0];
  }
  aiBat(e, d, speed, dt) {
    const h = this.hero;
    if (e.retreat > 0) { e.retreat -= dt; const dx = e.x - h.x, dy = e.y - h.y, l = Math.hypot(dx, dy) || 1; e.face = Math.atan2(-dx, -dy); return [dx / l * speed, dy / l * speed]; }
    if (d < 0.75 && e.cd.atk <= 0) {
      this.hurt(h, e.dmg, 'phys', 'enemy'); e.cd.atk = 1.0; e.retreat = 0.7; return [0, 0];
    }
    const dir = this.dirToward(e.x, e.y, h.x, h.y, this.heroFlow());
    const wob = Math.sin(this.time * 6 + e.phase) * 0.7;
    const a = Math.atan2(dir[1], dir[0]) + wob * 0.6;
    e.face = Math.atan2(dir[0], dir[1]);
    return [Math.cos(a) * speed, Math.sin(a) * speed];
  }

  fireAtk(e, kind) {
    const h = this.hero;
    const ang = Math.atan2(h.y - e.y, h.x - e.x);
    switch (kind) {
      case 'melee': {
        sfx('swing');
        if (dist(e.x, e.y, h.x, h.y) < e.def.range + 0.5) { this.hurt(h, e.dmg, 'phys', 'enemy'); const dx = h.x - e.x, dy = h.y - e.y, l = Math.hypot(dx, dy) || 1; h.vx += dx / l * 3; h.vy += dy / l * 3; }
        break;
      }
      case 'sweep': {
        sfx('swing'); this.world.ring(e.x, e.y, 0.5, 3.2, 0xffb090, 0.3, 0.6); this.world.shake = 0.3;
        if (dist(e.x, e.y, h.x, h.y) < 3.1) { this.hurt(h, e.dmg, 'phys', 'enemy'); const dx = h.x - e.x, dy = h.y - e.y, l = Math.hypot(dx, dy) || 1; h.vx += dx / l * 7; h.vy += dy / l * 7; }
        break;
      }
      case 'arrow': {
        sfx('arrow');
        this.fireProjectile({ team: 'enemy', kind: 'arrow', x: e.x, y: e.y, vx: Math.cos(ang) * 10, vy: Math.sin(ang) * 10, r: 0.18, life: 2, dmg: e.dmg, color: 0xd8cfb8, size: 0.09, z: 1.0 });
        break;
      }
      case 'tar': {
        sfx('flask');
        const tx = h.x + h.vx * 0.4, ty = h.y + h.vy * 0.4;
        this.world.ring(tx, ty, 0.3, 1.7, 0x9a6aff, 0.9, 0.5);
        this.fireProjectile({ team: 'enemy', kind: 'tar', lob: true, sx: e.x, sy: e.y, tx, ty, x: e.x, y: e.y, dur: 0.9, t: 0, color: 0x6a3aa0, size: 0.17, dmg: 0, r: 0.1, life: 5 });
        break;
      }
      case 'ember': {
        sfx('fire');
        this.fireProjectile({ team: 'enemy', kind: 'emberbolt', x: e.x, y: e.y, vx: Math.cos(ang) * 10, vy: Math.sin(ang) * 10, r: 0.25, life: 2, dmg: e.dmg, color: 0xff6a20, size: 0.2, z: 1.3 });
        break;
      }
      case 'volley': {
        sfx('roar'); const n = e.enraged ? 16 : 12, off = Math.random() * 6;
        for (let i = 0; i < n; i++) { const a = off + (i / n) * Math.PI * 2; this.fireProjectile({ team: 'enemy', kind: 'bone', x: e.x, y: e.y, vx: Math.cos(a) * 6.5, vy: Math.sin(a) * 6.5, r: 0.2, life: 2.6, dmg: e.dmg * 0.4, color: 0xe8dfc4, size: 0.13, z: 0.9 }); }
        break;
      }
      case 'summon': {
        sfx('roar'); this.world.ring(e.x, e.y, 0.5, 4, 0xc060ff, 0.6, 0.8);
        for (let i = 0; i < 3; i++) {
          for (let tries = 0; tries < 12; tries++) {
            const a = Math.random() * 6.28, r = 2 + Math.random() * 2.5, x = e.x + Math.cos(a) * r, y = e.y + Math.sin(a) * r;
            if (!this.blocked(x, y, 0.35)) { const s = this.spawnEnemy(Math.random() < 0.3 ? 'archer' : 'skeleton', x, y); s.aware = true; break; }
          }
        }
        break;
      }
    }
  }

  // ------------------------------------------------------------------ projectiles
  updateProjectiles(dt) {
    const h = this.hero;
    for (const p of this.projectiles) {
      p.age += dt;
      if (p.lob) {
        p.t += dt; const k = Math.min(1, p.t / p.dur);
        p.x = p.sx + (p.tx - p.sx) * k; p.y = p.sy + (p.ty - p.sy) * k;
        const z = 0.3 + Math.sin(k * Math.PI) * 2.4;
        p.mesh.position.set(p.x, z, p.y);
        if (k >= 1) { p.dead = true; this.landLob(p); }
        continue;
      }
      p.life -= dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.mesh.position.set(p.x, p.z ?? 1.1, p.y);
      if (p.kind === 'firebolt' || p.kind === 'emberbolt') {
        if (Math.random() < dt * 60) this.world.particles.emit({ x: p.x, y: p.z ?? 1.1, z: p.y, vx: (Math.random() - 0.5) * 0.6, vy: (Math.random() - 0.3) * 0.6, vz: (Math.random() - 0.5) * 0.6, life: 0.35, s0: 0.28, s1: 0.03, c0: 0xffb040, c1: 0xff2000, drag: 1, grav: 0 });
      }
      let hit = p.life <= 0 || this.blocked(p.x, p.y, 0.02);
      if (!hit) {
        if (p.team === 'hero') {
          for (const e of this.enemies) if (!e.dead && dist(p.x, p.y, e.x, e.y) < p.r + e.r * 0.9) { hit = true; p.target = e; break; }
          if (!hit) for (const b of this.barrels) if (!b.dead && dist(p.x, p.y, b.x, b.y) < p.r + b.r) { hit = true; break; }
        } else if (!h.dead && dist(p.x, p.y, h.x, h.y) < p.r + h.r) { hit = true; p.target = h; }
      }
      if (hit) { p.dead = true; this.impact(p); }
    }
    for (const p of this.projectiles) if (p.dead) this.world.effects.remove(p.mesh);
    this.projectiles = this.projectiles.filter(p => !p.dead);
  }
  impact(p) {
    switch (p.kind) {
      case 'firebolt': {
        sfx('boom'); this.world.lightFlash(p.x, p.y, 0xff8a30, 70, 0.28); this.world.shake = Math.max(this.world.shake, 0.15);
        this.world.ring(p.x, p.y, 0.3, 1.5, 0xff9a40, 0.3, 0.8);
        this.surf.ignite(p.x, p.y, 1.3, true);
        this.explode(p.x, p.y, 1.25, p.dmg, 'fire', 'hero');
        break;
      }
      case 'emberbolt': {
        sfx('boom'); this.world.lightFlash(p.x, p.y, 0xff8a30, 40, 0.25);
        this.surf.ignite(p.x, p.y, 0.8, true);
        this.explode(p.x, p.y, 1.1, p.dmg, 'fire', 'enemy');
        break;
      }
      case 'arrow': case 'bone':
        if (p.target) { this.hurt(p.target, p.dmg, 'phys', 'enemy'); }
        this.world.burst(p.x, p.y, 1.0, 4, { c0: 0xd8cfb8, c1: 0x444036, s0: 0.1, s1: 0.02, life: 0.4, speed: 2 });
        break;
    }
  }
  landLob(p) {
    if (p.kind === 'flask') {
      sfx('splash');
      this.surf.pour('oil', p.tx, p.ty, 2.1);
      this.world.burst(p.tx, p.ty, 0.3, 14, { c0: 0x6a3a9a, c1: 0x1a0a28, s0: 0.22, s1: 0.04, life: 0.8, speed: 3.5, up: 3 });
      this.world.ring(p.tx, p.ty, 0.3, 2.3, 0x8a5ac0, 0.4, 0.6);
    } else if (p.kind === 'tar') {
      sfx('splash');
      this.surf.pour('oil', p.tx, p.ty, 1.6);
      this.world.burst(p.tx, p.ty, 0.3, 12, { c0: 0x6a3a9a, c1: 0x1a0a28, s0: 0.2, s1: 0.04, life: 0.8, speed: 3, up: 3 });
    }
  }

  // ------------------------------------------------------------------ props / pickups
  updateProps(dt) {
    const h = this.hero;
    this.barrels = this.barrels.filter(x => !x.dead);
    for (const c of this.chests) {
      if (!c.opened && dist(h.x, h.y, c.x, c.y) < 1.4) {
        c.opened = true; sfx('chest');
        const r = this.rng;
        this.dropItem(c.x + 0.4, c.y + 0.4, rollItem(r, this.floor, { minRarity: 1, boost: 3 }));
        if (r.chance(0.5)) this.dropItem(c.x - 0.4, c.y + 0.4, rollItem(r, this.floor, { boost: 2 }));
        if (r.chance(0.5)) this.dropGlobe(c.x, c.y - 0.5);
        this.world.burst(c.x, c.y, 0.5, 10, { c0: 0xffe090, c1: 0xa06010, s0: 0.15, s1: 0.03, life: 0.7, speed: 2.5, up: 3 });
      }
      if (c.opened) { c.open = Math.min(1, c.open + dt * 3); if (c.rig.parts.lid) c.rig.parts.lid.rotation.x = c.open * 1.9; }
    }
  }
  updatePickups(dt) {
    const h = this.hero;
    for (const l of this.loot) {
      l.t += dt;
      l.mesh.position.y = 0.45 + Math.sin(l.t * 3) * 0.08; l.mesh.rotation.y += dt * 2;
      if (Math.random() < dt * 5) this.world.particles.emit({ x: l.x, y: 0.4, z: l.y, vy: 1.6, life: 0.9, s0: 0.14, s1: 0.02, c0: new THREE.Color(l.col), c1: new THREE.Color(l.col), drag: 0.3, grav: 0 });
      if (dist(h.x, h.y, l.x, l.y) < (l.globe ? 1.0 : 1.1)) { if (this.pickup(l)) l.taken = true; }
    }
    this.loot = this.loot.filter(l => !l.taken);
  }

  // ------------------------------------------------------------------ visuals
  animateActors(dt) {
    const h = this.hero;
    // hero
    const hr = h.rig;
    hr.group.position.set(h.x, 0, h.y);
    hr.group.rotation.y = h.face;
    let atk = null;
    if (h.atk) { const p = h.atk.t / h.atk.dur; atk = p < 0.4 ? { phase: 'wind', p: p / 0.4 } : p < 0.6 ? { phase: 'strike', p: (p - 0.4) / 0.2 } : { phase: 'recover', p: (p - 0.6) / 0.4 }; }
    animateRig(hr, dt, { moving: h.moveAmt || 0, attack: atk, cast: h.cast > 0 ? 1 - h.cast / 0.35 : 0, dead: h.dead ? Math.min(1, this.deadT * 1.6) : 0 });
    setTint(hr, this.tintKey(h));
    // enemies
    for (const e of this.enemies) {
      const r = e.rig;
      r.group.position.set(e.x, 0, e.y);
      r.group.visible = Math.hypot(e.x - h.x, e.y - h.y) < 15;
      let ry = r.group.rotation.y, ta = e.face;
      r.group.rotation.y = ry + angleDiff(ry, ta) * Math.min(1, dt * 12);
      let atk = null, cast = 0, aim = false;
      if (e.atk) {
        const p = e.atk.t / e.atk.dur;
        if (['melee', 'sweep'].includes(e.atk.kind)) atk = p < 0.6 ? { phase: 'wind', p: p / 0.6 } : p < 0.75 ? { phase: 'strike', p: (p - 0.6) / 0.15 } : { phase: 'recover', p: (p - 0.75) / 0.25 };
        else if (e.atk.kind === 'arrow') aim = true;
        else cast = p;
      }
      animateRig(r, dt, { moving: e.dead ? 0 : e.moveAmt, attack: atk, cast, aim, hover: e.hover ? e.hover + Math.sin(this.time * 4 + e.phase) * 0.08 : 0, dead: e.dead ? Math.min(1, e.deadT * 2) : 0 });
      if (e.dead && e.deadT > 2.4) r.group.scale.multiplyScalar(0.9);
      setTint(r, this.tintKey(e));
    }
    // exit portal shimmer
    if (this.exit) { this.exit.rig.group.position.set(this.exit.x, 0, this.exit.y); }
  }
  tintKey(e) {
    if (e.flash > 0) return 'flash';
    if (e.tintShock > 0) { e.tintShock -= 0.016; return 'shock'; }
    if (e.st.frozen > 0) return 'frozen';
    if (e.st.burn > 0) return 'burn' + (Math.floor(this.time * 10) % 2);
    if (e.st.wet > 0) return 'wet';
    if (e.st.oil > 0) return 'oil';
    return '';
  }
}

export { MON, MODS, SK, BAG_SIZE };
