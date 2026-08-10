// server.js — School Booking (multi-yard)
// One deploy, many yards. Each yard is a row in `yards`, identified by a
// URL slug (/y/:slug). All bookings, shares, and push subs are scoped to a
// yard_id. Andy manages yards from /superadmin; each yard has its own
// lightweight admin login (password only, no email/accounts) at /y/:slug/admin
// to edit its own booking hours, arena name, and display name.

const express      = require('express');
const path         = require('path');
const crypto       = require('crypto');
const cookieParser = require('cookie-parser');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const Database     = require('better-sqlite3');
const webpush      = require('web-push');
const QRCode       = require('qrcode');

const app = express();
app.set('trust proxy', 1); // Railway sits behind a proxy — needed so req.protocol reports https, not http, when building QR-code URLs
app.use(express.json());
app.use(cookieParser());

// ── Secrets / config ──────────────────────────────────────────────────
// Every one of these has a working fallback so the app runs out of the box
// in dev, but on Railway you should set real values via env vars — anyone
// who has JWT_SECRET can forge admin sessions, and SUPERADMIN_PASSWORD
// guards yard creation for the whole app.
const JWT_SECRET         = process.env.ADMIN_JWT_SECRET || 'dev-secret-change-me';
const SUPERADMIN_PASSWORD = process.env.SUPERADMIN_PASSWORD || 'changeme';

// Shown to visitors on a board whose subscription has lapsed, e.g.
// "andy@hqcontrol.co.uk" or "07123 456789". Optional — falls back to
// generic wording if unset.
const SUPPORT_CONTACT = process.env.SUPPORT_CONTACT || '';

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || 'BP3iUovYhLzfttBq439L_zIECQG-fat88s_wpOd6yhbDvWCOlw3MzgEce6Nm387NXdJmN6ecqyfxY8YA7UR4O8U';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || 'PAvQYmPWxEDPqYhrntKYiFV1kGNfCIuNwyFAPkHa6lM';
webpush.setVapidDetails('mailto:admin@example.com', VAPID_PUBLIC, VAPID_PRIVATE);

