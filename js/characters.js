// Modular character assembly: body + hair + outfit(s) share ONE skeleton; animations come from shared clip libraries.
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/GLTFLoader.js';
import * as SkeletonUtils from '../vendor/SkeletonUtils.js';

const loader = new GLTFLoader();
const cache = new Map();
export const clips = {};            // name -> AnimationClip  (Quaternius UAL1 + UAL2)
let baseURL = 'assets/';

export function loadGLB(url) {
  if (!cache.has(url)) cache.set(url, new Promise((res, rej) => loader.load(baseURL + url, res, undefined, rej)));
  return cache.get(url);
}
export function setBaseURL(u) { baseURL = u; }

export async function initCharacters() {
  for (const f of ['anim/ual1.glb', 'anim/ual2.glb']) {
    const g = await loadGLB(f);
    for (const c of g.animations) clips[c.name] = c;
  }
}

const HAIR_TINT = { black: 0x141210, brown: 0x3b2618, auburn: 0x5a2a18, blonde: 0xb99a58, grey: 0x8a8a90, red: 0x8a3018, white: 0xd8d8d8 };

export class Character {
  constructor(spec) {
    this.spec = { ...spec };
    this.group = new THREE.Group();
    this.pieces = {};              // slot -> array of meshes
    this.bones = {};
    this.mixer = null; this.actions = {}; this.current = null; this.speed = 1;
  }

  async build() {
    const s = this.spec;
    const bodyG = await loadGLB(`characters/body_${s.gender}_${s.skin || 'light'}.glb`);
    this.model = SkeletonUtils.clone(bodyG.scene);
    this.model.traverse(o => { if (o.isBone) this.bones[o.name] = o; });
    this.group.add(this.model);
    this.body = [];
    this.model.traverse(o => { if (o.isSkinnedMesh) { o.frustumCulled = false; o.castShadow = true; o.receiveShadow = true; this.body.push(o); } });
    this.mixer = new THREE.AnimationMixer(this.model);
    if (s.hair) await this.setHair(s.hair, s.hairColor);
    if (s.brows !== false) await this.setPiece('brows', `characters/brows_${s.gender === 'female' ? 'female' : 'regular'}.glb`, s.hairColor);
    if (s.outfit) await this.setOutfit(s.outfit);
    return this;
  }

  // Swap-in a skinned piece (garment / hair) onto this character's skeleton.
  async setPiece(slot, url, tint = null) {
    for (const m of this.pieces[slot] || []) { m.parent && m.parent.remove(m); }
    this.pieces[slot] = [];
    if (!url) return;
    const g = await loadGLB(url);
    const clone = SkeletonUtils.clone(g.scene);
    const meshes = [];
    clone.traverse(o => { if (o.isSkinnedMesh) meshes.push(o); });
    for (const m of meshes) {
      const bones = m.skeleton.bones.map(b => this.bones[b.name] || b);
      const sk = new THREE.Skeleton(bones, m.skeleton.boneInverses);
      m.parent.remove(m);
      this.model.add(m);
      m.bind(sk, m.bindMatrix);
      m.frustumCulled = false; m.castShadow = true; m.receiveShadow = true;
      if (tint !== null && tint !== undefined) { m.material = m.material.clone(); m.material.color.set(typeof tint === 'string' ? (HAIR_TINT[tint] ?? tint) : tint); }
      this.pieces[slot].push(m);
    }
  }
  setHair(style, color) { return this.setPiece('hair', `characters/hair_${style}.glb`, color || 'brown'); }
  setOutfit(name) { this.spec.outfit = name; return this.setPiece('outfit', `characters/outfit_${this.spec.gender}_${name}.glb`); }
  setVisible(v) { this.group.visible = v; }

  // ---- animation
  action(name) {
    let a = this.actions[name];
    if (!a) {
      const c = clips[name]; if (!c) { console.warn('missing clip', name); return null; }
      a = this.mixer.clipAction(c); this.actions[name] = a;
    }
    return a;
  }
  play(name, { fade = 0.2, loop = true, speed = 1, clamp = false } = {}) {
    const a = this.action(name); if (!a) return null;
    if (this.current === a && a.isRunning()) { a.timeScale = speed; return a; }
    a.reset(); a.enabled = true; a.setEffectiveTimeScale(speed); a.setEffectiveWeight(1);
    a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity); a.clampWhenFinished = clamp;
    if (this.current && this.current !== a) { a.crossFadeFrom(this.current, fade, false); }
    a.play(); this.current = a; this.currentName = name;
    return a;
  }
  update(dt) { this.mixer && this.mixer.update(dt); }
  attach(obj, bone) { const b = this.bones[bone]; if (b) b.add(obj); return obj; }
  dispose() { this.mixer && this.mixer.stopAllAction(); }
}

export async function createCharacter(spec) { return new Character(spec).build(); }
export const HAIR_COLORS = Object.keys(HAIR_TINT);
