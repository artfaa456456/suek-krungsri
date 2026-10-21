const socket = io();
const $ = (id) => document.getElementById(id);

const WORLD = { w: 2400, h: 1600 };
const SAFE_ZONE_X = 600;
const CLASS_NAMES = { swordsman: 'นักดาบ', archer: 'พลธนู', healer: 'หมอยา' };
const CLASS_COLORS = { swordsman: 0xd94f4f, archer: 0x4f9bd9, healer: 0x5fd97a };
const MONSTER_LOOK = {
  bandit: { name: 'โจรป่า', r: 16, color: 0x6b4a2b, barW: 36 },
  tiger:  { name: 'เสือสมิง', r: 20, color: 0xe08a2e, barW: 40 },
  boss:   { name: 'แม่ทัพข้าศึก', r: 42, color: 0x5a1a5a, barW: 110 },
};

let myId = null;
let joinData = null;
let latestState = null;
let scene = null;
let attackHeld = false;

// ---------------- หน้าเข้าเกม ----------------
let selectedClass = 'swordsman';
document.querySelectorAll('.cls').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.cls').forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
    selectedClass = btn.dataset.cls;
  });
});

$('nameInput').value = localStorage.getItem('playerName') || '';
$('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('startBtn').click(); });
$('startBtn').addEventListener('click', () => {
  const name = $('nameInput').value.trim();
  if (!name) return $('nameInput').focus();
  localStorage.setItem('playerName', name);
  joinData = { name, cls: selectedClass };
  socket.emit('join', joinData);
});

// ---------------- เชื่อมต่อเซิร์ฟเวอร์ ----------------
socket.on('connect', () => { if (joinData) socket.emit('join', joinData); }); // ต่อใหม่อัตโนมัติ
socket.on('joined', (data) => {
  myId = data.id;
  if (scene) scene.following = false;
  $('login').classList.add('hidden');
  $('hud').classList.remove('hidden');
});
socket.on('state', (s) => { latestState = s; });
socket.on('chat', addChat);
socket.on('banner', showBanner);
socket.on('fx', (fx) => { if (scene) scene.playFx(fx); });
socket.on('skillCd', (ms) => {
  const b = $('skillBtn');
  b.classList.add('cd');
  setTimeout(() => b.classList.remove('cd'), ms);
});

// ---------------- แชทและป้ายประกาศ ----------------
const chatInput = $('chatInput');
const typing = () => document.activeElement === chatInput;

function addChat(msg) {
  const line = document.createElement('div');
  if (msg.system) {
    line.className = 'sys';
    line.textContent = msg.text;
  } else {
    const b = document.createElement('b');
    b.textContent = msg.name + ': ';
    line.appendChild(b);
    line.appendChild(document.createTextNode(msg.text)); // กัน XSS
  }
  const log = $('chatLog');
  log.appendChild(line);
  while (log.children.length > 50) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

let bannerTimer;
function showBanner(text) {
  const b = $('banner');
  b.textContent = text;
  b.classList.remove('hidden');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => b.classList.add('hidden'), 4000);
}

chatInput.addEventListener('keydown', (e) => {
  e.stopPropagation(); // ไม่ให้ตัวอักษรที่พิมพ์ไปบังคับตัวละคร
  if (e.key === 'Enter') {
    const t = chatInput.value.trim();
    if (t) socket.emit('chat', t);
    chatInput.value = '';
    chatInput.blur();
  } else if (e.key === 'Escape') {
    chatInput.blur();
  }
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && myId && !typing()) { e.preventDefault(); chatInput.focus(); }
});

// ---------------- ปุ่มบนจอ (มือถือ) ----------------
const atkBtn = $('attackBtn');
atkBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); attackHeld = true; });
['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) =>
  atkBtn.addEventListener(ev, () => { attackHeld = false; }));
$('skillBtn').addEventListener('pointerdown', (e) => { e.preventDefault(); socket.emit('skill'); });

