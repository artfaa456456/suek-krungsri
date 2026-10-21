'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.send('ok'));

// ---------------- ค่าตั้งต้นของเกม ----------------
const PORT = process.env.PORT || 3000;
const TICK_MS = 50; // 20 ครั้ง/วินาที
const WORLD = { w: 2400, h: 1600, minY: 90, maxY: 1510 };
const SAFE_ZONE_X = 600; // x < 600 = เมือง (เขตปลอดภัย)
const SPAWN = { x: 300, y: 800 };
const BOSS_INTERVAL_MS = 5 * 60 * 1000;

const CLASSES = {
  swordsman: { name: 'นักดาบ', hp: 160, atk: 20, range: 70, cd: 450, speed: 190, skillCd: 5000 },
  archer:    { name: 'พลธนู', hp: 110, atk: 15, range: 280, cd: 550, speed: 200, skillCd: 5000 },
  healer:    { name: 'หมอยา', hp: 120, atk: 10, range: 180, cd: 650, speed: 195, skillCd: 4000 },
};

const RANKS = [
  { lv: 1, name: 'พลทหาร' },
  { lv: 3, name: 'นายหมวด' },
  { lv: 5, name: 'นายกอง' },
  { lv: 8, name: 'นายกองใหญ่' },
  { lv: 12, name: 'ขุน' },
  { lv: 16, name: 'หลวง' },
  { lv: 20, name: 'พระ' },
  { lv: 25, name: 'พระยา' },
];

const MONSTER_TYPES = {
  bandit: { name: 'โจรป่า', r: 16, hp: 70, atk: 6, exp: 18, speed: 90, aggro: 180, range: 40, cd: 1200 },
  tiger:  { name: 'เสือสมิง', r: 20, hp: 180, atk: 14, exp: 55, speed: 130, aggro: 230, range: 45, cd: 1000 },
  boss:   { name: 'แม่ทัพข้าศึก', r: 42, hp: 4000, atk: 28, exp: 1500, speed: 85, aggro: 380, range: 80, cd: 1400 },
};

const SPAWN_ZONES = [
  { type: 'bandit', count: 14, x1: 700, x2: 1450 },
  { type: 'tiger', count: 10, x1: 1550, x2: 2350 },
];

// ---------------- สถานะของโลก ----------------
const players = new Map();
const monsters = new Map();
let nextMonsterId = 1;
let bossAlive = false;
let lastBossAt = Date.now() - BOSS_INTERVAL_MS + 60 * 1000; // บอสตัวแรกมาหลังเปิดเซิร์ฟ 1 นาที

// ---------------- ฟังก์ชันช่วย ----------------
const rand = (a, b) => a + Math.random() * (b - a);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const expToNext = (lv) => Math.floor(40 * Math.pow(lv, 1.6));
const rankOf = (lv) => RANKS.reduce((r, x) => (lv >= x.lv ? x.name : r), RANKS[0].name);
const maxHpOf = (p) => CLASSES[p.cls].hp + (p.level - 1) * 14;
const atkOf = (p) => CLASSES[p.cls].atk + (p.level - 1) * 3;
const inSafeZone = (e) => e.x < SAFE_ZONE_X;

const systemMsg = (text) => io.emit('chat', { system: true, text });
const fx = (data) => io.emit('fx', data);

// ---------------- มอนสเตอร์ ----------------
function spawnMonster(type, x, y) {
  const t = MONSTER_TYPES[type];
  const m = {
    id: nextMonsterId++, type, x, y, homeX: x, homeY: y,
    hp: t.hp, maxHp: t.hp, lastAtk: 0, target: null,
    wander: null, returning: false, damageBy: new Map(),
  };
  monsters.set(m.id, m);
  return m;
}

for (const z of SPAWN_ZONES) {
  for (let i = 0; i < z.count; i++) {
    spawnMonster(z.type, rand(z.x1, z.x2), rand(WORLD.minY + 50, WORLD.maxY - 50));
  }
}

function spawnBoss() {
  bossAlive = true;
  spawnMonster('boss', 1900, 800);
  systemMsg('แม่ทัพข้าศึกบุกมาที่ป่าลึก! รวมพลด่วน!');
  io.emit('banner', 'แม่ทัพข้าศึกบุกมาที่ป่าลึก! รวมพลด่วน!');
}

