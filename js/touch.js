// Touch controls for phones/tablets.
import { GADGETS } from './player.js';
export const isTouchDevice = () => (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) || 'ontouchstart' in window || navigator.maxTouchPoints > 0;
const NAMES = { dart: 'DART', coin: 'COIN', emp: 'EMP' };

export function setupTouch(game, ui) {
  document.body.classList.add('touch'); ui.isTouch = true;
  const T = { mx: 0, my: 0, run: false, actionHeld: false, _crouch: false, _action: false, _fire: false, _cycle: 0, _gog: false };
  T.consumeCrouch = () => { const v = T._crouch; T._crouch = false; return v; };
  T.consumeAction = () => { const v = T._action; T._action = false; return v; };
  T.consumeFire = () => { const v = T._fire; T._fire = false; return v; };
  T.consumeCycle = () => { const v = T._cycle; T._cycle = 0; return v; };
  T.consumeGoggles = () => { const v = T._gog; T._gog = false; return v; };
  // aim assist: nearest visible person within a forward arc, else a spot ahead
  T.aimTarget = () => {
    const P = game.player; let best = null, bs = -1e9;
    for (const a of game.actors) {
      if (a === P || a.state === 'down' || !a.group || !a.group.visible) continue;
      const dx = a.x - P.x, dy = a.y - P.y, d = Math.hypot(dx, dy); if (d > 13 || d < 0.5) continue;
      const facing = (dx * Math.sin(P.face) + dy * Math.cos(P.face)) / d; if (facing < 0.35) continue;
      if (game.level.ray(P.x, P.y, a.x, a.y).hit) continue;
      const s = facing * 5 - d; if (s > bs) { bs = s; best = a; }
    }
    const g = GADGETS[P.gadget];
    if (best && g === 'dart') return { x: best.x, y: best.y };
    const d = g === 'dart' ? 10 : 7; return { x: P.x + Math.sin(P.face) * d, y: P.y + Math.cos(P.face) * d };
  };
  game.input.touch = T;

  const root = document.createElement('div'); root.id = 'touch';
  root.innerHTML = `<div id="joyZone"></div><div id="joyBase"><div id="joyKnob"></div></div>
    <div class="tb" id="tAct">ACTION</div><div class="tb" id="tCrouch"><span class="ic">▼</span>Crouch</div><div class="tb" id="tRun"><span class="ic">»</span>Run</div>
    <div class="tb" id="tFire"><span class="ic">✦</span>Fire</div><div class="tb" id="tGad">DART</div><div class="tb" id="tGog">NVG</div>
    <div class="tb" id="tRotL">⟲</div><div class="tb" id="tRotR">⟳</div><div class="tb" id="tPause">II</div>`;
  document.body.appendChild(root);
  const $ = s => root.querySelector(s);
  const zone = $('#joyZone'), base = $('#joyBase'), knob = $('#joyKnob'), R = 58;
  let joy = null, ox = 0, oy = 0;
  const setJoy = (dx, dy) => {
    const l = Math.hypot(dx, dy), k = l > R ? R / l : 1; knob.style.transform = `translate(${dx * k}px,${dy * k}px)`;
    const m = Math.min(1, l / R);
    if (m < 0.16) { T.mx = T.my = 0; } else { const s = Math.min(1, (m - 0.08) / 0.55); T.mx = dx / (l || 1) * s; T.my = dy / (l || 1) * s; }
  };
  zone.addEventListener('pointerdown', e => { if (joy !== null) return; e.preventDefault(); game.audioUnlock && game.audioUnlock(); joy = e.pointerId; zone.setPointerCapture(joy); ox = e.clientX; oy = e.clientY; base.style.left = ox + 'px'; base.style.top = oy + 'px'; base.classList.add('on'); setJoy(0, 0); });
  zone.addEventListener('pointermove', e => { if (e.pointerId === joy) { e.preventDefault(); setJoy(e.clientX - ox, e.clientY - oy); } });
  const end = e => { if (e.pointerId !== joy) return; joy = null; base.classList.remove('on'); T.mx = T.my = 0; };
  zone.addEventListener('pointerup', end); zone.addEventListener('pointercancel', end);

  const btn = (id, down, up) => { const el = $(id); el.addEventListener('pointerdown', e => { e.preventDefault(); game.audioUnlock && game.audioUnlock(); el.setPointerCapture(e.pointerId); el.classList.add('press'); down && down(); }); const u = () => { el.classList.remove('press'); up && up(); }; el.addEventListener('pointerup', u); el.addEventListener('pointercancel', u); };
  btn('#tAct', () => { T._action = true; T.actionHeld = true; }, () => { T.actionHeld = false; });
  btn('#tCrouch', () => { T._crouch = true; });
  btn('#tRun', () => { T.run = !T.run; $('#tRun').style.borderColor = T.run ? '#e7c66a' : ''; });
  btn('#tFire', () => { T._fire = true; });
  btn('#tGad', () => { T._cycle = 1; });
  btn('#tGog', () => { T._gog = true; });
  btn('#tPause', () => { game.input.pressed.add('escape'); });
  let rotL = 0, rotR = 0;
  btn('#tRotL', () => { rotL = 1; }, () => { rotL = 0; }); btn('#tRotR', () => { rotR = 1; }, () => { rotR = 0; });

  // two-finger twist + pinch on the canvas
  const pts = new Map(); let lastAng = null, lastDist = null;
  const cv = game.canvas;
  cv.addEventListener('pointerdown', e => { pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); lastAng = lastDist = null; });
  cv.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) { const [a, b] = [...pts.values()], ang = Math.atan2(b.y - a.y, b.x - a.x), dist = Math.hypot(b.x - a.x, b.y - a.y); if (lastAng !== null) { let d = ang - lastAng; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; game.R.rotateCamera(-d); game.R.zoomCamera(-(dist - lastDist) * 0.004); } lastAng = ang; lastDist = dist; }
  });
  const up = e => { pts.delete(e.pointerId); lastAng = lastDist = null; };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);

  return {
    update(dt) {
      const P = game.player;
      const active = P && game.state === 'play' && !game.paused;
      root.style.display = active ? 'block' : 'none';
      if (!active) return;
      if (rotL) game.R.rotateCamera(1.8 * dt); if (rotR) game.R.rotateCamera(-1.8 * dt);
      const pr = P.prompt; const a = $('#tAct'); a.textContent = pr && !pr.busy ? (pr.label.length > 18 ? pr.label.slice(0, 17) + '…' : pr.label) : pr && pr.busy ? 'Working…' : 'ACTION';
      a.style.opacity = pr ? 1 : 0.6;
      $('#tGad').textContent = NAMES[GADGETS[P.gadget]];
    },
  };
}
