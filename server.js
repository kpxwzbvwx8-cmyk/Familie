'use strict';

/*
 * Familie – kleiner Server für die gemeinsame Familien-App.
 * Alle Geräte (Clients) greifen auf denselben Server zu; jedes Gerät gehört genau einem Nutzer.
 *
 * Speicherung: JSON-Datei unter ./data/db.json
 * Live-Updates: Server-Sent Events (/api/stream)
 * Benachrichtigungen: Web Push (VAPID-Schlüssel werden beim ersten Start erzeugt)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const webpush = require('web-push');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------------------------------------------------------------------
// Datenhaltung
// ---------------------------------------------------------------------------

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return {};
  }
}

const db = Object.assign({ users: [], messages: [], pushSubscriptions: [], vapid: null }, loadDb());

function saveDb() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

if (!db.vapid) {
  db.vapid = webpush.generateVAPIDKeys();
  saveDb();
}
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || 'mailto:familie@example.invalid',
  db.vapid.publicKey,
  db.vapid.privateKey
);

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

const URGENCIES = ['info', 'normal', 'wichtig', 'dringend'];
const URGENCY_LABELS = { info: 'Info', normal: 'Normal', wichtig: 'Wichtig', dringend: 'Dringend' };

function newId() {
  return crypto.randomUUID();
}

function newTrainerId() {
  const taken = new Set(db.users.map((u) => u.trainerId));
  let id;
  do {
    id = String(crypto.randomInt(0, 100000)).padStart(5, '0');
  } while (taken.has(id));
  return id;
}

function publicUser(u) {
  return {
    id: u.id,
    trainerId: u.trainerId,
    firstName: u.firstName,
    lastName: u.lastName,
    color: u.color,
    birthday: u.birthday,
    strikes: u.strikes || 0,
    createdAt: u.createdAt,
  };
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 100_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Anfrage zu groß'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Ungültiges JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function authUser(req, url) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('t');
  if (!token) return null;
  return db.users.find((u) => u.token === token) || null;
}

function requireUser(req, url) {
  const user = authUser(req, url);
  if (!user) throw fail(401, 'Nicht angemeldet');
  return user;
}

function cleanString(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function isValidDate(v) {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

function validateProfile(body) {
  const firstName = cleanString(body.firstName, 40);
  const lastName = cleanString(body.lastName, 40);
  const color = typeof body.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.color) ? body.color.toLowerCase() : null;
  const birthday = typeof body.birthday === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.birthday) ? body.birthday : null;
  if (!firstName || !lastName) throw fail(400, 'Bitte Vor- und Nachnamen angeben');
  if (!color) throw fail(400, 'Bitte eine Lieblingsfarbe wählen');
  if (!birthday || Number.isNaN(Date.parse(birthday)) || new Date(birthday) > new Date()) {
    throw fail(400, 'Bitte ein gültiges Geburtsdatum angeben');
  }
  return { firstName, lastName, color, birthday };
}

function authorName(userId) {
  const u = db.users.find((x) => x.id === userId);
  return u ? `${u.firstName} ${u.lastName}` : 'Unbekannt';
}

function publicMessage(m) {
  const author = db.users.find((u) => u.id === m.authorId);
  return {
    ...m,
    authorName: author ? `${author.firstName} ${author.lastName}` : 'Unbekannt',
    authorColor: author ? author.color : '#888888',
  };
}

// ---------------------------------------------------------------------------
// Live-Updates (Server-Sent Events)
// ---------------------------------------------------------------------------

const streams = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const s of streams) s.res.write(payload);
}

setInterval(() => {
  for (const s of streams) s.res.write(': ping\n\n');
}, 25_000);

// ---------------------------------------------------------------------------
// Web Push
// ---------------------------------------------------------------------------

async function pushToOthers(authorId, payload) {
  const targets = db.pushSubscriptions.filter((s) => s.userId !== authorId);
  const dead = new Set();
  await Promise.all(
    targets.map(async (s) => {
      try {
        await webpush.sendNotification(s.subscription, JSON.stringify(payload), { TTL: 60 * 60 * 24 });
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) dead.add(s.subscription.endpoint);
        else console.warn('Push fehlgeschlagen:', err.statusCode || err.message);
      }
    })
  );
  if (dead.size) {
    db.pushSubscriptions = db.pushSubscriptions.filter((s) => !dead.has(s.subscription.endpoint));
    saveDb();
  }
}

// ---------------------------------------------------------------------------
// Automatisches Löschen abgelaufener Nachrichten
// ---------------------------------------------------------------------------

function purgeExpired() {
  const now = Date.now();
  const expired = db.messages.filter((m) => m.deleteAt && Date.parse(m.deleteAt) <= now);
  if (!expired.length) return;
  db.messages = db.messages.filter((m) => !expired.includes(m));
  saveDb();
  for (const m of expired) broadcast('message-deleted', { id: m.id });
}
setInterval(purgeExpired, 30_000);
purgeExpired();

// ---------------------------------------------------------------------------
// Kalender-Export (.ics)
// ---------------------------------------------------------------------------

function icsDate(d) {
  return new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function icsEscape(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function icsFold(line) {
  // RFC 5545: Zeilen max. 75 Oktette
  const out = [];
  let buf = Buffer.from(line, 'utf8');
  while (buf.length > 75) {
    let cut = 75;
    while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--; // UTF-8-Zeichen nicht zerteilen
    out.push(buf.subarray(0, cut).toString('utf8'));
    buf = Buffer.concat([Buffer.from(' '), buf.subarray(cut)]);
  }
  out.push(buf.toString('utf8'));
  return out.join('\r\n');
}

function buildIcs(m) {
  const start = m.eventAt || m.createdAt;
  const end = new Date(Date.parse(start) + 60 * 60 * 1000).toISOString();
  const desc = [m.description, `Dringlichkeit: ${URGENCY_LABELS[m.urgency] || m.urgency}`, `Von: ${authorName(m.authorId)}`]
    .filter(Boolean)
    .join('\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Familie//Austausch//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${m.id}@familie`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsEscape(m.title)}`,
    `DESCRIPTION:${icsEscape(desc)}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsEscape(m.title)}`,
    'TRIGGER:-PT30M',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;
  let m;

  // --- Nutzer ---------------------------------------------------------------
  if (pathname === '/api/users' && method === 'GET') {
    return sendJson(res, 200, db.users.map(publicUser));
  }

  if (pathname === '/api/users' && method === 'POST') {
    const profile = validateProfile(await readBody(req));
    const user = {
      id: newId(),
      token: crypto.randomBytes(32).toString('hex'),
      trainerId: newTrainerId(),
      ...profile,
      strikes: 0,
      createdAt: new Date().toISOString(),
    };
    db.users.push(user);
    saveDb();
    broadcast('users-changed', {});
    return sendJson(res, 201, { user: publicUser(user), token: user.token });
  }

  if (pathname === '/api/me' && method === 'GET') {
    return sendJson(res, 200, publicUser(requireUser(req, url)));
  }

  if (pathname === '/api/me' && method === 'PUT') {
    const user = requireUser(req, url);
    Object.assign(user, validateProfile(await readBody(req)));
    saveDb();
    broadcast('users-changed', {});
    return sendJson(res, 200, publicUser(user));
  }

  // --- Austausch --------------------------------------------------------------
  if (pathname === '/api/messages' && method === 'GET') {
    requireUser(req, url);
    purgeExpired();
    const list = db.messages
      .slice()
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map(publicMessage);
    return sendJson(res, 200, list);
  }

  if (pathname === '/api/messages' && method === 'POST') {
    const user = requireUser(req, url);
    const body = await readBody(req);
    const title = cleanString(body.title, 120);
    const description = cleanString(body.description, 4000);
    const urgency = URGENCIES.includes(body.urgency) ? body.urgency : 'normal';
    if (!title) throw fail(400, 'Bitte einen Titel angeben');
    if (body.eventAt && !isValidDate(body.eventAt)) throw fail(400, 'Ungültiger Zeitpunkt');
    if (body.deleteAt && !isValidDate(body.deleteAt)) throw fail(400, 'Ungültiges Löschdatum');
    if (body.deleteAt && Date.parse(body.deleteAt) <= Date.now()) {
      throw fail(400, 'Das Löschdatum muss in der Zukunft liegen');
    }
    const msg = {
      id: newId(),
      authorId: user.id,
      urgency,
      title,
      description,
      eventAt: body.eventAt ? new Date(body.eventAt).toISOString() : null,
      deleteAt: body.deleteAt ? new Date(body.deleteAt).toISOString() : null,
      createdAt: new Date().toISOString(),
    };
    db.messages.push(msg);
    saveDb();
    const pub = publicMessage(msg);
    broadcast('message-created', pub);
    pushToOthers(user.id, {
      title: `${URGENCY_LABELS[urgency]}: ${title}`,
      body: `${pub.authorName}${description ? ' – ' + description.slice(0, 140) : ''}`,
      tag: msg.id,
      url: `/?tab=austausch&msg=${msg.id}`,
      urgency,
    }).catch((e) => console.warn(e));
    return sendJson(res, 201, pub);
  }

  if ((m = pathname.match(/^\/api\/messages\/([\w-]+)$/)) && method === 'DELETE') {
    const user = requireUser(req, url);
    const msg = db.messages.find((x) => x.id === m[1]);
    if (!msg) throw fail(404, 'Nachricht nicht gefunden');
    if (msg.authorId !== user.id) throw fail(403, 'Nur der Urheber kann die Nachricht löschen');
    db.messages = db.messages.filter((x) => x !== msg);
    saveDb();
    broadcast('message-deleted', { id: msg.id });
    res.writeHead(204);
    return res.end();
  }

  if ((m = pathname.match(/^\/api\/messages\/([\w-]+)\.ics$/)) && method === 'GET') {
    requireUser(req, url);
    const msg = db.messages.find((x) => x.id === m[1]);
    if (!msg) throw fail(404, 'Nachricht nicht gefunden');
    const filename = (msg.title.replace(/[^\w\-äöüÄÖÜß ]+/g, '').trim() || 'termin').slice(0, 60);
    res.writeHead(200, {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `inline; filename="${encodeURIComponent(filename)}.ics"; filename*=UTF-8''${encodeURIComponent(filename)}.ics`,
      'Cache-Control': 'no-store',
    });
    return res.end(buildIcs(msg));
  }

  // --- Push -----------------------------------------------------------------
  if (pathname === '/api/push/key' && method === 'GET') {
    return sendJson(res, 200, { publicKey: db.vapid.publicKey });
  }

  if (pathname === '/api/push/subscribe' && method === 'POST') {
    const user = requireUser(req, url);
    const body = await readBody(req);
    const sub = body.subscription;
    if (!sub || typeof sub.endpoint !== 'string' || !sub.keys) throw fail(400, 'Ungültiges Abonnement');
    db.pushSubscriptions = db.pushSubscriptions.filter((s) => s.subscription.endpoint !== sub.endpoint);
    db.pushSubscriptions.push({ userId: user.id, subscription: sub, createdAt: new Date().toISOString() });
    saveDb();
    return sendJson(res, 201, { ok: true });
  }

  // --- Live-Stream ----------------------------------------------------------
  if (pathname === '/api/stream' && method === 'GET') {
    const user = requireUser(req, url);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 5000\n\n');
    const entry = { res, userId: user.id };
    streams.add(entry);
    req.on('close', () => streams.delete(entry));
    return;
  }

  throw fail(404, 'Nicht gefunden');
}

// ---------------------------------------------------------------------------
// Statische Dateien
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.stat(file, (err, stat) => {
    const target = !err && stat.isFile() ? file : path.join(PUBLIC_DIR, 'index.html');
    const ext = path.extname(target);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' || target.endsWith('sw.js') ? 'no-cache' : 'public, max-age=300',
    });
    fs.createReadStream(target).pipe(res);
  });
}

// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(req, res, url);
    } else {
      throw fail(405, 'Methode nicht erlaubt');
    }
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) sendJson(res, status, { error: err.message || 'Fehler' });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`Familie läuft auf http://localhost:${PORT}`);
});
