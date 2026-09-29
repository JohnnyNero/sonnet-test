// Unified input: keyboard + mouse (desktop). Touch controls live in touch.js and write into the same intent object.
export class Input {
  constructor(canvas, game) {
    this.game = game; this.canvas = canvas;
    this.keys = new Set(); this.pressed = new Set();
    this.mouse = { x: 0, y: 0, down: false, right: false, gx: 0, gy: 0 };
    this.intent = { mx: 0, my: 0, run: false, action: false, actionHeld: false, crouch: false, jump: false, fire: false, gadget: null, cycle: 0, goggles: false, rotate: 0, zoom: 0, tilt: 0, map: false, pause: false };
    this.touch = null;
    const kd = e => {
      const k = e.key.toLowerCase();
      if (e.repeat) { if (['arrowup','arrowdown','arrowleft','arrowright',' '].includes(k)) e.preventDefault(); return; }
      this.keys.add(k); this.pressed.add(k);
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' ', 'tab'].includes(k)) e.preventDefault();
      game.audioUnlock && game.audioUnlock();
    };
    const ku = e => { this.keys.delete(e.key.toLowerCase()); };
    window.addEventListener('keydown', kd); window.addEventListener('keyup', ku);
    window.addEventListener('blur', () => { this.keys.clear(); this.mouse.down = false; this.mouse.right = false; });
    canvas.addEventListener('mousedown', e => {
      game.audioUnlock && game.audioUnlock();
      this._move(e);
      if (e.button === 0) { this.mouse.down = true; this.pressed.add('mouse0'); }
      if (e.button === 2 || e.button === 1) { this.mouse.right = true; this.dragX = e.clientX; this.dragY = e.clientY; }
    });
    window.addEventListener('mouseup', e => { if (e.button === 0) this.mouse.down = false; if (e.button === 2 || e.button === 1) this.mouse.right = false; });
    canvas.addEventListener('mousemove', e => {
      this._move(e);
      if (this.mouse.right) { game.R.rotateCamera(-(e.clientX - this.dragX) * 0.008); game.R.tiltCamera((e.clientY - this.dragY) * 0.004); this.dragX = e.clientX; this.dragY = e.clientY; }
    });
    canvas.addEventListener('wheel', e => { e.preventDefault(); game.R.zoomCamera(Math.sign(e.deltaY) * 0.08); }, { passive: false });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
  }
  _move(e) { this.mouse.x = e.clientX; this.mouse.y = e.clientY; }
  was(k) { return this.pressed.has(k); }
  held(k) { return this.keys.has(k); }

  // Build this frame's intent (camera-relative movement).
  poll(dt) {
    const I = this.intent, R = this.game.R;
    if (this.captured) {           // a minigame owns the keyboard
      Object.assign(I, { mx: 0, my: 0, mag: 0, run: false, crouchPressed: false, jump: false, action: false, actionHeld: false, fire: false, gadget: null, cycle: 0, goggles: false, map: false, pause: false });
      this.pressed.clear(); return;
    }
    const K = k => this.keys.has(k);
    let ix = (K('d') || K('arrowright') ? 1 : 0) - (K('a') || K('arrowleft') ? 1 : 0);
    let iy = (K('s') || K('arrowdown') ? 1 : 0) - (K('w') || K('arrowup') ? 1 : 0);   // +y = towards camera (screen down)
    const T = this.touch;
    if (T && (T.mx || T.my)) { ix = T.mx; iy = T.my; }
    const l = Math.hypot(ix, iy); if (l > 1) { ix /= l; iy /= l; }
    const f = R.camForward(), r = R.camRight();
    I.mx = r.x * ix - f.x * iy; I.my = r.y * ix - f.y * iy;
    I.mag = Math.min(1, l);
    I.run = K('shift') || (T && T.run);
    I.crouchPressed = this.was('c') || this.was('control') || (T && T.consumeCrouch && T.consumeCrouch());
    I.jump = this.was(' ');
    I.action = this.was('f') || (T && T.consumeAction && T.consumeAction());
    I.actionHeld = K('f') || (T && T.actionHeld);
    I.fire = this.was('mouse0') || (T && T.consumeFire && T.consumeFire());
    I.gadget = null; for (let n = 1; n <= 6; n++) if (this.was(String(n))) I.gadget = n - 1;
    I.cycle = (this.was('tab') ? 1 : 0) + (T && T.consumeCycle ? T.consumeCycle() : 0);
    I.goggles = this.was('g') || (T && T.consumeGoggles && T.consumeGoggles());
    I.map = this.was('m');
    I.pause = this.was('escape') || this.was('p');
    // camera keys
    if (K('q')) R.rotateCamera(2.0 * dt); if (K('e')) R.rotateCamera(-2.0 * dt);
    if (K('r')) R.tiltCamera(-1.2 * dt); if (K('t')) R.tiltCamera(1.2 * dt);
    if (K('=') || K('+')) R.zoomCamera(-1.0 * dt); if (K('-')) R.zoomCamera(1.0 * dt);
    // cursor in the world
    const g = R.screenRay(this.mouse.x, this.mouse.y); if (g) { this.mouse.gx = g.x; this.mouse.gy = g.y; }
  }
  endFrame() { this.pressed.clear(); }
}
