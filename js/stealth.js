// Stealth rules: how visible is the player, who can hear what, and what a disguise buys you.
import { angleDiff } from './actor.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------------------------------------------------------
// Disguises. `allow` = zone types the disguise is legitimate in. `see` = factions that see through it at close range.
export const DISGUISES = {
  none:   { label: 'Infiltrator', allow: [], see: [], outfits: ['thief'], hint: 'Anyone who sees you is a problem' },
  guest:  { label: 'Gala Guest', allow: ['public'], see: [], outfits: ['tuxedo', 'dress', 'dress_green'], hint: 'Fine in public areas only' },
  waiter: { label: 'Waiter', allow: ['public', 'staff'], see: ['waiter'], outfits: ['waiter'], hint: 'Public + staff areas. Other waiters may see through it' },
  chef:   { label: 'Kitchen Staff', allow: ['public', 'staff'], see: ['chef'], outfits: ['chef'], hint: 'Public + staff areas. Kitchen crew may see through it' },
  staff:  { label: 'Maintenance', allow: ['public', 'staff', 'restricted'], see: ['staff'], outfits: ['staff'], hint: 'Staff + restricted. Maintenance crew may see through it' },
  guard:  { label: 'Security', allow: ['public', 'staff', 'restricted'], see: ['guard'], outfits: ['guard', 'guard_elite'], hint: 'Everywhere except the vault. Guards may see through it' },
  exec:   { label: 'Executive', allow: ['public', 'restricted'], see: ['exec'], outfits: ['exec_suit'], hint: 'Public + restricted. Executives may see through it' },
};
export function disguiseOfOutfit(o) { for (const k in DISGUISES) if (DISGUISES[k].outfits.includes(o)) return k; return 'none'; }
export function outfitForDisguise(d, gender) {
  const opts = DISGUISES[d].outfits;
  if (d === 'guest') return gender === 'female' ? 'dress' : 'tuxedo';
  return opts[0];
}

// Is `d` (disguise key) legitimate in this zone type?
export const disguiseAllows = (d, zoneType) => zoneType === 'outside' ? d !== 'none' || false : DISGUISES[d].allow.includes(zoneType);

// ---------------------------------------------------------------------------------------------------------------
// Line of sight with cover: a crouching/crawling target hides behind waist-high furniture.
export function sightBlocked(game, ox, oy, tx, ty, tgtStance) {
  const L = game.level;
  const crouched = tgtStance !== 'stand';
  const tcx = Math.floor(tx), tcy = Math.floor(ty);
  const r = L.ray(ox, oy, tx, ty, (cx, cy) => {
    if (L.opaqueAt(cx, cy)) return true;
    if (crouched && L.cover[cy * L.W + cx] && !(cx === tcx && cy === tcy)) return true;
    return false;
  });
  return r.hit;
}

// ---------------------------------------------------------------------------------------------------------------
// Exposure of a target to an observer, 0..~1.5. >0 means "currently seen" (rate of suspicion gain).
//   obs: { x, y, face, vRange, vFov (full angle rad), vNear, torchOn, torchRange, torchAngle, kind }
export function exposure(game, obs, tgt, { ignoreDisguise = false } = {}) {
  if (tgt.hidden || tgt.state === 'hidden') return 0;
  const dx = tgt.x - obs.x, dy = tgt.y - obs.y, d = Math.hypot(dx, dy);
  const range = Math.max(obs.vRange, obs.torchOn ? obs.torchRange : 0);
  if (d > range) return 0;
  const bearing = Math.atan2(dx, dy), off = Math.abs(angleDiff(obs.face, bearing));
  // a tight all-round bubble (you can feel someone right behind you), a wide 150-degree close range, then the normal cone
  const nearFull = d < (obs.vNearBack ?? 0.9), nearWide = d < obs.vNear && off <= 1.3;
  const near = nearFull || nearWide;
  let inCone = near || off <= obs.vFov / 2;
  let inTorch = false;
  if (obs.torchOn && d <= obs.torchRange && off <= obs.torchAngle) { inTorch = true; inCone = true; }
  if (!inCone) return 0;
  if (sightBlocked(game, obs.x, obs.y, tgt.x, tgt.y, tgt.stance)) return 0;
  // how well lit is the target?
  const lum = game.field.sample(tgt.x, tgt.y).lum;
  let light = smooth(0.045, 0.55, lum);
  if (inTorch) light = Math.max(light, 0.95);
  if (near) light = Math.max(light, 0.65);
  const stance = tgt.stance === 'stand' ? 1 : tgt.stance === 'crouch' ? 0.62 : 0.4;
  const spd = tgt.speed || 0;
  const move = spd > 3 ? 1.5 : spd > 0.4 ? 1.0 : 0.7;
  const dist = 1 - Math.pow(Math.min(1, d / range), 1.5);
  const peripheral = near ? 1 : 1 - 0.45 * smooth(obs.vFov * 0.3, obs.vFov / 2, off);
  return clamp(light * stance * move * (0.2 + 0.8 * dist) * peripheral * 1.25, 0, 1.6);
}

// ---------------------------------------------------------------------------------------------------------------
// Disguise verdict for an observer looking at the player.
//   returns 'ok' (nothing to see), 'trespass' (wrong place for this disguise), 'seethrough' (same faction, scrutinises), 'naked'.
export function disguiseVerdict(game, obs, player) {
  const d = player.disguise || 'none';
  const zone = game.level.zoneTypeAt(player.x, player.y);
  if (d === 'none') return 'naked';
  if (!disguiseAllows(d, zone)) return 'trespass';
  const dist = Math.hypot(obs.x - player.x, obs.y - player.y);
  if (DISGUISES[d].see.includes(obs.faction) && dist < 3.2) return 'seethrough';
  return 'ok';
}

// Things that blow a disguise if witnessed.
export function suspiciousBehaviour(player) {
  if (player.busy && player.busy.illegal) return player.busy.illegal;
  if (player.carrying) return 'carrying a body';
  if (player.weaponOut) return 'holding a weapon';
  if (player.stance !== 'stand' && !player.inVent) return 'crouching';
  if (player.running) return 'running';
  if (player.slide) return 'sliding';
  return null;
}
