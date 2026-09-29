// Procedural floor generator: rooms (rect + ellipse) joined by 2-wide corridors.
import { RNG } from './util.js';

export const W = 64;
export const H = 64;

function inRoom(r, x, y) {
  if (r.shape === 'rect') return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
  const nx = (x + 0.5 - r.cx) / (r.w / 2), ny = (y + 0.5 - r.cy) / (r.h / 2);
  return nx * nx + ny * ny <= 1;
}

export function generate(seed, floor, boss) {
  const rng = new RNG(seed * 7919 + floor * 104729);
  const tiles = new Uint8Array(W * H); // 0 = wall, 1 = floor
  const rooms = [];
  const target = boss ? 9 : 10 + Math.min(floor, 3);

  for (let attempt = 0; attempt < 400 && rooms.length < target; attempt++) {
    const w = rng.int(6, 12), h = rng.int(6, 10);
    const x = rng.int(3, W - w - 3), y = rng.int(3, H - h - 3);
    const shape = rooms.length > 0 && rng.chance(0.35) ? 'ellipse' : 'rect';
    let ok = true;
    for (const o of rooms) {
      if (x < o.x + o.w + 3 && x + w + 3 > o.x && y < o.y + o.h + 3 && y + h + 3 > o.y) { ok = false; break; }
    }
    if (!ok) continue;
    rooms.push({ x, y, w, h, cx: x + w / 2, cy: y + h / 2, shape, kind: 'normal', cells: [] });
  }

  for (const r of rooms) {
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++)
        if (inRoom(r, x, y)) { tiles[y * W + x] = 1; }
  }

  const carve = (x, y) => { if (x > 0 && y > 0 && x < W - 1 && y < H - 1) tiles[y * W + x] = 1; };
  const corridor = (a, b) => {
    let x = Math.round(a.cx), y = Math.round(a.cy);
    const tx = Math.round(b.cx), ty = Math.round(b.cy);
    const horizFirst = rng.chance(0.5);
    const leg = (horiz) => {
      if (horiz) { const s = Math.sign(tx - x); while (x !== tx) { carve(x, y); carve(x, y + 1); x += s; } }
      else { const s = Math.sign(ty - y); while (y !== ty) { carve(x, y); carve(x + 1, y); y += s; } }
    };
    leg(horizFirst); leg(!horizFirst);
    carve(x, y); carve(x + 1, y); carve(x, y + 1); carve(x + 1, y + 1);
  };

  // Prim-style spanning tree, then a few extra loops.
  const connected = [0], remaining = rooms.map((_, i) => i).slice(1);
  const edges = [];
  while (remaining.length) {
    let best = null;
    for (const c of connected) for (const r of remaining) {
      const d = Math.hypot(rooms[c].cx - rooms[r].cx, rooms[c].cy - rooms[r].cy);
      if (!best || d < best.d) best = { c, r, d };
    }
    edges.push([best.c, best.r]);
    connected.push(best.r);
    remaining.splice(remaining.indexOf(best.r), 1);
  }
  for (let i = 0; i < 3; i++) {
    const a = rng.int(0, rooms.length - 1), b = rng.int(0, rooms.length - 1);
    if (a !== b) edges.push([a, b]);
  }
  for (const [a, b] of edges) corridor(rooms[a], rooms[b]);

  // Start = room 0. Exit / boss arena = the room furthest from it by walking distance.
  const start = { x: Math.floor(rooms[0].cx), y: Math.floor(rooms[0].cy) };
  const d = distanceField(tiles, start.x, start.y);
  let far = 1, farD = -1;
  rooms.forEach((r, i) => {
    if (i === 0) return;
    const dd = d[Math.floor(r.cy) * W + Math.floor(r.cx)];
    if (dd > farD) { farD = dd; far = i; }
  });
  rooms[0].kind = 'start';
  rooms[far].kind = boss ? 'boss' : 'exit';

  if (boss) { // widen the arena
    const r = rooms[far];
    r.shape = 'ellipse'; r.w = 18; r.h = 14;
    r.x = Math.round(Math.min(Math.max(r.cx - 9, 2), W - 20)); r.y = Math.round(Math.min(Math.max(r.cy - 7, 2), H - 16));
    r.cx = r.x + r.w / 2; r.cy = r.y + r.h / 2;
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (inRoom(r, x, y)) tiles[y * W + x] = 1;
  }

  for (const r of rooms) {
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++)
        if (inRoom(r, x, y) && tiles[y * W + x]) r.cells.push({ x, y });
  }
  const exit = { x: rooms[far].cx, y: rooms[far].cy };
  return { W, H, tiles, rooms, start, exit, exitRoom: rooms[far], boss: !!boss, seed, floor };
}

export function distanceField(tiles, sx, sy) {
  const d = new Int16Array(W * H).fill(-1);
  const q = [sy * W + sx];
  d[q[0]] = 0;
  for (let i = 0; i < q.length; i++) {
    const c = q[i], x = c % W, y = (c / W) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const n = ny * W + nx;
      if (d[n] === -1 && tiles[n]) { d[n] = d[c] + 1; q.push(n); }
    }
  }
  return d;
}

// Grid line-of-sight (walls block).
export function hasLOS(tiles, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * 2);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = Math.floor(x0 + dx * t), y = Math.floor(y0 + dy * t);
    if (x < 0 || y < 0 || x >= W || y >= H || !tiles[y * W + x]) return false;
  }
  return true;
}
