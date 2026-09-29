// Game methods for context interactions, non-lethal takedowns and gadget effects. Installed onto Game.prototype.
import { Game } from './game.js';
import { angleDiff } from './actor.js';
import { DISGUISES, disguiseOfOutfit } from './stealth.js';
import { addRim } from './materials.js';

const P = Game.prototype;

P.applyPlayerRim = function () { if (this.player && this.player.group) addRim(this.player.group, 0x3a7cff); };

// ---------------------------------------------------------------------------------------------- interaction discovery
P.findInteractions = function (p) {
  const out = [];
  // ---- people
  for (const a of this.actors) {
    if (a === p || a.kind === 'player') continue;
    const dx = a.x - p.x, dy = a.y - p.y, d = Math.hypot(dx, dy);
    if (d > 1.65) continue;
    if (a.state === 'down') {
      if (a.hidden || a.z > 0.5) continue;
      if (!p.carrying) {
        out.push({ pri: 5, d, label: 'Pick up body', hold: 0.6, run: pl => { pl.carrying = a; a.carried = true; this.toast('Carrying a body. Find a locker, dumpster or vent', 'info'); } });
        const dkey = a.disguiseKey || disguiseOfOutfit(a.spec.outfit || 'guard');
        if (!a.stripped && dkey !== 'none' && DISGUISES[dkey] && dkey !== p.disguise) {
          out.push({ pri: 6, d, label: `Take ${DISGUISES[dkey].label} disguise`, hold: 0, run: pl => this.stripAndDisguise(pl, a, dkey) });
        }
        if (a.hasKeycard && !p.inv.keycard) out.push({ pri: 7, d, label: 'Search body: keycard', hold: 0.9, run: pl => { pl.inv.keycard = true; a.hasKeycard = false; this.onItem && this.onItem('keycard'); this.toast('Found a keycard', 'good'); } });
        if (a.carriesIntel && !a.intelTaken) out.push({ pri: 7, d, label: 'Search body: ' + a.carriesIntel.label, hold: 0.9, run: pl => { a.intelTaken = true; this.gainIntel(a.carriesIntel); } });
      }
      continue;
    }
    if (a.state !== 'active' && a.state !== 'patrol' && a.state !== 'return' && a.state !== 'investigate' && a.state !== 'suspicious' && a.state !== 'conversing' && a.state !== 'search') continue;
    // from behind? (angle between the target's facing and the direction target->player)
    const bearing = Math.atan2(p.x - a.x, p.y - a.y), off = Math.abs(angleDiff(a.face, bearing));
    const behind = off > 1.95;
    const unaware = !(a.state === 'alert') && !a.seesPlayer;
    if (a.kind === 'guard' || a.kind === 'npc') {
      if (behind && unaware && !(a.fleeT > 0) && !p.carrying) {
        out.push({ pri: 8, d, label: a.kind === 'guard' ? 'Choke out' : 'Knock out', hold: 0, run: pl => this.takedown(pl, a) });
        if ((a.hasKeycard && !pl_has(p, 'keycard')) || (a.carriesIntel && !a.intelTaken)) {
          out.push({ pri: 9, d, label: a.hasKeycard ? 'Pickpocket keycard' : 'Pickpocket ' + a.carriesIntel.label, hold: 1.1, run: pl => this.pickpocket(pl, a) });
        }
      }
    }
  }
  // ---- carrying a body
  if (p.carrying) out.push({ pri: 1, d: 9, label: 'Drop body', hold: 0, run: pl => pl.dropBody() });
  // ---- devices and world
  for (const it of this.interactables) {
    if (it.disabled) continue;
    const d = Math.hypot(it.x - p.x, it.y - p.y);
    if (d > (it.r || 1.5)) continue;
    const info = it.get(p, d);
    if (!info) continue;
    out.push({ pri: info.pri ?? 4, d, label: info.label, hold: info.hold || 0, enabled: info.enabled, reason: info.reason, run: info.run || (pl => it.run(pl)) });
  }
  out.sort((a, b) => (b.pri - a.pri) || (a.d - b.d));
  return out;
};
const pl_has = (p, k) => p.inv[k];

