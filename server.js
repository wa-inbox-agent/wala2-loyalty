// ولاء: multi-business loyalty app. Stamps or points, branches, staff, anti-fraud log,
// reports, WhatsApp outbox (ready to connect), free persistence via private GitHub backup.
// No dependencies. Node 22.5+ (built-in node:sqlite and fetch).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data.db');
const GH_TOKEN = process.env.GH_TOKEN || '';
const GH_REPO = process.env.GH_DATA_REPO || '';          // e.g. owner/private-repo
const GH_FILE = process.env.GH_DATA_FILE || 'backup.json';
const WA_TOKEN = process.env.WA_TOKEN || '';              // WhatsApp Cloud API token (later)
const WA_PHONE_ID = process.env.WA_PHONE_ID || '';        // WhatsApp phone number id (later)

const db = new DatabaseSync(DB_FILE);
db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS businesses(
  id INTEGER PRIMARY KEY, slug TEXT UNIQUE, name TEXT, phone TEXT UNIQUE,
  salt TEXT, hash TEXT, rsalt TEXT, rhash TEXT,
  mode TEXT DEFAULT 'stamps', goal INTEGER DEFAULT 10, rate REAL DEFAULT 1, reward TEXT,
  color TEXT DEFAULT '#0f766e', cooldown_min INTEGER DEFAULT 30, daily_cap INTEGER DEFAULT 3,
  wa_enabled INTEGER DEFAULT 0, wa_json TEXT DEFAULT '{}', created INTEGER);
CREATE TABLE IF NOT EXISTS branches(id INTEGER PRIMARY KEY, biz INTEGER, name TEXT);
CREATE TABLE IF NOT EXISTS staff(
  id INTEGER PRIMARY KEY, biz INTEGER, name TEXT, phone TEXT, salt TEXT, hash TEXT,
  branch INTEGER, active INTEGER DEFAULT 1, created INTEGER, UNIQUE(biz, phone));
CREATE TABLE IF NOT EXISTS customers(
  id INTEGER PRIMARY KEY, biz INTEGER, phone TEXT, name TEXT, balance INTEGER DEFAULT 0,
  visits INTEGER DEFAULT 0, rewards INTEGER DEFAULT 0, created INTEGER, last_visit INTEGER,
  UNIQUE(biz, phone));
CREATE TABLE IF NOT EXISTS tx(
  id INTEGER PRIMARY KEY, biz INTEGER, cust INTEGER, kind TEXT, amount INTEGER, spend REAL,
  staff INTEGER, branch INTEGER, voided INTEGER DEFAULT 0, note TEXT, created INTEGER);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, biz INTEGER, staff INTEGER, created INTEGER);
CREATE TABLE IF NOT EXISTS outbox(
  id INTEGER PRIMARY KEY, biz INTEGER, cust INTEGER, phone TEXT, event TEXT, text TEXT,
  template TEXT, params TEXT, status TEXT DEFAULT 'queued', error TEXT, created INTEGER, sent INTEGER);
