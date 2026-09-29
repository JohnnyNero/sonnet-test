// Rendering: scene, lights, level meshes, the surface shader, particles and screen helpers.
import * as THREE from 'three';
import { W, H } from './dungeon.js';
import { makeRig } from './models.js';
import { RNG } from './util.js';

const FOG = 0x08060c;

const SURF_VERT = `
varying vec2 vPos;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vPos = wp.xz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const SURF_FRAG = `
precision highp float;
uniform sampler2D t1; // r=oil g=water b=ice a=fire
uniform sampler2D t2; // r=elec g=scorch
uniform float time;
uniform vec2 size;
varying vec2 vPos;
float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
float vn(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y);
}
float fbm(vec2 p){ return vn(p)*0.55 + vn(p*2.1+7.3)*0.3 + vn(p*4.3+1.7)*0.15; }
void main(){
  vec2 uv = vPos / size;
  vec4 a = texture2D(t1, uv);
  vec4 b = texture2D(t2, uv);
  float n = fbm(vPos * 1.7);
  float n2 = fbm(vPos * 3.1 + time * 0.15);
  vec3 col = vec3(0.0);
  float alpha = 0.0;

  // scorch marks
  float sc = smoothstep(0.25, 0.6, b.g + (n - 0.5) * 0.5);
  col = vec3(0.0); alpha = sc * 0.55 * step(0.02, b.g);

  // water
  float w = smoothstep(0.42, 0.52, a.g + (n - 0.5) * 0.35);
  float wEdge = smoothstep(0.42, 0.66, a.g + (n - 0.5) * 0.35);
  vec3 wc = mix(vec3(0.20, 0.42, 0.62), vec3(0.06, 0.20, 0.38), wEdge);
  float rip = vn(vPos * 5.0 + vec2(time * 0.6, -time * 0.4)) * vn(vPos * 3.0 - time * 0.3);
  wc += vec3(0.22, 0.32, 0.4) * smoothstep(0.35, 0.6, rip) * 0.55;
  col = mix(col, wc, w * 0.86); alpha = max(alpha, w * 0.86);

  // oil
  float o = smoothstep(0.42, 0.52, a.r + (n - 0.5) * 0.4);
  float sheen = sin(n2 * 12.0 + time * 0.5) * 0.5 + 0.5;
  vec3 oc = vec3(0.045, 0.03, 0.06) + vec3(0.10, 0.05, 0.16) * sheen * (0.4 + 0.6 * n2) + vec3(0.0, 0.07, 0.05) * (1.0 - sheen) * n2;
  col = mix(col, oc, o * 0.95); alpha = max(alpha, o * 0.95);

  // ice
  float ic = smoothstep(0.42, 0.52, a.b + (n - 0.5) * 0.3);
  vec3 icc = mix(vec3(0.62, 0.84, 0.95), vec3(0.85, 0.96, 1.0), n2);
  float crack = 1.0 - smoothstep(0.0, 0.035, abs(fbm(vPos * 2.4 + 3.0) - 0.5));
  icc = mix(icc, vec3(1.0), crack * 0.65);
  col = mix(col, icc, ic * 0.93); alpha = max(alpha, ic * 0.93);

  // electricity
  float e = b.r;
  if (e > 0.02) {
    float arc = 1.0 - smoothstep(0.0, 0.07, abs(vn(vPos * 5.0 + floor(time * 24.0) * 3.7) - 0.5));
    float arc2 = 1.0 - smoothstep(0.0, 0.05, abs(vn(vPos * 9.0 - floor(time * 30.0) * 5.1) - 0.5));
    vec3 ec = vec3(0.35, 0.85, 1.0) * (0.55 + 0.45 * vn(vPos * 3.0 + time * 40.0)) + vec3(1.0) * (arc + arc2 * 0.6);
    float ea = clamp(w * (0.7 * e) + (arc + arc2) * e, 0.0, 1.0);
    col = mix(col, ec, ea); alpha = max(alpha, ea);
  }

  // fire
  float f = smoothstep(0.30, 0.5, a.a + (n2 - 0.5) * 0.5);
  if (f > 0.0) {
    float fl = fbm(vPos * 2.6 + vec2(time * 0.4, -time * 2.4));
    float core = smoothstep(0.42, 0.86, fl + (a.a - 0.5) * 0.35);
    vec3 fc = mix(vec3(0.95, 0.22, 0.02), vec3(1.0, 0.86, 0.32), core);
    fc = mix(fc, vec3(1.0, 0.97, 0.75), smoothstep(0.85, 1.0, core));
    col = mix(col, fc, f); alpha = max(alpha, f);
  }
  gl_FragColor = vec4(col, alpha);
}`;

function softTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.4, 'rgba(255,255,255,0.5)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

class Particles {
  constructor(scene, max, tex) {
    this.max = max; this.list = [];
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, max);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.mesh.count = 0; this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this._m = new THREE.Matrix4(); this._c = new THREE.Color(); this._p = new THREE.Vector3(); this._s = new THREE.Vector3();
  }
  emit(o) {
    if (this.list.length >= this.max) this.list.shift();
    this.list.push({ x: o.x, y: o.y, z: o.z, vx: o.vx || 0, vy: o.vy || 0, vz: o.vz || 0, life: o.life, max: o.life,
      s0: o.s0 ?? 0.3, s1: o.s1 ?? 0, c0: new THREE.Color(o.c0 ?? 0xffffff), c1: new THREE.Color(o.c1 ?? o.c0 ?? 0xffffff),
      drag: o.drag ?? 1, grav: o.grav ?? 0 });
  }
  update(dt, camQuat) {
    let n = 0;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.life -= dt;
      if (p.life <= 0) { this.list.splice(i, 1); continue; }
      const k = Math.exp(-p.drag * dt);
      p.vx *= k; p.vz *= k; p.vy = p.vy * k - p.grav * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.y < 0.02) { p.y = 0.02; p.vy = 0; }
    }
    for (const p of this.list) {
      const t = 1 - p.life / p.max;
      const s = p.s0 + (p.s1 - p.s0) * t;
      this._p.set(p.x, p.y, p.z); this._s.set(s, s, 1);
      this._m.compose(this._p, camQuat, this._s);
      this.mesh.setMatrixAt(n, this._m);
      this._c.copy(p.c0).lerp(p.c1, t).multiplyScalar(1 - t * t);
      this.mesh.setColorAt(n, this._c);
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
  clear() { this.list.length = 0; }
}

export class World {
  constructor(canvas) {
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    this.coarse = coarse;
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2));
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.15;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(FOG);
    this.scene.fog = new THREE.FogExp2(FOG, 0.05);
    this.camera = new THREE.PerspectiveCamera(36, 1, 0.5, 90);
    this.camOffset = new THREE.Vector3(0, 14.5, 8.6);
    this.camPos = new THREE.Vector3(); this.camTarget = new THREE.Vector3();
    this.shake = 0;

    this.scene.add(new THREE.HemisphereLight(0x8a92c8, 0x2a2034, 1.0));
    const moon = this.moon = new THREE.DirectionalLight(0xaab4ff, 1.15);
    moon.castShadow = true; moon.shadow.mapSize.set(coarse ? 1024 : 2048, coarse ? 1024 : 2048);
    const sc = moon.shadow.camera; sc.left = -16; sc.right = 16; sc.top = 16; sc.bottom = -16; sc.near = 1; sc.far = 50;
    moon.shadow.bias = -0.0004; moon.shadow.normalBias = 0.04;
    this.scene.add(moon, moon.target);
    this.heroLight = new THREE.PointLight(0xffb070, 55, 15, 1.6);
    this.scene.add(this.heroLight);
    this.fireLights = [];
    for (let i = 0; i < 6; i++) { const l = new THREE.PointLight(0xff7a2a, 0, 8, 1.8); this.scene.add(l); this.fireLights.push(l); }
    this.flashLight = new THREE.PointLight(0xffffff, 0, 10, 2); this.scene.add(this.flashLight); this.flash = 0; this.flashColor = new THREE.Color();

    this.level = new THREE.Group(); this.scene.add(this.level);
    this.actors = new THREE.Group(); this.scene.add(this.actors);
    this.effects = new THREE.Group(); this.scene.add(this.effects);
    this.tex = softTexture();
    this.particles = new Particles(this.scene, 1400, this.tex);
    this.rings = []; this.bolts = [];
    this.time = 0;
    this._ray = new THREE.Raycaster(); this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); this._v = new THREE.Vector3();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }

  // ---- level meshes
  buildLevel(level, surf) {
    this.clearLevel();
    const { tiles } = level;
    const rng = new RNG(level.seed * 31 + level.floor);
    const floorTint = 0x4a4654;
    const fl = [], wl = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (tiles[y * W + x]) fl.push([x, y]);
      else {
        let near = false;
        for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < W && ny < H && tiles[ny * W + nx]) { near = true; break; }
        }
        if (near) wl.push([x, y]);
      }
    }
    const fm = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.3, 1),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, flatShading: true }), fl.length);
    const c = new THREE.Color(), m4 = new THREE.Matrix4();
    fl.forEach(([x, y], i) => {
      m4.makeTranslation(x + 0.5, -0.15, y + 0.5); fm.setMatrixAt(i, m4);
      const v = rng.range(0.85, 1.12), checker = (x + y) % 2 ? 0.96 : 1.0;
      c.setHex(floorTint).multiplyScalar(v * checker);
      if (rng.chance(0.05)) c.multiplyScalar(0.72);
      fm.setColorAt(i, c);
    });
    fm.receiveShadow = true; fm.instanceMatrix.needsUpdate = true;
    this.level.add(fm);

    const wm = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true }), wl.length);
    wl.forEach(([x, y], i) => {
      const hgt = rng.range(0.85, 1.2);
      m4.makeScale(1.0, hgt, 1.0); m4.setPosition(x + 0.5, hgt / 2 - 0.1, y + 0.5); wm.setMatrixAt(i, m4);
      c.setHex(0x4a4658).multiplyScalar(rng.range(0.8, 1.15)); wm.setColorAt(i, c);
    });
    wm.castShadow = true; wm.receiveShadow = true; wm.instanceMatrix.needsUpdate = true;
    this.level.add(wm);

    // surface layer
    this.surf = surf;
    const n = W * H;
    this.d1 = new Uint8Array(n * 4); this.d2 = new Uint8Array(n * 4);
    const mk = d => { const t = new THREE.DataTexture(d, W, H, THREE.RGBAFormat); t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true; return t; };
    this.t1 = mk(this.d1); this.t2 = mk(this.d2);
    this.surfMat = new THREE.ShaderMaterial({
      vertexShader: SURF_VERT, fragmentShader: SURF_FRAG, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      uniforms: { t1: { value: this.t1 }, t2: { value: this.t2 }, time: { value: 0 }, size: { value: new THREE.Vector2(W, H) } },
    });
    const pg = new THREE.PlaneGeometry(W, H); pg.rotateX(-Math.PI / 2);
    this.surfMesh = new THREE.Mesh(pg, this.surfMat); this.surfMesh.position.set(W / 2, 0.02, H / 2);
    this.surfMesh.renderOrder = 1;
    this.level.add(this.surfMesh);

    // 3D flames
    const cg = new THREE.ConeGeometry(0.26, 1, 5); cg.translate(0, 0.5, 0);
    this.flames = new THREE.InstancedMesh(cg, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }), 450);
    this.flames.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(450 * 3), 3);
    this.flames.count = 0; this.flames.frustumCulled = false;
    this.level.add(this.flames);
    this.lightTimer = 0;
  }

  clearLevel() {
    const dispose = g => g.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material && !Array.isArray(o.material)) o.material.dispose(); });
    for (const g of [this.level, this.actors, this.effects]) { dispose(g); g.clear(); }
    this.particles.clear(); this.rings.length = 0; this.bolts.length = 0;
  }

  spawnActor(name, scale = 1) {
    const rig = makeRig(name);
    rig.group.scale.setScalar(scale);
    this.actors.add(rig.group);
    return rig;
  }
  removeActor(rig) { this.actors.remove(rig.group); }

  // ---- effects
  ring(x, y, r0, r1, color, dur = 0.5, opacity = 0.8) {
    const g = new THREE.RingGeometry(0.85, 1, 40); g.rotateX(-Math.PI / 2);
    const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(g, m); mesh.position.set(x, 0.06, y); mesh.scale.setScalar(r0);
    this.effects.add(mesh);
    this.rings.push({ mesh, r0, r1, t: 0, dur, opacity });
  }
  burst(x, y, z, count, o) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, sp = (o.speed || 3) * (0.3 + Math.random() * 0.9);
      this.particles.emit({
        x, y: z, z: y, vx: Math.cos(a) * sp, vz: Math.sin(a) * sp, vy: (o.up ?? 2) * (0.4 + Math.random()),
        life: (o.life || 0.6) * (0.6 + Math.random() * 0.6), s0: o.s0 ?? 0.3, s1: o.s1 ?? 0.05, c0: o.c0, c1: o.c1, drag: o.drag ?? 2, grav: o.grav ?? 6,
      });
    }
  }
  // jagged lightning between two points (x,y = ground plane, z = height)
  bolt(x1, y1, z1, x2, y2, z2, color = 0xa8f0ff, life = 0.2) {
    const N = 9, pts = [];
    const dx = x2 - x1, dz = y2 - y1, len = Math.hypot(dx, dz, z2 - z1) || 1;
    for (let i = 0; i <= N; i++) {
      const t = i / N, j = (i === 0 || i === N ? 0 : 1) * 0.22 * Math.min(1, len / 3 + 0.4);
      pts.push(new THREE.Vector3(x1 + dx * t + (Math.random() - 0.5) * j, z1 + (z2 - z1) * t + (Math.random() - 0.5) * j, y1 + dz * t + (Math.random() - 0.5) * j));
    }
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, fog: false }));
    this.effects.add(line); this.bolts.push({ line, t: 0, life });
    for (const p of pts) this.particles.emit({ x: p.x, y: p.y, z: p.z, life: life * 1.3, s0: 0.42, s1: 0.16, c0: color, c1: color, drag: 1 });
  }
  lightFlash(x, y, color, intensity = 60, dur = 0.25) {
    this.flashLight.position.set(x, 1.2, y); this.flashColor.set(color); this.flash = dur; this.flashMax = dur; this.flashI = intensity;
  }

  // ---- per-frame
  frame(dt, hero, dt2) {
    this.time += dt;
    const t = this.time;
    // camera follows hero
    const target = this._v.set(hero.x, 0, hero.y);
    this.camTarget.lerp(target, 1 - Math.exp(-dt * 7));
    this.camPos.copy(this.camTarget).add(this.camOffset);
    if (this.shake > 0) {
      this.camPos.x += (Math.random() - 0.5) * this.shake; this.camPos.y += (Math.random() - 0.5) * this.shake * 0.6; this.camPos.z += (Math.random() - 0.5) * this.shake;
      this.shake = Math.max(0, this.shake - dt * 2.2);
    }
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camTarget.x, 0.6, this.camTarget.z);
    this.moon.position.set(hero.x - 7, 20, hero.y + 6); this.moon.target.position.set(hero.x, 0, hero.y);
    this.heroLight.position.set(hero.x, 2.2, hero.y);
    this.heroLight.intensity = 52 + Math.sin(t * 9) * 3 + Math.sin(t * 23) * 2;

    if (this.flash > 0) {
      this.flash -= dt; const k = Math.max(0, this.flash / this.flashMax);
      this.flashLight.color.copy(this.flashColor); this.flashLight.intensity = this.flashI * k;
    } else this.flashLight.intensity = 0;

    // surfaces -> textures
    const s = this.surf;
    if (s) {
      const d1 = this.d1, d2 = this.d2, n = W * H;
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        d1[j] = s.oil[i] > 0.05 ? 255 : 0;
        d1[j + 1] = s.water[i] > 0.15 ? 255 : 0;
        d1[j + 2] = s.ice[i] > 0 ? 255 : 0;
        d1[j + 3] = s.fire[i] > 0 ? (s.fire[i] > 0.3 ? 255 : 110 + s.fire[i] * 480) : 0;
        d2[j] = s.elec[i] > 0 ? Math.min(255, s.elec[i] * 500) : 0;
        d2[j + 1] = s.scorch[i] * 255;
      }
      this.t1.needsUpdate = true; this.t2.needsUpdate = true;
      this.surfMat.uniforms.time.value = t;
      this._flames(t, hero, dt);
    }

    // rings
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i]; r.t += dt;
      const k = r.t / r.dur;
      if (k >= 1) { this.effects.remove(r.mesh); r.mesh.geometry.dispose(); r.mesh.material.dispose(); this.rings.splice(i, 1); continue; }
      r.mesh.scale.setScalar(r.r0 + (r.r1 - r.r0) * (1 - (1 - k) * (1 - k)));
      r.mesh.material.opacity = r.opacity * (1 - k);
    }
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i]; b.t += dt;
      if (b.t >= b.life) { this.effects.remove(b.line); b.line.geometry.dispose(); b.line.material.dispose(); this.bolts.splice(i, 1); }
      else b.line.material.opacity = 1 - b.t / b.life;
    }
    this.particles.update(dt, this.camera.quaternion);
    this.renderer.render(this.scene, this.camera);
  }

  _flames(t, hero, dt) {
    const s = this.surf, fm = this.flames;
    let n = 0; const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), col = new THREE.Color();
    const cells = [];
    for (let i = 0; i < s.n; i++) if (s.fire[i] > 0) cells.push(i);
    for (const i of cells) {
      if (n >= 448) break;
      const x = i % W, y = (i / W) | 0;
      for (let k = 0; k < 2; k++) {
        const seed = i * 7.31 + k * 3.7;
        const fl = 0.55 + 0.45 * Math.sin(t * (9 + k * 3) + seed) * Math.sin(t * 5.3 + seed * 1.7);
        const life = Math.min(1, s.fire[i] * 3);
        const hh = (0.45 + 0.5 * fl) * (0.6 + 0.4 * life) * (k ? 0.7 : 1.0);
        p.set(x + 0.5 + Math.sin(seed) * 0.28, 0.03, y + 0.5 + Math.cos(seed * 1.3) * 0.28);
        sc.set(1 + 0.3 * fl, hh * 1.4, 1 + 0.3 * fl);
        m.compose(p, q, sc); fm.setMatrixAt(n, m);
        col.setHSL(0.06 + 0.05 * fl, 1, 0.42 + 0.12 * fl); fm.setColorAt(n, col);
        n++;
        if (k === 0 && Math.random() < dt * 2.2) this.particles.emit({ x: p.x, y: 0.5, z: p.z, vx: (Math.random() - 0.5) * 0.4, vy: 1.6 + Math.random(), vz: (Math.random() - 0.5) * 0.4, life: 0.8, s0: 0.14, s1: 0.02, c0: 0xffa040, c1: 0xff3000, drag: 0.5, grav: -0.5 });
        if (k === 0 && Math.random() < dt * 0.6) this.particles.emit({ x: p.x, y: 0.9, z: p.z, vx: 0, vy: 0.9, vz: 0, life: 1.4, s0: 0.35, s1: 0.9, c0: 0x2a2226, c1: 0x0a0808, drag: 0.4, grav: -0.2 });
      }
    }
    fm.count = n; fm.instanceMatrix.needsUpdate = true; if (fm.instanceColor) fm.instanceColor.needsUpdate = true;

    // assign the point-light pool to the fires nearest the hero (spread out)
    this.lightTimer -= dt;
    if (this.lightTimer <= 0) {
      this.lightTimer = 0.15;
      const near = cells.map(i => ({ x: (i % W) + 0.5, y: ((i / W) | 0) + 0.5 }))
        .map(c => ({ ...c, d: Math.hypot(c.x - hero.x, c.y - hero.y) })).filter(c => c.d < 16).sort((a, b) => a.d - b.d);
      const chosen = [];
      for (const c of near) { if (chosen.length >= this.fireLights.length) break; if (chosen.every(o => Math.hypot(o.x - c.x, o.y - c.y) > 2.6)) chosen.push(c); }
      this.fireLights.forEach((l, i) => { const c = chosen[i]; if (c) { l.position.set(c.x, 1.0, c.y); l.userData.on = true; } else l.userData.on = false; });
    }
    for (const l of this.fireLights) {
      const target = l.userData.on ? 26 + Math.sin(t * 13 + l.id) * 5 : 0;
      l.intensity += (target - l.intensity) * Math.min(1, dt * 10);
    }
  }

  // ---- helpers
  screenPos(x, y, z = 1.2) {
    const v = new THREE.Vector3(x, z, y).project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * window.innerWidth, y: (-v.y * 0.5 + 0.5) * window.innerHeight, behind: v.z > 1 };
  }
  pickGround(clientX, clientY) {
    const nd = new THREE.Vector2((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
    this._ray.setFromCamera(nd, this.camera);
    const hit = this._ray.ray.intersectPlane(this._plane, this._v);
    return hit ? { x: hit.x, y: hit.z } : null;
  }
}
