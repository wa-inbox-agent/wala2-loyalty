// Loyalty app: multi-business, stamps or points. No dependencies. Node 22+ (node:sqlite).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data.db');
const db = new DatabaseSync(DB_FILE);
db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS businesses(
  id INTEGER PRIMARY KEY, slug TEXT UNIQUE, name TEXT, phone TEXT UNIQUE,
  salt TEXT, hash TEXT, mode TEXT DEFAULT 'stamps', goal INTEGER DEFAULT 10,
  rate REAL DEFAULT 1, reward TEXT, color TEXT DEFAULT '#0f766e', created INTEGER);
CREATE TABLE IF NOT EXISTS customers(
  id INTEGER PRIMARY KEY, biz INTEGER, phone TEXT, name TEXT, balance INTEGER DEFAULT 0,
  visits INTEGER DEFAULT 0, rewards INTEGER DEFAULT 0, created INTEGER, last_visit INTEGER,
  UNIQUE(biz, phone));
CREATE TABLE IF NOT EXISTS tx(
  id INTEGER PRIMARY KEY, biz INTEGER, cust INTEGER, kind TEXT, amount INTEGER, spend REAL, created INTEGER);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, biz INTEGER, created INTEGER);
`);

const now = () => Date.now();
const digits = s => String(s || '').replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/\D/g, '');
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const fail = (res, code, msg) => send(res, code, { error: msg });

function slugify(name) {
  let s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!s) s = 'shop';
  let out = s, i = 1;
  while (db.prepare('SELECT 1 FROM businesses WHERE slug=?').get(out)) out = s + '-' + (++i + Math.floor(Math.random() * 90));
  return out;
}
function publicBiz(b) {
  return { name: b.name, slug: b.slug, mode: b.mode, goal: b.goal, rate: b.rate, reward: b.reward, color: b.color };
}
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
    req.on('data', c => { d += c; if (d.length > 20000) { no(new Error('big')); req.destroy(); } });
    req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch (e) { no(e); } });
  });
}
function auth(req) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  if (!t) return null;
  const s = db.prepare('SELECT biz FROM sessions WHERE token=?').get(t);
  return s ? db.prepare('SELECT * FROM businesses WHERE id=?').get(s.biz) : null;
}
function newSession(bizId) {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(token, bizId, now());
  return token;
}
function cardOf(b, c) {
  const goal = b.goal;
  return {
    phone: c.phone, name: c.name, balance: c.balance, goal,
    ready: Math.floor(c.balance / goal), visits: c.visits, rewards: c.rewards,
    progress: c.balance >= goal ? goal : c.balance
  };
}

const routes = {
  async 'POST /api/signup'(req, res, ip) {
    if (limited(ip, 'signup', 10, 3600e3)) return fail(res, 429, 'محاولات كتير، جرب بعد شوية');
    const d = await body(req);
    const name = String(d.name || '').trim().slice(0, 60);
    const phone = digits(d.phone);
    const pw = String(d.password || '');
    if (!name) return fail(res, 400, 'اكتب اسم النشاط');
    if (phone.length < 8) return fail(res, 400, 'رقم الجوال غير صحيح');
    if (pw.length < 6) return fail(res, 400, 'كلمة السر لازم 6 حروف أو أرقام على الأقل');
    if (db.prepare('SELECT 1 FROM businesses WHERE phone=?').get(phone)) return fail(res, 409, 'الرقم ده مسجل قبل كده، سجل دخول');
    const mode = d.mode === 'points' ? 'points' : 'stamps';
    const goal = clamp(parseInt(d.goal) || 10, 2, 100000);
    const rate = clamp(parseFloat(d.rate) || 1, 0.001, 1000);
    const reward = String(d.reward || 'مكافأة مجانية').trim().slice(0, 80);
    const salt = crypto.randomBytes(16).toString('hex');
    const slug = slugify(String(d.slug || ''));
    const r = db.prepare('INSERT INTO businesses(slug,name,phone,salt,hash,mode,goal,rate,reward,created) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(slug, name, phone, salt, hashPw(pw, salt), mode, goal, rate, reward, now());
    send(res, 200, { token: newSession(Number(r.lastInsertRowid)), slug });
  },
  async 'POST /api/login'(req, res, ip) {
    if (limited(ip, 'login', 15, 600e3)) return fail(res, 429, 'محاولات كتير، جرب بعد شوية');
    const d = await body(req);
    const b = db.prepare('SELECT * FROM businesses WHERE phone=?').get(digits(d.phone));
    if (!b || hashPw(String(d.password || ''), b.salt) !== b.hash) return fail(res, 401, 'الرقم أو كلمة السر غلط');
    send(res, 200, { token: newSession(b.id) });
  },
  async 'GET /api/me'(req, res) {
    const b = auth(req); if (!b) return fail(res, 401, 'سجل دخول');
    const st = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(rewards),0) r, COALESCE(SUM(visits),0) v FROM customers WHERE biz=?').get(b.id);
    const week = db.prepare("SELECT COUNT(*) c FROM tx WHERE biz=? AND kind='add' AND created>?").get(b.id, now() - 7 * 864e5);
    const inactive = db.prepare('SELECT COUNT(*) c FROM customers WHERE biz=? AND (last_visit IS NULL OR last_visit<?)').get(b.id, now() - 30 * 864e5);
    send(res, 200, { ...publicBiz(b), stats: { customers: st.c, rewards: st.r, visits: st.v, week: week.c, inactive: inactive.c } });
  },
  async 'PUT /api/settings'(req, res) {
    const b = auth(req); if (!b) return fail(res, 401, 'سجل دخول');
    const d = await body(req);
    const name = String(d.name || b.name).trim().slice(0, 60);
    const mode = d.mode === 'points' ? 'points' : 'stamps';
    const goal = clamp(parseInt(d.goal) || b.goal, 2, 100000);
    const rate = clamp(parseFloat(d.rate) || b.rate, 0.001, 1000);
    const reward = String(d.reward || b.reward).trim().slice(0, 80);
    const color = /^#[0-9a-fA-F]{6}$/.test(d.color) ? d.color : b.color;
    db.prepare('UPDATE businesses SET name=?,mode=?,goal=?,rate=?,reward=?,color=? WHERE id=?').run(name, mode, goal, rate, reward, color, b.id);
    send(res, 200, { ok: true });
  },
  async 'GET /api/customers'(req, res, ip, url) {
    const b = auth(req); if (!b) return fail(res, 401, 'سجل دخول');
    const q = digits(url.searchParams.get('q'));
    const rows = q
      ? db.prepare('SELECT * FROM customers WHERE biz=? AND phone LIKE ? ORDER BY last_visit DESC LIMIT 100').all(b.id, '%' + q + '%')
      : db.prepare('SELECT * FROM customers WHERE biz=? ORDER BY last_visit DESC LIMIT 200').all(b.id);
    send(res, 200, { customers: rows.map(c => ({ ...cardOf(b, c), last_visit: c.last_visit })) });
  },
  // staff: add a visit (stamps) or a purchase amount (points)
  async 'POST /api/add'(req, res) {
    const b = auth(req); if (!b) return fail(res, 401, 'سجل دخول');
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
    let c = db.prepare('SELECT * FROM customers WHERE biz=? AND phone=?').get(b.id, phone);
    if (!c) {
      db.prepare('INSERT INTO customers(biz,phone,name,created) VALUES(?,?,?,?)').run(b.id, phone, String(d.name || '').slice(0, 40), now());
      c = db.prepare('SELECT * FROM customers WHERE biz=? AND phone=?').get(b.id, phone);
    } else if (d.name && !c.name) db.prepare('UPDATE customers SET name=? WHERE id=?').run(String(d.name).slice(0, 40), c.id);
    // same customer cannot be stamped twice within 60 seconds (double tap guard)
    if (b.mode === 'stamps' && c.last_visit && now() - c.last_visit < 60000) return fail(res, 429, 'تم تسجيل زيارة للعميل ده من أقل من دقيقة');
    const before = Math.floor(c.balance / b.goal);
    db.prepare('UPDATE customers SET balance=balance+?, visits=visits+1, last_visit=? WHERE id=?').run(amount, now(), c.id);
    db.prepare('INSERT INTO tx(biz,cust,kind,amount,spend,created) VALUES(?,?,?,?,?,?)').run(b.id, c.id, 'add', amount, spend, now());
    c = db.prepare('SELECT * FROM customers WHERE id=?').get(c.id);
    send(res, 200, { customer: cardOf(b, c), added: amount, unlocked: Math.floor(c.balance / b.goal) > before });
  },
  async 'POST /api/redeem'(req, res) {
    const b = auth(req); if (!b) return fail(res, 401, 'سجل دخول');
    const d = await body(req);
    const c = db.prepare('SELECT * FROM customers WHERE biz=? AND phone=?').get(b.id, digits(d.phone));
    if (!c) return fail(res, 404, 'العميل مش موجود');
    if (c.balance < b.goal) return fail(res, 400, 'رصيد العميل لسه مكملش المكافأة');
    db.prepare('UPDATE customers SET balance=balance-?, rewards=rewards+1 WHERE id=?').run(b.goal, c.id);
    db.prepare('INSERT INTO tx(biz,cust,kind,amount,created) VALUES(?,?,?,?,?)').run(b.id, c.id, 'redeem', b.goal, now());
    send(res, 200, { customer: cardOf(b, db.prepare('SELECT * FROM customers WHERE id=?').get(c.id)) });
  },
  async 'GET /api/public'(req, res, ip, url) {
    const m = url.pathname.match(/^\/api\/public\/([^/]+)(\/card)?$/);
    const b = m && db.prepare('SELECT * FROM businesses WHERE slug=?').get(m[1]);
    if (!b) return fail(res, 404, 'النشاط مش موجود');
    if (!m[2]) return send(res, 200, publicBiz(b));
    if (limited(ip, 'card', 60, 600e3)) return fail(res, 429, 'محاولات كتير');
    const c = db.prepare('SELECT * FROM customers WHERE biz=? AND phone=?').get(b.id, digits(url.searchParams.get('phone')));
    send(res, 200, { business: publicBiz(b), card: c ? cardOf(b, c) : null });
  }
};

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  try {
    if (url.pathname === '/health') return send(res, 200, { ok: true });
    if (url.pathname.startsWith('/api/')) {
      const key = req.method + ' ' + (url.pathname.startsWith('/api/public') ? '/api/public' : url.pathname);
      const h = routes[key];
      if (!h) return fail(res, 404, 'غير موجود');
      return await h(req, res, ip, url);
    }
    const f = path.join(__dirname, 'index.html'); // single-page app: every non-API path serves the app
    res.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  } catch (e) { fail(res, 400, 'طلب غير صحيح'); }
}).listen(PORT, () => console.log('listening', PORT));