// ---------------------------------------------------------------------------------------------- takedown / body handling
P.takedown = function (p, a) {
  const dx = a.x - p.x, dy = a.y - p.y;
  p.face = Math.atan2(dx, dy);
  a.moveToward && (a.vx = a.vy = 0);
  p.act('Punch_Cross', { speed: 1.5 });
  a.state = a.kind === 'guard' ? 'sedated' : 'sedated'; a.sedT = 0.55;
  a.locked = true; a.action = null; a.sedGrab = true;
  a.act && a.act('Hit_Head', { speed: 1.2 });
  this.stats.knockouts++;
  this.noise(a.x, a.y, 2.8, 'bodyfall', p);
  this.audio && this.audio.thud && this.audio.thud();
};
P.pickpocket = function (p, a) {
  p.face = Math.atan2(a.x - p.x, a.y - p.y);
  p.act('PickUp_Table', { speed: 1.2 });
  if (a.hasKeycard) { a.hasKeycard = false; p.inv.keycard = true; this.onItem && this.onItem('keycard'); this.toast('Keycard lifted', 'good'); }
  else if (a.carriesIntel) { a.intelTaken = true; this.gainIntel(a.carriesIntel); }
  this.audio && this.audio.pickup && this.audio.pickup();
};
P.stripAndDisguise = function (p, a, key) {
  p.startBusy('Changing clothes', 2.4, () => {
    a.stripped = true; a.disguiseKey = 'none';
    a.char.setOutfit(null);
    p.setDisguise(key);
    this.applyPlayerRim();
  }, { illegal: 'changing clothes', anim: 'Interact', noise: 0.8 });
};
P.gainIntel = function (intel) {
  const p = this.player; p.inv.intel[intel.key] = intel.value;
  this.toast(`${intel.label}: ${intel.value}`, 'good');
  this.onItem && this.onItem('intel:' + intel.key);
};

