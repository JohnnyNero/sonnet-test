// CPU light field. Every light casts grid-accurate shadows into a lightmap that is (a) sampled by the shaders so the
// scene is lit by it and (b) sampled by the game to decide how visible the player is. What you see = what guards see.
import { LM } from './config.js';

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class LightField {
  constructor(level, zoneAmbient) {
    this.L = level;
    this.tw = level.W * LM; this.th = level.H * LM; const n = this.tw * this.th;
    this.base = new Float32Array(n * 3);        // ambient + static lights
    this.dyn = new Float32Array(n * 3);         // dynamic lights (cleared every frame)
    this.touched = [];                          // indices touched by dynamic lights this frame
    this.texData = new Uint8Array(n * 4);       // encoded result uploaded as a texture
    this.version = 0; this.dirty = true;
    this.contrib = new Map();                   // light id -> {idx, val}
    this.lights = [];                           // static light descriptors (level.lights)
    this._ambient(zoneAmbient);
  }

  _ambient(zoneAmbient) {
    const { L, tw, th } = this;
    for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
      const cx = Math.floor(tx / LM), cy = Math.floor(ty / LM), ci = cy * L.W + cx;
      let zid = L.zone[ci];
      if (!L.carved[ci]) { // wall: take the ambient of the nearest carved neighbour
        zid = -1;
        for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
          const nx = cx + dx, ny = cy + dy; if (!L.inb(nx, ny)) continue;
          if (L.carved[ny * L.W + nx]) { zid = L.zone[ny * L.W + nx]; break; }
        }
      }
      const a = zid >= 0 ? (zoneAmbient(L.zones[zid]) || [0.03, 0.03, 0.03]) : [0.02, 0.02, 0.03];
      const o = (ty * tw + tx) * 3; this.base[o] = a[0]; this.base[o + 1] = a[1]; this.base[o + 2] = a[2];
    }
  }

  // ---- light contribution -------------------------------------------------
  // Evaluate one light and hand every affected texel to fn(index, r, g, b). soft = extra shadow-edge rays.
  _eval(light, soft, fn) {
    const { L, tw, th } = this;
    const R = light.range, lx = light.x, ly = light.y, lz = light.z ?? 3;
    const x0 = Math.max(0, Math.floor((lx - R) * LM)), x1 = Math.min(tw - 1, Math.ceil((lx + R) * LM));
    const y0 = Math.max(0, Math.floor((ly - R) * LM)), y1 = Math.min(th - 1, Math.ceil((ly + R) * LM));
    const cosOuter = light.angle ? Math.cos(light.angle) : -2, cosInner = light.angle ? Math.cos(light.angle * (1 - (light.penumbra ?? 0.35))) : -2;
    const dirx = Math.cos(light.dir || 0), diry = Math.sin(light.dir || 0);
    const off = soft ? 0.5 / LM : 0;
    const col = light.color, inten = light.intensity * (light.mul ?? 1);
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
      const px = (tx + 0.5) / LM, py = (ty + 0.5) / LM;
      const dx = px - lx, dy = py - ly, d2 = dx * dx + dy * dy;
      if (d2 > R * R) continue;
      const d = Math.sqrt(d2);
      let f = 1 - d2 / (R * R); f *= f;
      f *= lz / Math.sqrt(d2 + lz * lz);                       // lambert on the floor
      if (light.angle) {
        if (d < 1e-4) { /* directly below */ } else {
          const c = (dx * dirx + dy * diry) / d;
          if (c < cosOuter) continue;
          f *= smooth(cosOuter, cosInner, c);
        }
      }
      if (f < 0.004) continue;
      // shadowing
      let vis = 1;
      if (!light.noShadow) {
        if (L.ray(lx, ly, px, py).hit) {
          vis = 0;
          if (soft) { // penumbra: try slightly offset target points
            let hits = 0, tot = 0;
            for (const [ox, oy] of [[off, 0], [-off, 0], [0, off], [0, -off]]) { tot++; if (!L.ray(lx, ly, px + ox, py + oy).hit) hits++; }
            vis = (hits / tot) * 0.55;
          }
        } else if (soft) {
          let hits = 0;
          for (const [ox, oy] of [[off, 0], [-off, 0], [0, off], [0, -off]]) if (L.ray(lx, ly, px + ox, py + oy).hit) hits++;
          vis = 1 - hits * 0.14;
        }
      }
      if (vis <= 0.001) continue;
      const k = f * vis * inten;
      fn(ty * tw + tx, col[0] * k, col[1] * k, col[2] * k);
    }
  }

  addStatic(light) {
    light.id = light.id ?? this.lights.length;
    this.lights.push(light);
    if (light.on !== false) this._bake(light, 1);
    return light;
  }
  _bake(light, sign) {
    let c = this.contrib.get(light.id);
    if (!c) {
      const idx = [], val = [];
      this._eval(light, true, (i, r, g, b) => { idx.push(i); val.push(r, g, b); });
      c = { idx: Int32Array.from(idx), val: Float32Array.from(val) };
      this.contrib.set(light.id, c);
    }
    const base = this.base, { idx, val } = c;
    for (let k = 0; k < idx.length; k++) {
      const o = idx[k] * 3, v = k * 3;
      base[o] += sign * val[v]; base[o + 1] += sign * val[v + 1]; base[o + 2] += sign * val[v + 2];
      if (sign < 0) { if (base[o] < 0) base[o] = 0; if (base[o + 1] < 0) base[o + 1] = 0; if (base[o + 2] < 0) base[o + 2] = 0; }
    }
    this.dirty = true;
  }
  setOn(light, on) {
    if (light.on === on || light.broken && on) return;
    light.on = on;
    this._bake(light, on ? 1 : -1);
  }
  // Doors/props changed: re-bake lights whose reach includes (cx,cy). Cheap enough for occasional events.
  rebakeNear(cx, cy) {
    for (const l of this.lights) {
      if (Math.hypot(l.x - (cx + 0.5), l.y - (cy + 0.5)) > l.range + 1) continue;
      const wasOn = l.on !== false;
      if (wasOn) this._bake(l, -1);
      this.contrib.delete(l.id);
      if (wasOn) this._bake(l, 1);
    }
  }

  // ---- dynamic lights (flashlights, camera beams, alarms ...) ---------------
  beginFrame() {
    const d = this.dyn;
    for (const i of this.touched) { const o = i * 3; d[o] = d[o + 1] = d[o + 2] = 0; }
    this.touched.length = 0;
  }
  addDynamic(light) {
    const d = this.dyn, t = this.touched;
    this._eval(light, false, (i, r, g, b) => {
      const o = i * 3;
      if (d[o] === 0 && d[o + 1] === 0 && d[o + 2] === 0) t.push(i);
      d[o] += r; d[o + 1] += g; d[o + 2] += b;
    });
  }
  // Compose base+dyn into the uploadable texture. Values are sqrt-encoded so dark tones keep precision.
  commit(full = false) {
    const n = this.tw * this.th, out = this.texData, base = this.base, dyn = this.dyn;
    if (full || this.dirty) {
      for (let i = 0; i < n; i++) {
        const o = i * 3, q = i * 4;
        out[q] = enc(base[o] + dyn[o]); out[q + 1] = enc(base[o + 1] + dyn[o + 1]); out[q + 2] = enc(base[o + 2] + dyn[o + 2]); out[q + 3] = 255;
      }
      this.dirty = false;
    } else {
      // only re-encode texels touched by dynamic lights (both this frame and the ones we cleared)
      for (const i of this.touched) { const o = i * 3, q = i * 4; out[q] = enc(base[o] + dyn[o]); out[q + 1] = enc(base[o + 1] + dyn[o + 1]); out[q + 2] = enc(base[o + 2] + dyn[o + 2]); }
      if (this._prevTouched) for (const i of this._prevTouched) { const o = i * 3, q = i * 4; out[q] = enc(base[o] + dyn[o]); out[q + 1] = enc(base[o + 1] + dyn[o + 1]); out[q + 2] = enc(base[o + 2] + dyn[o + 2]); }
    }
    this._prevTouched = this.touched.slice();
    this.version++;
  }

  // ---- gameplay query -------------------------------------------------------
  sample(x, y) {
    const { tw, th, base, dyn } = this;
    const fx = x * LM - 0.5, fy = y * LM - 0.5;
    const x0 = Math.max(0, Math.min(tw - 1, Math.floor(fx))), y0 = Math.max(0, Math.min(th - 1, Math.floor(fy)));
    const x1 = Math.min(tw - 1, x0 + 1), y1 = Math.min(th - 1, y0 + 1);
    const ax = Math.min(1, Math.max(0, fx - x0)), ay = Math.min(1, Math.max(0, fy - y0));
    const g = (tx, ty, c) => { const o = (ty * tw + tx) * 3 + c; return base[o] + dyn[o]; };
    const out = [0, 0, 0];
    for (let c = 0; c < 3; c++) out[c] = (g(x0, y0, c) * (1 - ax) + g(x1, y0, c) * ax) * (1 - ay) + (g(x0, y1, c) * (1 - ax) + g(x1, y1, c) * ax) * ay;
    return { r: out[0], g: out[1], b: out[2], lum: lum(out[0], out[1], out[2]) };
  }
}
function enc(v) { const t = Math.sqrt(Math.min(1, Math.max(0, v / 3))); return (t * 255 + 0.5) | 0; }