// ── DB ─────────────────────────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || '/data/yardbook.db';
let db;
try {
  db = new Database(DB_PATH);
} catch (e) {
  console.error('Could not open DB at', DB_PATH, '— falling back to local file. Set DB_PATH to a persistent volume on Railway.', e.message);
  db = new Database('./yardbook.db');
}
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS yards (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    slug                 TEXT NOT NULL UNIQUE,
    name                 TEXT NOT NULL,
    arena_name           TEXT NOT NULL DEFAULT 'The School',
    slot_start_hour      INTEGER NOT NULL DEFAULT 6,
    slot_end_hour        INTEGER NOT NULL DEFAULT 21,
    admin_password_hash  TEXT NOT NULL,
    active               INTEGER NOT NULL DEFAULT 1,
    expires_at           TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    yard_id            INTEGER NOT NULL REFERENCES yards(id) ON DELETE CASCADE,
    date               TEXT NOT NULL,
    slot               TEXT NOT NULL,
    name               TEXT NOT NULL,
    owner_token        TEXT NOT NULL,
    owner_device_token TEXT,
    open_to_share      INTEGER NOT NULL DEFAULT 0,
    sharer_name        TEXT,
    sharer_token       TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(yard_id, date, slot)
  );

  CREATE TABLE IF NOT EXISTS share_requests (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id             INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    requester_name         TEXT NOT NULL,
    requester_token        TEXT NOT NULL,
    requester_device_token TEXT,
    status                 TEXT NOT NULL DEFAULT 'pending',
    created_at             TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    yard_id       INTEGER NOT NULL REFERENCES yards(id) ON DELETE CASCADE,
    device_token  TEXT NOT NULL,
    endpoint      TEXT NOT NULL UNIQUE,
    keys_json     TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migration: bring an old single-yard DB (no yard_id anywhere) forward.
// If `bookings.yard_id` is missing, this DB predates the multi-yard rebuild.
// We create yard #1 as a placeholder ("Default Yard", password "changeme")
// and attach all existing rows to it, so nothing is lost on upgrade.
(function migrateToMultiYard() {
  const bookingCols = db.prepare("PRAGMA table_info(bookings)").all().map(c => c.name);
  if (bookingCols.length && !bookingCols.includes('yard_id')) {
    console.log('Migrating legacy single-yard DB to multi-yard schema…');
    const tx = db.transaction(() => {
      const hash = bcrypt.hashSync('changeme', 10);
      const yard = db.prepare(`
        INSERT INTO yards (slug, name, arena_name, admin_password_hash) VALUES ('default','Default Yard','The School', ?)
      `).run(hash);
      db.exec('ALTER TABLE bookings ADD COLUMN yard_id INTEGER');
      db.prepare('UPDATE bookings SET yard_id=?').run(yard.lastInsertRowid);
      const pushCols = db.prepare("PRAGMA table_info(push_subscriptions)").all().map(c => c.name);
      if (!pushCols.includes('yard_id')) {
        db.exec('ALTER TABLE push_subscriptions ADD COLUMN yard_id INTEGER');
        db.prepare('UPDATE push_subscriptions SET yard_id=?').run(yard.lastInsertRowid);
      }
    });
    tx();
    console.log('Migration done — legacy data now lives under yard slug "default". Log in at /y/default/admin with password "changeme" and change it.');
  }
})();

// Migration: pre-sharing DBs won't have these columns either.
(function migrateSharingColumns() {
  const cols = db.prepare("PRAGMA table_info(bookings)").all().map(c => c.name);
  const add = [];
  if (!cols.includes('open_to_share')) add.push("ALTER TABLE bookings ADD COLUMN open_to_share INTEGER NOT NULL DEFAULT 0");
  if (!cols.includes('sharer_name'))   add.push("ALTER TABLE bookings ADD COLUMN sharer_name TEXT");
  if (!cols.includes('sharer_token'))  add.push("ALTER TABLE bookings ADD COLUMN sharer_token TEXT");
  add.forEach(sql => { try { db.exec(sql); } catch (e) { console.error('migration:', e.message); } });
})();

// Migration: yards created before subscription tracking existed won't have
// this column. NULL means "no expiry set" — existing yards stay accessible
// indefinitely until you set a date for them, nothing changes automatically.
(function migrateExpiryColumn() {
  const cols = db.prepare("PRAGMA table_info(yards)").all().map(c => c.name);
  if (!cols.includes('expires_at')) {
    try { db.exec("ALTER TABLE yards ADD COLUMN expires_at TEXT"); } catch (e) { console.error('migration:', e.message); }
  }
})();

// Migration: existing bookings/share_requests were created before targeted
// push notifications tracked the recipient's actual device — they stored
// owner_token/requester_token (random ownership-proof secrets, unrelated to
// any device) and tried to use THOSE to look up a push subscription, which
// never matches anything. Rows from before this fix just won't have a
// device to notify until the booking/request is re-created; new ones will.
(function migrateDeviceTokenColumns() {
  const bookingCols = db.prepare("PRAGMA table_info(bookings)").all().map(c => c.name);
  if (!bookingCols.includes('owner_device_token')) {
    try { db.exec("ALTER TABLE bookings ADD COLUMN owner_device_token TEXT"); } catch (e) { console.error('migration:', e.message); }
  }
  const shareCols = db.prepare("PRAGMA table_info(share_requests)").all().map(c => c.name);
  if (!shareCols.includes('requester_device_token')) {
    try { db.exec("ALTER TABLE share_requests ADD COLUMN requester_device_token TEXT"); } catch (e) { console.error('migration:', e.message); }
  }
})();

// Indexes come after the migrations above, since they reference yard_id —
// a column that only exists once migrateToMultiYard() has run.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_bookings_yard_date ON bookings(yard_id, date);
  CREATE INDEX IF NOT EXISTS idx_push_yard ON push_subscriptions(yard_id);
`);

// ── Helpers ────────────────────────────────────────────────────────────
function randomToken(len = 20) { return crypto.randomBytes(len).toString('base64url'); }

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function prettyDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}

function slotsFor(yard) {
  const slots = [];
  for (let h = yard.slot_start_hour; h < yard.slot_end_hour; h++) {
    slots.push(String(h).padStart(2, '0') + ':00');
    slots.push(String(h).padStart(2, '0') + ':30');
  }
  return slots;
}

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function slugify(s) {
  return String(s).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function yardIsExpired(yard) {
  return !!yard.expires_at && yard.expires_at < todayStr();
}

async function notifyYard(yardId, actorDeviceToken, payload) {
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE yard_id=? AND device_token != ?').all(yardId, actorDeviceToken || '');
  const body = JSON.stringify(payload);
  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: JSON.parse(sub.keys_json) }, body);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(sub.id);
    }
  }));
}

async function notifyDevice(yardId, deviceToken, payload) {
  if (!deviceToken) return;
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE yard_id=? AND device_token = ?').all(yardId, deviceToken);
  const body = JSON.stringify(payload);
  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: JSON.parse(sub.keys_json) }, body);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(sub.id);
    }
  }));
}

// ── Auth middleware ───────────────────────────────────────────────────
// Yard admin sessions are a JWT in a cookie scoped to /y/:slug/admin (via
// cookie `path`), so a browser logged into one yard's admin never leaks a
// valid session into another yard's admin area — the cookie simply isn't
// sent outside its path.
function yardAdminCookieName(slug) { return 'yb_admin_' + slug; }

function resolveYard(req, res, next) {
  // Only checks the yard actually exists. Whether it's currently open for
  // business (active + not expired) is a separate concern — see
  // requireYardOpen — because admin login/settings need to keep working
  // even when a yard is suspended, so its admin can log in and see why.
  const yard = db.prepare('SELECT * FROM yards WHERE slug=?').get(req.params.slug);
  if (!yard) return res.status(404).json({ error: 'Yard not found' });
  req.yard = yard;
  next();
}

// Gates the routes that should actually stop working when a yard's
// subscription has lapsed or been manually deactivated — booking, sharing,
// push. Deliberately NOT applied to admin login/settings routes.
function requireYardOpen(req, res, next) {
  if (!req.yard.active || yardIsExpired(req.yard)) {
    return res.status(403).json({ error: 'expired', contact: SUPPORT_CONTACT });
  }
  next();
}

function requireYardAdmin(req, res, next) {
  const token = req.cookies[yardAdminCookieName(req.yard.slug)];
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'yard_admin' || payload.yardId !== req.yard.id) throw new Error('mismatch');
    next();
  } catch (e) {
    res.status(401).json({ error: 'Session expired — log in again' });
  }
}

function requireSuperadmin(req, res, next) {
  const token = req.cookies['yb_superadmin'];
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'superadmin') throw new Error('mismatch');
    next();
  } catch (e) {
    res.status(401).json({ error: 'Session expired — log in again' });
  }
}

function yardPublicShape(yard) {
  return { slug: yard.slug, name: yard.name, arenaName: yard.arena_name, slots: slotsFor(yard) };
}
function yardAdminShape(yard) {
  return {
    slug: yard.slug, name: yard.name, arenaName: yard.arena_name,
    slotStartHour: yard.slot_start_hour, slotEndHour: yard.slot_end_hour,
    active: !!yard.active, expiresAt: yard.expires_at, expired: yardIsExpired(yard),
    contact: SUPPORT_CONTACT,
  };
}

// ══════════════════════════════════════════════════════════════════════
// Public booking API — scoped to one yard by slug
// ══════════════════════════════════════════════════════════════════════

// This is the one route that needs to tell "doesn't exist" apart from
// "exists but lapsed" — every other route just needs a blanket yes/no
// (resolveYard), but this is what the board's initial page load calls to
// decide which of three states to show: the board, a generic "not found",
// or a specific "subscription ended" message.
app.get('/api/y/:slug/config', (req, res) => {
  const yard = db.prepare('SELECT * FROM yards WHERE slug=?').get(req.params.slug);
  if (!yard) return res.status(404).json({ error: 'not_found' });
  if (!yard.active || yardIsExpired(yard)) return res.status(403).json({ error: 'expired', contact: SUPPORT_CONTACT });
  res.json(yardPublicShape(yard));
});

app.get('/api/y/:slug/vapid-public-key', resolveYard, requireYardOpen, (req, res) => {
  res.json({ key: VAPID_PUBLIC });
});

app.get('/api/y/:slug/bookings', resolveYard, requireYardOpen, (req, res) => {
  const start = req.query.start;
  if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) return res.status(400).json({ error: 'start=YYYY-MM-DD required' });
  const end = addDays(start, 7);
  const rows = db.prepare('SELECT id, date, slot, name, open_to_share, sharer_name, created_at FROM bookings WHERE yard_id=? AND date >= ? AND date < ? ORDER BY date, slot')
    .all(req.yard.id, start, end);
  res.json(rows);
});

app.post('/api/y/:slug/bookings', resolveYard, requireYardOpen, async (req, res) => {
  const { date, slot, name, deviceToken, openToShare } = req.body || {};
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Valid date required' });
  if (!slot || !slotsFor(req.yard).includes(slot)) return res.status(400).json({ error: 'Valid slot required' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'Enter who\'s booked in' });

  const slotDateTime = new Date(date + 'T' + slot + ':00');
  if (slotDateTime < new Date()) return res.status(400).json({ error: 'That time has already passed' });

  const ownerToken = randomToken();
  try {
    const r = db.prepare('INSERT INTO bookings (yard_id, date, slot, name, owner_token, owner_device_token, open_to_share) VALUES (?,?,?,?,?,?,?)')
      .run(req.yard.id, date, slot, name.trim().slice(0, 60), ownerToken, deviceToken || null, openToShare ? 1 : 0);
    const booking = { id: r.lastInsertRowid, date, slot, name: name.trim(), ownerToken, open_to_share: openToShare ? 1 : 0 };

    notifyYard(req.yard.id, deviceToken, {
      title: 'New booking',
      body: `${booking.name} booked ${req.yard.arena_name} — ${prettyDate(date)} at ${slot}`,
      tag: `booking-${date}-${slot}`,
    }).catch(() => {});

    res.json(booking);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'That slot was just taken — pick another' });
    res.status(500).json({ error: 'Could not create booking' });
  }
});

app.delete('/api/y/:slug/bookings/:id', resolveYard, requireYardOpen, async (req, res) => {
  const { ownerToken, name, deviceToken } = req.body || {};
  const row = db.prepare('SELECT * FROM bookings WHERE id=? AND yard_id=?').get(req.params.id, req.yard.id);
  if (!row) return res.status(404).json({ error: 'Booking not found' });

  const ownsByToken = ownerToken && ownerToken === row.owner_token;
  const ownsByName  = name && name.trim().toLowerCase() === row.name.trim().toLowerCase();
  if (!ownsByToken && !ownsByName) {
    return res.status(403).json({ error: 'Only the person who booked this slot can cancel it. If this was your booking from another device, enter the exact name on it.' });
  }

  db.prepare('DELETE FROM bookings WHERE id=?').run(row.id);

  notifyYard(req.yard.id, deviceToken, {
    title: 'Booking cancelled',
    body: `${prettyDate(row.date)} at ${row.slot} is now free`,
    tag: `booking-${row.date}-${row.slot}`,
  }).catch(() => {});

  res.json({ ok: true });
});

// ── Sharing ──────────────────────────────────────────────────────────

app.post('/api/y/:slug/bookings/:id/share-request', resolveYard, requireYardOpen, async (req, res) => {
  const { requesterName, deviceToken } = req.body || {};
  if (!requesterName || !requesterName.trim()) return res.status(400).json({ error: 'Enter your name' });

  const b = db.prepare('SELECT * FROM bookings WHERE id=? AND yard_id=?').get(req.params.id, req.yard.id);
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  if (!b.open_to_share) return res.status(403).json({ error: 'This booking isn\'t open to sharing' });
  if (b.sharer_name) return res.status(409).json({ error: 'This slot is already being shared' });
  if (deviceToken && deviceToken === b.owner_token) return res.status(400).json({ error: 'This is already your booking' });

  const existing = db.prepare("SELECT * FROM share_requests WHERE booking_id=? AND status='pending'").get(b.id);
  if (existing) return res.status(409).json({ error: 'There\'s already a pending request for this slot' });

  const requesterToken = randomToken();
  const r = db.prepare('INSERT INTO share_requests (booking_id, requester_name, requester_token, requester_device_token) VALUES (?,?,?,?)')
    .run(b.id, requesterName.trim().slice(0, 60), requesterToken, deviceToken || null);

  notifyDevice(req.yard.id, b.owner_device_token, {
    title: 'Share request',
    body: `${requesterName.trim()} has requested to share ${req.yard.arena_name} during your slot — ${prettyDate(b.date)} at ${b.slot}`,
    tag: `share-req-${b.id}`,
  }).catch(() => {});

  res.json({ ok: true, requestId: r.lastInsertRowid, requesterToken });
});

app.post('/api/y/:slug/share-requests/pending', resolveYard, requireYardOpen, (req, res) => {
  const { ownerTokens } = req.body || {};
  if (!Array.isArray(ownerTokens) || !ownerTokens.length) return res.json([]);
  const placeholders = ownerTokens.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT sr.id AS request_id, sr.requester_name, sr.booking_id,
           b.date, b.slot, b.name AS booking_name, b.owner_token
    FROM share_requests sr JOIN bookings b ON b.id = sr.booking_id
    WHERE sr.status='pending' AND b.yard_id=? AND b.owner_token IN (${placeholders})
    ORDER BY sr.created_at
  `).all(req.yard.id, ...ownerTokens);
  res.json(rows);
});