// ---------------- HUD ----------------
let lastHud = '';
function updateHud(d) {
  const key = [d.hp, d.maxHp, d.exp, d.next, d.level, d.rank, d.dead].join('|');
  if (key === lastHud) return;
  lastHud = key;
  $('title').textContent = `${d.rank} ${d.name} · Lv.${d.level} (${CLASS_NAMES[d.cls]})`;
  $('hpFill').style.width = `${(100 * d.hp) / d.maxHp}%`;
  $('hpText').textContent = `HP ${d.hp}/${d.maxHp}`;
  $('expFill').style.width = `${(100 * d.exp) / d.next}%`;
  $('expText').textContent = `EXP ${d.exp}/${d.next}`;
  $('deathScreen').classList.toggle('hidden', !d.dead);
}

// ---------------- ฉากเกมหลัก ----------------
class MainScene extends Phaser.Scene {
  constructor() {
    super('main');
    this.players = new Map();
    this.monsters = new Map();
    this.moveTarget = null;
    this.lastInput = { x: 0, y: 0 };
    this.lastSent = 0;
    this.lastAttack = 0;
    this.following = false;
    this.lastStateRef = null;
  }

  create() {
    scene = this;
    this.drawWorld();
    this.cameras.main.setBounds(0, 0, WORLD.w, WORLD.h);
    this.keys = this.input.keyboard.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,SPACE,E', false);
    this.input.keyboard.on('keydown-E', () => { if (myId && !typing()) socket.emit('skill'); });
    this.input.on('pointerdown', (p) => {
      if (!myId) return;
      chatInput.blur();
      this.moveTarget = { x: p.worldX, y: p.worldY };
      this.showMarker(p.worldX, p.worldY);
    });
  }

  drawWorld() {
    const g = this.add.graphics().setDepth(-10);
    // พื้นที่แต่ละโซน
    g.fillStyle(0x5b8c3e).fillRect(0, 0, WORLD.w, WORLD.h);                // ทุ่งชายแดน
    g.fillStyle(0x3d6b2f).fillRect(1500, 0, WORLD.w - 1500, WORLD.h);      // ป่าลึก
    g.fillStyle(0xc2a26a).fillRect(0, 0, SAFE_ZONE_X, WORLD.h);            // กรุงศรีฯ
    g.fillStyle(0xd9bf8a).fillRect(0, 760, SAFE_ZONE_X, 80);               // ถนน
    g.fillStyle(0x3a7bbf).fillRect(0, 0, WORLD.w, 70).fillRect(0, WORLD.h - 70, WORLD.w, 70); // แม่น้ำ

    // กำแพงเมืองและประตู
    g.fillStyle(0x8b4a2b)
      .fillRect(SAFE_ZONE_X - 16, 70, 16, 630)
      .fillRect(SAFE_ZONE_X - 16, 900, 16, WORLD.h - 970);
    g.fillStyle(0xd4a72c).fillRect(SAFE_ZONE_X - 22, 690, 28, 20).fillRect(SAFE_ZONE_X - 22, 890, 28, 20);

    // เจดีย์
    const chedi = (x, y) => {
      g.fillStyle(0x7a3b2b).fillRect(x - 40, y, 80, 18);
      g.fillStyle(0xe8dcc0).fillRect(x - 30, y - 14, 60, 14);
      g.fillStyle(0xd4a72c).fillCircle(x, y - 34, 26);
      g.fillTriangle(x - 10, y - 50, x + 10, y - 50, x, y - 120);
    };
    // บ้านเรือนไทย
    const house = (x, y) => {
      g.fillStyle(0x8b5a2b).fillRect(x - 35, y - 25, 70, 45);
      g.fillStyle(0x7a1f1f).fillTriangle(x - 48, y - 25, x + 48, y - 25, x, y - 70);
    };
    chedi(180, 330); chedi(420, 330); chedi(300, 1300);
    house(150, 620); house(450, 620); house(150, 1050); house(450, 1050);

    // ต้นไม้ (ใช้ seed เพื่อให้ทุกเครื่องเห็นตำแหน่งเดียวกัน)
    const rnd = new Phaser.Math.RandomDataGenerator(['krungsri']);
    for (let i = 0; i < 160; i++) {
      const x = rnd.between(650, WORLD.w - 20);
      const y = rnd.between(90, WORLD.h - 90);
      if (x < 1500 && rnd.frac() < 0.6) continue;
      const r = rnd.between(14, 26);
      g.fillStyle(0x24451d).fillCircle(x, y, r);
      g.fillStyle(0x2f5a26).fillCircle(x - r * 0.25, y - r * 0.25, r * 0.6);
    }

    // ชื่อโซน
    const style = { fontFamily: 'Sarabun', fontSize: '22px', fontStyle: 'bold', color: '#fff3d0', stroke: '#000', strokeThickness: 4 };
    this.add.text(300, 110, 'กรุงศรีอยุธยา (เขตปลอดภัย)', style).setOrigin(0.5).setDepth(-5);
    this.add.text(1050, 110, 'ทุ่งชายแดน · โจรป่า', style).setOrigin(0.5).setDepth(-5);
    this.add.text(1950, 110, 'ป่าลึก · เสือสมิง', style).setOrigin(0.5).setDepth(-5);
  }

