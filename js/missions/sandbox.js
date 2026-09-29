// Small test bed used during development: three rooms, a couple of guards, some furniture.
import { MapBuilder } from '../level.js';
import { Player } from '../player.js';
import { Guard } from '../guard.js';
import { Npc } from '../npc.js';

export async function buildSandbox(game, seed) {
  const M = new MapBuilder(56, 40);
  M.room('gala', 4, 4, 22, 16, { zone: 'public', floor: 'marble', wall: 'panel' });
  M.room('kitchen', 30, 4, 12, 10, { zone: 'staff', floor: 'tile', wall: 'tile' });
  M.room('hall', 26, 8, 4, 3, { zone: 'staff', floor: 'concrete', wall: 'concrete' });
  M.room('office', 30, 18, 14, 10, { zone: 'restricted', floor: 'carpet', wall: 'plaster' });
  M.room('alley', 4, 26, 22, 8, { zone: 'outside', floor: 'concrete', wall: 'concrete' });
  M.door(26, 9, 'v', {}); M.strip('link', 35, 14, 2, 4, { zone: 'staff', floor: 'concrete', wall: 'concrete' }); M.door(35, 14, 'h', {}); M.door(35, 17, 'h', { lock: 'keycard', model: 'security' });
  M.strip('link2', 14, 20, 2, 6, { zone: 'staff', floor: 'concrete' }); M.door(14, 20, 'h', {});
  const P = (n, x, y, o = {}) => M.prop(n, x, y, o);
  P('table_round', 9, 8, { w: 2, d: 2, h: 0.8 }); P('table_round', 15, 8, { w: 2, d: 2, h: 0.8 }); P('table_round', 21, 8, { w: 2, d: 2, h: 0.8 });
  P('sofa_2', 8, 17, { w: 2, d: 1, h: 0.9, rot: Math.PI }); P('bar_counter', 20.5, 17.5, { h: 1.1 }); P('bar_counter', 21.5, 17.5, { h: 1.1 });
  P('pillar_marble', 12.5, 13.5, { h: 3.2, opaque: true }); P('pillar_marble', 18.5, 13.5, { h: 3.2, opaque: true });
  P('counter_kitchen', 32.5, 5.5, { h: 0.9 }); P('counter_kitchen', 33.5, 5.5, { h: 0.9 }); P('stove_range', 36.5, 5.5, { h: 1 }); P('fridge_large', 40.5, 5.5, { h: 2, opaque: true });
  P('desk_office', 34, 22, { w: 2, d: 1, h: 0.75 }); P('desk_office', 38, 22, { w: 2, d: 1, h: 0.75 }); P('server_rack', 42.5, 26.5, { h: 2, opaque: true });
  P('dumpster', 8, 29, { w: 2, d: 1, h: 1.3 }); P('crate_stack', 20.5, 30.5, { h: 1 });
  const L = M.finish(); L.seed = seed;
  game.setLevel(L);
  const lamp = (x, y, c, i, r = 8, o = {}) => game.addLight({ x, y, z: 3, color: c, intensity: i, range: r, breakable: true, ...o });
  for (const [x, y] of [[9, 8], [15, 8], [21, 8], [9, 15], [17, 15]]) lamp(x, y, [1.0, 0.8, 0.52], 0.85, 8);
  lamp(36, 9, [0.9, 0.95, 1.0], 1.0, 7); lamp(37, 22, [0.75, 0.85, 1], 0.9, 7);
  lamp(10, 30, [0.5, 0.6, 1.0], 0.5, 10, { breakable: false }); lamp(20, 30, [0.5, 0.6, 1.0], 0.5, 10, { breakable: false });
  game.finalizeLevel();

  const hero = new Player(game, { gender: 'male', skin: 'light', hair: 'buzzed', hairColor: 'black', outfit: 'thief' }, 12, 30, 0);
  await hero.init(); game.player = hero; game.register(hero); game.applyPlayerRim();
  const mkGuard = async (x, y, route, o = {}) => { const g = new Guard(game, { gender: 'male', skin: o.skin || 'dark', hair: 'buzzed', hairColor: 'black', outfit: 'guard' }, x, y, { route, ...o }); await g.init(); game.guards.push(g); game.register(g); return g; };
  await mkGuard(12, 12, [{ x: 12, y: 12, wait: 2, face: 0 }, { x: 22, y: 12, wait: 2, face: Math.PI / 2 }, { x: 22, y: 6, wait: 2 }, { x: 8, y: 6, wait: 2 }]);
  await mkGuard(34, 20, [{ x: 34, y: 20, wait: 3, face: Math.PI }, { x: 42, y: 20, wait: 3 }], { keycard: true });
  const guest = new Npc(game, { gender: 'female', skin: 'light', hair: 'long', hairColor: 'blonde', outfit: 'dress' }, 12.5, 9.5, { faction: 'guest', behavior: 'wander', home: L.rooms[0] });
  await guest.init(); game.npcs.push(guest); game.register(guest);
  return { name: 'sandbox', objectives: [] };
}
