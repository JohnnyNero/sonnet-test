import { World } from './world.js';
import { loadModels } from './models.js';
import { Game } from './game.js';
import { UI } from './ui.js';
import { initAudio } from './audio.js';
import { setupTouch, isTouchDevice } from './touch.js';

const ui = new UI();
const world = new World(document.getElementById('c'));
const game = new Game(world, ui);
window.game = game; window.world = world; // handy for debugging / automated tests

let touchUI = null;
if (isTouchDevice()) { touchUI = setupTouch(game, ui, { initAudio }); ui.isTouch = true; }

const SKILL_KEYS = { '1': 'q', '2': 'w', '3': 'e', '4': 'r' };
const canvas = document.getElementById('c');

function updateMouse(ev) {
  game.mouse.x = ev.clientX; game.mouse.y = ev.clientY;
  const g = world.pickGround(ev.clientX, ev.clientY);
  if (g) { game.mouse.gx = g.x; game.mouse.gy = g.y; }
}
canvas.addEventListener('mousedown', ev => {
  initAudio(); updateMouse(ev);
  if (ev.button === 0) game.mouse.down = true;
  if (ev.button === 2) game.useSkill('q');
});
window.addEventListener('mouseup', ev => { if (ev.button === 0) game.mouse.down = false; });
canvas.addEventListener('mousemove', updateMouse);
canvas.addEventListener('contextmenu', ev => ev.preventDefault());
window.addEventListener('blur', () => { game.mouse.down = false; game.keys.clear(); });

window.addEventListener('keydown', ev => {
  const k = ev.key.toLowerCase();
  if (ev.repeat && (k === 'i' || k === 'h')) return;
  initAudio();
  if (k === 'shift') game.mouse.shift = true;
  if (game.state === 'title') return;
  if (SKILL_KEYS[k]) game.useSkill(SKILL_KEYS[k]);
  else if (k === 'i') { ui.toggleInv(game); game.paused = ui.invOpen; }
  else if (k === 'escape' && ui.invOpen) { ui.closeInv(); game.paused = false; }
  else if (k === 'h') document.getElementById('codex').classList.toggle('hidden');
  else game.keys.add(k);
  if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) ev.preventDefault();
});
window.addEventListener('keyup', ev => { const k = ev.key.toLowerCase(); game.keys.delete(k); if (k === 'shift') game.mouse.shift = false; });

document.getElementById('invClose').onclick = () => { ui.closeInv(); game.paused = false; };
ui.onStart = () => { initAudio(); ui.closeInv(); game.paused = false; game.newRun(); };

// hover detection for the target bar
function updateHover() {
  let best = null, bd = 1.1;
  if (game.enemies) for (const e of game.enemies) { if (e.dead) continue; const d = Math.hypot(game.mouse.gx - e.x, game.mouse.gy - e.y) - e.r; if (d < bd) { bd = d; best = e; } }
  game.hoverEnemy = best;
}

let last = performance.now();
function loop(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (game.state !== 'title') {
    if (ui.invOpen) updateMouse({ clientX: game.mouse.x, clientY: game.mouse.y });
    else if (game.mouse.x) { const g = world.pickGround(game.mouse.x, game.mouse.y); if (g) { game.mouse.gx = g.x; game.mouse.gy = g.y; } }
    updateHover();
    game.update(dt);
    ui.update(game, dt);
    if (touchUI) touchUI.update();
    ui.updateFloaters(world, dt);
    world.frame(dt, game.hero);
  } else {
    world.renderer.clear();
  }
  requestAnimationFrame(loop);
}

(async () => {
  try {
    await loadModels((n, t) => ui.setLoading(`Assembling the cast… ${n}/${t}`));
    ui.overlay('title');
  } catch (e) {
    ui.setLoading('Failed to load models: ' + e.message); console.error(e);
  }
  requestAnimationFrame(loop);
})();