function moveToward(e, to, speed, dt) {
  const dx = to.x - e.x, dy = to.y - e.y;
  const d = Math.hypot(dx, dy);
  if (d < 1) return d;
  const step = Math.min(d, speed * dt);
  e.x += (dx / d) * step;
  e.y += (dy / d) * step;
  e.x = Math.max(e.x, SAFE_ZONE_X + 30); // มอนสเตอร์เข้าเมืองไม่ได้
  return d - step;
}

function nearestMonster(p, range) {
  let best = null, bd = Infinity;
  for (const m of monsters.values()) {
    const d = dist(p, m) - MONSTER_TYPES[m.type].r;
    if (d <= range && d < bd) { bd = d; best = m; }
  }
  return best;
}

function damageMonster(m, p, amount) {
  if (m.hp <= 0) return;
  const crit = Math.random() < 0.12;
  const dmg = Math.round(amount * rand(0.85, 1.15) * (crit ? 2 : 1));
  m.hp -= dmg;
  m.damageBy.set(p.id, (m.damageBy.get(p.id) || 0) + dmg);
  if (!m.target && !m.returning) m.target = p.id;
  fx({ t: 'num', x: m.x, y: m.y, v: crit ? `${dmg}!` : `${dmg}`, c: crit ? '#ffd23f' : '#ffffff', big: crit });
  if (m.hp <= 0) killMonster(m);
}

function killMonster(m) {
  const t = MONSTER_TYPES[m.type];
  monsters.delete(m.id);

  let total = 0;
  for (const v of m.damageBy.values()) total += v;
  for (const [pid, d] of m.damageBy) {
    const p = players.get(pid);
    if (p) gainExp(p, Math.max(1, Math.round((t.exp * d) / total)));
  }

  if (m.type === 'boss') {
    bossAlive = false;
    lastBossAt = Date.now();
    const top = [...m.damageBy.entries()].sort((a, b) => b[1] - a[1])[0];
    const topPlayer = top ? players.get(top[0]) : null;
    systemMsg(`ปราบ${t.name}สำเร็จ! ผู้ทำดาเมจสูงสุด: ${topPlayer ? topPlayer.name : '-'}`);
    io.emit('banner', 'ปราบแม่ทัพข้าศึกสำเร็จ!');
  } else {
    setTimeout(() => spawnMonster(m.type, m.homeX, m.homeY), 8000);
  }
}

function gainExp(p, amount) {
  p.exp += amount;
  io.to(p.id).emit('fx', { t: 'num', x: p.x, y: p.y - 20, v: `+${amount} EXP`, c: '#f2c94c' });
  while (p.exp >= expToNext(p.level)) {
    p.exp -= expToNext(p.level);
    p.level++;
    const oldRank = p.rank;
    p.rank = rankOf(p.level);
    p.hp = maxHpOf(p);
    fx({ t: 'num', x: p.x, y: p.y - 50, v: 'LEVEL UP!', c: '#7CFC00', big: true });
    fx({ t: 'ring', x: p.x, y: p.y, r: 80, c: '#f2c94c' });
    if (p.rank !== oldRank) systemMsg(`${p.name} ได้เลื่อนยศเป็น "${p.rank}"`);
  }
}

function damagePlayer(p, atk, m) {
  const dmg = Math.round(atk * rand(0.85, 1.15));
  p.hp -= dmg;
  fx({ t: 'num', x: p.x, y: p.y, v: `-${dmg}`, c: '#ff5c5c' });
  if (p.hp <= 0) {
    p.hp = 0;
    p.dead = true;
    p.respawnAt = Date.now() + 5000;
    p.input = { x: 0, y: 0 };
    p.exp = Math.max(0, p.exp - Math.floor(expToNext(p.level) * 0.05)); // เสีย EXP 5%
    m.target = null;
    if (m.type === 'boss') systemMsg(`${p.name} พ่ายแพ้ต่อ${MONSTER_TYPES.boss.name}`);
  }
}