CREATE INDEX IF NOT EXISTS tx_biz ON tx(biz, created);
CREATE INDEX IF NOT EXISTS cust_biz ON customers(biz, last_visit);
`);
const TABLES = ['businesses', 'branches', 'staff', 'customers', 'tx', 'sessions', 'outbox'];

// ---------- helpers ----------
const now = () => Date.now();
const DAY = 864e5;
const digits = s => String(s || '').replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/\D/g, '');
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const send = (res, code, obj, type) => { res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8' }); res.end(type ? obj : JSON.stringify(obj)); };
const fail = (res, code, msg) => send(res, code, { error: msg });
const q1 = (sql, ...a) => db.prepare(sql).get(...a);
const qa = (sql, ...a) => db.prepare(sql).all(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);
const makeCode = () => crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 hex chars
const hits = new Map();
function limited(ip, key, max, windowMs) {
  const k = key + ip, t = now();
  const arr = (hits.get(k) || []).filter(x => t - x < windowMs);
  arr.push(t); hits.set(k, arr);
  return arr.length > max;
}
function body(req) {
  return new Promise((ok, no) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 50000) { no(new Error('big')); req.destroy(); } });
    req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch (e) { no(e); } });
  });
}
function slugify(name) {
  let s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!s) s = 'shop';
  let out = s, i = 1;
  while (q1('SELECT 1 FROM businesses WHERE slug=?', out)) out = s + '-' + (++i + Math.floor(Math.random() * 90));
  return out;
}
const DEFAULT_WA = {
  welcome: { on: true, text: 'أهلا {name} في {business}! سجلنا أول زيارة ليك. باقي {left} على {reward}.', template: '' },
  earn: { on: true, text: 'شكرا لزيارتك {business}. رصيدك {balance} من {goal}. باقي {left} على {reward}.', template: '' },
  reward: { on: true, text: 'مبروك {name}! استحقيت {reward} من {business}. استلمها في زيارتك الجاية.', template: '' },
  inactive: { on: true, text: 'وحشتنا يا {name}! رصيدك عندنا {balance} من {goal}. ننتظرك في {business}.', template: '' }
};
function waCfg(b) {
  let j = {}; try { j = JSON.parse(b.wa_json || '{}'); } catch {}
  const out = {};
  for (const k of Object.keys(DEFAULT_WA)) out[k] = { ...DEFAULT_WA[k], ...(j[k] || {}) };
  return out;
}
const publicBiz = b => ({ name: b.name, slug: b.slug, mode: b.mode, goal: b.goal, rate: b.rate, reward: b.reward, color: b.color });
function cardOf(b, c) {
  const goal = b.goal;
  return { phone: c.phone, name: c.name, balance: c.balance, goal, ready: Math.floor(c.balance / goal),
    visits: c.visits, rewards: c.rewards, progress: c.balance >= goal ? goal : c.balance };
}

// ---------- auth ----------
function newSession(bizId, staffId) {
  const token = crypto.randomBytes(24).toString('hex');
  run('INSERT INTO sessions VALUES(?,?,?,?)', token, bizId, staffId || null, now());
  return token;
}
function auth(req) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  if (!t) return null;
  const s = q1('SELECT * FROM sessions WHERE token=?', t);
  if (!s) return null;
  const b = q1('SELECT * FROM businesses WHERE id=?', s.biz);
  if (!b) return null;
  if (s.staff) {
    const st = q1('SELECT * FROM staff WHERE id=? AND active=1', s.staff);
    if (!st) return null;
    return { b, role: 'staff', staff: st };
  }
  return { b, role: 'owner', staff: null };
}
const need = (req, res, owner) => {
  const a = auth(req);
  if (!a) { fail(res, 401, 'سجل دخول'); return null; }
  if (owner && a.role !== 'owner') { fail(res, 403, 'الصلاحية دي لصاحب النشاط فقط'); return null; }
  return a;
};

// ---------- WhatsApp outbox ----------
function fill(tpl, b, c) {
  const left = Math.max(0, b.goal - (c.balance % b.goal || (c.balance >= b.goal ? b.goal : 0)));
  const map = { name: c.name || 'يا غالي', business: b.name, balance: c.balance, goal: b.goal, reward: b.reward, left: c.balance >= b.goal ? 0 : b.goal - c.balance };
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (k in map ? map[k] : ''));
}
function queueMsg(b, c, event) {
  if (!b.wa_enabled) return;
  const cfg = waCfg(b)[event];
  if (!cfg || !cfg.on) return;
  const params = JSON.stringify([c.name || 'يا غالي', String(c.balance), String(b.goal), b.reward, b.name]);
  run('INSERT INTO outbox(biz,cust,phone,event,text,template,params,created) VALUES(?,?,?,?,?,?,?,?)',
    b.id, c.id, c.phone, event, fill(cfg.text, b, c), cfg.template || '', params, now());
}
async function flushOutbox(limit = 50) {
  if (!WA_TOKEN || !WA_PHONE_ID) return { sent: 0, connected: false };
  const rows = qa("SELECT * FROM outbox WHERE status='queued' ORDER BY id LIMIT ?", limit);
  let sent = 0;
  for (const m of rows) {
    const payload = m.template
      ? { messaging_product: 'whatsapp', to: m.phone, type: 'template', template: { name: m.template, language: { code: 'ar' }, components: [{ type: 'body', parameters: JSON.parse(m.params).map(t => ({ type: 'text', text: t })) }] } }
      : { messaging_product: 'whatsapp', to: m.phone, type: 'text', text: { body: m.text } };
    try {
      const r = await fetch(`https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`, { method: 'POST', headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const j = await r.json();
      if (r.ok) { run("UPDATE outbox SET status='sent', sent=? WHERE id=?", now(), m.id); sent++; }
      else run("UPDATE outbox SET status='failed', error=? WHERE id=?", String((j.error && j.error.message) || r.status).slice(0, 200), m.id);
    } catch (e) { run("UPDATE outbox SET status='failed', error=? WHERE id=?", String(e.message).slice(0, 200), m.id); }
    await new Promise(r => setTimeout(r, 300));
  }
  return { sent, connected: true };
}
setInterval(() => flushOutbox().catch(() => {}), 60000);

// ---------- persistence (free): private GitHub repo backup ----------
let dirty = false, lastSha = null, lastBackup = 0, backupErr = '';
const ghHeaders = { Authorization: 'Bearer ' + GH_TOKEN, 'User-Agent': 'wala2', Accept: 'application/vnd.github+json' };
const backupOn = () => !!(GH_TOKEN && GH_REPO);
async function restore() {
  if (!backupOn()) return;
  if (q1('SELECT COUNT(*) c FROM businesses').c > 0) return;
  try {
    const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${GH_FILE}`, { headers: ghHeaders });
    if (r.status === 404) return;
    const meta = await r.json();
    lastSha = meta.sha;
    const raw = await fetch(meta.download_url || `https://api.github.com/repos/${GH_REPO}/contents/${GH_FILE}`, { headers: meta.download_url ? {} : { ...ghHeaders, Accept: 'application/vnd.github.raw+json' } });
    const data = JSON.parse(await raw.text());
    db.exec('BEGIN');
    for (const t of TABLES) for (const row of data[t] || []) {
      const cols = Object.keys(row);
      db.prepare(`INSERT OR REPLACE INTO ${t}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`).run(...cols.map(c => row[c]));
    }
    db.exec('COMMIT');
    console.log('restored from backup', Object.fromEntries(TABLES.map(t => [t, (data[t] || []).length])));
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} console.log('restore failed', e.message); backupErr = 'restore: ' + e.message; }
}
async function backup() {
  if (!backupOn() || !dirty) return;
  dirty = false;
  try {
    const data = {}; for (const t of TABLES) data[t] = qa(`SELECT * FROM ${t}`);
    const content = Buffer.from(JSON.stringify(data)).toString('base64');
    const url = `https://api.github.com/repos/${GH_REPO}/contents/${GH_FILE}`;
    if (!lastSha) { const g = await fetch(url, { headers: ghHeaders }); if (g.ok) lastSha = (await g.json()).sha; }
    let r = await fetch(url, { method: 'PUT', headers: ghHeaders, body: JSON.stringify({ message: 'backup ' + new Date().toISOString(), content, ...(lastSha ? { sha: lastSha } : {}) }) });
    if (r.status === 409 || r.status === 422) { const g = await fetch(url, { headers: ghHeaders }); if (g.ok) { lastSha = (await g.json()).sha; r = await fetch(url, { method: 'PUT', headers: ghHeaders, body: JSON.stringify({ message: 'backup ' + new Date().toISOString(), content, sha: lastSha }) }); } }
    if (!r.ok) throw new Error('github ' + r.status);
    lastSha = (await r.json()).content.sha; lastBackup = now(); backupErr = '';
  } catch (e) { dirty = true; backupErr = e.message; console.log('backup failed', e.message); }
}
setInterval(backup, 20000);
let closing = false;
process.on('SIGTERM', async () => { if (closing) return; closing = true; await backup(); process.exit(0); });

