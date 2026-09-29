// Scene renderer: level meshing, free top-down camera with wall cut-away, post-processing, overlays.
import * as THREE from 'three';
import { EffectComposer } from '../vendor/EffectComposer.js';
import { RenderPass } from '../vendor/RenderPass.js';
import { UnrealBloomPass } from '../vendor/UnrealBloomPass.js';
import { ShaderPass } from '../vendor/ShaderPass.js';
import { OutputPass } from '../vendor/OutputPass.js';
import { WALL_H } from './config.js';
import { shared, makeLightTextures } from './materials.js';
import * as Env from './envkit.js';
import { buildVentVisuals } from './vents.js';

const WALL_MODEL = { plaster: 'wall_plain', panel: 'wall_panel', glass: 'wall_glass', concrete: 'wall_concrete', tile: 'wall_tile', vault: 'wall_concrete', brick: 'wall_concrete' };
const FLOOR_MODEL = { marble: 'floor_marble', carpet: 'floor_carpet', wood: 'floor_wood', concrete: 'floor_concrete', tile: 'floor_tile', metal: 'floor_metal' };
const FLOOR_FALLBACK = { marble: 0x3a3a44, carpet: 0x4a2530, wood: 0x4b3222, concrete: 0x3b3d42, tile: 0x2b3a37, metal: 0x3a4048 };
const WALL_FALLBACK = { plaster: 0x353844, panel: 0x4a3626, glass: 0x2a3f55, concrete: 0x3d3f45, tile: 0x2c4a44, vault: 0x30343a, brick: 0x4a3030 };

