// Mobile controls: floating joystick, skill buttons with aim-assist, hold-to-attack, inventory button.
export const isTouchDevice = () =>
  (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) || 'ontouchstart' in window || navigator.maxTouchPoints > 0;

export function setupTouch(game, ui, { initAudio }) {
  document.body.classList.add('touch');
  game.touch = { active: true, mx: 0, my: 0, attack: false };
  const root = document.createElement('div');
  root.id = 'touchUI';
  root.innerHTML = `
    <div id="joyZone"></div>
    <div id="joyBase"><div id="joyKnob"></div></div>
    <div id="tSkills">
      <div class="tbtn" data-k="q"><i class="ico fire"></i><div class="cd"></div><span>1</span></div>
      <div class="tbtn" data-k="w"><i class="ico frost"></i><div class="cd"></div><span>2</span></div>
      <div class="tbtn" data-k="e"><i class="ico shock"></i><div class="cd"></div><span>3</span></div>
      <div class="tbtn" data-k="r"><i class="ico oil"></i><div class="cd"></div><span>4</span></div>
      <div class="tbtn atk" id="tAtk"><b>ATTACK</b></div>
    </div>
    <div id="tMenu"><button id="tInv">Bag</button><button id="tHelp">?</button></div>`;
  document.body.appendChild(root);

  const $ = s => root.querySelector(s);
  const zone = $('#joyZone'), base = $('#joyBase'), knob = $('#joyKnob');
  const R = 56;
  let joyId = null, ox = 0, oy = 0;

  const setJoy = (dx, dy) => {
    const l = Math.hypot(dx, dy), k = l > R ? R / l : 1;
    knob.style.transform = `translate(${dx * k}px,${dy * k}px)`;
    const mag = Math.min(1, l / R);
    if (mag < 0.18) { game.touch.mx = game.touch.my = 0; }
    else { game.touch.mx = dx / (l || 1) * Math.min(1, (mag - 0.1) / 0.6); game.touch.my = dy / (l || 1) * Math.min(1, (mag - 0.1) / 0.6); }
  };
  zone.addEventListener('pointerdown', ev => {
    if (joyId !== null) return;
    ev.preventDefault(); initAudio();
    joyId = ev.pointerId; zone.setPointerCapture(joyId);
    ox = ev.clientX; oy = ev.clientY;
    base.style.left = ox + 'px'; base.style.top = oy + 'px'; base.classList.add('on'); setJoy(0, 0);
  });
  zone.addEventListener('pointermove', ev => { if (ev.pointerId === joyId) { ev.preventDefault(); setJoy(ev.clientX - ox, ev.clientY - oy); } });
  const endJoy = ev => { if (ev.pointerId !== joyId) return; joyId = null; base.classList.remove('on'); game.touch.mx = game.touch.my = 0; };
  zone.addEventListener('pointerup', endJoy); zone.addEventListener('pointercancel', endJoy);

  root.querySelectorAll('.tbtn[data-k]').forEach(b => {
    b.addEventListener('pointerdown', ev => { ev.preventDefault(); initAudio(); b.classList.add('press'); game.useSkill(b.dataset.k); });
    const up = () => b.classList.remove('press');
    b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('pointerleave', up);
  });
  const atk = $('#tAtk');
  atk.addEventListener('pointerdown', ev => { ev.preventDefault(); initAudio(); atk.setPointerCapture(ev.pointerId); game.touch.attack = true; atk.classList.add('press'); });
  const atkUp = () => { game.touch.attack = false; atk.classList.remove('press'); };
  atk.addEventListener('pointerup', atkUp); atk.addEventListener('pointercancel', atkUp);

  $('#tInv').addEventListener('click', () => { ui.toggleInv(game); game.paused = ui.invOpen; });
  $('#tHelp').addEventListener('click', () => document.getElementById('codex').classList.toggle('show'));

  // cooldown overlays
  const btns = [...root.querySelectorAll('.tbtn[data-k]')];
  return {
    update() {
      for (const b of btns) {
        const k = b.dataset.k, cdMax = game.skillCd(k), cd = game.hero.cd[k];
        b.querySelector('.cd').style.height = (cd > 0 ? Math.min(100, cd / cdMax * 100) : 0) + '%';
      }
      root.classList.toggle('hidden', game.state === 'title');
    },
  };
}
