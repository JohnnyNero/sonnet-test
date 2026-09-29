// Ventilation network: a second grid that runs over walls. The player crawls through it, unseen, between grates.
import * as THREE from 'three';
import { Level } from './level.js';
import * as Env from './envkit.js';

export function makeVent(W, H, plan) {
  const v = new Level(W, H);
  v.zones = [{ name: 'vent', type: 'vent' }]; v.isVent = true;
  for (const [x, y] of plan.cells) { const i = v.idx(x, y); v.carved[i] = 1; }
  v.grates = plan.grates;
  return v;
}

// Which model + rotation for a duct cell, given which of its 4 neighbours are ducts.
// Base connections (model space, +Z = south): straight W+E, corner W+S, tee W+E+S, cross all, end W.
// Rotating by +90deg about Y maps W->S->E->N->W.
const NEXT = { W: 'S', S: 'E', E: 'N', N: 'W' };
function rotSet(set, times) { let s = new Set(set); for (let i = 0; i < times; i++) s = new Set([...s].map(d => NEXT[d])); return s; }
function sameSet(a, b) { return a.size === b.size && [...a].every(x => b.has(x)); }
const BASES = { vent_straight: ['W', 'E'], vent_corner: ['W', 'S'], vent_tee: ['W', 'E', 'S'], vent_cross: ['W', 'E', 'S', 'N'], vent_end: ['W'] };
export function ductFor(conns) {
  const want = new Set(conns);
  for (const [name, base] of Object.entries(BASES)) {
    if (base.length !== want.size) continue;
    for (let r = 0; r < 4; r++) if (sameSet(rotSet(base, r), want)) return { name, rot: r * Math.PI / 2 };
  }
  return { name: 'vent_end', rot: 0 };
}

export function buildVentVisuals(R, vent) {
  const group = new THREE.Group(); group.visible = false; R.ventGroup = group; R.levelGroup.add(group);
  const { W, H } = vent;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), yAxis = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1);
  const byName = {};
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!vent.carved[vent.idx(x, y)]) continue;
    const c = [];
    if (vent.inb(x - 1, y) && vent.carved[vent.idx(x - 1, y)]) c.push('W');
    if (vent.inb(x + 1, y) && vent.carved[vent.idx(x + 1, y)]) c.push('E');
    if (vent.inb(x, y + 1) && vent.carved[vent.idx(x, y + 1)]) c.push('S');
    if (vent.inb(x, y - 1) && vent.carved[vent.idx(x, y - 1)]) c.push('N');
    const d = ductFor(c);
    m4.compose(new THREE.Vector3(x + 0.5, 0.02, y + 0.5), q.setFromAxisAngle(yAxis, d.rot), one);
    (byName[d.name] = byName[d.name] || []).push(m4.clone());
  }
  for (const n in byName) { const g = Env.instanced(n, byName[n], { fb: { w: 1, d: 1, h: 0.7, color: 0x606870 } }); group.add(g.group); }
  return group;
}

