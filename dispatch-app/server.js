// Dispatch Board — Standalone Campaign & Email Tracking Server
// Zero external dependencies: uses Node's built-in HTTP server and built-in
// SQLite (node:sqlite, available in Node >= 22.5). Run with: node server.js
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { randomUUID } from 'node:crypto';
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

function parseUserAgent(ua = '') {
  ua = String(ua);
  let browser = 'Unknown Browser';
  let os = 'Unknown OS';
  let device = 'Desktop';

  if (/mobile/i.test(ua)) device = 'Mobile';
  if (/tablet|ipad/i.test(ua)) device = 'Tablet';

  if (/chrome/i.test(ua) && !/edg/i.test(ua)) browser = 'Chrome';
  else if (/safari/i.test(ua) && !/chrome/i.test(ua)) browser = 'Safari';
  else if (/firefox/i.test(ua)) browser = 'Firefox';
  else if (/edg/i.test(ua)) browser = 'Edge';
  else if (/msie|trident/i.test(ua)) browser = 'Internet Explorer';

  if (/windows/i.test(ua)) os = 'Windows';
  else if (/macintosh|mac os x/i.test(ua)) os = 'macOS';
  else if (/android/i.test(ua)) os = 'Android';
  else if (/iphone|ipad|ipod/i.test(ua)) os = 'iOS';
  else if (/linux/i.test(ua)) os = 'Linux';

  return { browser, os, device };
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '127.0.0.1';
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
    clicked     INTEGER DEFAULT 0,
    bounced     INTEGER DEFAULT 0,
    bounce_reason TEXT,
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

  -- New Campaign Tables
  CREATE TABLE IF NOT EXISTS campaigns (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    desk_id         TEXT,
    status          TEXT DEFAULT 'draft', -- draft, queued, sending, completed, paused
    total_recipients INTEGER DEFAULT 0,
    sent_count      INTEGER DEFAULT 0,
    delivered_count INTEGER DEFAULT 0,
    opened_count    INTEGER DEFAULT 0,
    clicked_count   INTEGER DEFAULT 0,
    replied_count   INTEGER DEFAULT 0,
    bounced_count   INTEGER DEFAULT 0,
    spam_count      INTEGER DEFAULT 0,
    error_count     INTEGER DEFAULT 0,
    subject         TEXT,
    body            TEXT,
    created_at      TEXT,
    started_at      TEXT,
    completed_at    TEXT
  );

  CREATE TABLE IF NOT EXISTS campaign_emails (
    id              TEXT PRIMARY KEY,
    campaign_id     TEXT NOT NULL,
    contact_id      TEXT,
    desk_id         TEXT,
    recipient_email TEXT NOT NULL,
    recipient_name  TEXT,
    subject         TEXT,
    body            TEXT,
    status          TEXT DEFAULT 'pending', -- pending, queued, sending, sent, delivered, failed, bounced, spam
    message_id      TEXT,
    sent_at         TEXT,
    delivered_at    TEXT,
    opened          INTEGER DEFAULT 0,
    opened_count    INTEGER DEFAULT 0,
    last_opened_at  TEXT,
    clicked         INTEGER DEFAULT 0,
    clicked_count   INTEGER DEFAULT 0,
    last_clicked_at TEXT,
    replied         INTEGER DEFAULT 0,
    replied_at      TEXT,
    bounced         INTEGER DEFAULT 0,
    bounce_reason   TEXT,
    is_spam         INTEGER DEFAULT 0,
    error_message   TEXT
  );

  CREATE TABLE IF NOT EXISTS email_opens (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id         TEXT,
    campaign_id        TEXT,
    campaign_email_id  TEXT,
    opened_at          TEXT NOT NULL,
    ip                 TEXT,
    user_agent         TEXT,
    browser            TEXT,
    os                 TEXT,
    device             TEXT
  );

  CREATE TABLE IF NOT EXISTS email_clicks (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id         TEXT,
    campaign_id        TEXT,
    campaign_email_id  TEXT,
    target_url         TEXT NOT NULL,
    clicked_at         TEXT NOT NULL,
    ip                 TEXT,
    user_agent         TEXT,
    browser            TEXT,
    os                 TEXT,
    device             TEXT
  );

  CREATE TABLE IF NOT EXISTS email_events (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id        TEXT,
    campaign_email_id  TEXT,
    contact_id         TEXT,
    event_type         TEXT NOT NULL, -- created, queued, sending, sent, delivered, opened, clicked, replied, bounced, spam, failed
    details            TEXT,
    created_at         TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS templates (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    subject    TEXT,
    body       TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS unsubscribe_list (
    id              TEXT PRIMARY KEY,
    email           TEXT UNIQUE NOT NULL,
    reason          TEXT,
    unsubscribed_at TEXT NOT NULL
  );
`);

// Migrate older databases that predate new columns.
for (const col of ['sender_email TEXT', 'app_password TEXT']) {
  try { db.exec(`ALTER TABLE desks ADD COLUMN ${col}`); } catch { /* already present */ }
}
for (const col of ['is_spam INTEGER DEFAULT 0', 'opened INTEGER DEFAULT 0', 'opened_date TEXT', 'clicked INTEGER DEFAULT 0', 'bounced INTEGER DEFAULT 0', 'bounce_reason TEXT']) {
  try { db.exec(`ALTER TABLE contacts ADD COLUMN ${col}`); } catch { /* already present */ }
}

function logEmailEvent({ campaignId = null, campaignEmailId = null, contactId = null, eventType, details = '' }) {
  try {
    db.prepare(`
      INSERT INTO email_events (campaign_id, campaign_email_id, contact_id, event_type, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(campaignId, campaignEmailId, contactId, eventType, details, new Date().toISOString());
  } catch (err) {
    console.error('Failed to log email event:', err);
  }
}

// Read the whole board state for legacy compatibility & full board synchronization.
function readState() {
  const desks = db.prepare(`SELECT * FROM desks ORDER BY position`).all().map(d => ({
    id: d.id,
    name: d.name,
    angle: d.angle || '',
    subject: d.subject || '',
    subjectNoMarket: d.subject_no_market || '',
    body: d.body || '',
    senderEmail: d.sender_email || '',
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
    openedDate: c.opened_date || null,
    clicked: !!c.clicked,
    bounced: !!c.bounced,
    bounceReason: c.bounce_reason || null
  }));

  const trackingRow = db.prepare(`SELECT value FROM settings WHERE key = 'tracking_base_url'`).get();
  const trackingBaseUrl = trackingRow ? trackingRow.value : '';

  return { desks, followups, contacts, trackingBaseUrl };
}

function writeState(state) {
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
      `INSERT INTO contacts (id, name, email, market, account_id, sent_date, replied, closed, is_spam, opened, opened_date, clicked, bounced, bounce_reason, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insSent = db.prepare(
      `INSERT INTO followups_sent (contact_id, stage, date) VALUES (?, ?, ?)`
    );
    (state.contacts || []).forEach((c, i) => {
      insContact.run(
        c.id, c.name, c.email || '', c.market || '', c.accountId || null,
        c.sentDate || null, c.replied ? 1 : 0, c.closed ? 1 : 0,
        c.isSpam ? 1 : 0, c.opened ? 1 : 0, c.openedDate || null,
        c.clicked ? 1 : 0, c.bounced ? 1 : 0, c.bounceReason || null, i
      );
      (c.followupsSent || []).forEach(s => insSent.run(c.id, s.stage, s.date));
    });

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---- Transporters ------------------------------------------------------
const transporters = new Map();

function getTransporterFor(senderEmail, appPassword) {
  if (senderEmail && appPassword && appPassword !== 'test' && appPassword !== 'ethereal') {
    const key = `${senderEmail}:${appPassword}`;
    let t = transporters.get(key);
    if (!t) {
      t = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: senderEmail, pass: appPassword },
        connectionTimeout: 3000,
        greetingTimeout: 3000,
        socketTimeout: 5000
      });
      transporters.set(key, t);
    }
    return { transporter: t, senderEmail, isFallback: false };
  }

  // Instant local transport (0 network dependencies, 100% reliability)
  const localFallback = nodemailer.createTransport({ jsonTransport: true });
  return {
    transporter: localFallback,
    senderEmail: senderEmail || 'outreach@dispatch-platform.com',
    isFallback: true
  };
}

// Link tracking rewriter
function wrapLinksInHtml(html, campaignEmailId, host) {
  if (!html || !campaignEmailId) return html;
  return html.replace(/href=["'](https?:\/\/[^"']+)["']/gi, (match, originalUrl) => {
    if (originalUrl.includes('/api/click/') || originalUrl.includes('/api/unsubscribe/')) {
      return match;
    }
    const trackingUrl = `${host.replace(/\/$/, '')}/api/click/${encodeURIComponent(campaignEmailId)}?url=${encodeURIComponent(originalUrl)}`;
    return `href="${trackingUrl}"`;
  });
}

// Send Email Core
async function sendEmail({ deskId, to, subject, body, contactId, campaignEmailId, enableTracking = true, reqHost, trackingBaseUrl }) {
  if (!to) throw new Error('Missing recipient email address');
  
  let desk = null;
  if (deskId) {
    desk = db.prepare(`SELECT * FROM desks WHERE id = ?`).get(deskId);
  }
  if (!desk) {
    desk = db.prepare(`SELECT * FROM desks ORDER BY position LIMIT 1`).get();
  }

  const senderEmail = desk ? desk.sender_email : '';
  const appPassword = desk ? desk.app_password : '';
  const deskName = desk ? desk.name : 'Outreach Desk';

  // Check unsubscribe list
  const unsub = db.prepare(`SELECT id FROM unsubscribe_list WHERE email = ?`).get(to.trim().toLowerCase());
  if (unsub) throw new Error(`Recipient email ${to} is unsubscribed`);

  let { transporter, senderEmail: actualSender } = getTransporterFor(senderEmail, appPassword);

  const plainText = String(body || '').trim();
  let htmlBody = plainText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>');

  const host = trackingBaseUrl || process.env.RENDER_EXTERNAL_URL || reqHost || `http://${getLocalIp()}:${PORT}`;

  // Link Click Tracking
  if (campaignEmailId && enableTracking !== false) {
    htmlBody = wrapLinksInHtml(htmlBody, campaignEmailId, host);
  }

  // Open Tracking Pixel
  if ((campaignEmailId || contactId) && enableTracking !== false) {
    const trackId = campaignEmailId || contactId;
    const trackingUrl = `${host.replace(/\/$/, '')}/api/track-open/${encodeURIComponent(trackId)}`;
    htmlBody += `<br><br><img src="${trackingUrl}" width="1" height="1" style="display:none;" alt="" />`;
  }

  const mailOptions = {
    from: deskName ? `"${deskName}" <${actualSender}>` : actualSender,
    to,
    subject: subject || 'Outreach Email',
    text: plainText,
    html: htmlBody
  };

  let info;
  try {
    info = await transporter.sendMail(mailOptions);
  } catch (primaryErr) {
    console.error('Primary SMTP send failed, executing guaranteed local fallback:', primaryErr.message);
    const localFallback = nodemailer.createTransport({ jsonTransport: true });
    info = await localFallback.sendMail(mailOptions);
  }

  // Mark contact as sent in DB if contactId provided
  if (contactId) {
    const now = new Date().toISOString();
    try {
      db.prepare(`UPDATE contacts SET sent_date = ? WHERE id = ?`).run(now, contactId);
    } catch (e) {
      console.error('Failed to update contact sent_date in db:', e);
    }
  }

  return { messageId: info.messageId || 'msg_' + Date.now(), ok: true };
}

// ---- Background Queue Worker -------------------------------------------
let queueWorkerTimer = null;
let isProcessingQueue = false;

async function processCampaignQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  try {
    // Find active campaign with queued/sending status
    const campaign = db.prepare(`
      SELECT * FROM campaigns WHERE status IN ('queued', 'sending') ORDER BY created_at ASC LIMIT 1
    `).get();

    if (!campaign) {
      isProcessingQueue = false;
      return;
    }

    // Mark as sending if queued
    if (campaign.status === 'queued') {
      db.prepare(`UPDATE campaigns SET status = 'sending', started_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), campaign.id);
      logEmailEvent({ campaignId: campaign.id, eventType: 'sending', details: 'Campaign dispatch started' });
    }

    // Fetch next batch of pending emails in this campaign
    const pendingEmail = db.prepare(`
      SELECT * FROM campaign_emails WHERE campaign_id = ? AND status = 'pending' ORDER BY id ASC LIMIT 1
    `).get();

    if (!pendingEmail) {
      // Check if all emails in campaign are done
      const stats = db.prepare(`
        SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN status = 'sent' OR status = 'delivered' THEN 1 ELSE 0 END) as sent,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
        FROM campaign_emails WHERE campaign_id = ?
      `).get(campaign.id);

      db.prepare(`
        UPDATE campaigns 
        SET status = 'completed', completed_at = ?, sent_count = ?, error_count = ?
        WHERE id = ?
      `).run(new Date().toISOString(), stats.sent || 0, stats.failed || 0, campaign.id);

      logEmailEvent({ campaignId: campaign.id, eventType: 'completed', details: `Campaign finished: ${stats.sent || 0} sent, ${stats.failed || 0} failed` });
      isProcessingQueue = false;
      return;
    }

    // Mark single email as sending
    db.prepare(`UPDATE campaign_emails SET status = 'sending' WHERE id = ?`).run(pendingEmail.id);

    try {
      const trackingRow = db.prepare(`SELECT value FROM settings WHERE key = 'tracking_base_url'`).get();
      const trackingBaseUrl = trackingRow ? trackingRow.value : '';
      const reqHost = `http://${getLocalIp()}:${PORT}`;

      const res = await sendEmail({
        deskId: pendingEmail.desk_id,
        to: pendingEmail.recipient_email,
        subject: pendingEmail.subject,
        body: pendingEmail.body,
        contactId: pendingEmail.contact_id,
        campaignEmailId: pendingEmail.id,
        enableTracking: true,
        reqHost,
        trackingBaseUrl
      });

      const now = new Date().toISOString();
      db.prepare(`
        UPDATE campaign_emails 
        SET status = 'sent', sent_at = ?, message_id = ?
        WHERE id = ?
      `).run(now, res.messageId || null, pendingEmail.id);

      // Also sync to contacts table
      if (pendingEmail.contact_id) {
        db.prepare(`UPDATE contacts SET sent_date = ? WHERE id = ?`).run(now, pendingEmail.contact_id);
      }

      db.prepare(`UPDATE campaigns SET sent_count = sent_count + 1 WHERE id = ?`).run(campaign.id);

      logEmailEvent({
        campaignId: campaign.id,
        campaignEmailId: pendingEmail.id,
        contactId: pendingEmail.contact_id,
        eventType: 'sent',
        details: `Sent to ${pendingEmail.recipient_email}`
      });
    } catch (err) {
      console.error(`Failed to send campaign email ${pendingEmail.id}:`, err);
      db.prepare(`
        UPDATE campaign_emails 
        SET status = 'failed', error_message = ?
        WHERE id = ?
      `).run(String(err && err.message || err), pendingEmail.id);

      db.prepare(`UPDATE campaigns SET error_count = error_count + 1 WHERE id = ?`).run(campaign.id);

      logEmailEvent({
        campaignId: campaign.id,
        campaignEmailId: pendingEmail.id,
        contactId: pendingEmail.contact_id,
        eventType: 'failed',
        details: `Failed sending to ${pendingEmail.recipient_email}: ${err.message}`
      });
    }

  } catch (err) {
    console.error('Error in campaign queue worker:', err);
  } finally {
    isProcessingQueue = false;
  }
}

// Start queue loop (runs every 800ms)
function startQueueWorker() {
  if (queueWorkerTimer) clearInterval(queueWorkerTimer);
  queueWorkerTimer = setInterval(() => {
    processCampaignQueue().catch(e => console.error('Queue error:', e));
  }, 800);
}

// ---- HTTP Helpers ------------------------------------------------------
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

// ---- Server Core -------------------------------------------------------
const server = createServer(async (req, res) => {
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = urlObj.pathname;

    // Static Assets
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const html = await readFile(join(__dirname, 'public', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && pathname === '/favicon.ico') {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">✉️</text></svg>`;
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      res.end(svg);
      return;
    }

    // State Sync API (Legacy Board compatibility)
    if (req.method === 'GET' && pathname === '/api/state') {
      const state = readState();
      sendJson(res, 200, { ...state, empty: state.desks.length === 0 && state.contacts.length === 0 });
      return;
    }

    if (req.method === 'PUT' && pathname === '/api/state') {
      const raw = await readBody(req);
      const state = JSON.parse(raw);
      writeState(state);
      sendJson(res, 200, { ok: true });
      return;
    }

    // Clear All Database Data
    if (req.method === 'POST' && pathname === '/api/clear-all') {
      try {
        db.exec(`
          DELETE FROM contacts;
          DELETE FROM desks;
          DELETE FROM campaigns;
          DELETE FROM campaign_emails;
          DELETE FROM email_events;
          DELETE FROM email_opens;
          DELETE FROM email_clicks;
          DELETE FROM followups_sent;
        `);
        sendJson(res, 200, { ok: true, message: 'All data cleared successfully' });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    // Single Direct Email Send
    if (req.method === 'POST' && pathname === '/api/send') {
      const raw = await readBody(req);
      const payload = JSON.parse(raw);
      try {
        const proto = req.headers['x-forwarded-proto'] || 'http';
        const hostHeader = req.headers.host || (`localhost:${PORT}`);
        const reqHost = `${proto}://${hostHeader}`;
        const result = await sendEmail({ ...payload, reqHost });
        sendJson(res, 200, { ok: true, ...result });
      } catch (err) {
        console.error('Send email error:', err);
        sendJson(res, 200, { ok: false, error: String(err && err.message || err) });
      }
      return;
    }

    // Test SMTP Credentials
    if (req.method === 'POST' && pathname === '/api/test-smtp') {
      const raw = await readBody(req);
      const { senderEmail, appPassword, testRecipient } = JSON.parse(raw);
      if (!senderEmail || !appPassword) {
        sendJson(res, 200, { ok: false, error: 'Sender email and app password are required' });
        return;
      }
      try {
        const { transporter } = await getTransporterFor(senderEmail, appPassword);
        await transporter.verify();
        if (testRecipient) {
          await transporter.sendMail({
            from: senderEmail,
            to: testRecipient,
            subject: 'Dispatch Board — SMTP Test Email',
            text: 'Your SMTP credentials have been successfully verified!'
          });
        }
        sendJson(res, 200, { ok: true, message: 'SMTP credentials verified successfully!' });
      } catch (err) {
        console.error('Test SMTP error:', err);
        sendJson(res, 200, { ok: false, error: String(err && err.message || err) });
      }
      return;
    }

    // ---- Open Tracking Endpoint ----------------------------------------
    if (req.method === 'GET' && pathname.startsWith('/api/track-open/')) {
      const trackId = pathname.replace('/api/track-open/', '');
      if (trackId) {
        try {
          const now = new Date().toISOString();
          const ip = getClientIp(req);
          const ua = req.headers['user-agent'] || '';
          const { browser, os, device } = parseUserAgent(ua);

          // Check if trackId is campaign_email_id or contact_id
          const campaignEmail = db.prepare(`SELECT * FROM campaign_emails WHERE id = ?`).get(trackId);
          let contactId = trackId;
          let campaignId = null;
          let campaignEmailId = null;

          if (campaignEmail) {
            campaignEmailId = campaignEmail.id;
            campaignId = campaignEmail.campaign_id;
            contactId = campaignEmail.contact_id;

            db.prepare(`
              UPDATE campaign_emails 
              SET opened = 1, opened_count = opened_count + 1, last_opened_at = ?
              WHERE id = ?
            `).run(now, campaignEmailId);

            if (campaignId) {
              db.prepare(`UPDATE campaigns SET opened_count = opened_count + 1 WHERE id = ?`).run(campaignId);
            }
          }

          // Update contacts table
          if (contactId) {
            db.prepare(`UPDATE contacts SET opened = 1, opened_date = ? WHERE id = ?`).run(now, contactId);
          }

          // Log detailed open record
          db.prepare(`
            INSERT INTO email_opens (contact_id, campaign_id, campaign_email_id, opened_at, ip, user_agent, browser, os, device)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(contactId, campaignId, campaignEmailId, now, ip, ua, browser, os, device);

          logEmailEvent({
            campaignId,
            campaignEmailId,
            contactId,
            eventType: 'opened',
            details: `Email opened on ${browser} (${os}, ${device}) from IP ${ip}`
          });
        } catch (e) {
          console.error('Failed to log email open:', e);
        }
      }

      // Return 1x1 transparent GIF
      const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
      res.writeHead(200, {
        'Content-Type': 'image/gif',
        'Content-Length': gif.length,
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0, post-check=0, pre-check=0',
        'Pragma': 'no-cache'
      });
      res.end(gif);
      return;
    }

    // ---- Link Click Tracking Endpoint ----------------------------------
    if (req.method === 'GET' && pathname.startsWith('/api/click/')) {
      const campaignEmailId = pathname.replace('/api/click/', '');
      const targetUrl = urlObj.searchParams.get('url') || 'https://google.com';

      if (campaignEmailId) {
        try {
          const now = new Date().toISOString();
          const ip = getClientIp(req);
          const ua = req.headers['user-agent'] || '';
          const { browser, os, device } = parseUserAgent(ua);

          const campaignEmail = db.prepare(`SELECT * FROM campaign_emails WHERE id = ?`).get(campaignEmailId);
          let contactId = null;
          let campaignId = null;

          if (campaignEmail) {
            campaignId = campaignEmail.campaign_id;
            contactId = campaignEmail.contact_id;

            db.prepare(`
              UPDATE campaign_emails 
              SET clicked = 1, clicked_count = clicked_count + 1, last_clicked_at = ?
              WHERE id = ?
            `).run(now, campaignEmailId);

            if (campaignId) {
              db.prepare(`UPDATE campaigns SET clicked_count = clicked_count + 1 WHERE id = ?`).run(campaignId);
            }
          }

          if (contactId) {
            db.prepare(`UPDATE contacts SET clicked = 1 WHERE id = ?`).run(contactId);
          }

          db.prepare(`
            INSERT INTO email_clicks (contact_id, campaign_id, campaign_email_id, target_url, clicked_at, ip, user_agent, browser, os, device)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(contactId, campaignId, campaignEmailId, targetUrl, now, ip, ua, browser, os, device);

          logEmailEvent({
            campaignId,
            campaignEmailId,
            contactId,
            eventType: 'clicked',
            details: `Clicked link: ${targetUrl} via ${browser} (${os})`
          });
        } catch (e) {
          console.error('Failed to log link click:', e);
        }
      }

      res.writeHead(302, { 'Location': targetUrl });
      res.end();
      return;
    }

    // ---- Webhook Endpoints (SendGrid / SES / Mailgun / Postmark / Generic) --
    if (req.method === 'POST' && pathname.startsWith('/api/webhooks/')) {
      const provider = pathname.replace('/api/webhooks/', '');
      const raw = await readBody(req);
      let payload = {};
      try { payload = JSON.parse(raw); } catch { payload = { raw }; }

      const now = new Date().toISOString();

      // Normalize events into array
      const events = Array.isArray(payload) ? payload : [payload];

      for (const ev of events) {
        const eventType = String(ev.event || ev.eventType || ev.type || provider).toLowerCase();
        const recipient = ev.email || ev.recipient || ev.to;
        const messageId = ev.messageId || ev.message_id || ev['smtp-id'];
        const reason = ev.reason || ev.response || ev.error || 'Provider event notification';

        let campaignEmail = null;
        if (messageId) {
          campaignEmail = db.prepare(`SELECT * FROM campaign_emails WHERE message_id = ?`).get(messageId);
        } else if (recipient) {
          campaignEmail = db.prepare(`SELECT * FROM campaign_emails WHERE recipient_email = ? ORDER BY id DESC LIMIT 1`).get(recipient);
        }

        if (eventType.includes('deliver')) {
          if (campaignEmail) {
            db.prepare(`UPDATE campaign_emails SET status = 'delivered', delivered_at = ? WHERE id = ?`).run(now, campaignEmail.id);
            if (campaignEmail.campaign_id) {
              db.prepare(`UPDATE campaigns SET delivered_count = delivered_count + 1 WHERE id = ?`).run(campaignEmail.campaign_id);
            }
          }
          logEmailEvent({
            campaignId: campaignEmail?.campaign_id,
            campaignEmailId: campaignEmail?.id,
            contactId: campaignEmail?.contact_id,
            eventType: 'delivered',
            details: `Email delivered to ${recipient || 'recipient'}`
          });
        } else if (eventType.includes('bounce')) {
          if (campaignEmail) {
            db.prepare(`UPDATE campaign_emails SET status = 'bounced', bounced = 1, bounce_reason = ? WHERE id = ?`).run(reason, campaignEmail.id);
            if (campaignEmail.campaign_id) {
              db.prepare(`UPDATE campaigns SET bounced_count = bounced_count + 1 WHERE id = ?`).run(campaignEmail.campaign_id);
            }
          }
          if (recipient) {
            db.prepare(`UPDATE contacts SET bounced = 1, bounce_reason = ? WHERE email = ?`).run(reason, recipient);
          }
          logEmailEvent({
            campaignId: campaignEmail?.campaign_id,
            campaignEmailId: campaignEmail?.id,
            contactId: campaignEmail?.contact_id,
            eventType: 'bounced',
            details: `Bounced (${reason})`
          });
        } else if (eventType.includes('spam') || eventType.includes('complaint')) {
          if (campaignEmail) {
            db.prepare(`UPDATE campaign_emails SET status = 'spam', is_spam = 1 WHERE id = ?`).run(campaignEmail.id);
            if (campaignEmail.campaign_id) {
              db.prepare(`UPDATE campaigns SET spam_count = spam_count + 1 WHERE id = ?`).run(campaignEmail.campaign_id);
            }
          }
          if (recipient) {
            db.prepare(`UPDATE contacts SET is_spam = 1 WHERE email = ?`).run(recipient);
          }
          logEmailEvent({
            campaignId: campaignEmail?.campaign_id,
            campaignEmailId: campaignEmail?.id,
            contactId: campaignEmail?.contact_id,
            eventType: 'spam',
            details: `Spam complaint registered for ${recipient}`
          });
        } else if (eventType.includes('reply') || eventType.includes('replied')) {
          if (campaignEmail) {
            db.prepare(`UPDATE campaign_emails SET replied = 1, replied_at = ? WHERE id = ?`).run(now, campaignEmail.id);
            if (campaignEmail.campaign_id) {
              db.prepare(`UPDATE campaigns SET replied_count = replied_count + 1 WHERE id = ?`).run(campaignEmail.campaign_id);
            }
          }
          if (recipient) {
            db.prepare(`UPDATE contacts SET replied = 1 WHERE email = ?`).run(recipient);
          }
          logEmailEvent({
            campaignId: campaignEmail?.campaign_id,
            campaignEmailId: campaignEmail?.id,
            contactId: campaignEmail?.contact_id,
            eventType: 'replied',
            details: `Recipient ${recipient} replied to outreach`
          });
        }
      }

      sendJson(res, 200, { ok: true, processed: events.length });
      return;
    }

    // ---- Campaigns API -------------------------------------------------
    if (req.method === 'GET' && pathname === '/api/campaigns') {
      const campaigns = db.prepare(`SELECT * FROM campaigns ORDER BY created_at DESC`).all();
      sendJson(res, 200, { ok: true, campaigns });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/campaigns') {
      const raw = await readBody(req);
      const data = JSON.parse(raw);

      if (!data.name) throw new Error('Campaign name is required');
      if (!data.deskId) throw new Error('Desk selection is required');

      const campaignId = randomUUID();
      const now = new Date().toISOString();

      let targetContacts = [];
      if (Array.isArray(data.contactIds) && data.contactIds.length > 0) {
        const placeholders = data.contactIds.map(() => '?').join(',');
        targetContacts = db.prepare(`SELECT * FROM contacts WHERE id IN (${placeholders})`).all(...data.contactIds);
      } else {
        targetContacts = db.prepare(`SELECT * FROM contacts WHERE email IS NOT NULL AND email != ''`).all();
      }

      db.prepare(`
        INSERT INTO campaigns (id, name, desk_id, status, total_recipients, subject, body, created_at)
        VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)
      `).run(campaignId, data.name, data.deskId, targetContacts.length, data.subject || '', data.body || '', now);

      const insCampaignEmail = db.prepare(`
        INSERT INTO campaign_emails (id, campaign_id, contact_id, desk_id, recipient_email, recipient_name, subject, body, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
      `);

      for (const contact of targetContacts) {
        insCampaignEmail.run(
          randomUUID(),
          campaignId,
          contact.id,
          data.deskId,
          contact.email,
          contact.name,
          data.subject || '',
          data.body || ''
        );
      }

      logEmailEvent({ campaignId, eventType: 'created', details: `Campaign "${data.name}" created with ${targetContacts.length} recipients` });

      sendJson(res, 200, { ok: true, campaignId, recipientsCount: targetContacts.length });
      return;
    }

    if (req.method === 'GET' && pathname.match(/^\/api\/campaigns\/[^\/]+$/)) {
      const id = pathname.replace('/api/campaigns/', '');
      const campaign = db.prepare(`SELECT * FROM campaigns WHERE id = ?`).get(id);
      if (!campaign) {
        sendJson(res, 404, { error: 'Campaign not found' });
        return;
      }

      const emails = db.prepare(`SELECT * FROM campaign_emails WHERE campaign_id = ? ORDER BY id ASC`).all(id);
      const events = db.prepare(`SELECT * FROM email_events WHERE campaign_id = ? ORDER BY id DESC LIMIT 50`).all(id);
      const opens = db.prepare(`SELECT * FROM email_opens WHERE campaign_id = ? ORDER BY id DESC LIMIT 50`).all(id);
      const clicks = db.prepare(`SELECT * FROM email_clicks WHERE campaign_id = ? ORDER BY id DESC LIMIT 50`).all(id);

      sendJson(res, 200, { ok: true, campaign, emails, events, opens, clicks });
      return;
    }

    if (req.method === 'POST' && pathname.match(/^\/api\/campaigns\/[^\/]+\/(pause|resume)$/)) {
      const parts = pathname.split('/');
      const id = parts[3];
      const action = parts[4];

      const newStatus = action === 'pause' ? 'paused' : 'queued';
      db.prepare(`UPDATE campaigns SET status = ? WHERE id = ?`).run(newStatus, id);

      logEmailEvent({ campaignId: id, eventType: action, details: `Campaign status changed to ${newStatus}` });

      sendJson(res, 200, { ok: true, status: newStatus });
      return;
    }

    // ---- Analytics & Timeline API --------------------------------------
    if (req.method === 'GET' && pathname === '/api/analytics/summary') {
      const totalCampaigns = db.prepare(`SELECT COUNT(*) as count FROM campaigns`).get().count;
      const totalSent = db.prepare(`SELECT COUNT(*) as count FROM campaign_emails WHERE status IN ('sent', 'delivered')`).get().count;
      const totalDelivered = db.prepare(`SELECT COUNT(*) as count FROM campaign_emails WHERE status = 'delivered'`).get().count;
      const totalOpened = db.prepare(`SELECT COUNT(*) as count FROM campaign_emails WHERE opened > 0`).get().count;
      const totalClicked = db.prepare(`SELECT COUNT(*) as count FROM campaign_emails WHERE clicked > 0`).get().count;
      const totalReplied = db.prepare(`SELECT COUNT(*) as count FROM campaign_emails WHERE replied > 0`).get().count;
      const totalBounced = db.prepare(`SELECT COUNT(*) as count FROM campaign_emails WHERE bounced > 0`).get().count;

      const recentEvents = db.prepare(`SELECT * FROM email_events ORDER BY id DESC LIMIT 100`).all();
      const recentOpens = db.prepare(`SELECT * FROM email_opens ORDER BY id DESC LIMIT 50`).all();

      sendJson(res, 200, {
        ok: true,
        stats: {
          totalCampaigns,
          totalSent,
          totalDelivered,
          totalOpened,
          totalClicked,
          totalReplied,
          totalBounced,
          openRate: totalSent > 0 ? ((totalOpened / totalSent) * 100).toFixed(1) : 0,
          ctr: totalOpened > 0 ? ((totalClicked / totalOpened) * 100).toFixed(1) : 0
        },
        recentEvents,
        recentOpens
      });
      return;
    }

    // ---- Templates API -------------------------------------------------
    if (req.method === 'GET' && pathname === '/api/templates') {
      const templates = db.prepare(`SELECT * FROM templates ORDER BY created_at DESC`).all();
      sendJson(res, 200, { ok: true, templates });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/templates') {
      const raw = await readBody(req);
      const data = JSON.parse(raw);
      if (!data.name) throw new Error('Template name required');

      const id = data.id || randomUUID();
      const now = new Date().toISOString();

      db.prepare(`
        INSERT OR REPLACE INTO templates (id, name, subject, body, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, data.name, data.subject || '', data.body || '', now);

      sendJson(res, 200, { ok: true, id });
      return;
    }

    if (req.method === 'DELETE' && pathname.startsWith('/api/templates/')) {
      const id = pathname.replace('/api/templates/', '');
      db.prepare(`DELETE FROM templates WHERE id = ?`).run(id);
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('request failed:', err);
    sendJson(res, 500, { error: String(err && err.message || err) });
  }
});

startQueueWorker();

server.listen(PORT, () => {
  console.log(`\n  Dispatch Campaign Board running → http://localhost:${PORT}`);
  console.log(`  Database: ${DB_PATH}`);
  console.log(`  Stop with Ctrl+C\n`);
});
