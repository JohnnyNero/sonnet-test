// Environment kit loader (Blender-authored .glb in assets/env). Falls back to simple boxes if a model is missing.
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/GLTFLoader.js';
import { prepareObject, patchMaterial } from './materials.js';

const loader = new GLTFLoader();
const templates = new Map();
let manifest = {};
let baseURL = 'assets/';
export function setEnvBase(u) { baseURL = u; }

export async function loadManifest() {
  try { const r = await fetch(baseURL + 'env/manifest.json'); const j = await r.json(); for (const m of j) manifest[m.name] = m; } catch (e) { /* optional */ }
  return manifest;
}
export const footprint = name => manifest[name]?.footprint || null;
export const modelInfo = name => manifest[name] || null;

export async function loadEnvModels(names, onProgress) {
  let n = 0;
  await Promise.all([...new Set(names)].map(name => new Promise(res => {
    if (templates.has(name)) return res();
    loader.load(`${baseURL}env/${name}.glb`, g => {
      prepareObject(g.scene); g.scene.updateMatrixWorld(true);
      templates.set(name, g.scene); onProgress && onProgress(++n, names.length); res();
    }, undefined, () => { templates.set(name, null); onProgress && onProgress(++n, names.length); res(); });
  })));
}
export const hasModel = name => !!templates.get(name);

const fbMats = {};
function fbMat(hex, emissive = false) {
  const k = hex + (emissive ? 'e' : '');
  if (!fbMats[k]) {
    const m = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.85, flatShading: true });
    if (emissive) { m.emissive = new THREE.Color(hex); m.emissiveIntensity = 2; }
    fbMats[k] = patchMaterial(m);
  }
  return fbMats[k];
}
// Simple stand-ins so the game still runs when a model is not available.
export function fallback(name, w = 1, d = 1, h = 1, hex = 0x55506a) {
  const g = new THREE.Group();
  const m = new THREE.Mesh(new THREE.BoxGeometry(w * 0.96, h, d * 0.96), fbMat(hex));
  m.position.y = h / 2; g.add(m);
  return g;
}

export function template(name) { return templates.get(name) || null; }

// Individual clone (for interactive props / doors that need to be animated).
export function cloneModel(name, fb = {}) {
  const t = templates.get(name);
  if (t) return t.clone(true);
  return fallback(name, fb.w, fb.d, fb.h, fb.color);
}
export function findPart(root, partName) { let f = null; root.traverse(o => { if (!f && o.name === partName) f = o; }); return f; }

// Build InstancedMeshes for one model from a list of matrices (THREE.Matrix4). Returns {group, meshes}.
export function instanced(name, matrices, { colors = null, fb = {} } = {}) {
  const group = new THREE.Group(); const meshes = [];
  if (!matrices.length) return { group, meshes };
  const t = templates.get(name);
  const parts = [];
  if (t) t.traverse(o => { if (o.isMesh) parts.push({ geo: o.geometry, mat: o.material, rel: o.matrixWorld.clone() }); });
  else {
    const f = fallback(name, fb.w, fb.d, fb.h, fb.color);
    f.updateMatrixWorld(true);
    f.traverse(o => { if (o.isMesh) parts.push({ geo: o.geometry, mat: o.material, rel: o.matrixWorld.clone() }); });
  }
  const tmp = new THREE.Matrix4();
  for (const p of parts) {
    const im = new THREE.InstancedMesh(p.geo, p.mat, matrices.length);
    for (let i = 0; i < matrices.length; i++) { tmp.multiplyMatrices(matrices[i], p.rel); im.setMatrixAt(i, tmp); }
    if (colors) for (let i = 0; i < matrices.length; i++) im.setColorAt(i, colors[i]);
    im.instanceMatrix.needsUpdate = true; im.frustumCulled = false; im.userData.rel = p.rel;
    group.add(im); meshes.push(im);
  }
  return { group, meshes };
}
