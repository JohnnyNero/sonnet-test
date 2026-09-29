// MISSION: "Ghost Ledger" - rob the vault of Aurelian Private Bank during its charity gala.
// Everything that varies between runs (who holds the keycard, the vault code, patrols, laser patterns,
// camera phases, guest crowd, lighting mood) comes from the contract seed.
import * as THREE from 'three';
import { MapBuilder } from '../level.js';
import { Player } from '../player.js';
import { Guard } from '../guard.js';
import { Npc } from '../npc.js';
import * as Env from '../envkit.js';
import { RNG } from '../util.js';
import { SecurityCamera, LaserGrid, Terminal, Breaker, Locker, VentGrate, Safe, Loot, Pickup, registerDoorLock, placeModel, findPart, setEmissive } from '../devices.js';
import { Level } from '../level.js';
import { makeVent } from '../vents.js';

export const CONTRACT_NAMES = ['Ghost Ledger', 'Velvet Ledger', 'Quiet Night', 'Black Tie Burglary', 'Silent Auction'];

export async function buildGhostLedger(game, seed) {
  const rng = new RNG(seed * 7919 + 3);
  const R = () => rng.next();
  const pick = a => a[Math.floor(R() * a.length)];
  const W = 100, H = 66;
  const M = new MapBuilder(W, H);

  // ================================================================================================ contract
  const contract = {
    seed,
    name: CONTRACT_NAMES[seed % CONTRACT_NAMES.length],
    keycardHolder: pick(['chief', 'director', 'desk']),
    codeSource: pick(['laptop', 'assistant']),
    vaultCode: String(1000 + Math.floor(R() * 9000)),
    safeCode: String(1000 + Math.floor(R() * 9000)),
    mood: pick(['amber', 'rose', 'teal']),
    guardCount: 0,
  };
  const MOOD = { amber: [1.0, 0.80, 0.50], rose: [1.0, 0.62, 0.66], teal: [0.6, 0.9, 1.0] }[contract.mood];

  // ================================================================================================ rooms
  const roomDef = (name, x, y, w, h, o) => M.room(name, x, y, w, h, o);
  roomDef('alley', 4, 53, 62, 9, { zone: 'outside', floor: 'concrete', wall: 'concrete' });
  roomDef('kitchen', 8, 40, 14, 12, { zone: 'staff', floor: 'tile', wall: 'tile' });
  roomDef('lockers', 23, 40, 8, 12, { zone: 'staff', floor: 'concrete', wall: 'concrete' });
  roomDef('storage', 8, 34, 10, 5, { zone: 'staff', floor: 'concrete', wall: 'concrete' });
  roomDef('service', 32, 19, 3, 33, { zone: 'staff', floor: 'concrete', wall: 'concrete' });
  roomDef('gala', 36, 27, 28, 23, { zone: 'public', floor: 'marble', wall: 'panel' });
  roomDef('foyer', 43, 50, 10, 2, { zone: 'public', floor: 'marble', wall: 'panel' });
  roomDef('lounge', 40, 22, 20, 4, { zone: 'public', floor: 'wood', wall: 'panel' });
  roomDef('vault_lobby', 40, 14, 20, 7, { zone: 'restricted', floor: 'carpet', wall: 'plaster' });
  roomDef('laser_hall', 46, 8, 8, 5, { zone: 'restricted', floor: 'metal', wall: 'concrete' });
  roomDef('vault', 40, 1, 20, 6, { zone: 'vault', floor: 'metal', wall: 'vault' });
  roomDef('ocorr', 65, 14, 3, 34, { zone: 'restricted', floor: 'carpet', wall: 'plaster' });
  roomDef('openplan', 69, 36, 20, 12, { zone: 'restricted', floor: 'carpet', wall: 'plaster' });
  roomDef('security', 69, 24, 9, 10, { zone: 'restricted', floor: 'tile', wall: 'plaster' });
  roomDef('server', 79, 24, 10, 10, { zone: 'restricted', floor: 'metal', wall: 'concrete' });
  roomDef('exec', 69, 9, 19, 12, { zone: 'restricted', floor: 'wood', wall: 'panel' });
  roomDef('roof', 62, 1, 32, 7, { zone: 'outside', floor: 'concrete', wall: 'concrete' });
  roomDef('lobby_link', 33, 18, 6, 1, { zone: 'restricted', floor: 'carpet', wall: 'plaster' });   // service corridor -> vault lobby (west route)
  const room = n => M.byName[n];

  // ================================================================================================ doors
  const D = (x, y, o, opts = {}) => M.door(x, y, o, opts);
  D(14, 52, 'h', { lock: 'lockpick', model: 'door', tag: 'kitchen' });             // service entrance
  D(26, 52, 'h', { lock: 'lockpick', model: 'door', tag: 'lockers' });
  D(22, 45, 'v', {});                                                              // kitchen <-> lockers
  D(12, 39, 'h', {});                                                              // kitchen <-> storage
  D(31, 45, 'v', {});                                                              // lockers <-> service corridor
  D(35, 44, 'v', { model: 'security' });                                           // service <-> gala (staff door)
  D(35, 32, 'v', {});                                                              // service <-> gala north
  D(47, 52, 'h', { glass: true, model: 'glass' });                                 // front entrance
  D(49, 26, 'h', { glass: true, model: 'glass' });                                 // gala <-> lounge
  D(50, 21, 'h', { lock: 'keycard', model: 'security', tag: 'lobby', group: 'vaultwing' });  // lounge -> vault lobby
  D(39, 18, 'v', { lock: 'keycard', model: 'security', tag: 'lobby2', group: 'vaultwing' }); // service corridor -> vault lobby (west route)
  D(50, 13, 'h', { model: 'security' });                                           // lobby -> laser hall
  D(64, 40, 'v', { model: 'security' });                                           // gala -> office corridor
  D(68, 41, 'v', {});                                                              // ocorr -> open plan
  D(68, 28, 'v', { lock: 'keycard', model: 'security', tag: 'security' });         // ocorr -> security office
  D(78, 28, 'v', {});                                                              // security <-> server
  D(68, 15, 'v', { lock: 'hack', model: 'security', tag: 'exec' });                // ocorr -> exec
  D(74, 8, 'h', { lock: 'hack', model: 'security', tag: 'roof' });                 // exec -> roof
  // vault door: 3 cells
  const vaultCells = [49, 50, 51].map(x => D(x, 7, 'h', { lock: 'vault', model: 'vault', tag: 'vault' }));
  vaultCells.forEach(d => { d.vault = true; d.glass = false; });

  // ================================================================================================ dressing helpers
  const info = n => Env.modelInfo(n);
  const propBlocks = [];       // {x0,y0,x1,y1}
  const L0 = M.L;
  const nearDoor = (cx, cy, r = 1.6) => L0.doors.some(d => Math.hypot(d.x - cx, d.y - cy) < r);
  const freeCell = (cx, cy) => L0.inb(cx, cy) && L0.carved[L0.idx(cx, cy)] && !L0.block[L0.idx(cx, cy)] && !L0.doorAt.has(L0.idx(cx, cy)) && !nearDoor(cx, cy);
  // place a prop by top-left cell after rotation; returns the prop or null when blocked
  function put(name, cx, cy, rot = 0, o = {}) {
    const inf = info(name); const cell = o.cell || (inf ? inf.cell : [1, 1]);
    const odd = Math.abs(Math.round(rot / (Math.PI / 2))) % 2 === 1;
    const cw = odd ? cell[1] : cell[0], cd = odd ? cell[0] : cell[1];
    if (!o.force) for (let y = cy; y < cy + cd; y++) for (let x = cx; x < cx + cw; x++) if (!freeCell(x, y)) return null;
    const h = o.h ?? (inf ? inf.height : 1);
    const p = M.prop(name, cx + cw / 2, cy + cd / 2, { rot, w: cw, d: cd, h, block: o.block !== false, opaque: !!o.opaque || (h > 1.5 && o.block !== false && o.tall !== false), tags: o.tags || [], y0: o.y0 || 0, data: o.data || null });
    return p;
  }
  // wall mounted decoration (no blocking): side = direction the item faces
  function wallMount(name, x, y, facing, y0 = 0.0, o = {}) {
    const rot = { S: 0, E: Math.PI / 2, N: Math.PI, W: -Math.PI / 2 }[facing];
    return M.prop(name, x, y, { rot, w: 1, d: 0.2, h: 1, block: false, y0, wall: true, tags: o.tags || [], data: o.data || null });
  }
  const cellsOf = r => r.cells;
  const inRoomFree = (r, filter = () => true) => r.cells.filter(c => freeCell(c.x, c.y) && filter(c));

  // ---- light helpers: room-relative lamps
  const lights = [];
  const lamp = (x, y, color, intensity, range, o = {}) => lights.push({ x, y, z: o.z ?? 3, color, intensity, range, ...o });
  function lampGrid(r, sx, sy, color, intensity, range, o = {}) {
    for (let y = r.y + sy / 2; y < r.y + r.h; y += sy) for (let x = r.x + sx / 2; x < r.x + r.w; x += sx) {
      const cx = Math.floor(x), cy = Math.floor(y);
      if (L0.inb(cx, cy) && L0.room[L0.idx(cx, cy)] === r.id) lamp(x, y, color, intensity, range, { wing: o.wing, breakable: o.breakable !== false, ...o });
    }
  }

  // ================================================================================================ ALLEY
  {
    const r = room('alley');
    // dumpsters (hiding spots), crates, barrels, street lamps, van
    put('crate_stack', 6, 55, 0); put('crate_stack', 7, 57, 0); put('pallet_boxes', 12, 55, 0); put('barrel_steel', 26, 55, 0); put('barrel_steel', 27, 55, 0);
    put('roof_ac_unit', 38, 58, 0); put('trash_can', 40, 54, 0); put('boxes_small', 30, 59, 0);
    put('fence_chainlink', 4, 60, 0, { force: true, h: 2 });
    for (const x of [8, 28, 46]) lamp(x, 55.5, [1.0, 0.72, 0.4], 0.9, 9, { z: 4.2, wing: 'alley', breakable: true, streetlamp: true });
    lamp(20, 58, [0.42, 0.52, 0.85], 0.42, 20, { z: 8, noShadow: false, wing: 'alley', moon: true }); lamp(50, 58, [0.42, 0.52, 0.85], 0.42, 20, { z: 8, wing: 'alley', moon: true });
    lamp(36, 57, [0.42, 0.52, 0.85], 0.30, 22, { z: 8, wing: 'alley', moon: true });
    // getaway van (extraction #1) parked at the east end
    M.prop('car_sedan', 58, 58, { rot: Math.PI / 2, w: 5, d: 3, h: 1.4, block: true, tags: ['interactive'], data: { color: 0x111114 } });
    // street lamp models
    for (const x of [8, 28, 46]) M.prop('street_lamp', x, 54.5, { w: 1, d: 1, h: 4.5, block: false });
  }

  // ================================================================================================ KITCHEN
  {
    const r = room('kitchen');
    // counters along the north wall, stoves, central prep island, fridges west
    for (let x = 9; x < 19; x += 1) if (x !== 12) put(x % 3 === 0 ? 'stove_range' : 'counter_kitchen', x, 41, 0);
    put('sink_kitchen', 19, 41, 0); put('fridge_large', 8, 44, 0); put('fridge_large', 8, 46, 0); put('shelving_industrial', 8, 49, 0);
    for (const x of [11, 13, 15]) put('counter_kitchen', x, 45, 0);     // prep island
    put('cart_catering', 18, 48, 0); put('cart_catering', 17, 49, 0);
    put('trash_can', 20, 50, 0); put('barrel_steel', 20, 42, 0);
    lampGrid(r, 5, 5, [0.92, 0.97, 1.0], 0.8, 7, { wing: 'service', breakable: true });
    wallMount('fire_extinguisher', 21.0, 47.5, 'W', 1.1);
  }
  {
    const r = room('storage');
    put('shelving_industrial', 9, 34, 0); put('shelving_industrial', 12, 34, 0); put('boxes_small', 15, 34, 0); put('crate_stack', 16, 36, 0); put('pallet_boxes', 9, 37, 0);
    lampGrid(r, 5, 4, [0.85, 0.9, 1.0], 0.8, 6, { wing: 'service' });
  }

  // ================================================================================================ LOCKER ROOM
  const lockerObjs = [];
  {
    const r = room('lockers');
    // lockers along the east wall (x=29) and west benches
    const contents = ['waiter', 'chef', 'staff', null, null, null, 'waiter', null];
    rng.shuffle && 0;
    let i = 0;
    for (let y = 41; y <= 50; y += 2) {
      const p = put('locker_tall', 29, y, -Math.PI / 2, { tags: ['interactive'] });
      if (p) { p.data = { locker: true, contains: contents[i % contents.length] }; lockerObjs.push(p); }
      i++;
    }
    for (let x = 24; x <= 28; x += 2) { const p = put('locker_tall', x, 41, 0, { tags: ['interactive'] }); if (p) { p.data = { locker: true, contains: null }; lockerObjs.push(p); } }
    put('crate_stack', 24, 49, 0); put('trash_can', 24, 46, 0); put('boxes_small', 26, 50, 0);
    lampGrid(r, 5, 5, [0.85, 0.9, 1.0], 0.85, 6, { wing: 'service' });
  }

  // ================================================================================================ SERVICE CORRIDOR
  {
    const r = room('service'); lampGrid(r, 1, 7, [0.8, 0.88, 1.0], 0.7, 6.5, { wing: 'service' });
    put('trash_can', 32, 30, 0); put('cart_catering', 33, 36, 0); put('boxes_small', 34, 26, 0); put('mop_bucket', 32, 47, 0);
    for (const y of [24, 40]) wallMount('fire_extinguisher', 32.0, y + 0.5, 'E', 1.1);
    wallMount('cctv_monitor_wall', 34.9, 34.5, 'W', 1.6);
  }

  // ================================================================================================ GALA HALL
  const galaTables = [];
  {
    const r = room('gala');
    // grand chandelier + moody lighting
    lampGrid(r, 6, 6, MOOD, 0.55, 9, { wing: 'gala', breakable: true });
    lamp(50, 38, MOOD.map(v => v * 1.0), 0.7, 12, { z: 3.4, wing: 'gala', breakable: true });
    // bar along the north wall
    for (let x = 40; x <= 47; x++) put(x === 47 ? 'bar_corner' : 'bar_counter', x, 30, 0, { force: true });
    for (let x = 40; x <= 46; x += 2) put('bar_stool', x, 32, 0);
    for (let x = 40; x <= 46; x++) put('bar_backshelf', x, 28, 0, { force: true, tags: [] });
    lamp(43, 30, [1.0, 0.7, 0.4], 0.7, 6, { z: 2.4, wing: 'gala', breakable: true });
    // stage + piano east
    put('stage_platform', 57, 29, 0, { h: 0.3 }); put('stage_platform', 58, 29, 0, { h: 0.3 }); put('stage_platform', 59, 29, 0, { h: 0.3 }); put('piano_grand', 56, 30, 0);
    put('speaker_tall', 61, 29, 0); put('speaker_tall', 61, 33, 0);
    lamp(58, 31, [1.0, 0.85, 0.55], 0.6, 8, { z: 3.4, wing: 'gala' });
    // dining tables (rows), some with chairs
    const spots = [[40, 35], [44, 38], [48, 41], [52, 38], [56, 41], [40, 41], [44, 45], [52, 45], [56, 36], [59, 41], [58, 45], [38, 46]];
    for (const [x, y] of spots) { const p = put('table_round', x, y, 0); if (p) { galaTables.push({ x: p.x, y: p.y }); lamp(p.x, p.y, [1.0, 0.9, 0.7], 0.3, 4.5, { z: 1.6, wing: 'gala', breakable: false }); } }
    // fountain + statues + plants + sofas
    put('fountain', 49, 33, 0); put('statue_bust', 37, 37, 0); put('statue_bust', 62, 47, 0);
    put('plant_large', 37, 28, 0); put('plant_large', 62, 28, 0); put('plant_large', 37, 48, 0); put('plant_large', 62, 40, 0);
    put('sofa_2', 37, 42, 0); put('sofa_2', 61, 44, Math.PI / 2, { }); put('armchair', 54, 32, 0); put('armchair', 55, 34, 0); put('coffee_table', 54, 33, 0);
    put('champagne_cart', 46, 44, 0);
    // paintings on the north wall of the lounge side + neon
    for (const x of [53.5, 58.5]) wallMount('painting_wall', x, 27.0, 'S', 1.4);
    wallMount('neon_sign', 42, 27.0, 'S', 2.4);
    M.L.lightsAccent = true;
    // dance floor rug
    M.prop('rug_round', 49.5, 41.5, { w: 3, d: 3, h: 0.02, block: false });
  }
  {
    const r = room('foyer'); lampGrid(r, 5, 2, MOOD, 0.6, 6, { wing: 'gala' });
    put('plant_small', 43, 50, 0); put('plant_small', 52, 50, 0); put('statue_bust', 44, 51, 0, { force: true });
    lamp(48, 55.5, [1.0, 0.8, 0.5], 0.6, 6, { z: 3, wing: 'alley', breakable: false });
  }
  {
    const r = room('lounge'); lampGrid(r, 5, 4, MOOD.map(v => v * 0.9), 0.6, 8, { wing: 'gala' });
    put('sofa_2', 41, 23, 0); put('sofa_2', 57, 23, 0); put('coffee_table', 44, 23, 0); put('plant_large', 40, 22, 0, { force: true }); put('plant_large', 58, 22, 0, { force: true });
    for (const x of [46.5, 53.5]) wallMount('painting_wall', x, 22.0, 'S', 1.4);
  }

  // ================================================================================================ VAULT WING
  {
    const r = room('vault_lobby');
    lampGrid(r, 6, 5, [0.75, 0.86, 1.0], 0.7, 8, { wing: 'vault', breakable: true });
    // reception desk + guards' seating + cameras cover the lobby
    put('desk_office', 47, 17, 0); put('office_chair', 48, 18, 0); put('plant_large', 40, 14, 0, { force: true }); put('plant_large', 58, 14, 0, { force: true });
    put('sofa_2', 42, 19, 0); put('coffee_table', 45, 19, 0); put('sofa_2', 54, 19, 0); put('filing_cabinet', 56, 16, 0, { }); put('water_cooler', 41, 17, 0);
    wallMount('keypad_wall', 50.0 - 1.5, 21.0, 'N', 1.2);
    put('statue_bust', 43, 15, 0);
    room('lobby_link'); lampGrid(room('lobby_link'), 3, 1, [0.75, 0.86, 1.0], 0.6, 5, { wing: 'vault' });
  }
  {
    const r = room('laser_hall');
    lamp(50, 10, [0.45, 0.7, 1.0], 0.9, 7, { z: 3, wing: 'vault', breakable: true, emergency: false }); lamp(48, 12, [1.0, 0.25, 0.25], 0.25, 6, { z: 2.5, wing: 'vault', emergency: true, alarm: true, breakable: false }); lamp(52, 9, [1.0, 0.25, 0.25], 0.22, 6, { z: 2.5, wing: 'vault', emergency: true, alarm: true, breakable: false });
  }
  const vaultLoot = [];
  {
    const r = room('vault');
    lamp(44, 4, [0.9, 0.95, 1.0], 0.9, 9, { z: 3, wing: 'vault', breakable: true }); lamp(56, 4, [0.9, 0.95, 1.0], 0.9, 9, { z: 3, wing: 'vault', breakable: true }); lamp(50, 3, [1.0, 0.85, 0.5], 0.7, 8, { z: 3, wing: 'vault', breakable: true });
    lamp(43, 5, [1.0, 0.25, 0.25], 0.2, 6, { z: 2.5, wing: 'vault', emergency: true, alarm: true, breakable: false });
    put('safe_deposit_wall', 41, 1, 0, { force: true }); put('safe_deposit_wall', 43, 1, 0, { force: true }); put('safe_deposit_wall', 55, 1, 0, { force: true }); put('safe_deposit_wall', 57, 1, 0, { force: true });
    // loot
    vaultLoot.push(['cash_pallet', 46, 3, 1], ['cash_pallet', 48, 4, 1], ['cash_pallet', 52, 4, 1], ['cash_pallet', 54, 3, 1], ['gold_bar_stack', 46, 5, 1], ['gold_bar_stack', 54, 5, 1], ['briefcase', 44, 6, 1], ['loot_bag', 56, 6, 1]);
  }

  // ================================================================================================ OFFICE WING
  {
    const r = room('ocorr'); lampGrid(r, 1, 6, [0.85, 0.92, 1.0], 0.75, 6.5, { wing: 'office' });
    put('plant_large', 65, 20, 0); put('plant_large', 65, 44, 0, { }); put('water_cooler', 67, 34, 0); put('vending_machine', 67, 30, 0);
    wallMount('painting_wall', 65.0, 26.5, 'E', 1.4, {});
  }
  {
    const r = room('openplan'); lampGrid(r, 5, 5, [0.82, 0.9, 1.0], 0.85, 7, { wing: 'office', breakable: true });
    // desk rows with chairs, cubicle walls, copier
    for (const y of [38, 42, 45]) for (const x of [70, 74, 78, 82, 86]) { if (x === 86 && y === 45) continue; const p = put('desk_office', x, y, 0); if (p) { put('office_chair', x + 1, y + 1, 0); } }
    put('copier', 88, 37, 0); put('water_cooler', 69, 36, 0); put('filing_cabinet', 88, 41, 0); put('plant_large', 88, 47, 0, { });
    put('meeting_table', 78, 36, 0, { });
  }
  {
    const r = room('security'); lampGrid(r, 4, 4, [0.7, 0.9, 1.0], 0.75, 6, { wing: 'office' });
    put('security_desk', 71, 25, 0); put('office_chair', 72, 27, 0); put('office_chair', 74, 27, 0);
    put('filing_cabinet', 75, 32, 0); put('bookshelf', 71, 32, 0); put('water_cooler', 76, 25, 0);
    wallMount('cctv_monitor_wall', 70.5, 33.0, 'N', 1.4);
    lamp(72, 26, [0.4, 0.9, 1.0], 0.5, 5, { z: 1.3, wing: 'office', breakable: false });
  }
  {
    const r = room('server'); lampGrid(r, 5, 5, [0.5, 0.8, 1.0], 0.55, 6.5, { wing: 'office', breakable: true });
    for (let y of [25, 28, 31]) for (const x of [81, 84, 87]) put('server_rack', x, y, 0);
    lamp(85, 27, [0.2, 1.0, 0.5], 0.3, 5, { z: 1.2, wing: 'office', emergency: true, alarm: true, breakable: false });
  }
  {
    const r = room('exec'); lampGrid(r, 6, 5, [1.0, 0.82, 0.55], 0.85, 8, { wing: 'office', breakable: true });
    put('desk_office', 77, 12, 0); put('office_chair', 78, 14, Math.PI); put('sofa_2', 71, 18, 0); put('coffee_table', 74, 18, 0); put('armchair', 76, 18, 0);
    put('bookshelf', 83, 10, 0); put('bookshelf', 85, 10, 0); put('plant_large', 70, 10, 0, { force: true }); put('statue_bust', 86, 19, 0);
    put('meeting_table', 80, 16, 0);
    for (const x of [72.5, 80.5]) wallMount('painting_wall', x, 9.0, 'S', 1.4);
    lamp(79, 12, [1.0, 0.75, 0.4], 0.5, 5, { z: 1.4, wing: 'office', breakable: false });
  }
  {
    const r = room('roof');
    lamp(70, 5, [0.42, 0.52, 0.85], 0.45, 22, { z: 9, wing: 'roof', moon: true }); lamp(84, 4, [0.42, 0.52, 0.85], 0.45, 22, { z: 9, wing: 'roof', moon: true });
    lamp(84, 4, [0.3, 1.0, 0.5], 0.35, 8, { z: 1.5, wing: 'roof', breakable: false });
    put('roof_ac_unit', 64, 2, 0); put('roof_ac_unit', 68, 6, 0); put('antenna_mast', 91, 2, 0); put('water_tank', 89, 4, 0);
    M.prop('helipad', 84.5, 3.5, { w: 5, d: 5, h: 0.08, block: false });
  }

  // ================================================================================================ FINISH LEVEL
  const L = M.finish(); L.seed = seed;
  L.floorStyles = L.floorStyles; L.contract = contract;
  game.setLevel(L);
  for (const l of lights) game.addLight(l);
  L.lights = game.field.lights;
  game.level.spawn = { x: 10.5, y: 59.5 };
  // the vault door cells: open together
  L.vaultCells = vaultCells;

  // ---- vent network (separate grid)
  const ventPlan = {
    cells: [], grates: [],
  };
  const seg = (x0, y0, x1, y1) => { const dx = Math.sign(x1 - x0), dy = Math.sign(y1 - y0); let x = x0, y = y0; ventPlan.cells.push([x, y]); while (x !== x1 || y !== y1) { x += dx; y += dy; ventPlan.cells.push([x, y]); } };
  seg(20, 52, 20, 44); seg(20, 44, 33, 44); seg(33, 44, 33, 19);       // alley grate -> kitchen -> lockers -> service corridor north
  seg(9, 35, 9, 44); seg(9, 44, 20, 44);                               // storage grate joins the trunk
  seg(33, 35, 37, 35);                                                  // branch east into the gala
  seg(33, 19, 45, 19);                                                  // west of the vault lobby
  seg(45, 19, 45, 3);                                                   // beside the laser hall into the vault
  seg(45, 19, 66, 19); seg(66, 19, 66, 14); seg(66, 14, 72, 14);        // east into the office wing and exec suite
  ventPlan.grates = [
    { id: 'A1', x: 20, y: 52, wall: true, exitAt: { x: 20.5, y: 53.6 }, facing: 'S' },
    { id: 'S1', x: 9, y: 35, floor: true, exitAt: { x: 9.5, y: 35.5 } },
    { id: 'G1', x: 37, y: 35, floor: true, exitAt: { x: 37.5, y: 35.5 } },
    { id: 'L1', x: 45, y: 19, floor: true, exitAt: { x: 45.5, y: 19.5 } },
    { id: 'V1', x: 45, y: 3, floor: true, exitAt: { x: 45.5, y: 3.5 } },
    { id: 'O1', x: 66, y: 19, floor: true, exitAt: { x: 66.5, y: 19.5 } },
    { id: 'E1', x: 72, y: 14, floor: true, exitAt: { x: 72.5, y: 14.5 } },
  ];
  game.vent = makeVent(W, H, ventPlan);
  game.ventPlan = ventPlan;

  game.finalizeLevel();
  game.R.buildVentVisuals && game.R.buildVentVisuals(game.vent);

  // ================================================================================================ locks + door devices
  for (const d of L.doors) {
    if (d.lock === 'lockpick') registerDoorLock(game, d, { label: d.tag === 'kitchen' ? 'Service entrance' : 'Staff door', difficulty: d.tag === 'kitchen' ? 1 : 2 });
    else if (d.lock === 'keycard') registerDoorLock(game, d, { label: d.tag === 'security' ? 'Security office' : 'Vault wing' });
    else if (d.lock === 'hack') registerDoorLock(game, d, { label: d.tag === 'roof' ? 'Roof access' : 'Executive suite', difficulty: 2 });
  }

  // ---- vent grate devices
  const grateObjs = {};
  for (const g of ventPlan.grates) {
    const v = new VentGrate(game, { x: g.wall ? g.x + 0.5 : g.x + 0.5, y: g.wall ? g.y + 1.0 : g.y + 0.5, rot: 0, wall: !!g.wall, y0: g.wall ? 0.35 : 0, id: g.id });
    v.ventCell = { x: g.x, y: g.y }; v.exitAt = g.exitAt; grateObjs[g.id] = v;
  }
  game.ventGrates = grateObjs;

  // ---- lockers: attach interactive behaviour to the props flagged as lockers
  for (const p of lockerObjs) {
    if (!p.data || !p.data.locker) continue;
    const c = p.data.contains;
    const contains = c ? { disguise: c, label: { waiter: 'waiter uniform', chef: 'chef whites', staff: 'maintenance overalls', guard: 'security uniform' }[c] } : null;
    new Locker(game, { x: p.x, y: p.y, rot: p.rot, model: 'locker_tall', contains });
  }
  // dumpsters as body/player hiding places
  for (const [x, y] of [[9, 57], [45, 55]]) {
    M.L.props.push({ id: 9000 + x, name: 'dumpster', x, y, rot: 0, w: 2, d: 1, h: 1.3, tags: [], y0: 0 });
    for (const dx of [-1, 0]) { const i = L.idx(Math.floor(x + dx + 0.5 - 0.5), Math.floor(y)); }
  }
  // dumpsters are placed after finalize (individual objects): reserve their cells
  const dumps = [];
  for (const [cx, cy] of [[9, 57], [46, 57]]) {
    for (let dx = 0; dx < 2; dx++) L.block[L.idx(cx + dx, cy)] = 1;
    dumps.push(new Locker(game, { x: cx + 1.0, y: cy + 0.5, rot: 0, model: 'dumpster', kind: 'dumpster', doorPart: 'lid', doorAngle: -1.2 }));
  }

  // ================================================================================================ cameras
  const camCfg = [
    { x: 38.5, y: 27.5, face: 0.6, amp: 0.7, range: 14, group: 'gala' },       // gala west
    { x: 62.5, y: 27.5, face: -0.6, amp: 0.7, range: 14, group: 'gala' },      // gala east
    { x: 44.5, y: 21.6, face: 0.0, amp: 0.85, range: 12, group: 'vault' },     // vault lobby
    { x: 55.5, y: 14.6, face: 0.0, amp: 0.85, range: 12, group: 'vault' },
    { x: 49.5, y: 8.6, face: 0.0, amp: 0.55, range: 10, group: 'vault', fov: 0.7 },   // laser hall
    { x: 41.5, y: 1.6, face: 0.3, amp: 0.9, range: 12, group: 'vault' },       // vault interior
    { x: 58.5, y: 1.6, face: -0.3, amp: 0.9, range: 12, group: 'vault' },
    { x: 66.5, y: 16.6, face: 0.0, amp: 0.4, range: 14, group: 'office', fov: 0.6 },   // office corridor
    { x: 66.5, y: 46.6, face: Math.PI, amp: 0.4, range: 14, group: 'office', fov: 0.6 },
    { x: 79.5, y: 36.6, face: 0.0, amp: 1.0, range: 13, group: 'office' },     // open plan
    { x: 83.5, y: 24.6, face: 0.0, amp: 0.9, range: 12, group: 'office' },     // server room
    { x: 75.5, y: 9.6, face: 0.0, amp: 0.9, range: 12, group: 'office' },      // exec
  ];
  for (const c of camCfg) new SecurityCamera(game, { ...c, phase: R() * 6, speed: 0.4 + R() * 0.3, mountH: 2.6 });

  // ================================================================================================ laser grids
  const patterns = ['static', 'blink', 'sweep'];
  const lh = room('laser_hall');
  const beams = [];
  // three staggered beam layers across the hall (players slide/crouch/jump according to height)
  const mk = (a, b, h, pattern, ph = 0) => beams.push({ a, b, h, pattern, phase: ph, period: 2.2 + R() * 1.4, amp: 0.55, speed: 0.6 + R() * 0.4, visible: true });
  mk([46.3, 9.5], [53.7, 9.5], 'high', pick(['static', 'blink']), 0);
  mk([46.3, 10.8], [53.7, 10.8], 'mid', pick(['static', 'blink']), 1.1);
  mk([46.3, 12.1], [53.7, 12.1], 'low', pick(['blink', 'static']), 0.6);
  mk([46.3, 8.4], [50.0, 12.6], 'high', 'sweep', 0);
  new LaserGrid(game, { beams, group: 'vault' });
  // doorway tripwire in the lobby's north entrance
  new LaserGrid(game, { beams: [{ a: [49.2, 13.5], b: [51.2, 13.5], h: 'mid', pattern: 'static', visible: false }], group: 'vault' });
  // server room
  new LaserGrid(game, { beams: [{ a: [79.6, 25.5], b: [79.6, 32.5], h: 'high', pattern: pick(['static', 'blink']), phase: 0.3, period: 2.6, visible: true }], group: 'office' });

  // ================================================================================================ terminals, breakers, safes, laptops
  const halfCode = contract.vaultCode;
  const intelCode = { key: 'code', label: 'Vault code', value: contract.vaultCode };
  const intelSafe = { key: 'safe', label: 'Safe combination', value: contract.safeCode };
  const secTerm = new Terminal(game, { x: 75.5, y: 26.5, rot: 0, type: 'security', label: 'Camera control', difficulty: 2, group: null, y0: 0.0, scale: 1 });
  new Terminal(game, { x: 76.6, y: 30.5, rot: -Math.PI / 2, type: 'alarm', label: 'Lockdown override', difficulty: 2 });
  const srvTerm = new Terminal(game, { x: 86.5, y: 32.0, rot: Math.PI, type: 'lasers', label: 'Laser grid controller', difficulty: 3, group: 'vault' });
  if (contract.codeSource === 'laptop') new Terminal(game, { x: 77.6, y: 12.6, rot: 0, type: 'intel', label: "Director's laptop", difficulty: 2, model: 'laptop', scale: 1.8, y0: 0.72, intel: intelCode });
  else new Terminal(game, { x: 77.6, y: 12.6, rot: 0, type: 'intel', label: "Director's laptop (safe combination)", difficulty: 2, model: 'laptop', scale: 1.8, y0: 0.72, intel: intelSafe });
  // executive safe: USB drive + (if the code source is the safe) the vault code memo
  const safe = new Safe(game, { x: 86.2, y: 15.5, rot: -Math.PI / 2, code: contract.safeCode, label: 'Executive safe', contains: contract.codeSource === 'laptop' ? { type: 'item', key: 'usb', label: 'Ledger USB drive acquired' } : { type: 'intel', intel: intelCode } });
  // breakers
  new Breaker(game, { x: 34.9, y: 28.5, rot: -Math.PI / 2, wing: 'gala' });
  new Breaker(game, { x: 68.0, y: 45.5, rot: Math.PI / 2, wing: 'office', });
  new Breaker(game, { x: 41.0, y: 20.0, rot: Math.PI, wing: 'vault' });
  // breakers face the room: fix to sensible wall faces
  // loot
  for (const [m, x, y, w] of vaultLoot) new Loot(game, { x, y, model: m, value: m === 'cash_pallet' ? 80000 : m === 'gold_bar_stack' ? 60000 : 30000, label: m === 'cash_pallet' ? 'cash pallet' : m === 'gold_bar_stack' ? 'gold bars' : m === 'briefcase' ? 'briefcase of bonds' : 'bag of cash', weight: m === 'cash_pallet' ? 2 : 1, scale: m === 'briefcase' || m === 'loot_bag' ? 1.6 : 1 });

  // ================================================================================================ vault door + extraction
  const vaultCtl = { open: false };
  const vaultModel = placeModel(game, 'vault_door', 50.0, 7.6, { rot: 0 });
  const slab = findPart(vaultModel, 'slab'), wheel = findPart(vaultModel, 'wheel');
  const vaultIt = {
    x: 50.0, y: 8.5, r: 2.4,
    get(p) {
      if (vaultCtl.open) return null;
      if (!p.inv.keycard) return { label: 'Vault door: keycard required', enabled: false, reason: 'Find the vault keycard first', pri: 4 };
      return { label: 'Open the vault (keycard + code)', pri: 8 };
    },
    run(p) {
      p.startBusy('Entering code', 1e9, null, { illegal: 'working the vault' });
      game.ui.minigame('keypad', { title: 'Vault door', code: contract.vaultCode, hint: p.inv.intel.code ? `Known code: ${p.inv.intel.code}` : 'You need the 4-digit code', attempts: 3 }).then(ok => {
        p.cancelBusy();
        if (!ok) { game.noise(50, 9, 10, 'alarm', p); game.toast('Wrong code', 'warn'); return; }
        p.startBusy('Vault opening', 5.5, () => { vaultCtl.open = true; vaultCells.forEach(d => { d.unlocked = true; d.forced = true; }); game.toast('The vault is open', 'good'); game.onItem && game.onItem('vault'); L.invalidateNav(); }, { illegal: 'cracking the vault', noise: 7 });
        game.audio && game.audio.vault && game.audio.vault();
      });
    },
  };
  game.addInteractable(vaultIt);
  game.devices.push({ update(dt) { if (slab) slab.rotation.y += ((vaultCtl.open ? -1.75 : 0) - slab.rotation.y) * Math.min(1, dt * 1.6); if (wheel && (vaultCtl.open || p_busy())) wheel.rotation.z += dt * (vaultCtl.open ? 0 : 4); } });
  const p_busy = () => game.player && game.player.busy && game.player.busy.label === 'Vault opening';

  // ---- ladder to the roof + extraction points
  const roofSpot = { x: 84.5, y: 3.5 };
  const ladder = { x: 32.5, y: 54.0, r: 1.5, get: (p) => ({ label: 'Climb the fire escape to the roof', hold: 1.2, pri: 6 }), run: (p) => { p.startBusy('Climbing', 2.2, () => { p.x = 66; p.y = 3.5; p.vx = p.vy = 0; game.toast('You reach the rooftop', 'info'); game.R.cam.shake = 0.1; }, { anim: 'ClimbUp_1m', illegal: 'climbing the wall' }); } };
  // the fire escape ladder model on the alley wall
  M.L.props.push({ id: 9100, name: 'fire_escape_ladder', x: 32.5, y: 53.0, rot: 0, w: 1, d: 0.3, h: 3, tags: [], y0: 0.0, wall: true });
  placeModel(game, 'fire_escape_ladder', 32.5, 53.05, { rot: 0 });
  game.addInteractable(ladder);
  const roofLadder = { x: 65.2, y: 3.5, r: 1.5, get: () => ({ label: 'Climb down to the alley', hold: 1.2, pri: 6 }), run: (p) => { p.startBusy('Climbing', 2.0, () => { p.x = 32.5; p.y = 55.2; p.vx = p.vy = 0; }, { anim: 'ClimbUp_1m', illegal: 'climbing' }); } };
  game.addInteractable(roofLadder);
  const extract = (x, y, label) => ({ x, y, r: 2.6, get(p) { return game.mission.canEscape() ? { label, hold: 1.2, pri: 9 } : { label: 'Extraction (finish the job first)', enabled: false, reason: 'Take the money before you leave', pri: 2 }; }, run(p) { game.completeMission(); } });
  game.addInteractable(extract(58, 58.6 - 1.3, 'Escape in the getaway car'));
  game.addInteractable(extract(roofSpot.x, roofSpot.y, 'Signal the helicopter and escape'));

  // ================================================================================================ ACTORS
  const skins = ['light', 'dark'];
  const hairM = ['buzzed', 'simpleparted'], hairF = ['long', 'buns', 'buzzedfemale'], hairCols = ['black', 'brown', 'auburn', 'blonde', 'grey'];
  const person = (gender, outfit) => ({ gender, skin: pick(skins), hair: pick(gender === 'male' ? hairM : hairF), hairColor: pick(hairCols), outfit, width: 0.9 + R() * 0.08, scale: 0.97 + R() * 0.07 });

  // ---- the hero
  const hero = new Player(game, { gender: 'male', skin: 'light', hair: 'buzzed', hairColor: 'black', outfit: 'thief', width: 0.94 }, L.spawn.x, L.spawn.y, -Math.PI / 2 * 0);
  await hero.init(); game.player = hero; game.register(hero); game.applyPlayerRim();
  hero.face = 0; game.R.cam.target.set(hero.x, 0.9, hero.y);

  const promises = [];
  const addGuard = (x, y, route, o = {}) => {
    const g = new Guard(game, { ...person('male', o.outfit || 'guard'), ...(o.spec || {}) }, x, y, { route, ...o });
    game.guards.push(g); game.register(g); contract.guardCount++; promises.push(g.init()); return g;
  };
  const addNpc = (spec, x, y, o = {}) => { const n = new Npc(game, spec, x, y, o); game.npcs.push(n); game.register(n); promises.push(n.init()); return n; };
  const jit = (a, b) => a + R() * (b - a);
  const wp = (x, y, wait, face, pose) => ({ x, y, wait, face, pose });

  // gala guards
  const concierge = addGuard(47.5, 50.5, [], { post: wp(47.5, 50.5, 1e9, 0, 'arms'), name: 'Concierge' });
  addGuard(40, 36, [wp(40, 36, 2, 0.5, 'idle'), wp(40, 46, 3, Math.PI, 'arms'), wp(58, 46, 2, 0), wp(58, 36, 3, Math.PI, 'idle')].sort(() => R() - 0.5 > 0 ? 0 : 0), { name: 'Gala guard' });
  addGuard(61, 32, [wp(61, 32, 3, -Math.PI / 2, 'arms'), wp(50, 30, 2, Math.PI), wp(44, 40, 2, 0), wp(56, 44, 3, Math.PI)], { name: 'Gala guard' });
  // service + kitchen
  addGuard(33.5, 46, [wp(33.5, 46, 2, Math.PI, 'idle'), wp(33.5, 26, 2, 0), wp(26, 45, 2, Math.PI / 2, 'arms'), wp(33.5, 36, 3, 0)], { name: 'Service guard' });
  // office wing
  const chief = addGuard(72, 30, [wp(72, 30, 2, 0, 'arms'), wp(66.5, 30, 2, 0), wp(66.5, 42, 2, 0), wp(80, 41, 3, 0), wp(66.5, 20, 2, 0)], { name: 'Chief of Security', keycard: contract.keycardHolder === 'chief', outfit: 'guard_elite', role: 'chief' });
  addGuard(66, 44, [wp(66, 44, 3, Math.PI, 'idle'), wp(66, 24, 2, 0), wp(70, 40, 2, 0), wp(85, 40, 2, 0)], { name: 'Office guard' });
  addGuard(82, 28, [wp(82, 28, 4, 0, 'arms'), wp(86, 32, 3, 0), wp(82, 25, 2, 0)], { name: 'Server guard' });
  // vault wing
  addGuard(52, 18, [wp(52, 18, 3, Math.PI, 'arms'), wp(44, 18, 3, 0), wp(48, 16, 2, 0), wp(56, 18, 3, 0)], { name: 'Lobby guard' });
  addGuard(50, 11, [wp(50, 11, 4, 0, 'torch'), wp(48, 9, 3, Math.PI)], { name: 'Vault guard', outfit: 'guard_elite', role: 'elite' });
  // roof
  addGuard(78, 5, [wp(78, 5, 3, 0), wp(90, 5, 3, Math.PI), wp(70, 4, 2, 0)], { name: 'Roof guard' });

  // exec / director / assistant
  const directorSpec = person('male', 'exec_suit');
  const director = addNpc(directorSpec, 78, 15, { faction: 'exec', behavior: 'route', route: [wp(78, 15, 12, 0, 'phone'), wp(74, 18, 10, 0, 'idle'), wp(55, 33, 14, 0, 'talk'), wp(78, 15, 10, 0, 'idle')], keycard: contract.keycardHolder === 'director', name: 'The Director', important: true });
  const assistant = addNpc(person('female', 'exec_suit'), 75, 19, { faction: 'exec', behavior: 'wander', home: room('exec'), name: 'Executive assistant', intel: contract.codeSource === 'assistant' ? { key: 'code', label: 'Vault code', value: contract.vaultCode } : null });
  // a keycard on the security desk
  if (contract.keycardHolder === 'desk') new Pickup(game, { x: 73.0, y: 26.2, y0: 1.25, label: 'Vault keycard', key: 'keycard' });

  // gala crowd
  const nGuests = 15;
  const guestSpots = inRoomFree(room('gala'), c => c.y > 30).sort(() => R() - 0.5).slice(0, nGuests);
  guestSpots.forEach((c, i) => {
    const female = i % 2 === 0;
    addNpc(person(female ? 'female' : 'male', female ? pick(['dress', 'dress', 'dress_green']) : 'tuxedo'), c.x, c.y, { faction: 'guest', behavior: R() < 0.55 ? 'wander' : 'idle', home: room('gala'), pose: pick(['idle', 'talk', 'phone', 'arms']), face: R() * 6.28, speed: 0.85 });
  });
  // waiters with trays walk loops
  const wr = [[40, 38], [56, 38], [56, 46], [40, 46]];
  addNpc(person('female', 'waiter'), 40, 38, { faction: 'waiter', behavior: 'route', route: wr.map(p => wp(p[0], p[1], 3, 0, 'idle')), name: 'Waiter' });
  addNpc(person('male', 'waiter'), 56, 46, { faction: 'waiter', behavior: 'route', route: wr.slice().reverse().map(p => wp(p[0], p[1], 3, 0, 'idle')), name: 'Waiter' });
  addNpc(person('male', 'waiter'), 43, 31, { faction: 'waiter', behavior: 'idle', pose: 'arms', name: 'Bartender', face: Math.PI });
  // kitchen crew
  addNpc(person('male', 'chef'), 12, 43, { faction: 'chef', behavior: 'wander', home: room('kitchen'), name: 'Chef', speed: 0.8 });
  addNpc(person('female', 'chef'), 16, 47, { faction: 'chef', behavior: 'wander', home: room('kitchen'), name: 'Cook', speed: 0.8 });
  // maintenance
  addNpc(person('male', 'staff'), 67, 36, { faction: 'staff', behavior: 'wander', home: room('ocorr'), name: 'Janitor', speed: 0.8 });
  await Promise.all(promises);
  game.contract = contract; game.keyNPCs = { chief, director, assistant, concierge };

  // ================================================================================================ objectives
  const O = { keycard: null, code: null, vault: null, loot: null, escape: null };
  game.objectives = [
    { id: 'keycard', text: contract.keycardHolder === 'chief' ? 'Get the vault keycard from the Chief of Security' : contract.keycardHolder === 'director' ? "Get the vault keycard from The Director (he mingles at the gala)" : 'Find the vault keycard (security office desk)', done: false, hint: contract.keycardHolder === 'chief' ? { x: 72, y: 30 } : contract.keycardHolder === 'director' ? { x: 55, y: 33 } : { x: 73, y: 26 } },
    { id: 'code', text: contract.codeSource === 'laptop' ? "Learn the vault code from the Director's laptop (executive suite)" : "Learn the vault code: the executive assistant knows it", done: false, hint: contract.codeSource === 'laptop' ? { x: 77.6, y: 12.6 } : { x: 75, y: 19 } },
    { id: 'vault', text: 'Open the vault door', done: false, hint: { x: 50, y: 8 } },
    { id: 'loot', text: 'Grab at least $200,000', done: false, hint: { x: 50, y: 4 } },
    { id: 'escape', text: 'Escape via the getaway car or the roof helicopter', done: false, hint: { x: 58, y: 58 } },
    { id: 'usb', text: 'BONUS: steal the Ledger USB from the executive safe', optional: true, done: false, hint: { x: 86, y: 15 } },
    { id: 'ghost', text: 'BONUS: never raise an alarm', optional: true, done: false },
  ];
  game.onItem = evt => {
    const ob = id => game.objectives.find(o => o.id === id);
    if (evt === 'keycard') ob('keycard').done = true;
    if (evt === 'intel:code') ob('code').done = true;
    if (evt === 'vault') ob('vault').done = true;
    if (evt === 'item:usb') ob('usb').done = true;
    if (game.player.inv.lootValue >= 200000) ob('loot').done = true;
  };
  game.mission = { name: contract.name, contract, ended: false, canEscape: () => game.objectives.find(o => o.id === 'loot').done, seed };
  game.completeMission = () => {
    if (game.mission.ended) return; game.mission.ended = true;
    game.objectives.find(o => o.id === 'escape').done = true; game.objectives.find(o => o.id === 'ghost').done = game.stats.ghost;
    game.state = 'result'; game.ui.result(true);
  };
  game.failMission = (why) => {
    if (game.mission.ended) return; game.mission.ended = true; game.state = 'result'; game.player.state = 'down'; game.ui.result(false, why);
  };
  game.disguiseOK = (P, zone) => { const dz = { none: [], guest: ['public'], waiter: ['public', 'staff'], chef: ['public', 'staff'], staff: ['public', 'staff', 'restricted'], guard: ['public', 'staff', 'restricted'], exec: ['public', 'restricted'] }; return (dz[P.disguise] || []).includes(zone); };
  return game.mission;
}
