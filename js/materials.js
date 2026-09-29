// Patches Three's standard materials so they are lit by the CPU light field and masked by the player's line of sight.
import * as THREE from 'three';

export const shared = {
  uLight: { value: null }, uVis: { value: null }, uMap: { value: new THREE.Vector2(64, 64) },
  uTime: { value: 0 }, uAlarm: { value: 0 }, uExposure: { value: 1.7 }, uNight: { value: 0 },
};

const VERT_COMMON = '#include <common>\nvarying vec3 vLmPos; varying vec3 vLmNrm;';
const VERT_PROJECT = `#include <project_vertex>
#ifdef USE_INSTANCING
  vec4 lmw = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
  vLmNrm = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal);
#else
  vec4 lmw = modelMatrix * vec4(transformed, 1.0);
  vLmNrm = normalize(mat3(modelMatrix) * objectNormal);
#endif
  vLmPos = lmw.xyz;`;

const FRAG_COMMON = `#include <common>
uniform sampler2D uLight; uniform sampler2D uVis; uniform vec2 uMap; uniform float uTime; uniform float uAlarm; uniform float uExposure;
varying vec3 vLmPos; varying vec3 vLmNrm;`;
const FRAG_OUT = `{
  vec2 puv = (vLmPos.xz + vLmNrm.xz * 0.5) / uMap;
  vec3 Lc = texture2D(uLight, puv).rgb; Lc = Lc * Lc * 3.0;
  Lc += vec3(0.5, 0.02, 0.02) * uAlarm * (0.4 + 0.6 * sin(uTime * 6.0 + vLmPos.x * 0.3 + vLmPos.z * 0.3)) * 0.05;
  float up = clamp(vLmNrm.y * 0.5 + 0.5, 0.0, 1.0);
  float shade = 0.55 + 0.45 * up;
  vec3 lit = diffuseColor.rgb * Lc * shade * uExposure;
  vec4 vm = texture2D(uVis, vLmPos.xz / uMap);
  float k = mix(vm.g * 0.09, 1.0, vm.r);
  vec3 rimc = vec3(0.0);
#ifdef LM_RIM
  { float fr = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 2.2); rimc = LM_RIM_COLOR * fr * 0.28 + LM_RIM_COLOR * 0.012; }
#endif
  outgoingLight = (lit + totalEmissiveRadiance) * k + rimc * k;
}
#include <opaque_fragment>`;

export function patchMaterial(mat) {
  if (!mat || mat.userData.lmPatched || !mat.isMeshStandardMaterial) return mat;
  mat.userData.lmPatched = true;
  mat.onBeforeCompile = shader => {
    for (const k in shared) shader.uniforms[k] = shared[k];
    shader.vertexShader = shader.vertexShader.replace('#include <common>', VERT_COMMON).replace('#include <project_vertex>', VERT_PROJECT);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', FRAG_COMMON).replace('#include <opaque_fragment>', FRAG_OUT);
  };
  mat.customProgramCacheKey = () => 'lightfield';
  return mat;
}

// Convert imported glTF materials to the patched form (and drop features we do not need).
export function prepareObject(root, { castShadow = false } = {}) {
  root.traverse(o => {
    if (!o.isMesh) return;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    list.forEach(m => { patchMaterial(m); m.envMapIntensity = 0; });
    o.castShadow = false; o.receiveShadow = false;
    if (o.isSkinnedMesh) o.frustumCulled = false;
  });
  return root;
}

// Give a character a faint silhouette rim so it never vanishes into black (rendering aid only; visibility is judged by the light field).
export function addRim(root, hex = 0x3a8cff) {
  const c = new THREE.Color(hex);
  const seen = new Map();
  root.traverse(o => {
    if (!o.isMesh || !o.material.isMeshStandardMaterial) return;
    const src = o.material;
    if (!seen.has(src)) {
      const m = src.clone(); m.userData.lmPatched = false; patchMaterial(m);
      m.defines = { ...(m.defines || {}), LM_RIM: '', LM_RIM_COLOR: `vec3(${c.r.toFixed(3)},${c.g.toFixed(3)},${c.b.toFixed(3)})` };
      m.customProgramCacheKey = () => 'lightfield-rim-' + hex; m.needsUpdate = true; seen.set(src, m);
    }
    o.material = seen.get(src);
  });
}

export function makeLightTextures(field, vision) {
  const mk = (data, w, h) => {
    const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.magFilter = t.minFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.generateMipmaps = false;
    t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true; return t;
  };
  const light = mk(field.texData, field.tw, field.th), vis = mk(vision.texData, vision.tw, vision.th);
  return { light, vis };
}