function updateMonster(m, dt, now) {
  const t = MONSTER_TYPES[m.type];
  const home = { x: m.homeX, y: m.homeY };

  if (m.returning) {
    if (moveToward(m, home, t.speed * 1.5, dt) < 10) {
      m.returning = false;
      m.hp = m.maxHp;
      m.damageBy.clear();
    }
    return;
  }

  let target = m.target ? players.get(m.target) : null;
  if (target && (target.dead || inSafeZone(target))) { target = null; m.target = null; }

  if (!target) {
    let bd = t.aggro;
    for (const p of players.values()) {
      if (p.dead || inSafeZone(p)) continue;
      const d = dist(m, p);
      if (d < bd) { bd = d; target = p; }
    }
    if (target) m.target = target.id;
  }

  if (target) {
    if (dist(m, home) > 500) { m.returning = true; m.target = null; return; }
    if (dist(m, target) > t.range) moveToward(m, target, t.speed, dt);
    else if (now - m.lastAtk >= t.cd) { m.lastAtk = now; damagePlayer(target, t.atk, m); }
    return;
  }

  // เดินเล่นรอบจุดเกิด
  if (!m.wander && Math.random() < 0.02) {
    m.wander = {
      x: m.homeX + rand(-120, 120),
      y: clamp(m.homeY + rand(-120, 120), WORLD.minY, WORLD.maxY),
    };
  }
  if (m.wander && moveToward(m, m.wander, t.speed * 0.5, dt) < 5) m.wander = null;
}

// ---------------- การเชื่อมต่อของผู้เล่น ----------------
io.on('connection', (socket) => {
  socket.on('join', (data) => {
    if (players.has(socket.id)) return;
    const name = String((data && data.name) || '').replace(/\s+/g, ' ').trim().slice(0, 16);
    if (!name) return;
    const cls = data && CLASSES[data.cls] ? data.cls : 'swordsman';

    const p = {
      id: socket.id, name, cls, level: 1, exp: 0, rank: RANKS[0].name,
      x: SPAWN.x + rand(-60, 60), y: SPAWN.y + rand(-60, 60),
      input: { x: 0, y: 0 }, lastAtk: 0, lastSkill: 0, lastChat: 0, lastWarn: 0,
      dead: false, respawnAt: 0,
    };
    p.hp = maxHpOf(p);
    players.set(socket.id, p);

    socket.emit('joined', { id: socket.id });
    systemMsg(`${name} (${CLASSES[cls].name}) เข้าสู่กรุงศรีอยุธยา`);
    if (bossAlive) socket.emit('banner', 'แม่ทัพข้าศึกกำลังบุกอยู่ที่ป่าลึก!');
  });

  socket.on('input', (v) => {
    const p = players.get(socket.id);
    if (!p || !v) return;
    let x = clamp(Number(v.x) || 0, -1, 1);
    let y = clamp(Number(v.y) || 0, -1, 1);
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    p.input = { x, y };
  });

  const warnSafeZone = (p, now) => {
    if (now - p.lastWarn < 1500) return;
    p.lastWarn = now;
    socket.emit('fx', { t: 'num', x: p.x, y: p.y - 40, v: 'เขตปลอดภัย ห้ามต่อสู้', c: '#9fd3ff' });
  };

  socket.on('attack', () => {
    const p = players.get(socket.id);
    if (!p || p.dead) return;
    const c = CLASSES[p.cls];
    const now = Date.now();
    if (now - p.lastAtk < c.cd) return;
    if (inSafeZone(p)) return warnSafeZone(p, now);

    const target = nearestMonster(p, c.range);
    if (!target) return;
    p.lastAtk = now;

    if (p.cls === 'swordsman') {
      fx({ t: 'ring', x: target.x, y: target.y, r: 30, c: '#ffffff' });
    } else {
      fx({ t: 'arrow', x1: p.x, y1: p.y, x2: target.x, y2: target.y, c: p.cls === 'healer' ? '#7dff9a' : '#f5e6c8' });
    }
    damageMonster(target, p, atkOf(p));
  });

  socket.on('skill', () => {
    const p = players.get(socket.id);
    if (!p || p.dead) return;
    const c = CLASSES[p.cls];
    const now = Date.now();
    if (now - p.lastSkill < c.skillCd) return;

    if (p.cls === 'healer') {
      // ฮีลตัวเองและเพื่อนรอบตัว (ใช้ในเมืองได้)
      const amount = 30 + p.level * 6;
      for (const o of players.values()) {
        if (o.dead || dist(o, p) > 220) continue;
        o.hp = Math.min(maxHpOf(o), o.hp + amount);
        fx({ t: 'num', x: o.x, y: o.y - 10, v: `+${amount}`, c: '#7dff9a' });
      }
      fx({ t: 'ring', x: p.x, y: p.y, r: 220, c: '#7dff9a' });
    } else {
      if (inSafeZone(p)) return warnSafeZone(p, now);

      if (p.cls === 'swordsman') {
        // ฟันวงกว้างรอบตัว
        const hits = [...monsters.values()].filter((m) => dist(m, p) - MONSTER_TYPES[m.type].r <= 110);
        if (!hits.length) return;
        fx({ t: 'ring', x: p.x, y: p.y, r: 110, c: '#ff6b6b' });
        hits.forEach((m) => damageMonster(m, p, atkOf(p) * 1.6));
      } else if (p.cls === 'archer') {
        // ยิงพร้อมกัน 3 ดอก
        const hits = [...monsters.values()]
          .filter((m) => dist(m, p) - MONSTER_TYPES[m.type].r <= c.range)
          .sort((a, b) => dist(a, p) - dist(b, p))
          .slice(0, 3);
        if (!hits.length) return;
        hits.forEach((m) => {
          fx({ t: 'arrow', x1: p.x, y1: p.y, x2: m.x, y2: m.y, c: '#ffd23f' });
          damageMonster(m, p, atkOf(p) * 1.3);
        });
      }
    }
    p.lastSkill = now;
    socket.emit('skillCd', c.skillCd);
  });

  socket.on('chat', (text) => {
    const p = players.get(socket.id);
    if (!p) return;
    const now = Date.now();
    if (now - p.lastChat < 800) return; // กันสแปม
    p.lastChat = now;
    const t = String(text || '').trim().slice(0, 120);
    if (t) io.emit('chat', { name: `[${p.rank}] ${p.name}`, text: t });
  });

  socket.on('disconnect', () => {
    const p = players.get(socket.id);
    if (p) {
      players.delete(socket.id);
      systemMsg(`${p.name} ออกจากเกม`);
    }
  });
});

