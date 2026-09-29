// Level model: grid layers, doors, props, lights, zones, ray-casting and path-finding. No rendering here.
import { ZONE_ORDER } from './config.js';

export class Level {
  constructor(W, H) {
    this.W = W; this.H = H; const n = W * H;
    this.carved = new Uint8Array(n);      // 1 = walkable floor of some room/corridor
    this.solid = new Uint8Array(n);       // 1 = wall / permanent obstacle
    this.block = new Uint8Array(n);       // 1 = furniture blocking movement (not light)
    this.opaqueBase = new Uint8Array(n);  // 1 = blocks light + vision (walls, tall props)
    this.zone = new Uint8Array(n);        // index into this.zones
    this.floor = new Uint8Array(n);       // floor style index
    this.wallStyle = new Uint8Array(n);   // wall style index (for wall cells)
    this.cover = new Uint8Array(n);       // 1 = waist-high cover (blocks sight for crouching targets)
    this.room = new Int16Array(n).fill(-1);
    this.zones = [];                      // {name, type, room?}
    this.rooms = [];                      // {id,name,x,y,w,h,zone,type,...}
    this.doors = []; this.doorAt = new Map();
    this.props = [];                      // {id,name,x,y,rot,w,d,h,tags,ref}
    this.lights = [];                     // static/dynamic light descriptors (see lighting.js)
    this.vents = null;                    // vent network (added by the mission)
    this.floorStyles = []; this.wallStyles = [];
    this.spawn = { x: 2.5, y: 2.5 };
    this._flowCache = new Map();
  }

  idx(x, y) { return y * this.W + x; }
  inb(x, y) { return x >= 0 && y >= 0 && x < this.W && y < this.H; }
  zoneIdOf(name, type) {
    let i = this.zones.findIndex(z => z.name === name);
    if (i < 0) { i = this.zones.length; this.zones.push({ name, type: type || 'public' }); }
    return i;
  }
  styleId(list, name) { let i = list.indexOf(name); if (i < 0) { i = list.length; list.push(name); } return i; }
  zoneAt(x, y) { const cx = Math.floor(x), cy = Math.floor(y); return this.inb(cx, cy) ? this.zones[this.zone[this.idx(cx, cy)]] : null; }
  zoneTypeAt(x, y) { const z = this.zoneAt(x, y); return z ? z.type : 'outside'; }
  roomAt(x, y) { const cx = Math.floor(x), cy = Math.floor(y); return this.inb(cx, cy) ? this.rooms[this.room[this.idx(cx, cy)]] || null : null; }

  // ---- doors -------------------------------------------------------------
  doorCell(cx, cy) { return this.doorAt.get(cy * this.W + cx) || null; }
  isDoorOpen(d) { return d.open > 0.45; }

  // Can an actor stand in this cell? (doors count as passable while open)
  passable(cx, cy) {
    if (!this.inb(cx, cy)) return false;
    const i = this.idx(cx, cy);
    if (!this.carved[i] || this.solid[i] || this.block[i]) return false;
    const d = this.doorAt.get(i);
    if (d && !this.isDoorOpen(d)) return false;
    return true;
  }
  // Path-finding treats every unlocked or keyed door as passable (doors open on approach).
  walkable(cx, cy, opts = {}) {
    if (!this.inb(cx, cy)) return false;
    const i = this.idx(cx, cy);
    if (!this.carved[i] || this.solid[i] || this.block[i]) return false;
    const d = this.doorAt.get(i);
    if (d && d.lock && !opts.keys) return false;
    return true;
  }
  opaqueAt(cx, cy) {
    if (!this.inb(cx, cy)) return true;
    const i = this.idx(cx, cy);
    if (this.opaqueBase[i]) return true;
    if (!this.carved[i]) return true;
    const d = this.doorAt.get(i);
    if (d && d.open < 0.35 && !d.glass) return true;
    return false;
  }