  makeEntity({ color, r, label, labelColor, barW, barColor, isMe, hat, fontSize }) {
    const c = this.add.container(0, 0);
    const parts = [
      this.add.ellipse(0, r * 0.9, r * 2, r * 0.7, 0x000000, 0.3),
      this.add.circle(0, 0, r, color).setStrokeStyle(isMe ? 3 : 2, isMe ? 0xf2c94c : 0x000000),
    ];
    if (hat) parts.push(this.add.triangle(0, -r + 2, -7, 6, 7, 6, 0, -12, 0xf2c94c)); // ยอดชฎาเล็กๆ
    const nameText = this.add.text(0, -r - 30, label, {
      fontFamily: 'Sarabun', fontSize: fontSize || '13px', fontStyle: 'bold',
      color: labelColor, stroke: '#000', strokeThickness: 3,
    }).setOrigin(0.5);
    const hpBg = this.add.rectangle(0, -r - 14, barW + 2, 6, 0x000000);
    const hpFg = this.add.rectangle(-barW / 2, -r - 14, barW, 4, barColor).setOrigin(0, 0.5);
    parts.push(nameText, hpBg, hpFg);
    c.add(parts);
    return { c, nameText, hpFg, label, tx: 0, ty: 0, data: null };
  }

  makePlayer(d) {
    const isMe = d.id === myId;
    return this.makeEntity({
      color: CLASS_COLORS[d.cls], r: 16, label: '', labelColor: isMe ? '#ffe680' : '#ffffff',
      barW: 40, barColor: 0x4cd964, isMe, hat: true,
    });
  }

  makeMonster(d) {
    const look = MONSTER_LOOK[d.type];
    const isBoss = d.type === 'boss';
    return this.makeEntity({
      color: look.color, r: look.r, label: look.name, labelColor: isBoss ? '#ff7070' : '#ffd0a0',
      barW: look.barW, barColor: 0xe05252, fontSize: isBoss ? '18px' : '13px',
    });
  }

  sync(map, list, factory) {
    const seen = new Set();
    for (const d of list) {
      seen.add(d.id);
      let e = map.get(d.id);
      if (!e) {
        e = factory(d);
        e.c.setPosition(d.x, d.y);
        map.set(d.id, e);
      }
      e.tx = d.x;
      e.ty = d.y;
      e.data = d;
    }
    for (const [id, e] of map) {
      if (!seen.has(id)) { e.c.destroy(); map.delete(id); }
    }
  }

