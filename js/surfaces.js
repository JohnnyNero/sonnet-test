// The "living surfaces" layer: oil / water / ice / fire / electricity on a tile grid,
// plus the reaction rules between them. Pure data + rules, no rendering.
//
//   fire  + oil   -> burns, and spreads along the oil (fast)
//   fire  + water -> fizzles (steam)          fire + ice -> melts to water
//   frost + water -> ice (slippery)           frost + fire -> extinguished
//   shock + water -> arcs through the whole connected puddle
//   oil floating on water still burns
export const STEP = 0.1;           // reaction tick (seconds)
const OIL_BURN_TTL = 0.6;          // fire refreshes to this while oil remains
const BARE_FIRE_TTL = 0.9;
const ICE_TTL = 14;
const ELEC_TTL = 0.7;

export class Surfaces {
  constructor(w, h, tiles) {
    this.w = w; this.h = h; this.n = w * h;
    this.solid = new Uint8Array(this.n);
    for (let i = 0; i < this.n; i++) this.solid[i] = tiles[i] ? 0 : 1;
    this.oil = new Float32Array(this.n);
    this.water = new Float32Array(this.n);
    this.ice = new Float32Array(this.n);    // ttl
    this.fire = new Float32Array(this.n);   // ttl
    this.elec = new Float32Array(this.n);   // ttl
    this.scorch = new Float32Array(this.n);
    this.perm = new Uint8Array(this.n);     // permanent flames (braziers)
    this.acc = 0;
    this.events = [];                       // {type,x,y} drained by the game (steam, sfx...)
    this.stats = { burned: 0, arcs: 0, frozen: 0 };
  }
  idx(x, y) { return (y | 0) * this.w + (x | 0); }
  ok(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h && !this.solid[y * this.w + x]; }