  circleBlocked(x, y, r) {
    const x0 = Math.floor(x - r), x1 = Math.floor(x + r), y0 = Math.floor(y - r), y1 = Math.floor(y + r);
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
      if (this.passable(cx, cy)) continue;
      // closest point on the cell square to the circle
      const px = Math.max(cx, Math.min(x, cx + 1)), py = Math.max(cy, Math.min(y, cy + 1));
      const dx = x - px, dy = y - py;
      if (dx * dx + dy * dy < r * r) return true;
    }
    return false;
  }
  // slide movement against the grid. returns {x,y,hitX,hitY}
  moveCircle(x, y, dx, dy, r) {
    let nx = x + dx, ny = y, hitX = false, hitY = false;
    if (this.circleBlocked(nx, ny, r)) { nx = x; hitX = true; }
    ny = y + dy;
    if (this.circleBlocked(nx, ny, r)) { ny = y; hitY = true; }
    return { x: nx, y: ny, hitX, hitY };
  }

  // ---- ray casting (Amanatides & Woo DDA) --------------------------------
  // Returns {hit:boolean, t:distance to first blocking cell entry (or full length), cx, cy}
  ray(x0, y0, x1, y1, blockedFn = null) {
    const bf = blockedFn || ((cx, cy) => this.opaqueAt(cx, cy));
    const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
    if (len < 1e-6) return { hit: false, t: 0 };
    let cx = Math.floor(x0), cy = Math.floor(y0);
    const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity, tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    let tmx = dx !== 0 ? ((dx > 0 ? cx + 1 - x0 : x0 - cx) * tdx) : Infinity;
    let tmy = dy !== 0 ? ((dy > 0 ? cy + 1 - y0 : y0 - cy) * tdy) : Infinity;
    // the start cell never blocks (a light sits inside a lamp cell; an actor in a doorway)
    for (let guard = 0; guard < 400; guard++) {
      let t;
      if (tmx < tmy) { t = tmx; cx += sx; tmx += tdx; } else { t = tmy; cy += sy; tmy += tdy; }
      if (t >= 1) return { hit: false, t: len };
      if (bf(cx, cy)) return { hit: true, t: t * len, cx, cy };
    }
    return { hit: false, t: len };
  }
  los(x0, y0, x1, y1) { return !this.ray(x0, y0, x1, y1).hit; }

  // number of wall cells crossed between two points (sound attenuation)
  wallsBetween(x0, y0, x1, y1) {
    let n = 0, lastCx = -1, lastCy = -1;
    const dx = x1 - x0, dy = y1 - y0, steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * 2);
    for (let i = 1; i < steps; i++) {
      const t = i / steps, cx = Math.floor(x0 + dx * t), cy = Math.floor(y0 + dy * t);
      if (cx === lastCx && cy === lastCy) continue; lastCx = cx; lastCy = cy;
      if (!this.inb(cx, cy)) { n++; continue; }
      const k = this.idx(cx, cy);
      if (this.solid[k] || !this.carved[k]) n++; else { const d = this.doorAt.get(k); if (d && d.open < 0.35) n += 0.6; }
    }
    return n;
  }
  nearestWalkable(x, y, maxR = 4) {
    const cx = Math.floor(x), cy = Math.floor(y);
    if (this.walkable(cx, cy, { keys: true })) return { x: cx, y: cy };
    for (let r = 1; r <= maxR; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      if (this.walkable(cx + dx, cy + dy, { keys: true })) return { x: cx + dx, y: cy + dy };
    }
    return { x: cx, y: cy };
  }

  // ---- path finding ------------------------------------------------------
  // Breadth-first distance field from a cell (used for chase / flee / search).
  flowField(tx, ty, opts = {}) {
    const key = tx + ',' + ty + (opts.keys ? 'k' : '');
    const c = this._flowCache.get(key);
    if (c && c.stamp === this._navStamp) return c.d;
    const { W, H } = this; const d = new Int16Array(W * H).fill(-1);
    if (!this.inb(tx, ty)) return d;
    const q = new Int32Array(W * H); let qh = 0, qt = 0;
    const s = ty * W + tx; d[s] = 0; q[qt++] = s;
    while (qh < qt) {
      const cidx = q[qh++], x = cidx % W, y = (cidx / W) | 0, nd = d[cidx] + 1;
      for (let k = 0; k < 4; k++) {
        const nx = x + (k === 0) - (k === 1), ny = y + (k === 2) - (k === 3);
        if (!this.inb(nx, ny)) continue;
        const ni = ny * W + nx;
        if (d[ni] !== -1 || !this.walkable(nx, ny, opts)) continue;
        d[ni] = nd; q[qt++] = ni;
      }
    }
    if (this._flowCache.size > 60) this._flowCache.clear();
    this._flowCache.set(key, { d, stamp: this._navStamp });
    return d;
  }
  invalidateNav() { this._navStamp = (this._navStamp || 0) + 1; }

  // Next waypoint (world centre of the neighbouring cell with the lowest flow value).
  flowStep(field, x, y) {
    const cx = Math.floor(x), cy = Math.floor(y), W = this.W;
    let best = field[cy * W + cx], bx = cx, by = cy;
    if (best < 0) best = 1e9;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = cx + dx, ny = cy + dy;
      if (!this.inb(nx, ny)) continue;
      const v = field[ny * W + nx];
      if (v < 0) continue;
      if (dx && dy && (!this.walkable(cx + dx, cy) || !this.walkable(cx, cy + dy))) continue;   // no corner cutting
      const score = v + (dx && dy ? 0.35 : 0);
      if (score < best) { best = score; bx = nx; by = ny; }
    }
    return { x: bx + 0.5, y: by + 0.5, found: bx !== cx || by !== cy };
  }

  // A* over walkable cells (4-connected), returns list of cell centres.
  path(sx, sy, tx, ty, opts = {}) {
    const W = this.W; sx = Math.floor(sx); sy = Math.floor(sy); tx = Math.floor(tx); ty = Math.floor(ty);
    if (!this.walkable(tx, ty, opts)) return null;
    const open = [[0, sy * W + sx]]; const g = new Map([[sy * W + sx, 0]]); const from = new Map();
    const h = (x, y) => Math.abs(x - tx) + Math.abs(y - ty);
    while (open.length) {
      open.sort((a, b) => a[0] - b[0]);
      const [, cur] = open.shift(); const cx = cur % W, cy = (cur / W) | 0;
      if (cx === tx && cy === ty) {
        const out = []; let c = cur;
        while (c !== undefined) { out.push({ x: (c % W) + 0.5, y: ((c / W) | 0) + 0.5 }); c = from.get(c); }
        return out.reverse();
      }
      for (let k = 0; k < 4; k++) {
        const nx = cx + (k === 0) - (k === 1), ny = cy + (k === 2) - (k === 3);
        if (!this.walkable(nx, ny, opts)) continue;
        const ni = ny * W + nx, ng = g.get(cur) + 1;
        if (g.has(ni) && g.get(ni) <= ng) continue;
        g.set(ni, ng); from.set(ni, cur); open.push([ng + h(nx, ny), ni]);
      }
    }
    return null;
  }

  // ---- misc helpers ------------------------------------------------------
  randomCellIn(room, rng, filter = null) {
    for (let i = 0; i < 60; i++) {
      const x = room.x + Math.floor(rng.next() * room.w), y = room.y + Math.floor(rng.next() * room.h);
      if (this.room[this.idx(x, y)] !== room.id) continue;
      if (!this.walkable(x, y)) continue;
      if (filter && !filter(x, y)) continue;
      return { x: x + 0.5, y: y + 0.5 };
    }
    return null;
  }
  zoneRank(type) { return ZONE_ORDER.indexOf(type); }
}

