import { Game } from './game.js';
import './interactions.js';
import { buildGhostLedger } from './missions/ghostledger.js';
import { buildSandbox } from './missions/sandbox.js';
import { UI } from './ui.js';
import { setupTouch, isTouchDevice } from './touch.js';

const canvas = document.getElementById('c');
const game = new Game(canvas);
window.game = game;
const ui = new UI(game, document.getElementById('ui'));
game.ui = ui;
let touchUI = null;
if (isTouchDevice()) touchUI = setupTouch(game, ui);
const q = new URLSearchParams(location.search);
ui.onRetry = seed => { location.href = location.pathname + '?seed=' + seed + '&go=1'; };

async function begin(seed) {
  ui.loading('Casing the joint…');
  const builder = q.get('mission') === 'sandbox' ? buildSandbox : buildGhostLedger;
  game.paused = true;
  await game.startMission(builder, seed);
  game.paused = true;
  ui.loading(null);
  if (q.get('go') || q.get('skip')) { game.paused = false; ui.hideScreen(); ui.showHud(true); }
  else ui.briefing(game, () => { game.paused = false; });
  window.__mission = true;
}

(async () => {
  ui.loading('Assembling the crew…');
  await game.load((n, t) => ui.loading(`Loading models ${n}/${t}`));
  window.__ready = true;
  let last = performance.now();
  const loop = now => { const dt = Math.min(0.1, (now - last) / 1000); last = now; game.frame(dt); touchUI && touchUI.update(dt); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  if (q.get('seed') && (q.get('go') || q.get('skip'))) begin(+q.get('seed')); else { game.seedHint = +q.get('seed') || 0 || undefined; ui.title(s => begin(s)); }
})();