app.post('/api/y/:slug/share-requests/:id/respond', resolveYard, requireYardOpen, async (req, res) => {
  const { decision, ownerToken, deviceToken } = req.body || {};
  if (decision !== 'accept' && decision !== 'decline') return res.status(400).json({ error: 'Invalid decision' });

  const sr = db.prepare("SELECT * FROM share_requests WHERE id=? AND status='pending'").get(req.params.id);
  if (!sr) return res.status(404).json({ error: 'Request not found or already handled' });
  const b = db.prepare('SELECT * FROM bookings WHERE id=? AND yard_id=?').get(sr.booking_id, req.yard.id);
  if (!b) return res.status(404).json({ error: 'Booking no longer exists' });
  if (!ownerToken || ownerToken !== b.owner_token) return res.status(403).json({ error: 'Only the original booker can respond' });

  if (decision === 'accept') {
    if (b.sharer_name) return res.status(409).json({ error: 'Slot is already shared' });
    db.prepare('UPDATE bookings SET sharer_name=?, sharer_token=? WHERE id=?').run(sr.requester_name, sr.requester_token, b.id);
    db.prepare("UPDATE share_requests SET status='accepted' WHERE id=?").run(sr.id);
    notifyDevice(req.yard.id, sr.requester_device_token, {
      title: 'Share accepted',
      body: `${b.name} accepted your request to share — ${prettyDate(b.date)} at ${b.slot}`,
      tag: `share-res-${b.id}`,
    }).catch(() => {});
    notifyYard(req.yard.id, deviceToken, {
      title: 'Slot now shared',
      body: `${b.name} & ${sr.requester_name} are sharing ${req.yard.arena_name} — ${prettyDate(b.date)} at ${b.slot}`,
      tag: `booking-${b.date}-${b.slot}`,
    }).catch(() => {});
  } else {
    db.prepare("UPDATE share_requests SET status='declined' WHERE id=?").run(sr.id);
    notifyDevice(req.yard.id, sr.requester_device_token, {
      title: 'Share declined',
      body: `${b.name} declined your request to share — ${prettyDate(b.date)} at ${b.slot}`,
      tag: `share-res-${b.id}`,
    }).catch(() => {});
  }
  res.json({ ok: true });
});