// ---------------- ลูปหลักของเกม ----------------
function snapshot() {
  return {
    players: [...players.values()].map((p) => ({
      id: p.id, name: p.name, cls: p.cls, rank: p.rank, level: p.level,
      x: Math.round(p.x), y: Math.round(p.y),
      hp: Math.ceil(p.hp), maxHp: maxHpOf(p),
      exp: p.exp, next: expToNext(p.level), dead: p.dead,
    })),
    monsters: [...monsters.values()].map((m) => ({
      id: m.id, type: m.type, x: Math.round(m.x), y: Math.round(m.y),
      hp: Math.max(0, Math.ceil(m.hp)), maxHp: m.maxHp,
    })),
  };
}

let lastTick = Date.now();
let regenAcc = 0;

setInterval(() => {
  const now = Date.now();
  const dt = (now - lastTick) / 1000;
  lastTick = now;
  regenAcc += dt;
  const doRegen = regenAcc >= 1;
  if (doRegen) regenAcc -= 1;

  for (const p of players.values()) {
    if (p.dead) {
      if (now >= p.respawnAt) {
        p.dead = false;
        p.hp = maxHpOf(p);
        p.x = SPAWN.x;
        p.y = SPAWN.y;
      }
      continue;
    }
    const sp = CLASSES[p.cls].speed;
    p.x = clamp(p.x + p.input.x * sp * dt, 20, WORLD.w - 20);
    p.y = clamp(p.y + p.input.y * sp * dt, WORLD.minY, WORLD.maxY);
    if (doRegen) {
      const max = maxHpOf(p);
      p.hp = Math.min(max, p.hp + max * (inSafeZone(p) ? 0.08 : 0.01));
    }
  }

  for (const m of monsters.values()) updateMonster(m, dt, now);
  if (!bossAlive && now - lastBossAt >= BOSS_INTERVAL_MS) spawnBoss();

  io.emit('state', snapshot());
}, TICK_MS);

server.listen(PORT, () => console.log(`ศึกกรุงศรี ออนไลน์ เปิดที่พอร์ต ${PORT}`));