const GRADE_SHADER = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uAlarm: { value: 0 }, uVignette: { value: 0.55 }, uGrain: { value: 0.022 }, uSat: { value: 0.86 }, uTint: { value: new THREE.Vector3(0.94, 1.0, 1.08) }, uNV: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uTime; uniform float uAlarm; uniform float uVignette; uniform float uGrain; uniform float uSat; uniform vec3 uTint; uniform float uNV;
    varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)) + uTime) * 43758.5453); }
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      c.rgb = mix(vec3(l), c.rgb, uSat) * uTint;
      c.rgb = (c.rgb - 0.5) * 1.06 + 0.5;
      // night-vision goggles
      if (uNV > 0.5) { float g = pow(clamp(l * 2.6 + 0.04, 0.0, 1.0), 0.6); c.rgb = vec3(0.10, 1.0, 0.35) * g; c.rgb *= 0.85 + 0.15 * sin(vUv.y * 900.0); }
      vec2 q = vUv - 0.5; float v = 1.0 - dot(q, q) * uVignette * 2.6;
      c.rgb *= clamp(v, 0.0, 1.0);
      c.r += uAlarm * 0.14 * (0.5 + 0.5 * sin(uTime * 7.0)) * (1.0 - v * 0.6);
      c.rgb += (h(vUv * 800.0) - 0.5) * uGrain * (0.35 + 0.65 * smoothstep(0.0, 0.5, l));
      gl_FragColor = vec4(max(c.rgb, 0.0), c.a);
    }`,
};

export class Renderer {
  constructor(canvas) {
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    this.coarse = coarse;
    const r = this.gl = new THREE.WebGLRenderer({ canvas, antialias: !coarse, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2));
    r.toneMapping = THREE.NoToneMapping;      // tone-mapped in OutputPass
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(0x030305);
    this.camera = new THREE.PerspectiveCamera(34, 1, 0.5, 140);
    this.cam = { yaw: 0.0, pitch: 1.08, dist: 19, target: new THREE.Vector3(), tYaw: 0, tPitch: 1.08, tDist: 19, shake: 0 };
    this.levelGroup = new THREE.Group(); this.actors = new THREE.Group(); this.fx = new THREE.Group();
    this.scene.add(this.levelGroup, this.actors, this.fx);
    this.time = 0;
    this._setupPost();
    this.resize(); window.addEventListener('resize', () => this.resize());
    this.walls = []; this.wallGroups = []; this.cutRadius = 11; this.ventMode = false;
    this.overlay = new THREE.Group(); this.scene.add(this.overlay);
    this.ray = new THREE.Raycaster(); this.plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); this._v = new THREE.Vector3();
  }

  _setupPost() {
    const r = this.gl, size = new THREE.Vector2(); r.getSize(size);
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: this.coarse ? 0 : 4 });
    this.composer = new EffectComposer(r, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.55, 0.55, 0.9);
    this.composer.addPass(this.bloom);
    this.grade = new ShaderPass(GRADE_SHADER); this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.gl.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }

  // -------------------------------------------------------------------- level meshing
  buildLevel(level, field, vision) {
    this.clearLevel();
    this.level = level;
    const tex = makeLightTextures(field, vision);
    this.lightTex = tex.light; this.visTex = tex.vis; this.field = field; this.vision = vision;
    shared.uLight.value = tex.light; shared.uVis.value = tex.vis; shared.uMap.value.set(level.W, level.H);
    const { W, H } = level;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    const rotY = a => q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), a);

    // ---- floors: one instance per carved cell, per style
    const byFloor = {};
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = level.idx(x, y); if (!level.carved[i]) continue;
      const st = level.floorStyles[level.floor[i]] || 'marble';
      (byFloor[st] = byFloor[st] || []).push([x, y]);
    }
    const rng = mulberry(level.seed || 1);
    for (const st in byFloor) {
      const mats = [], cols = [];
      for (const [x, y] of byFloor[st]) {
        mats.push(new THREE.Matrix4().makeTranslation(x + 0.5, 0, y + 0.5));
        const v = 0.86 + rng() * 0.28, chk = (x + y) % 2 ? 0.94 : 1.0; cols.push(new THREE.Color().setScalar(v * chk * 1.7));
      }
      const name = FLOOR_MODEL[st] || 'floor_marble';
      const g = Env.instanced(name, mats, { colors: cols, fb: { w: 1, d: 1, h: 0.1, color: FLOOR_FALLBACK[st] || 0x3a3a44 } });
      // fallback floors are boxes sitting on y=0: sink them so the top is at 0
      if (!Env.hasModel(name)) g.group.position.y = -0.1;
      this.levelGroup.add(g.group);
    }

    // ---- walls: cells that touch a carved cell (8-neighbourhood), instanced per style so we can lower them (cut-away)
    const byWall = {};
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = level.idx(x, y); if (level.carved[i]) continue;
      let near = false;
      for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = x + dx, ny = y + dy; if (level.inb(nx, ny) && level.carved[level.idx(nx, ny)]) { near = true; break; } }
      if (!near) continue;
      const st = level.wallStyles[level.wallStyle[i]] || 'plaster';
      (byWall[st] = byWall[st] || []).push([x, y]);
    }
    this.wallInst = [];
    for (const st in byWall) {
      const cells = byWall[st], name = WALL_MODEL[st] || 'wall_plain';
      const base = [], info = [];
      for (const [x, y] of cells) {
        let rot = 0;
        if (st === 'glass') { const horiz = !level.carved[level.idx(Math.max(0, x - 1), y)] || !level.carved[level.idx(Math.min(W - 1, x + 1), y)]; rot = horiz && !(level.carved[level.idx(x, Math.max(0, y - 1))] && level.carved[level.idx(x, Math.min(H - 1, y + 1))]) ? 0 : Math.PI / 2;
          // run direction: if walls continue along X the pane runs along X
          const wl = !level.carved[level.idx(Math.max(0, x - 1), y)] || level.solid[level.idx(Math.max(0, x - 1), y)];
          const wr = !level.carved[level.idx(Math.min(W - 1, x + 1), y)] || level.solid[level.idx(Math.min(W - 1, x + 1), y)];
          rot = (wl && wr) ? 0 : Math.PI / 2; }
        else rot = ((x * 7 + y * 13) % 4) * Math.PI / 2 * 0;      // plain walls are symmetric
        base.push({ x: x + 0.5, y: y + 0.5, rot });
        info.push({ x, y, rot, h: 1, target: 1 });
      }
      const mats = base.map(b => { m4.compose(new THREE.Vector3(b.x, 0, b.y), rotY(b.rot), one); return m4.clone(); });
      const g = Env.instanced(name, mats, { fb: { w: 1, d: 1, h: WALL_H, color: WALL_FALLBACK[st] || 0x353844 } });
      this.levelGroup.add(g.group);
      this.wallInst.push({ style: st, meshes: g.meshes, cells: info, name });
    }
    // a big dark ground plane so nothing peeks out beyond the map
    const gp = new THREE.Mesh(new THREE.PlaneGeometry(W + 80, H + 80), new THREE.MeshBasicMaterial({ color: 0x000000 }));
    gp.rotation.x = -Math.PI / 2; gp.position.set(W / 2, -0.12, H / 2); this.levelGroup.add(gp);

    this.doorObjs = []; this.propObjs = new Map();
    this._buildProps(level);
    this._buildDoors(level);
  }

  _buildProps(level) {
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), yAxis = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1);
    const byName = {};
    for (const p of level.props) {
      if (p.tags.includes('interactive') || p.data?.interactive) {
        const obj = Env.cloneModel(p.name, { w: p.w, d: p.d, h: p.h, color: p.data?.color });
        obj.position.set(p.x, p.y0 || 0, p.y); obj.rotation.y = p.rot;
        this.levelGroup.add(obj); this.propObjs.set(p.id, obj); p.obj = obj;
      } else (byName[p.name] = byName[p.name] || []).push(p);
    }
    for (const name in byName) {
      const TINT = { table_round: 0.4, sofa_2: 0.9 };
      const list = byName[name], mats = list.map(p => { m4.compose(new THREE.Vector3(p.x, p.y0 || 0, p.y), q.setFromAxisAngle(yAxis, p.rot), one); return m4.clone(); });
      const f = list[0];
      const g = Env.instanced(name, mats, { fb: { w: f.w, d: f.d, h: f.h, color: f.data?.color }, colors: TINT[name] ? mats.map(() => new THREE.Color().setScalar(TINT[name])) : null });
      this.levelGroup.add(g.group);
    }
  }

  _buildDoors(level) {
    for (const d of level.doors) {
      const frameName = d.model === 'security' ? 'door_security_frame' : d.glass ? 'door_glass_frame' : d.sliding ? 'door_slide' : 'door_frame';
      const leafName = d.model === 'security' ? 'door_security_leaf' : d.glass ? 'door_glass_leaf' : d.sliding ? null : 'door_leaf';
      const root = new THREE.Group(); root.position.set(d.x + 0.5, 0, d.y + 0.5);
      root.rotation.y = d.orient === 'v' ? Math.PI / 2 : 0;
      const frame = Env.hasModel(frameName) ? Env.cloneModel(frameName) : this._fallbackFrame();
      root.add(frame);
      let leafPivot = null, leafL = null, leafR = null;
      if (d.sliding) { leafL = Env.findPart(frame, 'leafL'); leafR = Env.findPart(frame, 'leafR'); }
      else {
        leafPivot = new THREE.Group(); leafPivot.position.set(-0.475, 0, 0); root.add(leafPivot);
        const leaf = Env.hasModel(leafName) ? Env.cloneModel(leafName) : this._fallbackLeaf();
        leafPivot.add(leaf);
      }
      this.levelGroup.add(root);
      d.obj = { root, leafPivot, leafL, leafR };
    }
  }
  _fallbackFrame() {
    const g = new THREE.Group(); const m = Env.fallback('f', 1, 1, 0.1).children[0].material;
    const top = new THREE.Mesh(new THREE.BoxGeometry(1, 0.6, 1), m); top.position.y = 2.9; g.add(top);
    for (const s of [-1, 1]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.03, 2.6, 1), m); p.position.set(0.5 * s * 0.97, 1.3, 0); g.add(p); }
    return g;
  }
  _fallbackLeaf() {
    const g = new THREE.Group(); const m = new THREE.Mesh(new THREE.BoxGeometry(0.95, 2.6, 0.06), Env.fallback('l', 1, 1, 1, 0x6a4a30).children[0].material);
    m.position.set(0.475, 1.3, 0); g.add(m); return g;
  }

  animateDoors(level, dt) {
    for (const d of level.doors) {
      const speed = d.sliding ? 2.2 : 3.4;
      if (d.open < d.target) d.open = Math.min(d.target, d.open + dt * speed); else if (d.open > d.target) d.open = Math.max(d.target, d.open - dt * speed);
      const o = d.obj; if (!o) continue;
      if (o.leafPivot) o.leafPivot.rotation.y = -d.open * 1.75;
      if (o.leafL) o.leafL.position.x = -d.open * 0.5;
      if (o.leafR) o.leafR.position.x = d.open * 0.5;
    }
  }

  buildVentVisuals(vent) { return buildVentVisuals(this, vent); }

  clearLevel() {
    for (const g of [this.levelGroup, this.actors, this.fx, this.overlay]) {
      while (g.children.length) { const c = g.children.pop(); c.traverse && c.traverse(o => { if (o.geometry && !o.geometry.userData.shared) { /* keep shared kit geometry */ } }); }
    }
  }

  // -------------------------------------------------------------------- camera
  screenRay(clientX, clientY) {
    const nd = new THREE.Vector2((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
    this.ray.setFromCamera(nd, this.camera);
    const hit = this.ray.ray.intersectPlane(this.plane, this._v);
    return hit ? { x: hit.x, y: hit.z } : null;
  }
  screenPos(x, y, z = 1.6) {
    const v = new THREE.Vector3(x, z, y).project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * window.innerWidth, y: (-v.y * 0.5 + 0.5) * window.innerHeight, behind: v.z > 1 };
  }
  // world-space direction (x,z) that the "up" key/joystick should move in
  camForward() { return { x: -Math.sin(this.cam.yaw), y: -Math.cos(this.cam.yaw) }; }
  camRight() { return { x: Math.cos(this.cam.yaw), y: -Math.sin(this.cam.yaw) }; }
  rotateCamera(d) { this.cam.tYaw += d; }
  zoomCamera(d) { this.cam.tDist = Math.min(34, Math.max(9, this.cam.tDist * (1 + d))); }
  tiltCamera(d) { this.cam.tPitch = Math.min(1.42, Math.max(0.62, this.cam.tPitch + d)); }

  updateCamera(dt, tx, ty, tz = 0.9) {
    const c = this.cam, k = 1 - Math.exp(-dt * 9);
    c.yaw += (c.tYaw - c.yaw) * k; c.pitch += (c.tPitch - c.pitch) * k; c.dist += (c.tDist - c.dist) * k;
    c.target.x += (tx - c.target.x) * (1 - Math.exp(-dt * 6)); c.target.z += (ty - c.target.z) * (1 - Math.exp(-dt * 6)); c.target.y = tz;
    const cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
    const off = new THREE.Vector3(Math.sin(c.yaw) * cp * c.dist, sp * c.dist, Math.cos(c.yaw) * cp * c.dist);
    this.camera.position.copy(c.target).add(off);
    if (c.shake > 0) { this.camera.position.x += (Math.random() - 0.5) * c.shake; this.camera.position.y += (Math.random() - 0.5) * c.shake; c.shake = Math.max(0, c.shake - dt * 2); }
    this.camera.lookAt(c.target);
    // keep the depth range tight: floor detail is millimetres thick and z-fights ("tripping") with a wide range
    const near = Math.max(0.5, c.dist * 0.5 - 3), far = c.dist * 3 + 60;
    if (Math.abs(near - this.camera.near) > 0.05 || Math.abs(far - this.camera.far) > 0.5) { this.camera.near = near; this.camera.far = far; this.camera.updateProjectionMatrix(); }
  }

  // Lower the walls that sit between the camera and the player so the action is always visible.
  updateWalls(dt, px, py) {
    const c = this.cam, fx = -Math.sin(c.yaw), fz = -Math.cos(c.yaw);           // camera -> player (horizontal)
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), yAxis = new THREE.Vector3(0, 1, 0), pos = new THREE.Vector3(), sc = new THREE.Vector3();
    const R = this.cutRadius;
    for (const wi of this.wallInst) {
      let dirty = false;
      for (let k = 0; k < wi.cells.length; k++) {
        const w = wi.cells[k];
        const dx = w.x + 0.5 - px, dz = w.y + 0.5 - py;
        if (Math.abs(dx) > R + 4 || Math.abs(dz) > R + 4) { if (w.h !== 1) { w.target = 1; } else continue; }
        else {
          const along = dx * fx + dz * fz;                                     // <0: nearer to the camera than the player
          const lat = Math.abs(dx * fz - dz * fx);
          w.target = (along < -0.6 && lat < 7.5 && Math.hypot(dx, dz) < R * 1.3) ? 0.28 : 1;
          if (this.ventMode && Math.hypot(dx, dz) < 12) w.target = 0.14;
          // walls right next to the player always lower a bit so silhouettes stay readable
          if (Math.hypot(dx, dz) < 1.6 && along < 1.2) w.target = Math.min(w.target, 0.6);
        }
        if (Math.abs(w.h - w.target) > 0.002) {
          w.h += (w.target - w.h) * Math.min(1, dt * 10);
          if (Math.abs(w.h - w.target) <= 0.002) w.h = w.target;
          pos.set(w.x + 0.5, 0, w.y + 0.5); sc.set(1, w.h, 1);
          m4.compose(pos, q.setFromAxisAngle(yAxis, w.rot), sc);
          for (const im of wi.meshes) { const tmp = new THREE.Matrix4().multiplyMatrices(m4, im.userData.rel); im.setMatrixAt(k, tmp); }
          dirty = true;
        }
      }
      if (dirty) for (const im of wi.meshes) im.instanceMatrix.needsUpdate = true;
    }
  }

  // -------------------------------------------------------------------- frame
  render(dt) {
    this.time += dt; shared.uTime.value = this.time;
    if (this.field) { this.lightTex.needsUpdate = true; }
    if (this.vision) { this.visTex.needsUpdate = true; }
    this.grade.uniforms.uTime.value = this.time;
    this.composer.render(dt);
  }
}

function mulberry(a) { return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
