// Loads the Blender-exported .glb cast and rigs them for procedural animation.
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/GLTFLoader.js';

const NAMES = ['hero', 'skeleton', 'archer', 'brute', 'shaman', 'bat', 'boss',
  'barrel_oil', 'barrel_water', 'chest', 'brazier', 'exit'];
const templates = {};

export async function loadModels(onProgress) {
  const loader = new GLTFLoader();
  let done = 0;
  await Promise.all(NAMES.map(n => new Promise((res, rej) => {
    loader.load(`assets/models/${n}.glb`, g => {
      g.scene.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      templates[n] = g.scene; onProgress && onProgress(++done, NAMES.length); res();
    }, undefined, rej);
  })));
}

const PART_NAMES = ['head', 'legL', 'legR', 'armL', 'armR', 'wingL', 'wingR', 'lid', 'orb'];
const FLASH = new THREE.Color(0xffffff);

// Returns a rig: { group, model, parts, mats }. Materials are cloned so status tints are per-actor.
export function makeRig(name) {
  const model = templates[name].clone(true);
  const mats = [];
  model.traverse(o => {
    if (!o.isMesh) return;
    o.material = o.material.clone();
    o.material.userData.baseE = o.material.emissive.clone();
    o.material.userData.baseI = o.material.emissiveIntensity;
    mats.push(o.material);
  });
  const parts = {};
  for (const p of PART_NAMES) { const o = model.getObjectByName(p); if (o) parts[p] = o; }
  const group = new THREE.Group();
  group.add(model);
  return { group, model, parts, mats, phase: Math.random() * 6, tintKey: '' };
}

const TINTS = { flash: [FLASH, 0.9], frozen: [new THREE.Color(0x6fd6ff), 0.75], burn: [new THREE.Color(0xff6a10), 0.55],
  wet: [new THREE.Color(0x2a6fb0), 0.25], oil: [new THREE.Color(0x2a1a3a), 0.2], shock: [new THREE.Color(0xa0f0ff), 0.8] };
export function setTint(rig, key) {
  if (rig.tintKey === key) return;
  rig.tintKey = key;
  const t = key ? TINTS[key.split('|')[0]] : null;
  for (const m of rig.mats) {
    if (!t) { m.emissive.copy(m.userData.baseE); m.emissiveIntensity = m.userData.baseI; }
    else { m.emissive.copy(t[0]); m.emissiveIntensity = t[1]; }
  }
}

// state: { moving:0..1, t, attack:{phase:'wind'|'strike'|'recover', p:0..1}|null, cast:0..1, dead:0..1 }
export function animateRig(rig, dt, s) {
  const P = rig.parts;
  rig.phase += dt * (4 + 8 * s.moving) ;
  const sw = Math.sin(rig.phase * 1.6) * 0.75 * s.moving;
  if (P.legL) { P.legL.rotation.x = -sw; P.legR.rotation.x = sw; }
  rig.model.position.y = Math.abs(Math.sin(rig.phase * 1.6)) * 0.06 * s.moving + (s.hover || 0);
  const breathe = Math.sin(rig.phase * 0.5) * 0.02;
  if (P.head) P.head.rotation.x = breathe;
  let armR = sw * 0.6, armL = -sw * 0.8;
  if (s.aim) { armL = -1.5; armR = -0.8; }
  if (s.attack) {
    const { phase, p } = s.attack;
    if (phase === 'wind') armR = -2.8 * p;
    else if (phase === 'strike') armR = -2.8 + 2.5 * p;
    else armR = -0.3 * (1 - p);
    if (P.armL && s.twoHand) armL = armR;
  }
  if (s.cast > 0) { armR = -2.0 - Math.sin(s.cast * Math.PI) * 0.6; }
  if (P.armL) P.armL.rotation.x = armL;
  if (P.armR) P.armR.rotation.x = armR;
  if (P.wingL) { const f = Math.sin(rig.phase * 5) * 0.9; P.wingL.rotation.z = f; P.wingR.rotation.z = -f; }
  if (P.orb) P.orb.scale.setScalar(1 + Math.sin(rig.phase * 2) * 0.15);
  // death: topple backwards and sink
  if (s.dead > 0) {
    const e = Math.min(1, s.dead);
    rig.model.rotation.x = -Math.PI / 2 * e * e * (3 - 2 * e) * 0.98;
    rig.model.position.y = -0.1 * e + (s.hover ? s.hover * (1 - e) : 0);
  } else rig.model.rotation.x = 0;
}
