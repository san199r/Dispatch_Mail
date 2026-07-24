// Dispatch Board — standalone local server.
// Zero external dependencies: uses Node's built-in HTTP server and built-in
// SQLite (node:sqlite, available in Node >= 22.5). Run with: node server.js
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { networkInterfaces } from 'node:os';
import nodemailer from 'nodemailer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4173;
const DB_PATH = join(__dirname, 'dispatch.db');

function getLocalIp() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

// ---- Database ----------------------------------------------------------
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS desks (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    angle             TEXT,
    subject           TEXT,
    subject_no_market TEXT,
    body              TEXT,
    sender_email      TEXT,
    app_password      TEXT,
    position          INTEGER
  );

  CREATE TABLE IF NOT EXISTS followups (
    stage    INTEGER,
    day      INTEGER,
    subject  TEXT,
    body     TEXT,
    position INTEGER
  );

  CREATE TABLE IF NOT EXISTS contacts (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    email       TEXT,
    market      TEXT,
    account_id  TEXT,
    sent_date   TEXT,
    replied     INTEGER DEFAULT 0,
    closed      INTEGER DEFAULT 0,
    is_spam     INTEGER DEFAULT 0,
    opened      INTEGER DEFAULT 0,
    opened_date TEXT,
    position    INTEGER
  );

  CREATE TABLE IF NOT EXISTS followups_sent (
    contact_id TEXT,
    stage      INTEGER,
    date       TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Migrate older databases that predate new columns.
// node:sqlite throws if the column already exists, so add each guardedly.
for (const col of ['sender_email TEXT', 'app_password TEXT']) {
  try { db.exec(`ALTER TABLE desks ADD COLUMN ${col}`); } catch { /* already present */ }
}
for (const col of ['is_spam INTEGER DEFAULT 0', 'opened INTEGER DEFAULT 0', 'opened_date TEXT']) {
  try { db.exec(`ALTER TABLE contacts ADD COLUMN ${col}`); } catch { /* already present */ }
}

// Read the whole board out of the DB in the exact shape the frontend expects.
function readState() {
  const desks = db.prepare(`SELECT * FROM desks ORDER BY position`).all().map(d => ({
    id: d.id,
    name: d.name,
    angle: d.angle || '',
    subject: d.subject || '',
    subjectNoMarket: d.subject_no_market || '',
    body: d.body || '',
    senderEmail: d.sender_email || '',
    // The app password never leaves the server. The frontend only needs to know
    // whether credentials exist so it can enable/disable the Send button.
    hasPassword: !!(d.app_password && d.app_password.length)
  }));

  const followups = db.prepare(`SELECT * FROM followups ORDER BY position`).all().map(f => ({
    stage: f.stage,
    day: f.day,
    subject: f.subject || '',
    body: f.body || ''
  }));

  const sentRows = db.prepare(`SELECT * FROM followups_sent`).all();
  const sentByContact = new Map();
  for (const r of sentRows) {
    if (!sentByContact.has(r.contact_id)) sentByContact.set(r.contact_id, []);
    sentByContact.get(r.contact_id).push({ stage: r.stage, date: r.date });
  }

  const contacts = db.prepare(`SELECT * FROM contacts ORDER BY position`).all().map(c => ({
    id: c.id,
    name: c.name,
    email: c.email || '',
    market: c.market || '',
    accountId: c.account_id || null,
    sentDate: c.sent_date || null,
    followupsSent: sentByContact.get(c.id) || [],
    replied: !!c.replied,
    closed: !!c.closed,
    isSpam: !!c.is_spam,
    opened: !!c.opened,
    openedDate: c.opened_date || null
  }));

  const trackingRow = db.prepare(`SELECT value FROM settings WHERE key = 'tracking_base_url'`).get();
  const trackingBaseUrl = trackingRow ? trackingRow.value : '';

  return { desks, followups, contacts, trackingBaseUrl };
}

// Replace the entire board. Full-replace keeps the frontend's "save the whole
// state" model intact while still storing everything in normalized tables.
// node:sqlite has no transaction() helper, so we drive BEGIN/COMMIT by hand and
// roll back on any error so a failed save never leaves half-written tables.
function writeState(state) {
  // The frontend never sees stored app passwords, so a normal save would blank
  // them. Snapshot existing passwords first and keep them unless the incoming
  // desk explicitly supplies a new non-empty one.
  const existingPw = new Map(
    db.prepare(`SELECT id, app_password FROM desks`).all().map(r => [r.id, r.app_password || ''])
  );

  db.exec('BEGIN');
  try {
    if (typeof state.trackingBaseUrl === 'string') {
      db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('tracking_base_url', ?)`).run(state.trackingBaseUrl);
    }
    db.prepare(`DELETE FROM desks`).run();
    db.prepare(`DELETE FROM followups`).run();
    db.prepare(`DELETE FROM contacts`).run();
    db.prepare(`DELETE FROM followups_sent`).run();

    const insDesk = db.prepare(
      `INSERT INTO desks (id, name, angle, subject, subject_no_market, body, sender_email, app_password, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    (state.desks || []).forEach((d, i) => {
      const pw = (d.appPassword && d.appPassword.length) ? d.appPassword : (existingPw.get(d.id) || '');
      insDesk.run(
        d.id, d.name, d.angle || '', d.subject || '', d.subjectNoMarket || '', d.body || '',
        d.senderEmail || '', pw, i
      );
    });

    const insFollowup = db.prepare(
      `INSERT INTO followups (stage, day, subject, body, position) VALUES (?, ?, ?, ?, ?)`
    );
    (state.followups || []).forEach((f, i) => {
      insFollowup.run(f.stage, f.day, f.subject || '', f.body || '', i);
    });

    const insContact = db.prepare(
      `INSERT INTO contacts (id, name, email, market, account_id, sent_date, replied, closed, is_spam, opened, opened_date, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insSent = db.prepare(
      `INSERT INTO followups_sent (contact_id, stage, date) VALUES (?, ?, ?)`
    );
    (state.contacts || []).forEach((c, i) => {
      insContact.run(
        c.id, c.name, c.email || '', c.market || '', c.accountId || null,
        c.sentDate || null, c.replied ? 1 : 0, c.closed ? 1 : 0,
        c.isSpam ? 1 : 0, c.opened ? 1 : 0, c.openedDate || null, i
      );
      (c.followupsSent || []).forEach(s => insSent.run(c.id, s.stage, s.date));
    });

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---- Email sending -----------------------------------------------------
// One reusable Gmail SMTP transporter per desk, keyed by "email:password" so a
// credential change transparently builds a fresh one.
const transporters = new Map();

function transporterFor(senderEmail, appPassword) {
  const key = `${senderEmail}:${appPassword}`;
  let t = transporters.get(key);
  if (!t) {
    t = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: senderEmail, pass: appPassword }
    });
    transporters.set(key, t);
  }
  return t;
}

// Send one email from a desk's mailbox. The frontend composes subject/body and
// passes the desk id; credentials are looked up server-side and never exposed.
async function sendEmail({ deskId, to, subject, body, contactId, enableTracking, reqHost, trackingBaseUrl }) {
  if (!to) throw new Error('Missing recipient email address');
  const desk = db.prepare(`SELECT * FROM desks WHERE id = ?`).get(deskId);
  if (!desk) throw new Error('Desk not found');
  if (!desk.sender_email) throw new Error(`Desk "${desk.name}" has no sender email set`);
  if (!desk.app_password) throw new Error(`Desk "${desk.name}" has no app password set`);

  const transporter = transporterFor(desk.sender_email, desk.app_password);
  
  // Clean, high-deliverability body formatting
  const plainText = String(body || '').trim();
  let htmlBody = plainText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>');

  // Appending http://localhost tracking pixels can trigger Gmail spam filters on personal accounts.
  // Only embed the tracking pixel if enableTracking is explicitly requested.
  if (contactId && enableTracking !== false) {
    const host = trackingBaseUrl || process.env.RENDER_EXTERNAL_URL || reqHost || `http://${getLocalIp()}:${PORT}`;
    const trackingUrl = `${host.replace(/\/$/, '')}/api/track-open/${encodeURIComponent(contactId)}`;
    htmlBody += `<br><br><img src="${trackingUrl}" width="1" height="1" style="display:none;" alt="" />`;
  }

  const mailOptions = {
    from: desk.name ? `"${desk.name}" <${desk.sender_email}>` : desk.sender_email,
    to,
    subject: subject || '',
    text: plainText,
    html: htmlBody
  };

  const info = await transporter.sendMail(mailOptions);
  return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
}

// ---- HTTP --------------------------------------------------------------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 20 * 1024 * 1024) reject(new Error('payload too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      const html = await readFile(join(__dirname, 'public', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && req.url === '/favicon.ico') {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">✉️</text></svg>`;
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      res.end(svg);
      return;
    }

    if (req.method === 'GET' && req.url === '/api/state') {
      const state = readState();
      sendJson(res, 200, { ...state, empty: state.desks.length === 0 && state.contacts.length === 0 });
      return;
    }

    if (req.method === 'PUT' && req.url === '/api/state') {
      const raw = await readBody(req);
      const state = JSON.parse(raw);
      writeState(state);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/api/track-open/')) {
      const contactId = req.url.replace('/api/track-open/', '').split('?')[0];
      if (contactId) {
        try {
          db.prepare(`UPDATE contacts SET opened = 1, opened_date = ? WHERE id = ?`).run(new Date().toISOString(), contactId);
        } catch (e) {
          console.error('Failed to mark open for contact', contactId, e);
        }
      }
      const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
      res.writeHead(200, {
        'Content-Type': 'image/gif',
        'Content-Length': gif.length,
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
      });
      res.end(gif);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/send') {
      const raw = await readBody(req);
      const payload = JSON.parse(raw);
      try {
        const proto = req.headers['x-forwarded-proto'] || 'http';
        const hostHeader = req.headers.host || (`localhost:${PORT}`);
        const reqHost = `${proto}://${hostHeader}`;
        const result = await sendEmail({ ...payload, reqHost });
        sendJson(res, 200, { ok: true, ...result });
      } catch (err) {
        // A send failure (bad password, rejected recipient, etc.) is a normal
        // outcome, not a server crash — report it as 400 with a clear message.
        sendJson(res, 400, { ok: false, error: String(err && err.message || err) });
      }
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('request failed:', err);
    sendJson(res, 500, { error: String(err && err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`\n  Dispatch Board running →  http://localhost:${PORT}`);
  console.log(`  Database: ${DB_PATH}`);
  console.log(`  Stop with Ctrl+C\n`);
});