// ---------- routes ----------
const routes = {
  async 'POST /api/signup'(req, res, ip) {
    if (limited(ip, 'signup', 10, 3600e3)) return fail(res, 429, 'محاولات كتير، جرب بعد شوية');
    const d = await body(req);
    const name = String(d.name || '').trim().slice(0, 60);
    const phone = digits(d.phone), pw = String(d.password || '');
    if (!name) return fail(res, 400, 'اكتب اسم النشاط');
    if (phone.length < 8) return fail(res, 400, 'رقم الجوال غير صحيح');
    if (pw.length < 6) return fail(res, 400, 'كلمة السر لازم 6 حروف أو أرقام على الأقل');
    if (q1('SELECT 1 FROM businesses WHERE phone=?', phone)) return fail(res, 409, 'الرقم ده مسجل قبل كده، سجل دخول');
    const mode = d.mode === 'points' ? 'points' : 'stamps';
    const goal = clamp(parseInt(d.goal) || 10, 2, 100000);
    const rate = clamp(parseFloat(d.rate) || 1, 0.001, 1000);
    const reward = String(d.reward || 'مكافأة مجانية').trim().slice(0, 80);
    const salt = crypto.randomBytes(16).toString('hex'), rsalt = crypto.randomBytes(16).toString('hex');
    const code = makeCode();
    const r = run('INSERT INTO businesses(slug,name,phone,salt,hash,rsalt,rhash,mode,goal,rate,reward,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      slugify(d.slug), name, phone, salt, hashPw(pw, salt), rsalt, hashPw(code, rsalt), mode, goal, rate, reward, now());
    const id = Number(r.lastInsertRowid);
    run('INSERT INTO branches(biz,name) VALUES(?,?)', id, 'الفرع الرئيسي');
    send(res, 200, { token: newSession(id), slug: q1('SELECT slug FROM businesses WHERE id=?', id).slug, recovery_code: code });
  },
  async 'POST /api/login'(req, res, ip) {
    if (limited(ip, 'login', 15, 600e3)) return fail(res, 429, 'محاولات كتير، جرب بعد شوية');
    const d = await body(req);
    const b = q1('SELECT * FROM businesses WHERE phone=?', digits(d.phone));
    if (!b || hashPw(d.password, b.salt) !== b.hash) return fail(res, 401, 'الرقم أو كلمة السر غلط');
    send(res, 200, { token: newSession(b.id) });
  },
  async 'POST /api/staff-login'(req, res, ip) {
    if (limited(ip, 'slogin', 20, 600e3)) return fail(res, 429, 'محاولات كتير، جرب بعد شوية');
    const d = await body(req);
    const b = q1('SELECT * FROM businesses WHERE slug=?', String(d.slug || '').trim().toLowerCase());
    const s = b && q1('SELECT * FROM staff WHERE biz=? AND phone=? AND active=1', b.id, digits(d.phone));
    if (!s || hashPw(d.pin, s.salt) !== s.hash) return fail(res, 401, 'البيانات غلط');
    send(res, 200, { token: newSession(b.id, s.id) });
  },
  async 'POST /api/reset'(req, res, ip) {
    if (limited(ip, 'reset', 8, 3600e3)) return fail(res, 429, 'محاولات كتير، جرب بعد ساعة');
    const d = await body(req);
    const b = q1('SELECT * FROM businesses WHERE phone=?', digits(d.phone));
    if (!b || hashPw(String(d.code || '').trim().toUpperCase(), b.rsalt) !== b.rhash) return fail(res, 401, 'الرقم أو كود الاسترجاع غلط');
    const pw = String(d.password || '');
    if (pw.length < 6) return fail(res, 400, 'كلمة السر الجديدة لازم 6 على الأقل');
    const salt = crypto.randomBytes(16).toString('hex'), rsalt = crypto.randomBytes(16).toString('hex'), code = makeCode();
    run('UPDATE businesses SET salt=?,hash=?,rsalt=?,rhash=? WHERE id=?', salt, hashPw(pw, salt), rsalt, hashPw(code, rsalt), b.id);
    run('DELETE FROM sessions WHERE biz=? AND staff IS NULL', b.id);
    send(res, 200, { token: newSession(b.id), recovery_code: code });
  },
  async 'GET /api/me'(req, res) {
    const a = need(req, res); if (!a) return; const b = a.b;
    const st = q1('SELECT COUNT(*) c FROM customers WHERE biz=?', b.id);
    const week = q1("SELECT COUNT(*) c FROM tx WHERE biz=? AND kind='add' AND voided=0 AND created>?", b.id, now() - 7 * DAY);
    const mine = a.staff ? q1("SELECT COUNT(*) c FROM tx WHERE biz=? AND staff=? AND kind='add' AND voided=0 AND created>?", b.id, a.staff.id, now() - DAY).c : null;
    send(res, 200, { ...publicBiz(b), role: a.role, staff_name: a.staff && a.staff.name, staff_branch: a.staff && a.staff.branch,
      branches: qa('SELECT id,name FROM branches WHERE biz=? ORDER BY id', b.id),
      cooldown_min: b.cooldown_min, daily_cap: b.daily_cap, wa_enabled: !!b.wa_enabled,
      stats: { customers: st.c, week: week.c, mine_today: mine } });
  },
  async 'PUT /api/settings'(req, res) {
    const a = need(req, res, true); if (!a) return; const b = a.b;
    const d = await body(req);
    run('UPDATE businesses SET name=?,mode=?,goal=?,rate=?,reward=?,color=?,cooldown_min=?,daily_cap=? WHERE id=?',
      String(d.name || b.name).trim().slice(0, 60), d.mode === 'points' ? 'points' : 'stamps',
      clamp(parseInt(d.goal) || b.goal, 2, 100000), clamp(parseFloat(d.rate) || b.rate, 0.001, 1000),
      String(d.reward || b.reward).trim().slice(0, 80), /^#[0-9a-fA-F]{6}$/.test(d.color) ? d.color : b.color,
      clamp(d.cooldown_min === '' || d.cooldown_min == null ? b.cooldown_min : parseInt(d.cooldown_min) || 0, 0, 1440),
      clamp(parseInt(d.daily_cap) || b.daily_cap, 1, 100), b.id);
    send(res, 200, { ok: true });
  },
  // ----- branches & staff (owner)
  async 'POST /api/branches'(req, res) {
    const a = need(req, res, true); if (!a) return; const d = await body(req);
    const name = String(d.name || '').trim().slice(0, 40); if (!name) return fail(res, 400, 'اكتب اسم الفرع');
    run('INSERT INTO branches(biz,name) VALUES(?,?)', a.b.id, name); send(res, 200, { ok: true });
  },
  async 'DELETE /api/branches'(req, res, ip, url) {
    const a = need(req, res, true); if (!a) return; const id = parseInt(url.searchParams.get('id'));
    if (q1('SELECT COUNT(*) c FROM branches WHERE biz=?', a.b.id).c <= 1) return fail(res, 400, 'لازم يفضل فرع واحد على الأقل');
    run('DELETE FROM branches WHERE id=? AND biz=?', id, a.b.id); run('UPDATE staff SET branch=NULL WHERE branch=? AND biz=?', id, a.b.id);
    send(res, 200, { ok: true });
  },
  async 'GET /api/staff'(req, res) {
    const a = need(req, res, true); if (!a) return;
    send(res, 200, { staff: qa('SELECT id,name,phone,branch,active FROM staff WHERE biz=? ORDER BY id', a.b.id) });
  },
  async 'POST /api/staff'(req, res) {
    const a = need(req, res, true); if (!a) return; const d = await body(req);
    const name = String(d.name || '').trim().slice(0, 40), phone = digits(d.phone), pin = String(d.pin || '');
    if (!name || phone.length < 8) return fail(res, 400, 'اكتب اسم الموظف ورقم جواله');
    if (pin.length < 4) return fail(res, 400, 'الرقم السري لازم 4 أرقام أو أكتر');
    if (q1('SELECT 1 FROM staff WHERE biz=? AND phone=?', a.b.id, phone)) return fail(res, 409, 'الموظف ده مضاف قبل كده');
    const salt = crypto.randomBytes(16).toString('hex');
    const br = d.branch && q1('SELECT id FROM branches WHERE id=? AND biz=?', parseInt(d.branch), a.b.id);
    run('INSERT INTO staff(biz,name,phone,salt,hash,branch,created) VALUES(?,?,?,?,?,?,?)', a.b.id, name, phone, salt, hashPw(pin, salt), br ? br.id : null, now());
    send(res, 200, { ok: true });
  },
  async 'DELETE /api/staff'(req, res, ip, url) {
    const a = need(req, res, true); if (!a) return; const id = parseInt(url.searchParams.get('id'));
    run('UPDATE staff SET active=0 WHERE id=? AND biz=?', id, a.b.id); run('DELETE FROM sessions WHERE staff=?', id);
    send(res, 200, { ok: true });
  },
  // ----- customers & operations
  async 'GET /api/customers'(req, res, ip, url) {
    const a = need(req, res); if (!a) return; const b = a.b;
    const qd = digits(url.searchParams.get('q'));
    const rows = qd ? qa('SELECT * FROM customers WHERE biz=? AND phone LIKE ? ORDER BY last_visit DESC LIMIT 100', b.id, '%' + qd + '%')
      : qa('SELECT * FROM customers WHERE biz=? ORDER BY last_visit DESC LIMIT 200', b.id);
    send(res, 200, { customers: rows.map(c => ({ ...cardOf(b, c), last_visit: c.last_visit })) });
  },
  async 'POST /api/add'(req, res) {
    const a = need(req, res); if (!a) return; const b = a.b;
    const d = await body(req);
    const phone = digits(d.phone);
    if (phone.length < 8) return fail(res, 400, 'رقم الجوال غير صحيح');
    let amount = 1, spend = null;
    if (b.mode === 'points') {
      spend = parseFloat(d.spend);
      if (!(spend > 0)) return fail(res, 400, 'اكتب مبلغ الفاتورة');
      amount = Math.floor(spend * b.rate);
      if (amount < 1) return fail(res, 400, 'المبلغ صغير ومش هيدي نقاط');
    }
    const staffId = a.staff ? a.staff.id : null;
    let branch = a.staff ? a.staff.branch : (parseInt(d.branch) || null);
    if (branch && !q1('SELECT 1 FROM branches WHERE id=? AND biz=?', branch, b.id)) branch = null;
    let c = q1('SELECT * FROM customers WHERE biz=? AND phone=?', b.id, phone);
    const blocked = reason => { if (c) run("INSERT INTO tx(biz,cust,kind,amount,staff,branch,note,created) VALUES(?,?,'blocked',0,?,?,?,?)", b.id, c.id, staffId, branch, reason, now()); return fail(res, 429, reason); };
    if (c) {
      if (b.cooldown_min > 0 && c.last_visit && now() - c.last_visit < b.cooldown_min * 60000)
        return blocked(`العميل ده اتسجله من أقل من ${b.cooldown_min} دقيقة`);
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      if (q1("SELECT COUNT(*) c FROM tx WHERE cust=? AND kind='add' AND voided=0 AND created>=?", c.id, todayStart.getTime()).c >= b.daily_cap)
        return blocked(`وصل الحد اليومي (${b.daily_cap}) للعميل ده`);
    } else {
      run('INSERT INTO customers(biz,phone,name,created) VALUES(?,?,?,?)', b.id, phone, String(d.name || '').slice(0, 40), now());
      c = q1('SELECT * FROM customers WHERE biz=? AND phone=?', b.id, phone);
    }
    if (d.name && !c.name) { run('UPDATE customers SET name=? WHERE id=?', String(d.name).slice(0, 40), c.id); c.name = String(d.name).slice(0, 40); }
    const first = c.visits === 0, before = Math.floor(c.balance / b.goal);
    run('UPDATE customers SET balance=balance+?, visits=visits+1, last_visit=? WHERE id=?', amount, now(), c.id);
    run("INSERT INTO tx(biz,cust,kind,amount,spend,staff,branch,created) VALUES(?,?,'add',?,?,?,?,?)", b.id, c.id, amount, spend, staffId, branch, now());
    c = q1('SELECT * FROM customers WHERE id=?', c.id);
    const unlocked = Math.floor(c.balance / b.goal) > before;
    queueMsg(b, c, unlocked ? 'reward' : first ? 'welcome' : 'earn');
    flushOutbox().catch(() => {});
    send(res, 200, { customer: cardOf(b, c), added: amount, unlocked });
  },
  async 'POST /api/redeem'(req, res) {
    const a = need(req, res); if (!a) return; const b = a.b; const d = await body(req);
    const c = q1('SELECT * FROM customers WHERE biz=? AND phone=?', b.id, digits(d.phone));
    if (!c) return fail(res, 404, 'العميل مش موجود');
    if (c.balance < b.goal) return fail(res, 400, 'رصيد العميل لسه مكملش المكافأة');
    run('UPDATE customers SET balance=balance-?, rewards=rewards+1 WHERE id=?', b.goal, c.id);
    run("INSERT INTO tx(biz,cust,kind,amount,staff,branch,created) VALUES(?,?,'redeem',?,?,?,?)", b.id, c.id, b.goal, a.staff ? a.staff.id : null, a.staff ? a.staff.branch : null, now());
    send(res, 200, { customer: cardOf(b, q1('SELECT * FROM customers WHERE id=?', c.id)) });
  },
  async 'POST /api/void'(req, res) {
    const a = need(req, res, true); if (!a) return; const b = a.b; const d = await body(req);
    const t = q1('SELECT * FROM tx WHERE id=? AND biz=?', parseInt(d.id), b.id);
    if (!t || t.voided || !['add', 'redeem'].includes(t.kind)) return fail(res, 400, 'مينفعش تلغي العملية دي');
    run('UPDATE tx SET voided=1 WHERE id=?', t.id);
    if (t.kind === 'add') run('UPDATE customers SET balance=MAX(0,balance-?), visits=MAX(0,visits-1) WHERE id=?', t.amount, t.cust);
    else run('UPDATE customers SET balance=balance+?, rewards=MAX(0,rewards-1) WHERE id=?', t.amount, t.cust);
    send(res, 200, { ok: true });
  },
  async 'GET /api/log'(req, res) {
    const a = need(req, res, true); if (!a) return;
    const rows = qa(`SELECT t.id,t.kind,t.amount,t.spend,t.voided,t.note,t.created,c.phone,c.name cname,s.name sname,br.name bname
      FROM tx t LEFT JOIN customers c ON c.id=t.cust LEFT JOIN staff s ON s.id=t.staff LEFT JOIN branches br ON br.id=t.branch
      WHERE t.biz=? ORDER BY t.id DESC LIMIT 100`, a.b.id);
    send(res, 200, { log: rows });
  },
  async 'GET /api/reports'(req, res) {
    const a = need(req, res, true); if (!a) return; const b = a.b;
    const days = []; const start = new Date(); start.setHours(0, 0, 0, 0);
    for (let i = 13; i >= 0; i--) {
      const s = start.getTime() - i * DAY;
      days.push({ day: s, n: q1("SELECT COUNT(*) c FROM tx WHERE biz=? AND kind='add' AND voided=0 AND created>=? AND created<?", b.id, s, s + DAY).c });
    }
    const tot = q1(`SELECT COUNT(*) customers, COALESCE(SUM(rewards),0) rewards, COALESCE(SUM(visits),0) visits FROM customers WHERE biz=?`, b.id);
    const newWeek = q1('SELECT COUNT(*) c FROM customers WHERE biz=? AND created>?', b.id, now() - 7 * DAY).c;
    const returning = q1('SELECT COUNT(*) c FROM customers WHERE biz=? AND visits>=2', b.id).c;
    const inactive = q1('SELECT COUNT(*) c FROM customers WHERE biz=? AND last_visit<?', b.id, now() - 30 * DAY).c;
    const revenue = q1("SELECT COALESCE(SUM(spend),0) s FROM tx WHERE biz=? AND kind='add' AND voided=0 AND created>?", b.id, now() - 30 * DAY).s;
    const top = qa('SELECT phone,name,visits,balance FROM customers WHERE biz=? ORDER BY visits DESC LIMIT 5', b.id);
    const byStaff = qa(`SELECT COALESCE(s.name,'صاحب النشاط') name, COUNT(*) n FROM tx t LEFT JOIN staff s ON s.id=t.staff WHERE t.biz=? AND t.kind='add' AND t.voided=0 AND t.created>? GROUP BY t.staff ORDER BY n DESC`, b.id, now() - 30 * DAY);
    const byBranch = qa(`SELECT COALESCE(br.name,'بدون فرع') name, COUNT(*) n FROM tx t LEFT JOIN branches br ON br.id=t.branch WHERE t.biz=? AND t.kind='add' AND t.voided=0 AND t.created>? GROUP BY t.branch ORDER BY n DESC`, b.id, now() - 30 * DAY);
    const blocked = q1("SELECT COUNT(*) c FROM tx WHERE biz=? AND kind='blocked' AND created>?", b.id, now() - 30 * DAY).c;
    send(res, 200, { days, totals: { ...tot, newWeek, returning, inactive, revenue, blocked }, top, byStaff, byBranch });
  },
  async 'GET /api/export'(req, res) {
    const a = need(req, res, true); if (!a) return;
    const rows = qa('SELECT phone,name,balance,visits,rewards,created,last_visit FROM customers WHERE biz=? ORDER BY id', a.b.id);
    const f = t => t ? new Date(t).toISOString().slice(0, 10) : '';
    const esc = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const csv = '\ufeff' + 'phone,name,balance,visits,rewards,joined,last_visit\n' + rows.map(r => [r.phone, r.name, r.balance, r.visits, r.rewards, f(r.created), f(r.last_visit)].map(esc).join(',')).join('\n');
    send(res, 200, csv, 'text/csv; charset=utf-8');
  },
  // ----- WhatsApp layer
  async 'GET /api/whatsapp'(req, res) {
    const a = need(req, res, true); if (!a) return; const b = a.b;
    const counts = Object.fromEntries(qa('SELECT status, COUNT(*) c FROM outbox WHERE biz=? GROUP BY status', b.id).map(r => [r.status, r.c]));
    send(res, 200, { connected: !!(WA_TOKEN && WA_PHONE_ID), enabled: !!b.wa_enabled, templates: waCfg(b), counts,
      outbox: qa('SELECT id,phone,event,text,status,error,created FROM outbox WHERE biz=? ORDER BY id DESC LIMIT 30', b.id) });
  },
  async 'PUT /api/whatsapp'(req, res) {
    const a = need(req, res, true); if (!a) return; const d = await body(req);
    const cfg = waCfg(a.b);
    for (const k of Object.keys(cfg)) if (d.templates && d.templates[k]) {
      const t = d.templates[k];
      cfg[k] = { on: !!t.on, text: String(t.text || cfg[k].text).slice(0, 500), template: String(t.template || '').replace(/[^a-z0-9_]/gi, '').slice(0, 60) };
    }
    run('UPDATE businesses SET wa_enabled=?, wa_json=? WHERE id=?', d.enabled ? 1 : 0, JSON.stringify(cfg), a.b.id);
    send(res, 200, { ok: true });
  },
  async 'POST /api/whatsapp/remind'(req, res) {
    const a = need(req, res, true); if (!a) return; const b = a.b;
    if (!b.wa_enabled) return fail(res, 400, 'فعّل رسائل واتساب الأول');
    const rows = qa(`SELECT * FROM customers WHERE biz=? AND last_visit<? AND id NOT IN
      (SELECT cust FROM outbox WHERE biz=? AND event='inactive' AND created>?) LIMIT 200`, b.id, now() - 30 * DAY, b.id, now() - 14 * DAY);
    for (const c of rows) queueMsg(b, c, 'inactive');
    flushOutbox().catch(() => {});
    send(res, 200, { queued: rows.length });
  },
  async 'GET /api/system'(req, res) {
    const a = need(req, res, true); if (!a) return;
    send(res, 200, { backup: backupOn(), last_backup: lastBackup, backup_error: backupErr, whatsapp_connected: !!(WA_TOKEN && WA_PHONE_ID) });
  },
  // ----- public customer card
  async 'GET /api/public'(req, res, ip, url) {
    const m = url.pathname.match(/^\/api\/public\/([^/]+)(\/card)?$/);
    const b = m && q1('SELECT * FROM businesses WHERE slug=?', m[1]);
    if (!b) return fail(res, 404, 'النشاط مش موجود');
    if (!m[2]) return send(res, 200, publicBiz(b));
    if (limited(ip, 'card', 60, 600e3)) return fail(res, 429, 'محاولات كتير');
    const c = q1('SELECT * FROM customers WHERE biz=? AND phone=?', b.id, digits(url.searchParams.get('phone')));
    send(res, 200, { business: publicBiz(b), card: c ? cardOf(b, c) : null });
  }
};

const INDEX = path.join(__dirname, 'index.html');
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  try {
    if (url.pathname === '/health') return send(res, 200, { ok: true });
    if (url.pathname.startsWith('/api/')) {
      const key = req.method + ' ' + (url.pathname.startsWith('/api/public') ? '/api/public' : url.pathname);
      const h = routes[key];
      if (!h) return fail(res, 404, 'غير موجود');
      await h(req, res, ip, url);
      if (req.method !== 'GET' && res.statusCode === 200) dirty = true;
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(INDEX).pipe(res);
  } catch (e) { console.log('err', req.url, e.message); if (!res.headersSent) fail(res, 400, 'طلب غير صحيح'); }
});
restore().finally(() => server.listen(PORT, () => console.log('listening', PORT, 'backup:', backupOn())));