app.post('/api/y/:slug/bookings/:id/remove-sharer', resolveYard, requireYardOpen, async (req, res) => {
  const { sharerToken, deviceToken } = req.body || {};
  const b = db.prepare('SELECT * FROM bookings WHERE id=? AND yard_id=?').get(req.params.id, req.yard.id);
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  if (!b.sharer_token || sharerToken !== b.sharer_token) return res.status(403).json({ error: 'Only the sharer can remove their own share' });

  const sharerName = b.sharer_name;
  db.prepare('UPDATE bookings SET sharer_name=NULL, sharer_token=NULL WHERE id=?').run(b.id);

  notifyDevice(req.yard.id, b.owner_device_token, {
    title: 'Share removed',
    body: `${sharerName} is no longer sharing your slot — ${prettyDate(b.date)} at ${b.slot}`,
    tag: `booking-${b.date}-${b.slot}`,
  }).catch(() => {});

  res.json({ ok: true });
});

app.post('/api/y/:slug/push/subscribe', resolveYard, requireYardOpen, (req, res) => {
  const { subscription, deviceToken } = req.body || {};
  if (!subscription || !subscription.endpoint || !deviceToken) return res.status(400).json({ error: 'Missing subscription or deviceToken' });
  db.prepare(`
    INSERT INTO push_subscriptions (yard_id, device_token, endpoint, keys_json) VALUES (?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET device_token=excluded.device_token, yard_id=excluded.yard_id
  `).run(req.yard.id, deviceToken, subscription.endpoint, JSON.stringify(subscription.keys));
  res.json({ ok: true });
});