// ---------------------------------------------------------------------------------------------- gadgets
P.fireDart = function (p, tx, ty) {
  const dx = tx - p.x, dy = ty - p.y, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d;
  const ox = p.x + ux * 0.4, oy = p.y + uy * 0.4;
  const L = this.level;
  const wall = L.ray(ox, oy, p.x + ux * 16, p.y + uy * 16, (cx, cy) => L.opaqueAt(cx, cy) && !L.passable(cx, cy));
  let maxT = wall.hit ? wall.t : 16, hit = null, ht = maxT;
  for (const a of this.actors) {
    if (a === p || a.state === 'down' || a.hidden || a.kind === 'player') continue;
    const ax = a.x - ox, ay = a.y - oy, t = ax * ux + ay * uy;
    if (t < 0.3 || t > maxT) continue;
    const perp = Math.abs(ax * uy - ay * ux);
    if (perp < 0.42 && t < ht) { ht = t; hit = a; }
  }
  // breakable lights near the end of the flight
  const ex = ox + ux * ht, ey = oy + uy * ht;
  this.fx.tracer(ox, oy, 1.2, ex, ey, hit ? 1.2 : 1.0, 0xbfefff, 0.16);
  this.noise(p.x, p.y, 1.6, 'dart', p);
  if (hit) { hit.sedate && hit.sedate(p); this.fx.sparks(ex, ey, 1.2, 8, 0x9fd0ff, 2); this.audio && this.audio.dart && this.audio.dart(); return; }
  // no creature: try a light
  let best = null, bd = 1.7;
  for (const l of L.lights) { if (!l.breakable || l.broken || l.on === false) continue; const dd = Math.hypot(l.x - tx, l.y - ty); if (dd < bd && !L.ray(p.x, p.y, l.x, l.y).hit) { bd = dd; best = l; } }
  if (best) { this.breakLight(best); return; }
  this.fx.sparks(ex, ey, 1.0, 5, 0xcccccc, 1.5);
};
P.breakLight = function (l) {
  if (l.broken) return;
  l.broken = true; this.field.setOn(l, false);
  this.fx.sparks(l.x, l.y, 2.9, 24, 0xffd890, 4);
  this.noise(l.x, l.y, 6, 'glass', this.player);
  this.audio && this.audio.glass && this.audio.glass();
  this.stats.lightsBroken = (this.stats.lightsBroken || 0) + 1;
  if (l.obj) l.obj.visible = false;
};
P.throwObject = function (p, x, y, type) {
  const L = this.level;
  // stop at walls
  const wall = L.ray(p.x, p.y, x, y);
  if (wall.hit) { const t = Math.max(0, wall.t - 0.3), d = Math.hypot(x - p.x, y - p.y) || 1; x = p.x + (x - p.x) / d * t; y = p.y + (y - p.y) / d * t; }
  const color = type === 'emp' ? 0x60d8ff : 0xd8c050;
  this.fx.projectile(p.x, p.y, x, y, { color, size: type === 'emp' ? 0.1 : 0.06, dur: 0.35 + Math.hypot(x - p.x, y - p.y) * 0.03, onLand: () => {
    if (type === 'coin') { this.noise(x, y, 9, 'coin', p); this.fx.ring(x, y, 0.3, 4, 0xffe080, 0.8, 0.6); this.audio && this.audio.coin && this.audio.coin(); }
    else this.detonateEMP(x, y, 5.2);
  } });
};
P.detonateEMP = function (x, y, r) {
  this.fx.ring(x, y, 0.4, r, 0x60d8ff, 0.9, 0.8); this.fx.sparks(x, y, 0.6, 30, 0x80e8ff, 5);
  this.noise(x, y, 4, 'emp', this.player); this.audio && this.audio.emp && this.audio.emp();
  for (const c of this.cameras) if (Math.hypot(c.x - x, c.y - y) < r + 1) c.disable(14);
  for (const l of this.lasers) if (Math.hypot(l.cx - x, l.cy - y) < r + 2) l.disable(14);
  for (const d of this.devices) if (d.emp && Math.hypot(d.x - x, d.y - y) < r + 1) d.emp(14);
  // lights flicker out for a while
  for (const l of this.level.lights) {
    if (l.broken || l.on === false || l.emp === false) continue;
    if (Math.hypot(l.x - x, l.y - y) < r + 1.5) { this.field.setOn(l, false); this.after(10, () => { if (!l.broken) this.field.setOn(l, true); }); }
  }
  for (const gd of this.guards) if (gd.state !== 'down' && Math.hypot(gd.x - x, gd.y - y) < r + 4) gd.hear({ x, y, type: 'emp' });
};
P.fireTaser = function (gd) {
  const p = this.player; if (!p || p.state === 'down') return;
  const d = Math.hypot(p.x - gd.x, p.y - gd.y);
  const chance = Math.max(0.18, Math.min(0.85, 0.9 - d * 0.055 - p.speed * 0.05 - (p.stance === 'stand' ? 0 : 0.12)));
  this.fx.tracer(gd.x + gd.fx * 0.4, gd.y + gd.fy * 0.4, 1.3, p.x, p.y, 1.1, 0xffee66, 0.12);
  this.audio && this.audio.taser && this.audio.taser();
  if (Math.random() < chance && !this.level.ray(gd.x, gd.y, p.x, p.y).hit) this.after(0.1, () => p.hit(gd));
};

// ---------------------------------------------------------------------------------------------- Game methods
P.enterVent = function (p, grate) {
  const c = grate.ventCell;
  p.inVent = true; p.stance = 'crouch'; p.x = c.x + 0.5; p.y = c.y + 0.5; p.vx = p.vy = 0;
  this.R.ventMode = true; if (this.R.ventGroup) this.R.ventGroup.visible = true;
  this.R.cam.tDist = 11; this.R.cam.tPitch = 1.2;
  this.toast('Crawling through the vents. Guards can barely hear you', 'info');
  this.noise(p.x, p.y, 2.5, 'vent', p);
};
P.ventExit = function (p, grate) {
  const c = grate.ventCell; return Math.hypot(p.x - (c.x + 0.5), p.y - (c.y + 0.5)) < 1.15;
};
P.exitVent = function (p, grate) {
  p.inVent = false; p.stance = 'crouch'; p.x = grate.exitAt.x; p.y = grate.exitAt.y; p.vx = p.vy = 0;
  this.R.ventMode = false; if (this.R.ventGroup) this.R.ventGroup.visible = false;
  this.R.cam.tDist = 19; this.R.cam.tPitch = 1.08;
  this.noise(p.x, p.y, 3, 'work', p);
};
