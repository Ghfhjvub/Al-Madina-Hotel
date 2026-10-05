// خادم محلي اختياري: يربط الموقع بقاعدة SQLite على جهازك (بدون إنترنت).
// التشغيل:   node server.js     ثم افتح:  http://localhost:3000
// يتطلب Node.js 22.5 أو أحدث (SQLite مدمجة، لا حاجة لتثبيت أي حزمة).
// ولتفعيله في الموقع: في index.html اجعل  const API_URL = 'http://localhost:3000/api';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const ALLOWED = ['booking', 'reviews', 'offers', 'likes', 'visits'];
const db = new DatabaseSync(path.join(__dirname, 'hotel.db'));
db.exec(`CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY, col TEXT NOT NULL, data TEXT NOT NULL,
  created TEXT DEFAULT CURRENT_TIMESTAMP
); CREATE INDEX IF NOT EXISTS idx_docs_col ON docs(col);`);

// ================== سجل الحجوزات الدائم (جدول records) ==================
// كل طلب حجز جديد، وكل قبول أو رفض، يُضاف هنا تلقائيًا كصف جديد بكامل بيانات العميل.
// الخادم لا يوفّر أي طريقة لتعديل هذا الجدول أو حذفه (الواجهة للقراءة فقط)،
// وحذف الحجز من لوحة المدير لا يمسّ السجلات. الحذف ممكن فقط من قاعدة البيانات مباشرة.
const recordsTableExisted = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'records'").get();
db.exec(`CREATE TABLE IF NOT EXISTS records (
  id             INTEGER PRIMARY KEY AUTOINCREMENT, -- رقم السجل (لا يُعاد استخدامه حتى لو حُذفت سجلات)
  booking_id     TEXT NOT NULL,                     -- رقم الحجز الأصلي
  decision       TEXT NOT NULL,                     -- قيد الانتظار / مقبول / مرفوض
  kind           TEXT NOT NULL,                     -- غرفة / عرض
  client_name    TEXT NOT NULL DEFAULT '',          -- اسم العميل
  client_phone   TEXT NOT NULL DEFAULT '',          -- رقم الجوال / الواتساب
  room_name      TEXT NOT NULL DEFAULT '',          -- نوع الغرفة
  room_number    TEXT NOT NULL DEFAULT '',          -- رقم الغرفة (إن حدده المدير)
  check_in       TEXT NOT NULL DEFAULT '',          -- تاريخ الوصول
  check_out      TEXT NOT NULL DEFAULT '',          -- تاريخ المغادرة
  offer_title    TEXT NOT NULL DEFAULT '',          -- عنوان العرض (لحجوزات العروض)
  residency      TEXT NOT NULL DEFAULT '',          -- مقيم / غير مقيم (لحجوزات العروض)
  price_applied  TEXT NOT NULL DEFAULT '',          -- السعر المطبّق (لحجوزات العروض)
  payment_method TEXT NOT NULL DEFAULT '',          -- طريقة الدفع
  bank_name      TEXT NOT NULL DEFAULT '',          -- البنك / التطبيق البنكي
  paid           TEXT NOT NULL DEFAULT '',          -- هل تأكد الدفع المسبق (نعم / لا)
  transport      TEXT NOT NULL DEFAULT '',          -- خدمة النقل
  transport_time TEXT NOT NULL DEFAULT '',          -- موعد وصول الطائرة / الباص
  transport_ref  TEXT NOT NULL DEFAULT '',          -- رقم الرحلة / شركة الباص
  notes          TEXT NOT NULL DEFAULT '',          -- ملاحظات العميل
  booked_at      TEXT NOT NULL DEFAULT '',          -- وقت إرسال الحجز الأصلي
  event_at       TEXT NOT NULL,                     -- وقت تسجيل هذا السجل (وقت الطلب أو وقت القرار)
  source         TEXT NOT NULL DEFAULT 'مباشر',     -- مباشر / مُرحَّل (حجوزات قديمة قبل تفعيل السجل)
  snapshot       TEXT NOT NULL                      -- نسخة كاملة (JSON) من بيانات الحجز لحظة التسجيل
);
CREATE INDEX IF NOT EXISTS idx_records_booking ON records(booking_id);`);

const REC_FIELDS = ['bookingId', 'decision', 'kind', 'clientName', 'clientPhone', 'roomName', 'roomNumber',
  'checkIn', 'checkOut', 'offerTitle', 'residency', 'priceApplied', 'paymentMethod', 'bankName', 'paid',
  'transport', 'transportTime', 'transportRef', 'notes', 'bookedAt', 'eventAt', 'source'];
const snake = (k) => k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
const REC_COLS = REC_FIELDS.map(snake);
const DECISION_OF = { 'مؤكد': 'مقبول', 'مرفوض': 'مرفوض', 'قيد الانتظار': 'قيد الانتظار' };
const str = (x) => (x === undefined || x === null ? '' : String(x));

