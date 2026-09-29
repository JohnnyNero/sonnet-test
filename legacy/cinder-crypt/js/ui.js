// DOM HUD: orb, skill bar, toasts, floating text, inventory, minimap, overlays.
import { RARITY, SLOTS, AFFIXES, describe } from './loot.js';
import { W, H } from './dungeon.js';
import { SK } from './game.js';

const $ = s => document.querySelector(s);

export class UI {
  constructor() {
    this.floaters = [];
    this.invOpen = false;
    this.miniT = 0;
    this.el = { hud: $('#hud'), orbFill: $('#orbFill'), orbText: $('#orbText'), floor: $('#floorLabel'), toasts: $('#toasts'), fl: $('#floaters'),
      target: $('#targetBar'), boss: $('#bossBar'), mini: $('#mini'), inv: $('#inv'), tip: $('#tip'), overlay: $('#overlay'), card: $('#ovCard'),
      codex: $('#codex'), slots: $('#slots'), bag: $('#bag'), stats: $('#statlist') };
    this.skills = {};
    document.querySelectorAll('.skill').forEach(s => { this.skills[s.dataset.k] = { el: s, cd: s.querySelector('.cd') }; });
    this.mctx = this.el.mini.getContext('2d');
  }

  setLoading(t) { const e = $('#loadText'); if (e) e.textContent = t; }

  toast(text, color = '#fff') {
    const d = document.createElement('div');
    d.className = 'toast'; d.textContent = text; d.style.color = color;
    this.el.toasts.appendChild(d);
    setTimeout(() => d.remove(), 3700);
    while (this.el.toasts.children.length > 4) this.el.toasts.firstChild.remove();
  }