// ------------------------------------------------------------------------------------------------
// Blueprint helper used to author missions: carve rooms/corridors, place doors + props, then finalise walls.
export class MapBuilder {
  constructor(W, H) { this.L = new Level(W, H); this.W = W; this.H = H; this.byName = {}; this.propId = 1; }

  room(name, x, y, w, h, { zone = 'public', type = null, floor = 'marble', wall = 'plaster', shape = 'rect' } = {}) {
    const L = this.L; const id = L.rooms.length;
    const zid = L.zoneIdOf(name, type || zone);
    L.zones[zid].type = type || zone;
    const fs = L.styleId(L.floorStyles, floor), ws = L.styleId(L.wallStyles, wall);
    const r = { id, name, x, y, w, h, zone: zone, zid, floor, wall, cells: [], doors: [], props: [] };
    for (let cy = y; cy < y + h; cy++) for (let cx = x; cx < x + w; cx++) {
      if (shape === 'ellipse') { const nx = (cx + 0.5 - (x + w / 2)) / (w / 2), ny = (cy + 0.5 - (y + h / 2)) / (h / 2); if (nx * nx + ny * ny > 1) continue; }
      const i = L.idx(cx, cy);
      L.carved[i] = 1; L.zone[i] = zid; L.floor[i] = fs; L.room[i] = id; r.cells.push({ x: cx, y: cy });
    }
    L.rooms.push(r); this.byName[name] = r;
    r._ws = ws;
    return r;
  }

