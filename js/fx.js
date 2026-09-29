// Visual effects: vision cones, tracers, sparks, rings, laser beams.
import * as THREE from 'three';

const CONE_VS = `attribute float aR; varying float vR; void main(){ vR = aR; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
const CONE_FS = `uniform vec3 uColor; uniform float uAlpha; varying float vR;
void main(){ float a = uAlpha * (0.25 + 0.75 * (1.0 - vR)) * smoothstep(0.0, 0.08, vR + 0.02); gl_FragColor = vec4(uColor * (1.0 + (1.0 - vR) * 0.6), a); }`;

class Cone {
  constructor(n = 44) {
    this.n = n;
    const pos = new Float32Array((n + 2) * 3), r = new Float32Array(n + 2), idx = [];
    for (let i = 0; i < n; i++) idx.push(0, i + 1, i + 2);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aR', new THREE.BufferAttribute(r, 1)); g.setIndex(idx);
    this.mat = new THREE.ShaderMaterial({ vertexShader: CONE_VS, fragmentShader: CONE_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uColor: { value: new THREE.Color(0.6, 0.7, 0.9) }, uAlpha: { value: 0.12 } } });
    this.mesh = new THREE.Mesh(g, this.mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = 3;
    this.pos = pos; this.r = r; this.g = g;
  }
  update(level, x, y, face, fov, range) {
    const n = this.n, p = this.pos, r = this.r;
    p[0] = x; p[1] = 0.06; p[2] = y; r[0] = 0;
    for (let i = 0; i <= n; i++) {
      const a = face + (i / n - 0.5) * fov, dx = Math.sin(a), dy = Math.cos(a);
      const hit = level.ray(x, y, x + dx * range, y + dy * range);
      const t = hit.hit ? Math.max(0.1, hit.t - 0.02) : range;
      const k = (i + 1) * 3; p[k] = x + dx * t; p[k + 1] = 0.06; p[k + 2] = y + dy * t; r[i + 1] = t / range;
    }
    this.g.attributes.position.needsUpdate = true; this.g.attributes.aR.needsUpdate = true;
  }
}

export class FX {
  constructor(renderer) {
    this.R = renderer; this.group = new THREE.Group(); renderer.scene.add(this.group);
    this.cones = new Map(); this.items = [];
    this.sparkGeo = new THREE.BufferGeometry();
  }
  clear() { while (this.group.children.length) this.group.remove(this.group.children[0]); this.cones.clear(); this.items.length = 0; }

  // observer = guard | camera ; visible/state tint
  cone(key, level, x, y, face, fov, range, { color = [0.55, 0.68, 0.95], alpha = 0.11, visible = true } = {}) {
    let c = this.cones.get(key);
    if (!c) { c = new Cone(); this.cones.set(key, c); this.group.add(c.mesh); }
    c.mesh.visible = visible;
    if (!visible) return;
    c.update(level, x, y, face, fov, range);
    c.mat.uniforms.uColor.value.setRGB(color[0], color[1], color[2]); c.mat.uniforms.uAlpha.value = alpha;
  }
  hideCone(key) { const c = this.cones.get(key); if (c) c.mesh.visible = false; }

  tracer(x1, y1, z1, x2, y2, z2, color = 0xffffff, life = 0.14) {
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x1, z1, y1), new THREE.Vector3(x2, z2, y2)]);
    const m = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending });
    const l = new THREE.Line(g, m); l.frustumCulled = false; this.group.add(l); this.items.push({ obj: l, t: 0, life, fade: true });
  }
  ring(x, y, r0, r1, color = 0xffffff, life = 0.7, opacity = 0.5) {
    const g = new THREE.RingGeometry(0.94, 1, 40); g.rotateX(-Math.PI / 2);
    const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(g, m); mesh.position.set(x, 0.08, y); mesh.scale.setScalar(r0); mesh.renderOrder = 4; this.group.add(mesh);
    this.items.push({ obj: mesh, t: 0, life, r0, r1, op: opacity, ring: true });
  }
  sparks(x, y, z, n = 14, color = 0xffd070, speed = 3) {
    const pts = [], vel = [];
    for (let i = 0; i < n; i++) { pts.push(new THREE.Vector3(x, z, y)); const a = Math.random() * 6.28, u = Math.random(); vel.push(new THREE.Vector3(Math.cos(a) * speed * u, (0.5 + Math.random()) * speed * 0.8, Math.sin(a) * speed * u)); }
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    const m = new THREE.PointsMaterial({ color, size: 0.09, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
    const p = new THREE.Points(g, m); p.frustumCulled = false; this.group.add(p); this.items.push({ obj: p, t: 0, life: 0.7, vel, spark: true });
  }
  // thrown object arc (returns a handle that resolves through onLand)
  projectile(x0, y0, x1, y1, { color = 0xd8c050, size = 0.06, dur = 0.5, arc = 1.6, onLand = null } = {}) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(size, 8, 6), new THREE.MeshBasicMaterial({ color }));
    m.position.set(x0, 1.3, y0); this.group.add(m); this.items.push({ obj: m, t: 0, life: dur, x0, y0, x1, y1, arc, onLand, proj: true });
  }

  update(dt) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i]; it.t += dt; const k = it.t / it.life;
      if (k >= 1) {
        if (it.proj && it.onLand) it.onLand();
        this.group.remove(it.obj); it.obj.geometry && it.obj.geometry.dispose(); it.obj.material && it.obj.material.dispose(); this.items.splice(i, 1); continue;
      }
      if (it.fade) it.obj.material.opacity = 1 - k;
      if (it.ring) { it.obj.scale.setScalar(it.r0 + (it.r1 - it.r0) * (1 - (1 - k) * (1 - k))); it.obj.material.opacity = it.op * (1 - k); }
      if (it.proj) { const x = it.x0 + (it.x1 - it.x0) * k, y = it.y0 + (it.y1 - it.y0) * k; it.obj.position.set(x, 0.15 + Math.sin(k * Math.PI) * it.arc + (1 - k) * 1.1, y); }
      if (it.spark) {
        const pos = it.obj.geometry.attributes.position;
        for (let j = 0; j < it.vel.length; j++) { it.vel[j].y -= 9 * dt; pos.setXYZ(j, pos.getX(j) + it.vel[j].x * dt, Math.max(0.02, pos.getY(j) + it.vel[j].y * dt), pos.getZ(j) + it.vel[j].z * dt); }
        pos.needsUpdate = true; it.obj.material.opacity = 1 - k;
      }
    }
  }
}