  // ---- queries
  at(x, y) {
    const i = Math.floor(y) * this.w + Math.floor(x);
    if (i < 0 || i >= this.n) return null;
    return { i, oil: this.oil[i] > 0.15, water: this.water[i] > 0.15, ice: this.ice[i] > 0, fire: this.fire[i] > 0, elec: this.elec[i] > 0 };
  }
  fireNear(x, y, r) {
    const R = Math.ceil(r);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const cx = Math.floor(x) + dx, cy = Math.floor(y) + dy;
      if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h) continue;
      if (Math.hypot(cx + 0.5 - x, cy + 0.5 - y) <= r && this.fire[cy * this.w + cx] > 0) return true;
    }
    return false;
  }

  _each(x, y, r, fn) {
    const R = Math.ceil(r);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const cx = Math.floor(x) + dx, cy = Math.floor(y) + dy;
      if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h) continue;
      if (Math.hypot(cx + 0.5 - x, cy + 0.5 - y) > r) continue;
      const i = cy * this.w + cx;
      if (this.solid[i]) continue;
      fn(i, cx, cy);
    }
  }

  // ---- actions (called by skills / props / monsters)
  pour(kind, x, y, r) {
    this._each(x, y, r, (i, cx, cy) => {
      if (kind === 'oil') { this.oil[i] = 1; if (this.ice[i] > 0) this.ice[i] = Math.min(this.ice[i], 0.01); }
      else {
        if (this.fire[i] > 0 && !this.perm[i] && this.oil[i] <= 0.05) { this.fire[i] = 0; this.events.push({ type: 'steam', x: cx + 0.5, y: cy + 0.5 }); }
        this.water[i] = 1;
      }
    });
  }
  // strong = a real spell impact (can burn bare floor briefly)
  ignite(x, y, r, strong = true) {
    this._each(x, y, r, (i, cx, cy) => {
      if (this.oil[i] > 0.05) this._light(i, cx, cy, OIL_BURN_TTL);
      else if (this.ice[i] > 0) { this.ice[i] = 0; this.water[i] = 1; this.events.push({ type: 'steam', x: cx + 0.5, y: cy + 0.5 }); }
      else if (this.water[i] > 0.15) { if (strong) { this.events.push({ type: 'steam', x: cx + 0.5, y: cy + 0.5 }); } }
      else if (strong) this._light(i, cx, cy, BARE_FIRE_TTL);
    });
  }
  _light(i, cx, cy, ttl) {
    if (this.fire[i] <= 0) { this.events.push({ type: 'ignite', x: cx + 0.5, y: cy + 0.5 }); if (this.oil[i] > 0.05) this.stats.burned++; }
    this.fire[i] = Math.max(this.fire[i], ttl);
  }
  freeze(x, y, r) {
    this._each(x, y, r, (i, cx, cy) => {
      if (this.fire[i] > 0 && !this.perm[i]) { this.fire[i] = 0; this.events.push({ type: 'steam', x: cx + 0.5, y: cy + 0.5 }); }
      if (this.water[i] > 0.15) { this.water[i] = 0; this.ice[i] = ICE_TTL; this.elec[i] = 0; this.stats.frozen++; }
    });
  }
  shock(x, y) {
    const i = this.idx(x, y);
    if (i < 0 || i >= this.n || this.water[i] <= 0.15) return false;
    if (this.elec[i] <= 0) this.stats.arcs++;
    this.elec[i] = ELEC_TTL;
    return true;
  }
  brazier(x, y) {
    const i = this.idx(x, y);
    this.fire[i] = 1e9; this.perm[i] = 1;
  }

  // ---- simulation
  update(dt) {
    this.acc += dt;
    while (this.acc >= STEP) { this.acc -= STEP; this._tick(); }
  }
  _tick() {
    const { w, h, n } = this;
    const N = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    // fire
    const ignitions = [];
    for (let i = 0; i < n; i++) {
      if (this.fire[i] <= 0) continue;
      const x = i % w, y = (i / w) | 0;
      if (!this.perm[i]) this.fire[i] -= STEP;
      this.scorch[i] = Math.min(1, this.scorch[i] + 0.04);
      if (this.oil[i] > 0) { this.oil[i] -= 0.035; if (this.oil[i] > 0.05) this.fire[i] = Math.max(this.fire[i], OIL_BURN_TTL); else this.oil[i] = 0; }
      if (this.ice[i] > 0) { this.ice[i] = 0; this.water[i] = 1; if (this.oil[i] <= 0) { this.fire[i] = 0; } }
      else if (this.water[i] > 0.15 && this.oil[i] <= 0.05 && !this.perm[i]) { this.fire[i] = 0; this.events.push({ type: 'steam', x: x + 0.5, y: y + 0.5 }); }
      // spread along oil
      if (this.fire[i] > 0.05) for (const [dx, dy] of N) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (this.solid[ni] || this.fire[ni] > 0 || this.oil[ni] <= 0.05) continue;
        ignitions.push(ni);
      }
    }
    for (const ni of ignitions) this._light(ni, ni % w, (ni / w) | 0, OIL_BURN_TTL);
    // electricity: the front moves through connected water
    const front = [];
    for (let i = 0; i < n; i++) if (this.elec[i] > 0.5) front.push(i);
    for (let i = 0; i < n; i++) if (this.elec[i] > 0) this.elec[i] = Math.max(0, this.elec[i] - STEP);
    for (const i of front) {
      const x = i % w, y = (i / w) | 0;
      for (const [dx, dy] of N) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (this.water[ni] > 0.15 && this.elec[ni] <= 0) { this.elec[ni] = ELEC_TTL; }
      }
    }
    // ice melts back into water
    for (let i = 0; i < n; i++) if (this.ice[i] > 0) { this.ice[i] -= STEP; if (this.ice[i] <= 0) { this.ice[i] = 0; this.water[i] = 1; } }
    // scorch fades very slowly
    for (let i = 0; i < n; i++) if (this.scorch[i] > 0 && this.fire[i] <= 0) this.scorch[i] = Math.max(0, this.scorch[i] - 0.0004);
  }
}