  update(time, delta) {
    if (!latestState) return;
    if (latestState !== this.lastStateRef) {
      this.lastStateRef = latestState;
      this.sync(this.players, latestState.players, (d) => this.makePlayer(d));
      this.sync(this.monsters, latestState.monsters, (d) => this.makeMonster(d));
    }

    // เลื่อนตำแหน่งให้นุ่มนวล (interpolation)
    const k = Math.min(1, (delta / 1000) * 12);
    for (const map of [this.players, this.monsters]) {
      for (const e of map.values()) {
        e.c.x += (e.tx - e.c.x) * k;
        e.c.y += (e.ty - e.c.y) * k;
        e.c.setDepth(e.c.y);
        e.hpFg.scaleX = Phaser.Math.Clamp(e.data.hp / e.data.maxHp, 0, 1);
        e.c.setAlpha(e.data.dead ? 0.35 : 1);
      }
    }
    for (const e of this.players.values()) {
      const label = `${e.data.rank} ${e.data.name} Lv.${e.data.level}`;
      if (label !== e.label) { e.label = label; e.nameText.setText(label); }
    }

    const me = this.players.get(myId);
    if (!me) return;
    if (!this.following) {
      this.cameras.main.startFollow(me.c, true, 0.12, 0.12);
      this.following = true;
    }
    this.handleInput(me, time);
    updateHud(me.data);
  }

  handleInput(me, time) {
    let x = 0, y = 0;
    if (!typing()) {
      const K = this.keys;
      if (K.A.isDown || K.LEFT.isDown) x -= 1;
      if (K.D.isDown || K.RIGHT.isDown) x += 1;
      if (K.W.isDown || K.UP.isDown) y -= 1;
      if (K.S.isDown || K.DOWN.isDown) y += 1;
      if (K.SPACE.isDown) attackHeldKey(this, time);
    }
    if (attackHeld) attackHeldKey(this, time);

    if (x || y) {
      this.moveTarget = null;
    } else if (this.moveTarget) {
      const dx = this.moveTarget.x - me.tx;
      const dy = this.moveTarget.y - me.ty;
      const d = Math.hypot(dx, dy);
      if (d < 10) this.moveTarget = null;
      else { x = dx / d; y = dy / d; }
    }
    if (me.data.dead) { x = 0; y = 0; this.moveTarget = null; }

    const changed = Math.abs(x - this.lastInput.x) > 0.05 || Math.abs(y - this.lastInput.y) > 0.05;
    if (changed && time - this.lastSent > 50) {
      socket.emit('input', { x, y });
      this.lastInput = { x, y };
      this.lastSent = time;
    }
  }

  showMarker(x, y) {
    const m = this.add.circle(x, y, 12).setStrokeStyle(2, 0xf2c94c).setDepth(5);
    this.tweens.add({ targets: m, scale: 0.2, alpha: 0, duration: 400, onComplete: () => m.destroy() });
  }

  playFx(fx) {
    if (fx.t === 'num') {
      const t = this.add.text(fx.x + Phaser.Math.Between(-10, 10), fx.y - 30, fx.v, {
        fontFamily: 'Sarabun', fontSize: fx.big ? '24px' : '16px', fontStyle: 'bold',
        color: fx.c, stroke: '#000', strokeThickness: 4,
      }).setOrigin(0.5).setDepth(99999);
      this.tweens.add({ targets: t, y: t.y - 40, alpha: 0, duration: 900, onComplete: () => t.destroy() });
    } else if (fx.t === 'arrow') {
      const color = Phaser.Display.Color.HexStringToColor(fx.c).color;
      const a = this.add.rectangle(fx.x1, fx.y1, 18, 3, color).setDepth(99998);
      a.rotation = Math.atan2(fx.y2 - fx.y1, fx.x2 - fx.x1);
      this.tweens.add({ targets: a, x: fx.x2, y: fx.y2, duration: 150, onComplete: () => a.destroy() });
    } else if (fx.t === 'ring') {
      const color = Phaser.Display.Color.HexStringToColor(fx.c).color;
      const r = this.add.circle(fx.x, fx.y, 10).setStrokeStyle(4, color).setDepth(99998);
      this.tweens.add({ targets: r, scale: fx.r / 10, alpha: 0, duration: 400, onComplete: () => r.destroy() });
    }
  }
}

// ส่งคำสั่งโจมตีไม่เกินทุก 150 ms (เซิร์ฟเวอร์ตรวจคูลดาวน์จริงอีกชั้น)
function attackHeldKey(sc, time) {
  if (time - sc.lastAttack > 150) {
    socket.emit('attack');
    sc.lastAttack = time;
  }
}

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#1a1208',
  scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
  scene: MainScene,
});