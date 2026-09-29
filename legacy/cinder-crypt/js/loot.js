// Procedural loot. Affixes deliberately key into the surface reactions.
export const SLOTS = ['weapon', 'armor', 'ring', 'amulet'];
export const RARITY = [
  { name: 'Common', color: '#cfcac2' },
  { name: 'Magic', color: '#6f95ff' },
  { name: 'Rare', color: '#ffd24a' },
];

const BASES = {
  weapon: ['Ash Staff', 'Gnarled Staff', 'Bone Staff', 'Ember Rod', 'Iron-shod Staff'],
  armor: ['Tattered Robe', 'Warded Robe', 'Cindercloth Robe', 'Scale Vestments'],
  ring: ['Copper Band', 'Bone Ring', 'Signet', 'Ash Ring'],
  amulet: ['Talisman', 'Fetish', 'Pendant', 'Charm'],
};
const RARE_A = ['Doom', 'Cinder', 'Gloom', 'Storm', 'Grave', 'Ash', 'Wraith', 'Ember', 'Frost', 'Blight', 'Dread'];
const RARE_B = ['Grip', 'Wail', 'Bite', 'Song', 'Veil', 'Mark', 'Coil', 'Ward', 'Spark', 'Lash'];

const ALL = ['weapon', 'armor', 'ring', 'amulet'];
// v = [min,max] at floor 1; life/armor scale with floor.
export const AFFIXES = {
  dmg:      { w: 10, slots: ALL, v: [6, 14],  fmt: v => `+${v}% Damage`, tag: 'of Power' },
  life:     { w: 10, slots: ALL, v: [14, 30], fmt: v => `+${v} Life`, tag: 'of Vigor', scale: true },
  speed:    { w: 6,  slots: ['armor', 'ring', 'amulet'], v: [4, 9], fmt: v => `+${v}% Move Speed`, tag: 'of Haste' },
  cdr:      { w: 7,  slots: ALL, v: [6, 14],  fmt: v => `-${v}% Cooldowns`, tag: 'of Focus' },
  fire:     { w: 8,  slots: ALL, v: [14, 32], fmt: v => `+${v}% Fire Damage`, tag: 'of Embers' },
  shock:    { w: 8,  slots: ALL, v: [14, 32], fmt: v => `+${v}% Shock Damage`, tag: 'of Storms' },
  frost:    { w: 8,  slots: ALL, v: [14, 32], fmt: v => `+${v}% Frost Damage`, tag: 'of Rime' },
  vsBurn:   { w: 6,  slots: ALL, v: [16, 36], fmt: v => `+${v}% Damage to Burning`, tag: 'of the Pyre' },
  vsWet:    { w: 6,  slots: ALL, v: [16, 36], fmt: v => `+${v}% Damage to Wet`, tag: 'of the Tide' },
  vsFrozen: { w: 5,  slots: ALL, v: [20, 45], fmt: v => `+${v}% Damage to Frozen`, tag: 'of Shattering' },
  ignite:   { w: 5,  slots: ['weapon', 'ring', 'amulet'], v: [12, 28], fmt: v => `${v}% chance to ignite on hit`, tag: 'of Kindling' },
  fireRes:  { w: 6,  slots: ['armor', 'ring', 'amulet'], v: [12, 26], fmt: v => `-${v}% Fire Damage Taken`, tag: 'of Warding' },
  shockRes: { w: 6,  slots: ['armor', 'ring', 'amulet'], v: [12, 26], fmt: v => `-${v}% Shock Damage Taken`, tag: 'of Grounding' },
  armor:    { w: 7,  slots: ['armor', 'amulet'], v: [3, 7], fmt: v => `+${v} Armor`, tag: 'of Bulwark', scale: true },
  oilTrail: { w: 1.4, slots: ['armor', 'ring', 'amulet'], rare: true, v: [1, 1], fmt: () => 'Leaves a trail of oil behind you', tag: 'of the Slick' },
  ironsole: { w: 1.4, slots: ['armor', 'ring'], rare: true, v: [1, 1], fmt: () => 'Never slip on ice', tag: 'of Steady Feet' },
};

let uid = 1;
export function rollItem(rng, floor, opts = {}) {
  const { minRarity = 0, boost = 0 } = opts;
  const slot = opts.slot || rng.pick(SLOTS);
  let rar = rng.weighted([0, 1, 2], r => [55 - boost * 3, 33 + boost * 1.5, 12 + boost * 1.5 + floor * 2][r]);
  rar = Math.max(rar, minRarity, slot === 'ring' || slot === 'amulet' ? 1 : 0);
  const n = rar === 0 ? 0 : rar === 1 ? rng.int(1, 2) : rng.int(3, 4);
  const pool = Object.keys(AFFIXES).filter(k => AFFIXES[k].slots.includes(slot) && (!AFFIXES[k].rare || rar === 2));
  const affixes = [];
  while (affixes.length < n && pool.length) {
    const id = rng.weighted(pool, k => AFFIXES[k].w);
    pool.splice(pool.indexOf(id), 1);
    const a = AFFIXES[id];
    let lo = a.v[0], hi = a.v[1];
    if (a.scale) { const m = 1 + (floor - 1) * 0.45; lo = Math.round(lo * m); hi = Math.round(hi * m); }
    affixes.push({ id, v: rng.int(lo, hi) });
  }
  const base = rng.pick(BASES[slot]);
  const item = { uid: uid++, slot, rarity: rar, base, affixes, floor };
  if (slot === 'weapon') item.weaponDmg = Math.round((3 + floor * 1.6) * (1 + rar * 0.35) * rng.range(0.85, 1.2));
  if (slot === 'armor') item.armor = Math.round((3 + floor * 2.5) * (1 + rar * 0.3) * rng.range(0.85, 1.2));
  item.name = rar === 0 ? base
    : rar === 1 ? `${base} ${AFFIXES[affixes[0].id].tag}`
    : `${rng.pick(RARE_A)} ${rng.pick(RARE_B)}`;
  return item;
}

export function emptyStats() {
  return { dmg: 0, life: 0, speed: 0, cdr: 0, fire: 0, shock: 0, frost: 0, vsBurn: 0, vsWet: 0, vsFrozen: 0,
    ignite: 0, fireRes: 0, shockRes: 0, armor: 0, weaponDmg: 0, oilTrail: false, ironsole: false };
}
export function computeStats(equipped) {
  const s = emptyStats();
  for (const slot of SLOTS) {
    const it = equipped[slot];
    if (!it) continue;
    if (it.weaponDmg) s.weaponDmg += it.weaponDmg;
    if (it.armor) s.armor += it.armor;
    for (const a of it.affixes) {
      if (a.id === 'oilTrail' || a.id === 'ironsole') s[a.id] = true; else s[a.id] += a.v;
    }
  }
  return s;
}
export function describe(it) {
  const lines = [];
  if (it.weaponDmg) lines.push(`+${it.weaponDmg} Staff Damage`);
  if (it.armor) lines.push(`${it.armor} Armor`);
  for (const a of it.affixes) lines.push(AFFIXES[a.id].fmt(a.v));
  return lines;
}