  floater(x, y, text, cls, z = 1.6) {
    if (this.floaters.length > 40) { const o = this.floaters.shift(); o.el.remove(); }
    const el = document.createElement('div');
    el.className = 'fl ' + cls; el.textContent = text;
    this.el.fl.appendChild(el);
    this.floaters.push({ el, x: x + (Math.random() - 0.5) * 0.5, y, z, t: 0, life: cls.includes('tag') ? 1.1 : 0.9 });
  }
  updateFloaters(world, dt) {
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i]; f.t += dt;
      if (f.t >= f.life) { f.el.remove(); this.floaters.splice(i, 1); continue; }
      const p = world.screenPos(f.x, f.y, f.z + f.t * 0.9);
      f.el.style.left = p.x + 'px'; f.el.style.top = p.y + 'px';
      f.el.style.opacity = String(Math.min(1, (f.life - f.t) * 3));
    }
  }

  overlay(kind, data) {
    const o = this.el.overlay, c = this.el.card;
    if (!kind) { o.classList.add('clear'); this.el.hud.classList.remove('hidden'); return; }
    o.classList.remove('clear');
    if (kind === 'title') {
      this.el.hud.classList.add('hidden');
      const controls = this.isTouch
        ? `<tr><td>Move</td><td>Drag anywhere on the <b>left</b> side (floating joystick)</td></tr>
          <tr><td>Fight</td><td>Hold <b>ATTACK</b> for the staff strike. The four round buttons cast Firebolt, Frost Nova, Chain Lightning and Oil Flask, and aim at the nearest enemy you're facing</td></tr>
          <tr><td>Other</td><td><b>Bag</b> for inventory &middot; <b>?</b> for the reaction list. Landscape works best</td></tr>`
        : `<tr><td>Move / attack</td><td>Hold <b>left mouse</b> (or WASD) &middot; click a monster to fight it</td></tr>
          <tr><td>Skills</td><td><b>1</b> Firebolt &middot; <b>2</b> Frost Nova &middot; <b>3</b> Chain Lightning &middot; <b>4</b> Oil Flask &middot; right-click = Firebolt</td></tr>
          <tr><td>Other</td><td><b>I</b> inventory &middot; <b>H</b> reaction list &middot; <b>Shift</b> hold position</td></tr>`;
      c.innerHTML = `<h1>CINDER CRYPT</h1><div class="sub">Everything down here burns, floods, freezes, and conducts.</div>
        <table>
          ${controls}
          <tr><td>The trick</td><td>The floor is alive. Douse them in oil, then light it. Lure them into water, then zap it. Freeze what's wet, then shatter it.</td></tr>
        </table><button class="go" id="goBtn">Descend</button><div class="seed">Three floors. One Grave King. Every crypt is generated fresh.</div>`;
    } else if (kind === 'dead') {
      c.innerHTML = `<h2 style="color:#ff8a70">You Died</h2><div class="sub">The crypt keeps what it takes.</div>
        <div class="sum">Reached floor <b>${data.floor}</b> &middot; <b>${data.kills}</b> slain &middot; <b>${data.items}</b> items found<br>
        Oil burned: <b>${data.burned}</b> tiles &middot; Puddles electrified: <b>${data.arcs}</b> &middot; Water frozen: <b>${data.frozen}</b></div>
        <button class="go" id="goBtn">Descend Again</button><div class="seed">Last crypt seed ${data.seed}</div>`;
    } else if (kind === 'won') {
      c.innerHTML = `<h2 style="color:#ffd24a">The Grave King Is Dead</h2><div class="sub">The crypt falls quiet, and cools.</div>
        <div class="sum"><b>${data.kills}</b> slain &middot; <b>${data.items}</b> items found<br>
        Oil burned: <b>${data.burned}</b> tiles &middot; Puddles electrified: <b>${data.arcs}</b> &middot; Water frozen: <b>${data.frozen}</b></div>
        <button class="go" id="goBtn">Descend Again</button><div class="seed">Crypt seed ${data.seed}</div>`;
    }
    const b = $('#goBtn'); if (b) b.onclick = () => this.onStart && this.onStart();
  }

  update(g, dt) {
    const h = g.hero;
    const p = Math.max(0, h.hp / h.maxHp);
    this.el.orbFill.style.height = (p * 100) + '%';
    this.el.orbFill.classList.toggle('burning', h.st.burn > 0);
    this.el.orbText.textContent = Math.ceil(h.hp) + '';
    for (const k in this.skills) {
      const cdMax = SK[k].cd * g.cdMul(), cd = h.cd[k];
      this.skills[k].cd.style.height = (cd > 0 ? Math.min(100, cd / cdMax * 100) : 0) + '%';
      this.skills[k].el.classList.toggle('ready', cd <= 0);
    }
    this.el.floor.textContent = `Floor ${g.floor} / 3`;

    // hover / target bar
    const e = g.hoverEnemy;
    if (e && !e.dead) {
      this.el.target.classList.remove('hidden');
      const nm = (e.mod ? require_mod(e) + ' ' : '') + e.def.name;
      this.el.target.querySelector('.tname').textContent = nm;
      this.el.target.querySelector('.tname').style.color = e.elite ? '#ffd24a' : '#ffe0d0';
      this.el.target.querySelector('.tbar i').style.width = (Math.max(0, e.hp / e.maxHp) * 100) + '%';
      const chips = [];
      if (e.st.burn > 0) chips.push(['burn', 'BURNING']); if (e.st.frozen > 0) chips.push(['frozen', 'FROZEN']); else if (e.st.chill > 0) chips.push(['chill', 'CHILLED']);
      if (e.st.wet > 0) chips.push(['wet', 'WET']); if (e.st.oil > 0) chips.push(['oil', 'OILED']);
      this.el.target.querySelector('.tchips').innerHTML = chips.map(c => `<span class="chip ${c[0]}">${c[1]}</span>`).join('');
    } else this.el.target.classList.add('hidden');
    const boss = g.enemies.find(x => x.def.boss && x.aware && !x.dead);
    if (boss) { this.el.boss.classList.remove('hidden'); this.el.boss.querySelector('i').style.width = Math.max(0, boss.hp / boss.maxHp * 100) + '%'; }
    else this.el.boss.classList.add('hidden');

    this.miniT -= dt;
    if (this.miniT <= 0) { this.miniT = 0.15; this.drawMini(g); }
  }

  drawMini(g) {
    const c = this.mctx, S = 150 / W * 1.0, ex = g.exploredMap;
    c.clearRect(0, 0, 150, 150);
    c.fillStyle = '#3a3646';
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (ex[y * W + x] && g.level.tiles[y * W + x]) c.fillRect(x * S, y * S, S + 0.5, S + 0.5);
    const s = g.surf;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x; if (!ex[i]) continue;
      if (s.fire[i] > 0) c.fillStyle = '#ff7a20'; else if (s.ice[i] > 0) c.fillStyle = '#cdeeff'; else if (s.water[i] > 0.15) c.fillStyle = '#2f6fae'; else if (s.oil[i] > 0.05) c.fillStyle = '#6a3a9a'; else continue;
      c.fillRect(x * S, y * S, S + 0.5, S + 0.5);
    }
    if (g.exit && ex[Math.floor(g.exit.y) * W + Math.floor(g.exit.x)]) { c.fillStyle = '#b090ff'; c.fillRect(g.exit.x * S - 2, g.exit.y * S - 2, 5, 5); }
    for (const e of g.enemies) if (!e.dead && Math.hypot(e.x - g.hero.x, e.y - g.hero.y) < 12) { c.fillStyle = e.elite ? '#ffd24a' : '#ff4a4a'; c.fillRect(e.x * S - 1, e.y * S - 1, 3, 3); }
    c.fillStyle = '#7dff9a'; c.fillRect(g.hero.x * S - 2, g.hero.y * S - 2, 4, 4);
  }

  // ---- inventory
  toggleInv(g) { this.invOpen = !this.invOpen; this.el.inv.classList.toggle('hidden', !this.invOpen); this.hideTip(); if (this.invOpen) this.renderInventory(g); }
  closeInv() { this.invOpen = false; this.el.inv.classList.add('hidden'); this.hideTip(); }
  renderInventory(g) {
    if (!g.equipped) return;
    const rc = it => RARITY[it.rarity].color;
    const detail = it => this.isTouch
      ? describe(it).map(l => `<div style="color:#9fb6ff;font-size:11px">${l}</div>`).join('') || '<div style="color:#7d7566;font-size:11px">no bonuses</div>'
      : `<div style="color:#9a917f">${it.affixes.length ? it.affixes.length + ' affix' + (it.affixes.length > 1 ? 'es' : '') : 'no affixes'}</div>`;
    const cell = (it, extra = '', del = false) => `<div class="cell" ${extra}>${del ? '<button class="del" title="Discard">✕</button>' : ''}<div class="sl">${it.slot}</div><div class="nm" style="color:${rc(it)}">${it.name}</div>${detail(it)}</div>`;
    this.el.slots.innerHTML = SLOTS.map(s => { const it = g.equipped[s]; return it ? cell(it, `data-eq="${s}" data-uid="${it.uid}"`) : `<div class="cell empty"><div class="sl">${s}</div>empty</div>`; }).join('');
    this.el.bag.innerHTML = g.bag.length ? g.bag.map(it => cell(it, `data-uid="${it.uid}"`, true)).join('') : '<div style="color:#5d556b;font-size:12px">Nothing yet. Monsters, chests and elites drop gear.</div>';
    const s = g.hero.stats, L = [];
    L.push(`Life <b>${g.hero.maxHp}</b>`, `Staff damage <b>${10 + s.weaponDmg}</b>`);
    if (s.armor) L.push(`Armor <b>${s.armor}</b>`);
    for (const [k, l] of [['dmg', 'Damage'], ['fire', 'Fire dmg'], ['shock', 'Shock dmg'], ['frost', 'Frost dmg'], ['vsBurn', 'vs Burning'], ['vsWet', 'vs Wet'], ['vsFrozen', 'vs Frozen'], ['speed', 'Move speed'], ['cdr', 'Cooldown red.'], ['ignite', 'Ignite chance'], ['fireRes', 'Fire resist'], ['shockRes', 'Shock resist']])
      if (s[k]) L.push(`${l} <b>${s[k]}%</b>`);
    if (s.oilTrail) L.push('<b style="color:#ffb060">Oil trail</b>'); if (s.ironsole) L.push('<b style="color:#ffb060">Ice-proof soles</b>');
    this.el.stats.innerHTML = L.join('<br>');
    const items = new Map([...g.bag, ...Object.values(g.equipped)].map(i => [i.uid, i]));
    this.el.inv.querySelectorAll('[data-uid]').forEach(n => {
      const it = items.get(+n.dataset.uid);
      n.onmouseenter = ev => this.showTip(it, ev);
      n.onmousemove = ev => this.moveTip(ev);
      n.onmouseleave = () => this.hideTip();
      n.onclick = () => { this.hideTip(); n.dataset.eq ? g.unequip(n.dataset.eq) : g.equip(it.uid); };
      n.oncontextmenu = ev => { ev.preventDefault(); this.hideTip(); if (!n.dataset.eq) g.discard(it.uid); };
      const del = n.querySelector('.del');
      if (del) del.onclick = ev => { ev.stopPropagation(); g.discard(it.uid); };
    });
  }
  showTip(it, ev) {
    const t = this.el.tip;
    const lines = [];
    if (it.weaponDmg) lines.push(`<div class="base">+${it.weaponDmg} Staff Damage</div>`);
    if (it.armor) lines.push(`<div class="base">${it.armor} Armor</div>`);
    for (const a of it.affixes) lines.push(`<div class="${AFFIXES[a.id].rare ? 'special' : 'aff'}">${AFFIXES[a.id].fmt(a.v)}</div>`);
    t.innerHTML = `<div class="tn" style="color:${RARITY[it.rarity].color}">${it.name}</div><div class="ts">${RARITY[it.rarity].name} ${it.base} &middot; ${it.slot}</div>${lines.join('') || '<div style="color:#7d7566">No bonuses</div>'}`;
    t.classList.remove('hidden'); this.moveTip(ev);
  }
  moveTip(ev) { const t = this.el.tip; t.style.left = Math.min(window.innerWidth - 290, ev.clientX + 16) + 'px'; t.style.top = Math.min(window.innerHeight - 200, ev.clientY + 12) + 'px'; }
  hideTip() { this.el.tip.classList.add('hidden'); }
}

import { MODS } from './game.js';
function require_mod(e) { return MODS[e.mod].label; }