// يحوّل بيانات الحجز إلى صف في السجل (نفس المنطق المستخدم في index.html للوضع بدون خادم)
function makeRecord(bookingId, b, source, at) {
  const isOffer = b.kind === 'offer';
  return {
    bookingId,
    decision: DECISION_OF[b.status] || str(b.status) || 'قيد الانتظار',
    kind: isOffer ? 'عرض' : 'غرفة',
    clientName: str(b.clientName), clientPhone: str(b.clientPhone),
    roomName: str(b.roomName), roomNumber: str(b.roomNumber),
    checkIn: str(b.checkInDate), checkOut: str(b.checkOutDate),
    offerTitle: str(b.offerTitle),
    residency: isOffer ? (b.isResident ? 'مقيم' : 'غير مقيم') : '',
    priceApplied: str(b.priceApplied),
    paymentMethod: b.paymentMethod === 'bank' ? 'تطبيق بنكي' : (b.paymentMethod === 'cash' ? 'الدفع عند الوصول' : ''),
    bankName: str(b.bankName),
    paid: b.paymentMethod === 'bank' ? (b.paid ? 'نعم' : 'لا') : '',
    transport: b.transport === 'limousine' ? 'ليموزين (المطار)' : b.transport === 'taxi' ? 'تاكسي (الميناء البري)' : (b.transport === 'none' ? 'بدون' : ''),
    transportTime: str(b.transportTime), transportRef: str(b.transportRef),
    notes: str(b.notes),
    bookedAt: str(b.createdAt),
    eventAt: at || new Date().toISOString(),
    source: source || 'مباشر',
  };
}

const insRecord = db.prepare(
  `INSERT INTO records (${REC_COLS.join(', ')}, snapshot) VALUES (${REC_COLS.map(() => '?').join(', ')}, ?)`);
const listRecords = db.prepare(`SELECT id, ${REC_COLS.join(', ')} FROM records ORDER BY id`);

function logRecord(bookingId, booking, source, at) {
  const rec = makeRecord(bookingId, booking, source, at);
  insRecord.run(...REC_FIELDS.map((f) => rec[f]), JSON.stringify(booking));
}

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// أول تشغيل بعد إضافة الجدول: تُنقل الحجوزات الموجودة مسبقًا إلى السجل مرة واحدة فقط
// (لا تتكرر العملية بعد ذلك، حتى لا تعود سجلات حذفتَها يدويًا من قاعدة البيانات).
if (!recordsTableExisted) {
  const old = db.prepare("SELECT id, data, created FROM docs WHERE col = 'booking' ORDER BY created, rowid").all();
  tx(() => old.forEach((r) => {
    const b = JSON.parse(r.data);
    logRecord(r.id, b, 'مُرحَّل', b.createdAt || r.created);
  }));
  console.log(`تم إنشاء جدول السجلات ونقل ${old.length} حجز موجود مسبقًا إليه.`);
}
// =========================================================================

const q = {
  list: db.prepare('SELECT id, data FROM docs WHERE col = ? ORDER BY created, rowid'),
  get: db.prepare('SELECT data FROM docs WHERE col = ? AND id = ?'),
  add: db.prepare('INSERT INTO docs (id, col, data) VALUES (?, ?, ?)'),
  upd: db.prepare('UPDATE docs SET data = ? WHERE col = ? AND id = ?'),
  del: db.prepare('DELETE FROM docs WHERE col = ? AND id = ?'),
};
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 20e6) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  });
}

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts[0] === 'api') {
    const [, col, id] = parts;

    // سجل الحجوزات: قراءة فقط. لا إضافة ولا تعديل ولا حذف عبر الواجهة (يُكتب تلقائيًا من الخادم).
    if (col === 'records') {
      if (req.method === 'GET' && !id) {
        try {
          return send(res, 200, listRecords.all().map((r) => {
            const o = { id: r.id };
            REC_FIELDS.forEach((f) => { o[f] = r[snake(f)]; });
            return o;
          }));
        } catch (e) { return send(res, 500, { error: String(e.message || e) }); }
      }
      return send(res, 405, { error: 'سجل الحجوزات للقراءة فقط، ولا يُحذف أو يُعدَّل إلا من قاعدة البيانات مباشرة' });
    }

    if (!ALLOWED.includes(col)) return send(res, 404, { error: 'unknown collection' });
    try {
      if (req.method === 'GET' && !id)
        return send(res, 200, q.list.all(col).map(r => ({ id: r.id, ...JSON.parse(r.data) })));
      if (req.method === 'POST' && !id) {
        const body = await readBody(req);
        if (col === 'booking' && (!body || typeof body !== 'object' || Array.isArray(body)))
          return send(res, 400, { error: 'invalid booking' });
        const nid = newId();
        // إضافة الحجز وتسجيله في السجل في عملية واحدة: إمّا يُحفظان معًا أو لا يُحفظ أيٌّ منهما
        tx(() => {
          q.add.run(nid, col, JSON.stringify(body));
          if (col === 'booking') logRecord(nid, body);
        });
        return send(res, 201, { id: nid });
      }
      if (req.method === 'PATCH' && id) {
        const patch = await readBody(req);
        const row = q.get.get(col, id);
        if (!row) return send(res, 404, { error: 'not found' });
        const old = JSON.parse(row.data);
        const merged = { ...old, ...patch };
        tx(() => {
          q.upd.run(JSON.stringify(merged), col, id);
          // تغيّرت حالة الحجز (قبول / رفض) → سجل جديد بكامل البيانات لحظة القرار
          if (col === 'booking' && patch.status !== undefined && patch.status !== old.status) logRecord(id, merged);
        });
        return send(res, 200, { ok: true });
      }
      // حذف الحجز من لوحة المدير لا يمسّ سجلاته في جدول records
      if (req.method === 'DELETE' && id) { q.del.run(col, id); return send(res, 200, { ok: true }); }
      return send(res, 405, { error: 'method not allowed' });
    } catch (e) { return send(res, 500, { error: String(e.message || e) }); }
  }

  // تقديم ملفات الموقع (index.html والصور...)
  let file = path.normalize(path.join(__dirname, parts.length ? decodeURIComponent(url.pathname) : 'index.html'));
  if (!file.startsWith(__dirname) || file.endsWith('hotel.db')) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(PORT, () => console.log(`الموقع يعمل على: http://localhost:${PORT}`));