  // carve a corridor/door-connector strip (rect) that belongs to an existing named zone or its own
  strip(name, x, y, w, h, opts = {}) { return this.room(name, x, y, w, h, opts); }

  door(x, y, orient, { lock = null, glass = false, sliding = false, model = 'door', code = null, faction = null } = {}) {
    const L = this.L, i = L.idx(x, y);
    L.carved[i] = 1;
    const d = { id: L.doors.length, x, y, orient, lock, glass, sliding, model, code, open: 0, target: 0, faction, alarm: false, ref: null };
    L.doors.push(d); L.doorAt.set(i, d);
    // inherit the zone of a neighbouring carved cell (prefer the more restricted)
    let bestZ = null, bestR = -1;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy; if (!L.inb(nx, ny)) continue;
      const j = L.idx(nx, ny); if (!L.carved[j] || L.doorAt.has(j)) continue;
      const z = L.zones[L.zone[j]]; const rk = L.zoneRank(z.type);
      if (rk > bestR) { bestR = rk; bestZ = L.zone[j]; }
    }
    if (bestZ !== null) { L.zone[i] = bestZ; L.floor[i] = L.floor[L.idx(x + (orient === 'h' ? 1 : 0), y + (orient === 'h' ? 0 : 1))] || 0; }
    return d;
  }

  prop(name, x, y, { rot = 0, w = 1, d = 1, h = 1, block = true, opaque = false, tags = [], y0 = 0, wall = false, data = null, roomRef = null } = {}) {
    const L = this.L;
    const p = { id: this.propId++, name, x, y, rot, w, d, h, tags, y0, wall, data, block, opaque, cells: [] };
    if (block || opaque) {
      // footprint in cells, respecting rotation (w x d metres centred on x,y)
      const rw = (Math.abs(Math.round(rot / (Math.PI / 2))) % 2) ? d : w, rd = (Math.abs(Math.round(rot / (Math.PI / 2))) % 2) ? w : d;
      const x0 = Math.floor(x - rw / 2 + 0.01), x1 = Math.floor(x + rw / 2 - 0.01), y1c = Math.floor(y + rd / 2 - 0.01), y0c = Math.floor(y - rd / 2 + 0.01);
      for (let cy = y0c; cy <= y1c; cy++) for (let cx = x0; cx <= x1; cx++) {
        if (!L.inb(cx, cy)) continue; const i = L.idx(cx, cy);
        if (block) L.block[i] = 1;
        if (opaque) L.opaqueBase[i] = 1;
        if (block && !opaque && h >= 0.45 && h <= 1.5) L.cover[i] = 1;
        p.cells.push(i);
      }
    }
    L.props.push(p); return p;
  }

  // Finalise: everything not carved becomes wall; wall cells touching a room take that room's wall style.
  finish() {
    const L = this.L, { W, H } = this;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = L.idx(x, y);
      if (!L.carved[i]) { L.solid[i] = 1; L.opaqueBase[i] = 1; }
    }
    // wall style from adjacent carved cell (prefers a non-door neighbour, 4-neighbourhood first)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = L.idx(x, y); if (L.carved[i]) continue;
      let found = -1;
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const nx = x + dx, ny = y + dy; if (!L.inb(nx, ny)) continue;
        const j = L.idx(nx, ny); if (L.carved[j] && L.room[j] >= 0) { found = L.room[j]; break; }
      }
      L.wallStyle[i] = found >= 0 ? L.rooms[found]._ws : 0;
    }
    L.invalidateNav();
    return L;
  }
}