app.post('/api/y/:slug/push/unsubscribe', resolveYard, (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(endpoint);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════
// Yard admin API — settings for one yard, gated by that yard's own password
// ══════════════════════════════════════════════════════════════════════

app.post('/api/y/:slug/admin/login', resolveYard, (req, res) => {
  const { password } = req.body || {};
  if (!password || !bcrypt.compareSync(String(password), req.yard.admin_password_hash)) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  const token = jwt.sign({ role: 'yard_admin', yardId: req.yard.id }, JWT_SECRET, { expiresIn: '30d' });
  // Path is '/' (not scoped to /y/:slug) because the API lives under /api/y/:slug/
  // too — there's no single path prefix that covers both. The cookie name is
  // still per-yard, and the JWT's yardId claim is what actually gates access
  // (checked in requireYardAdmin), so this doesn't weaken isolation between yards.
  res.cookie(yardAdminCookieName(req.yard.slug), token, {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
    path: '/', maxAge: 30 * 24 * 60 * 60 * 1000,
  });
  res.json({ ok: true });
});

app.post('/api/y/:slug/admin/logout', resolveYard, (req, res) => {
  res.clearCookie(yardAdminCookieName(req.yard.slug), { path: '/' });
  res.json({ ok: true });
});

app.get('/api/y/:slug/admin/session', resolveYard, (req, res) => {
  const token = req.cookies[yardAdminCookieName(req.yard.slug)];
  if (!token) return res.json({ loggedIn: false });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    res.json({ loggedIn: payload.role === 'yard_admin' && payload.yardId === req.yard.id });
  } catch (e) { res.json({ loggedIn: false }); }
});

app.get('/api/y/:slug/admin/settings', resolveYard, requireYardAdmin, (req, res) => {
  res.json(yardAdminShape(req.yard));
});

app.put('/api/y/:slug/admin/settings', resolveYard, requireYardAdmin, (req, res) => {
  const { name, arenaName, slotStartHour, slotEndHour } = req.body || {};
  const errors = [];
  if (name !== undefined && !String(name).trim()) errors.push('Yard name can\'t be blank');
  if (arenaName !== undefined && !String(arenaName).trim()) errors.push('Arena name can\'t be blank');
  const startH = slotStartHour !== undefined ? parseInt(slotStartHour, 10) : req.yard.slot_start_hour;
  const endH   = slotEndHour   !== undefined ? parseInt(slotEndHour, 10)   : req.yard.slot_end_hour;
  if (!Number.isInteger(startH) || startH < 0 || startH > 23) errors.push('Start hour must be 0–23');
  if (!Number.isInteger(endH)   || endH   < 1 || endH   > 24) errors.push('End hour must be 1–24');
  if (startH >= endH) errors.push('Start hour must be before end hour');
  if (errors.length) return res.status(400).json({ error: errors.join('. ') });

  db.prepare('UPDATE yards SET name=?, arena_name=?, slot_start_hour=?, slot_end_hour=? WHERE id=?').run(
    name !== undefined ? String(name).trim().slice(0, 80) : req.yard.name,
    arenaName !== undefined ? String(arenaName).trim().slice(0, 80) : req.yard.arena_name,
    startH, endH, req.yard.id
  );
  const updated = db.prepare('SELECT * FROM yards WHERE id=?').get(req.yard.id);
  res.json(yardAdminShape(updated));
});

app.post('/api/y/:slug/admin/change-password', resolveYard, requireYardAdmin, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!bcrypt.compareSync(String(currentPassword || ''), req.yard.admin_password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  db.prepare('UPDATE yards SET admin_password_hash=? WHERE id=?').run(bcrypt.hashSync(String(newPassword), 10), req.yard.id);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════
// Superadmin API — create and manage yards (Andy only)
// ══════════════════════════════════════════════════════════════════════

app.post('/api/superadmin/login', (req, res) => {
  const { password } = req.body || {};
  if (!password || !timingSafeEqualStr(password, SUPERADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  const token = jwt.sign({ role: 'superadmin' }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('yb_superadmin', token, {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
    path: '/', maxAge: 30 * 24 * 60 * 60 * 1000,
  });
  res.json({ ok: true });
});

app.post('/api/superadmin/logout', (req, res) => {
  res.clearCookie('yb_superadmin', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/superadmin/session', (req, res) => {
  const token = req.cookies['yb_superadmin'];
  if (!token) return res.json({ loggedIn: false });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    res.json({ loggedIn: payload.role === 'superadmin' });
  } catch (e) { res.json({ loggedIn: false }); }
});

app.get('/api/superadmin/yards', requireSuperadmin, (req, res) => {
  const rows = db.prepare(`
    SELECT y.*,
      (SELECT COUNT(*) FROM bookings b WHERE b.yard_id=y.id AND b.date >= date('now')) AS upcoming_bookings
    FROM yards y ORDER BY y.created_at DESC
  `).all();
  res.json(rows.map(y => ({
    id: y.id, slug: y.slug, name: y.name, arenaName: y.arena_name,
    slotStartHour: y.slot_start_hour, slotEndHour: y.slot_end_hour,
    active: !!y.active, expiresAt: y.expires_at, expired: yardIsExpired(y),
    createdAt: y.created_at, upcomingBookings: y.upcoming_bookings,
  })));
});

app.post('/api/superadmin/yards', requireSuperadmin, (req, res) => {
  const { name, arenaName, adminPassword, expiresAt } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Yard name is required' });
  if (!adminPassword || String(adminPassword).length < 6) return res.status(400).json({ error: 'Admin password must be at least 6 characters' });
  if (expiresAt && !/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) return res.status(400).json({ error: 'Expiry date must be YYYY-MM-DD' });

  let slug = req.body.slug ? slugify(req.body.slug) : slugify(name);
  if (!slug) return res.status(400).json({ error: 'Could not generate a URL slug from that name — try a simpler one' });
  // De-dupe: append -2, -3, … if the slug is taken.
  let candidate = slug, n = 1;
  while (db.prepare('SELECT 1 FROM yards WHERE slug=?').get(candidate)) {
    n += 1; candidate = `${slug}-${n}`;
  }
  slug = candidate;

  const hash = bcrypt.hashSync(String(adminPassword), 10);
  const r = db.prepare('INSERT INTO yards (slug, name, arena_name, admin_password_hash, expires_at) VALUES (?,?,?,?,?)')
    .run(slug, name.trim().slice(0, 80), (arenaName || 'The School').trim().slice(0, 80), hash, expiresAt || null);
  const yard = db.prepare('SELECT * FROM yards WHERE id=?').get(r.lastInsertRowid);
  res.json({ id: yard.id, slug: yard.slug, name: yard.name, arenaName: yard.arena_name, expiresAt: yard.expires_at, boardUrl: `/y/${yard.slug}/`, adminUrl: `/y/${yard.slug}/admin` });
});

app.put('/api/superadmin/yards/:id', requireSuperadmin, (req, res) => {
  const yard = db.prepare('SELECT * FROM yards WHERE id=?').get(req.params.id);
  if (!yard) return res.status(404).json({ error: 'Yard not found' });
  const body = req.body || {};
  const { name, arenaName, active } = body;

  // expiresAt is tri-state: omitted = leave unchanged, null/'' = clear (no
  // expiry), a date string = set it. Object.hasOwnProperty distinguishes
  // "not sent" from "sent as null", which a plain `body.expiresAt !== undefined`
  // check can't.
  const hasExpiresAt = Object.prototype.hasOwnProperty.call(body, 'expiresAt');
  if (hasExpiresAt && body.expiresAt && !/^\d{4}-\d{2}-\d{2}$/.test(body.expiresAt)) {
    return res.status(400).json({ error: 'Expiry date must be YYYY-MM-DD' });
  }
  const newExpiresAt = hasExpiresAt ? (body.expiresAt || null) : yard.expires_at;

  db.prepare('UPDATE yards SET name=?, arena_name=?, active=?, expires_at=? WHERE id=?').run(
    name !== undefined ? String(name).trim().slice(0, 80) : yard.name,
    arenaName !== undefined ? String(arenaName).trim().slice(0, 80) : yard.arena_name,
    active !== undefined ? (active ? 1 : 0) : yard.active,
    newExpiresAt,
    yard.id
  );
  res.json({ ok: true, expiresAt: newExpiresAt });
});

app.post('/api/superadmin/yards/:id/reset-admin-password', requireSuperadmin, (req, res) => {
  const yard = db.prepare('SELECT * FROM yards WHERE id=?').get(req.params.id);
  if (!yard) return res.status(404).json({ error: 'Yard not found' });
  const newPassword = req.body && req.body.newPassword ? String(req.body.newPassword) : randomToken(6);
  db.prepare('UPDATE yards SET admin_password_hash=? WHERE id=?').run(bcrypt.hashSync(newPassword, 10), yard.id);
  res.json({ ok: true, newPassword });
});

// ══════════════════════════════════════════════════════════════════════
// Pages & static assets
// ══════════════════════════════════════════════════════════════════════

function boardUrlFor(req, yard) {
  return `${req.protocol}://${req.get('host')}/y/${yard.slug}/`;
}

function escapeHtmlServer(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// QR code for a yard's public board link — used from both the yard admin
// page and the superadmin panel. ?format=png for a raster image (easier to
// paste into other documents); default is svg (crisp at any print size).
app.get('/api/y/:slug/qr', resolveYard, async (req, res) => {
  const url = boardUrlFor(req, req.yard);
  const opts = { margin: 1, color: { dark: '#22261f', light: '#f0ece0' } };
  try {
    if (req.query.format === 'png') {
      const buf = await QRCode.toBuffer(url, { ...opts, type: 'png', width: 640 });
      res.type('image/png').send(buf);
    } else {
      const svg = await QRCode.toString(url, { ...opts, type: 'svg' });
      res.type('image/svg+xml').send(svg);
    }
  } catch (e) {
    res.status(500).send('Could not generate QR code');
  }
});

// A standalone, ready-to-print page: yard name + a large QR code + a caption.
// Opens in a new tab from the admin/superadmin panels; the person then uses
// their browser's own print (or "save as PDF") — nothing here auto-prints,
// since triggering window.print() without being asked is the kind of
// surprise that makes people distrust a page.
app.get('/y/:slug/qr-print', resolveYard, async (req, res) => {
  const url = boardUrlFor(req, req.yard);
  let svg;
  try {
    svg = await QRCode.toString(url, { margin: 1, color: { dark: '#22261f', light: '#ffffff' }, type: 'svg' });
  } catch (e) {
    return res.status(500).send('Could not generate QR code');
  }
  res.type('html').send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtmlServer(req.yard.name)} — Scan to book</title>
<link href="https://fonts.googleapis.com/css2?family=Kalam:wght@700&family=Inter:wght@400;600&display=swap" rel="stylesheet">
<style>
  body { font-family: 'Inter', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f4f1ea; }
  .sheet { text-align: center; padding: 48px; max-width: 480px; }
  h1 { font-family: 'Kalam', cursive; font-size: 34px; margin: 0 0 6px; color: #22261f; }
  .sub { font-size: 14px; letter-spacing: 1px; text-transform: uppercase; color: #6b6f63; margin-bottom: 28px; }
  .qr { width: 100%; max-width: 320px; margin: 0 auto; border: 1px solid #ddd8ca; border-radius: 12px; padding: 16px; background: #fff; }
  .caption { font-size: 15px; color: #45483f; margin-top: 22px; }
  .link { font-size: 12px; color: #8a8f80; margin-top: 6px; word-break: break-all; }
  .no-print { margin-top: 28px; }
  .no-print button { font-family: 'Inter', sans-serif; font-weight: 600; font-size: 14px; padding: 10px 18px; border-radius: 8px; border: 1px solid #22261f; background: #22261f; color: #f4f1ea; cursor: pointer; }
  @media print { .no-print { display: none; } body { background: #fff; } }
</style>
</head><body>
<div class="sheet">
  <h1>${escapeHtmlServer(req.yard.name)}</h1>
  <div class="sub">${escapeHtmlServer(req.yard.arena_name)} — Booking Board</div>
  <div class="qr">${svg}</div>
  <div class="caption">Scan to check availability &amp; book your slot</div>
  <div class="link">${url}</div>
  <div class="no-print"><button onclick="window.print()">Print this page</button></div>
</div>
</body></html>`);
});

// Dynamic manifest so each yard installs to the home screen under its own name.
app.get('/y/:slug/manifest.json', resolveYard, (req, res) => {
  res.json({
    name: req.yard.name + ' — Booking',
    short_name: req.yard.name.slice(0, 20),
    start_url: `/y/${req.yard.slug}`,
    scope: `/y/${req.yard.slug}/`,
    display: 'standalone',
    background_color: '#22261f',
    theme_color: '#22261f',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
  });
});

// These two always serve the page shell, regardless of whether the yard is
// real, expired, or deactivated — resolveYard is deliberately NOT used here.
// The page's own JS calls /api/y/:slug/config right after load and decides
// what to actually show (the board, a "not found" message, or a "subscription
// ended" message) — that's the only place that needs to draw that
// distinction, and it already has to fetch config anyway to build the board.
app.get('/y/:slug', (req, res) => {
  // Express's default routing ignores trailing slashes when matching, so this
  // single handler receives both '/y/:slug' and '/y/:slug/' — we branch on
  // req.path ourselves. A bare '/y/:slug' redirects to add the trailing slash,
  // because the document's actual URL needs to fall inside the service-worker
  // scope registered as '/y/:slug/' (scope matching is a strict string
  // prefix). Without this, navigator.serviceWorker.ready never resolves on
  // the board page and push notifications can't be enabled.
  if (!req.path.endsWith('/')) return res.redirect(302, `/y/${req.params.slug}/`);
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/y/:slug/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/superadmin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'superadmin.html'));
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.get('/', (req, res) => {
  res.type('html').send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>School Booking</title>
  <style>body{font-family:system-ui,sans-serif;background:#22261f;color:#f0ece0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:24px}
  a{color:#5a8065}</style></head><body><div><h1>School Booking</h1><p>Ask your yard for their booking link — it looks like <code>/y/your-yard</code>.</p></div></body></html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('School Booking (multi-yard) on port ' + PORT));

module.exports = { slotsFor, addDays, prettyDate, slugify };