// ------------------------------------------------------------------------------------------------
// Player line-of-sight mask + fog-of-war memory. Same texel grid as the light field.
export class VisionMask {
  constructor(level) {
    this.L = level; this.tw = level.W * LM; this.th = level.H * LM;
    const n = this.tw * this.th;
    this.vis = new Float32Array(n); this.explored = new Uint8Array(n);
    this.texData = new Uint8Array(n * 4); this.version = 0;
    this._prev = []; this._win = null;
  }
  update(px, py, radius, level = null, peek = null, dt = 1 / 60) {
    const { tw, th, vis, explored, texData } = this;
    const tgt = this.tgt || (this.tgt = new Float32Array(tw * th));
    const L = level || this.L;
    for (const i of this._prev) { tgt[i] = 0; }
    this._prev.length = 0;
    let x0 = Math.max(0, Math.floor((px - radius) * LM)), x1 = Math.min(tw - 1, Math.ceil((px + radius) * LM));
    let y0 = Math.max(0, Math.floor((py - radius) * LM)), y1 = Math.min(th - 1, Math.ceil((py + radius) * LM));
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
      const qx = (tx + 0.5) / LM, qy = (ty + 0.5) / LM, dx = qx - px, dy = qy - py, d2 = dx * dx + dy * dy;
      if (d2 > radius * radius) continue;
      // wall texels are visible if the ray gets within one texel of them
      const r = L.ray(px, py, qx, qy);
      let v = 0;
      if (!r.hit) v = 1; else { const d = Math.sqrt(d2); if (r.t > d - 0.75) v = 0.9; }
      if (v > 0) {
        const edge = 1 - smooth(radius * 0.72, radius, Math.sqrt(d2));
        v *= edge; const i = ty * tw + tx; tgt[i] = v; this._prev.push(i);
        if (v > 0.5) explored[i] = 1;
      }
    }
    if (peek) this._peek(peek.x, peek.y, peek.radius, peek.level || this.L);
    const wx0 = peek ? Math.min(x0, Math.floor((peek.x - peek.radius) * LM)) : x0, wx1 = peek ? Math.max(x1, Math.ceil((peek.x + peek.radius) * LM)) : x1;
    const wy0 = peek ? Math.min(y0, Math.floor((peek.y - peek.radius) * LM)) : y0, wy1 = peek ? Math.max(y1, Math.ceil((peek.y + peek.radius) * LM)) : y1;
    x0 = Math.max(0, wx0); x1 = Math.min(tw - 1, wx1); y0 = Math.max(0, wy0); y1 = Math.min(th - 1, wy1);
    const nw = [Math.max(1, x0 - 1), Math.min(tw - 2, x1 + 1), Math.max(1, y0 - 1), Math.min(th - 2, y1 + 1)];
    const o = this._win || nw;
    const ux0 = Math.min(o[0], nw[0]), ux1 = Math.max(o[1], nw[1]), uy0 = Math.min(o[2], nw[2]), uy1 = Math.max(o[3], nw[3]);
    this._win = nw;
    // temporal smoothing: visibility eases toward this frame's ray results so shadow edges glide instead of crawling
    const k = 1 - Math.exp(-dt * 14);
    for (let ty = uy0; ty <= uy1; ty++) for (let tx = ux0; tx <= ux1; tx++) {
      const i = ty * tw + tx; let c = vis[i]; c += (tgt[i] - c) * k; vis[i] = c < 0.004 ? 0 : c;
    }
    // soften: 3x3 tent over the touched window + write the texture
    const tmp = this._tmp || (this._tmp = new Float32Array(tw * th));
    const bx0 = Math.max(1, ux0 - 1), bx1 = Math.min(tw - 2, ux1 + 1), by0 = Math.max(1, uy0 - 1), by1 = Math.min(th - 2, uy1 + 1);
    for (let ty = by0; ty <= by1; ty++) for (let tx = bx0; tx <= bx1; tx++) {
      const i = ty * tw + tx;
      tmp[i] = (vis[i] * 4 + vis[i - 1] + vis[i + 1] + vis[i - tw] + vis[i + tw]) / 8;
    }
    for (let ty = by0; ty <= by1; ty++) for (let tx = bx0; tx <= bx1; tx++) {
      const i = ty * tw + tx, q = i * 4; texData[q] = (Math.min(1, tmp[i]) * 255) | 0; texData[q + 1] = explored[i] ? 255 : 0; texData[q + 2] = 0; texData[q + 3] = 255;
    }
    this.version++;
  }
  // extra visibility from a second viewpoint (looking down through a vent grate into the room)
  _peek(px, py, radius, L) {
    const { tw, th, vis, explored } = this;
    const x0 = Math.max(0, Math.floor((px - radius) * LM)), x1 = Math.min(tw - 1, Math.ceil((px + radius) * LM));
    const y0 = Math.max(0, Math.floor((py - radius) * LM)), y1 = Math.min(th - 1, Math.ceil((py + radius) * LM));
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
      const qx = (tx + 0.5) / LM, qy = (ty + 0.5) / LM, d = Math.hypot(qx - px, qy - py); if (d > radius) continue;
      const r = L.ray(px, py, qx, qy); let v = r.hit ? (r.t > d - 0.75 ? 0.9 : 0) : 1;
      if (v <= 0) continue; v *= 1 - smooth(radius * 0.7, radius, d);
      const i = ty * tw + tx; if (v > this.tgt[i]) { this.tgt[i] = v; this._prev.push(i); if (v > 0.5) explored[i] = 1; }
    }
  }
  // cheap point test used to hide enemies the player cannot see
  visibleAt(x, y) {
    const tx = Math.min(this.tw - 1, Math.max(0, Math.floor(x * LM))), ty = Math.min(this.th - 1, Math.max(0, Math.floor(y * LM)));
    return this.vis[ty * this.tw + tx];
  }
}
