'use strict';

/* =========================================================================
 * Familie – Client (statische Web-App, Daten & Benachrichtigungen über Supabase)
 * ======================================================================= */

const CFG = window.FAMILIE_CONFIG || {};
// Versionsanhang, damit das Handy nach einer Veröffentlichung neue Bilder lädt
const V = CFG.version && CFG.version !== 'dev' ? `?v=${CFG.version}` : '';
const asset = (path) => path + V;
const configured = Boolean(CFG.supabaseUrl && CFG.supabaseKey && window.supabase);
const sb = configured
  ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'familie.auth' },
    })
  : null;

const state = {
  session: null,
  me: null,
  users: [],
  messages: [],
  familyCode: null,
  tab: 'start',
  highlight: null,
  expanded: new Set(),
  responses: new Map(), // messageId -> [{ userId, option, createdAt }]
  comments: new Map(),  // messageId -> [{ id, authorId, body, createdAt }]
  notes: [],            // Notizen (eigene + gemeinsame)
  events: [],           // Kalendertermine
  invites: [],          // Einladungen zu Terminen
  eventComments: [],    // Kommentare zu Terminen
  strikes: [],          // Board der Schande: alle Striche (neueste zuerst)
  rules: [],            // Strafkatalog inkl. Vorschläge
  fines: [],            // Strafen (10 € je 10 Striche)
};

const TABS = {
  start: 'Start',
  team: 'Team',
  notizen: 'Notizen',
  kalender: 'Kalender',
  einstellungen: 'Einstellungen',
  schande: 'Board der Schande',
};
const TAB_ALIASES = { austausch: 'start' }; // alte Links (z. B. aus Benachrichtigungen)

const URGENCIES = [
  { key: 'info', label: 'Info', ball: 'master', ballName: 'Meisterball' },
  { key: 'normal', label: 'Normal', ball: 'poke', ballName: 'Pokéball' },
  { key: 'wichtig', label: 'Wichtig', ball: 'super', ballName: 'Superball' },
  { key: 'dringend', label: 'Dringend', ball: 'hyper', ballName: 'Hyperball' },
];

// Trainer-Memo: Auswahlmöglichkeiten wie im Spiel
const NATURES = [
  'Robust', 'Kühn', 'Mäßig', 'Still', 'Scheu',
  'Solo', 'Sanft', 'Mild', 'Zart', 'Hastig',
  'Hart', 'Pfiffig', 'Zaghaft', 'Sacht', 'Froh',
  'Frech', 'Lasch', 'Hitzig', 'Kauzig', 'Naiv',
  'Mutig', 'Locker', 'Ruhig', 'Forsch', 'Ernst',
].sort((a, b) => a.localeCompare(b, 'de'));
const STATUS_MAX = 120; // kurz halten, damit das Memo nicht zerfällt
const FLAVORS = { scharf: 'scharfes', trocken: 'trockenes', 'süß': 'süßes', bitter: 'bitteres', sauer: 'saures' };

/** Ball als kleines SVG (eigene Zeichnung) */
function ballSvg(kind, size = 22) {
  const top = { poke: '#e3350d', super: '#3b6fd8', hyper: '#2b2b2b', master: '#7a3fa0' }[kind] || '#e3350d';
  const deco = {
    super: '<path d="M5 11.5 9.8 6.3l2.6 2-4.6 5z M27 11.5 22.2 6.3l-2.6 2 4.6 5z" fill="#e3350d"/>',
    hyper: '<path d="M8.6 5.4 12.4 3.5V16H8.6z M23.4 5.4 19.6 3.5V16h3.8z" fill="#f2c12e"/>',
    master: '<circle cx="8.6" cy="10.4" r="2.7" fill="#e85d9c"/><circle cx="23.4" cy="10.4" r="2.7" fill="#e85d9c"/>'
      + '<path d="M12.6 12.2V6.6l3.4 3.2 3.4-3.2v5.6" fill="none" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/>',
  }[kind] || '';
  return `<svg class="ball-svg" viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true">
    <circle cx="16" cy="16" r="14" fill="#fff"/>
    <path d="M2 16a14 14 0 0 1 28 0z" fill="${top}"/>${deco}
    <circle cx="16" cy="16" r="14" fill="none" stroke="#222" stroke-width="2"/>
    <path d="M2 16h28" stroke="#222" stroke-width="2.4"/>
    <circle cx="16" cy="16" r="4.4" fill="#fff" stroke="#222" stroke-width="2"/>
  </svg>`;
}

function urgencyInfo(key) {
  return URGENCIES.find((u) => u.key === key) || URGENCIES[1];
}

const COLOR_PRESETS = [
  '#d63b3b', '#e8772e', '#f2c12e', '#4caf50', '#1fa39a',
  '#2f80ed', '#6a4fd6', '#c04fc9', '#e85d9c', '#8d6e63', '#546e7a',
];

const $ = (sel, root = document) => root.querySelector(sel);

const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/* -------------------------------------------------------------------------
 * Hilfsfunktionen
 * ---------------------------------------------------------------------- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Supabase-Antwort auswerten: Fehler werfen, sonst Daten zurückgeben. */
function must({ data, error }) {
  if (error) throw new Error(friendlyError(error));
  return data;
}

function friendlyError(error) {
  const msg = error && (error.message || String(error));
  if (!msg) return 'Unbekannter Fehler';
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return 'Keine Verbindung zum Server. Bist du online?';
  if (/anonymous/i.test(msg) && /disabled/i.test(msg)) return 'Anonyme Anmeldung ist in Supabase noch nicht aktiviert (siehe Anleitung).';
  if (/row-level security/i.test(msg)) return 'Keine Berechtigung.';
  return msg;
}

function mapProfile(r) {
  return {
    id: r.id,
    trainerId: r.trainer_id,
    firstName: r.first_name,
    lastName: r.last_name,
    gender: r.gender,
    color: r.color,
    birthday: r.birthday,
    strikes: Number(r.strikes) || 0,
    nature: r.nature || '',
    loves: r.loves || '',
    flavor: r.flavor || '',
    region: r.region || '',
    statusText: r.status_text || '',
  };
}

function mapMessage(r) {
  return {
    id: r.id,
    authorId: r.author_id,
    urgency: r.urgency,
    title: r.title,
    description: r.description || '',
    eventAt: r.event_at,
    endAt: r.end_at || null,
    deleteAt: r.delete_at,
    createdAt: r.created_at,
    remindAtStart: Boolean(r.remind_at_start),
    needsAck: Boolean(r.needs_ack),
    deleteOnDone: Boolean(r.delete_on_done),
    doneBy: r.done_by || null,
    doneAt: r.done_at || null,
    ackOptions: Array.isArray(r.ack_options) && r.ack_options.length ? r.ack_options : null,
    deadlineAt: r.deadline_at || null,
    threatStrike: Boolean(r.threat_strike),
    closedAt: r.closed_at || null,
    reviewStatus: r.review_status || null,
    strikeNote: r.strike_note || null,
    respondBy: r.respond_by || null,
  };
}

let usersReloading = null;
function userById(id) {
  const u = state.users.find((x) => x.id === id);
  // Unbekanntes Konto (z. B. gerade beigetreten) → Profile einmal nachladen und neu zeichnen
  if (!u && id && sb && state.me && !usersReloading) {
    usersReloading = loadUsers()
      .then(() => { if (state.users.some((x) => x.id === id)) render(); })
      .catch(() => {})
      .finally(() => { setTimeout(() => { usersReloading = null; }, 5000); });
  }
  return u;
}

function parseBirthday(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function daysBetween(a, b) {
  return Math.round((startOfDay(b) - startOfDay(a)) / 86400000);
}

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function birthdayInYear(birth, year) {
  let day = birth.getDate();
  if (birth.getMonth() === 1 && day === 29 && !isLeap(year)) day = 28;
  return new Date(year, birth.getMonth(), day);
}

/** Alter in Jahren / Monaten / Wochen / Tagen */
function ageParts(birth, now = new Date()) {
  let years = now.getFullYear() - birth.getFullYear();
  let months = now.getMonth() - birth.getMonth();
  let days = now.getDate() - birth.getDate();
  if (days < 0) {
    months -= 1;
    days += new Date(now.getFullYear(), now.getMonth(), 0).getDate();
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  return { years, months, weeks: Math.floor(days / 7), days: days % 7 };
}

/** XP: Tage seit dem letzten Geburtstag von 365/366 bis zum nächsten */
function xpInfo(birth, now = new Date()) {
  const today = startOfDay(now);
  let last = birthdayInYear(birth, today.getFullYear());
  if (last > today) last = birthdayInYear(birth, today.getFullYear() - 1);
  const next = birthdayInYear(birth, last.getFullYear() + 1);
  const total = daysBetween(last, next);
  const xp = daysBetween(last, today);
  return { xp, total, remaining: total - xp, level: ageParts(birth, now).years, next };
}

function formatDate(d) {
  return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatDateTime(iso) {
  return new Date(iso).toLocaleString('de-DE', {
    weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

const rtf = new Intl.RelativeTimeFormat('de', { numeric: 'auto' });
function relative(iso) {
  const diff = (Date.parse(iso) - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 14) return rtf.format(Math.round(diff / 86400), 'day');
  return rtf.format(Math.round(diff / (86400 * 7)), 'week');
}

function toLocalInput(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(hex, target, amount) {
  const [r, g, b] = hexToRgb(hex);
  const [tr, tg, tb] = hexToRgb(target);
  const f = (a, t) => Math.round(a + (t - a) * amount);
  return `rgb(${f(r, tr)}, ${f(g, tg)}, ${f(b, tb)})`;
}
function isLightColor(hex) {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 175;
}

function colorVars(hex) {
  const light = isLightColor(hex);
  return `--c:${hex};--c-dark:${mix(hex, '#000000', light ? 0.3 : 0.45)};--c-light:${mix(hex, '#ffffff', 0.55)};`
    + (light ? '--c-text:#33333d;--c-shadow:rgba(255,255,255,.8);' : '');
}

function initials(u) {
  return ((u.firstName || '?')[0] + ((u.lastName || '')[0] || '')).toUpperCase();
}

/* -------------------------------------------------------------------------
 * Pokémon-Konten (fest hinterlegt, ohne Anmeldung)
 * ---------------------------------------------------------------------- */

const POKEMON = [
  {
    id: 'pokemon-speedy',
    kind: 'pokemon',
    trainerId: '15616',
    firstName: 'Speedy',
    lastName: '',
    gender: 'm',
    sprite: asset('img/speedy.png'),
    color: '#8d6e63', // braun
    birthday: '2016-06-15',
    strikes: 0,
    nature: 'Sanft',
    region: 'Kanto',
    loves: 'Essen und Schlafen',
    flavor: 'bitter',
    statusText: 'Am Essen',
  },
  {
    id: 'pokemon-idefix',
    kind: 'pokemon',
    trainerId: '01120',
    firstName: 'Idefix',
    lastName: '',
    gender: 'm',
    sprite: asset('img/idefix.png'),
    color: '#ececf0', // weiß
    birthday: '2020-01-01',
    strikes: 0,
    nature: 'Frech',
    region: 'Sinnoh',
    loves: 'es zu provozieren',
    flavor: 'bitter',
    statusText: 'Am Putzen',
  },
];

function pokemonById(id) {
  return POKEMON.find((p) => p.id === id);
}

/** Geschlechtssymbol wie im Spiel: blaues ♂ bzw. rotes ♀ */
function genderSvg(g) {
  if (g === 'm') {
    return '<svg class="gender-svg" viewBox="0 0 16 16" width="14" height="14" aria-label="männlich"><circle cx="6.5" cy="9.5" r="4" fill="none" stroke="#3b7dd8" stroke-width="2.2"/><path d="M9.5 6.5 14 2M9.6 2H14v4.4" fill="none" stroke="#3b7dd8" stroke-width="2.2" stroke-linecap="square"/></svg>';
  }
  return '<svg class="gender-svg" viewBox="0 0 16 16" width="14" height="14" aria-label="weiblich"><circle cx="8" cy="6" r="4" fill="none" stroke="#e0457b" stroke-width="2.2"/><path d="M8 10v5M5 12.7h6" fill="none" stroke="#e0457b" stroke-width="2.2"/></svg>';
}

function fullName(u) {
  return `${u.firstName} ${u.lastName}`.trim();
}

/* -------------------------------------------------------------------------
 * Trainerpass
 * ---------------------------------------------------------------------- */

const TRAINER_SVG = `
<svg viewBox="0 0 60 74" aria-hidden="true">
  <circle cx="30" cy="18" r="11" fill="#f2d1b3" stroke="#222" stroke-width="2"/>
  <path d="M18 15c0-8 6-12 12-12s12 4 12 12c-4-3-8-4-12-4s-8 1-12 4z" fill="var(--c-dark)" stroke="#222" stroke-width="2"/>
  <path d="M15 14h30" stroke="#222" stroke-width="2"/>
  <path d="M10 70c0-15 9-26 20-26s20 11 20 26z" fill="var(--c)" stroke="#222" stroke-width="2"/>
  <path d="M30 44v26" stroke="#222" stroke-width="2"/>
  <circle cx="26" cy="19" r="1.6" fill="#222"/><circle cx="34" cy="19" r="1.6" fill="#222"/>
</svg>`;

const SPRITES = { m: asset('img/trainer-m.png'), w: asset('img/trainer-w.png') };
// Porträts des Urhebers an Meldungen im Austausch
const PORTRAITS = { m: asset('img/portrait-m.png'), w: asset('img/portrait-w.png') };

function avatarHtml(u) {
  if (u.sprite) return `<img class="sprite" src="${esc(u.sprite)}" alt="">`;
  return SPRITES[u.gender]
    ? `<img class="sprite" src="${SPRITES[u.gender]}" alt="">`
    : TRAINER_SVG;
}

function fmtNum(n) {
  return String(Number(n) || 0).replace('.', ',');
}

function strikesLabel(n) {
  n = Number(n) || 0;
  if (!n) return '0';
  if (n > 15) return fmtNum(n);
  const whole = Math.floor(n);
  const tally = ('||||/ '.repeat(Math.floor(whole / 5)) + '|'.repeat(whole % 5) + (n % 1 ? '½' : '')).trim();
  return `${tally} (${fmtNum(n)})`;
}

function trainerCardHtml(u) {
  const birth = u.birthday ? parseBirthday(u.birthday) : null;
  const age = birth ? ageParts(birth) : null;
  const xp = birth ? xpInfo(birth) : null;
  const pct = xp ? Math.min(100, (xp.xp / xp.total) * 100) : 0;
  const spielzeit = age ? `${age.years} J ${age.months} M ${age.weeks} W ${age.days} T` : '–';
  const name = fullName(u) || '–';
  const isPokemon = u.kind === 'pokemon';

  return `
  <article class="tcard" style="${colorVars(u.color || '#d63b3b')}" aria-label="Trainerpass von ${esc(name)}">
    <div class="tcard-head"><span class="ball"></span>${isPokemon ? 'POKÉMON-PASS' : 'TRAINERPASS'}<span class="ball"></span></div>
    <div class="tcard-top">
      <div class="tcard-rows">
        <div class="trow"><span class="k">ID Nr.</span><span class="v">${esc(u.trainerId || '?????')}</span></div>
        <div class="trow"><span class="k">${isPokemon ? 'Name' : 'Trainer'}</span><span class="v">${esc(name)}${isPokemon ? ' ' + genderSvg(u.gender) : ''}</span></div>
        <div class="trow strikes"><span class="k">Striche</span><span class="v">${esc(strikesLabel(u.strikes || 0))}</span></div>
      </div>
      <div class="tcard-avatar">
        ${avatarHtml(u)}
        ${isPokemon ? '' : `<span class="initials">${esc(initials(u))}</span>`}
      </div>
    </div>
    <div class="tcard-bottom">
      <div class="trow"><span class="k">Spielzeit</span><span class="v">${esc(spielzeit)}</span></div>
      <div class="trow"><span class="k">Abenteuer gestartet</span><span class="v">${birth ? esc(formatDate(birth)) : '–'}</span></div>
    </div>
    <div class="xp">
      <div class="xp-line"><span>Lv. ${xp ? xp.level : '–'}</span><span>${xp ? `${xp.xp} / ${xp.total} XP` : '– XP'}</span></div>
      <div class="xp-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${xp ? xp.total : 0}" aria-valuenow="${xp ? xp.xp : 0}">
        <div class="xp-fill" style="width:${pct.toFixed(1)}%"></div>
      </div>
      <div class="xp-sub">${xp ? (xp.remaining === 0 ? 'Heute Level-Up! 🎉' : `Noch ${xp.remaining} XP bis Lv. ${xp.level + 1}`) : ''}</div>
    </div>
  </article>`;
}

/* -------------------------------------------------------------------------
 * Modal & Toast
 * ---------------------------------------------------------------------- */

function openModal(html, { dismissible = true, onMount, full = false, cls = '' } = {}) {
  const root = $('#modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = `modal-backdrop${cls ? ' bd-' + cls.split(' ')[0] : ''}`;
  backdrop.innerHTML = `<div class="modal${full ? ' full' : ''}${cls ? ' ' + cls : ''}" role="dialog" aria-modal="true">${html}</div>`;
  root.appendChild(backdrop);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    // Danach ggf. das nächste offene Urteil zeigen
    setTimeout(() => checkVerdicts(), 50);
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && dismissible) close();
  };
  document.addEventListener('keydown', onKey);
  if (dismissible) {
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop || e.target.closest('[data-close]')) close();
    });
  }
  const modal = backdrop.firstElementChild;
  if (onMount) onMount(modal, close);
  return close;
}

/* -------------------------------------------------------------------------
 * Spiel-Textbox (wie die Dialoge in den Pokémon-Spielen)
 *  – Text erscheint Buchstabe für Buchstabe; Tippen zeigt alles / blättert weiter
 *  – dsSay: Erklärungen & Hinweise (mehrseitig)
 *  – dsAsk: Ja/Nein-Auswahl statt der Browser-Rückfrage
 * ---------------------------------------------------------------------- */

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Schreibt Text Buchstabe für Buchstabe; liefert finish() und ein Versprechen */
function typeText(el, text, speed = 22) {
  let i = 0, timer = null, resolve;
  const done = new Promise((r) => { resolve = r; });
  const chars = [...text];
  const step = () => {
    i = Math.min(chars.length, i + 1);
    el.textContent = chars.slice(0, i).join('');
    if (i >= chars.length) { resolve(); return; }
    const c = chars[i - 1];
    timer = setTimeout(step, /[.!?…:]/.test(c) ? speed * 6 : /[,;–]/.test(c) ? speed * 3 : speed);
  };
  if (reduceMotion || !text) { el.textContent = text; resolve(); } else step();
  return {
    done,
    get finished() { return i >= chars.length || reduceMotion; },
    finish() { clearTimeout(timer); i = chars.length; el.textContent = text; resolve(); },
  };
}

/** Längere Texte in Seiten teilen (wie im Spiel: höchstens ~2–3 Zeilen pro Box) */
function pagesOf(text, max = 130) {
  const sentences = String(text).match(/[^.!?]+[.!?]*\s*/g) || [String(text)];
  const pages = [];
  let cur = '';
  for (const s of sentences) {
    if ((cur + s).length > max && cur) { pages.push(cur.trim()); cur = ''; }
    cur += s;
  }
  if (cur.trim()) pages.push(cur.trim());
  return pages;
}

function sayRoot() {
  let r = document.getElementById('say-root');
  if (!r) { r = document.createElement('div'); r.id = 'say-root'; document.body.appendChild(r); }
  return r;
}

function dsBoxHtml(speaker) {
  return `<div class="ds-say" role="dialog" aria-live="polite">
    ${speaker ? `<span class="ds-say-name">${esc(speaker)}</span>` : ''}
    <p class="ds-say-text"></p>
    <span class="ds-say-arrow" aria-hidden="true">▼</span>
  </div>`;
}

/** Erklärung/Hinweis als Spiel-Textbox; Tippen blättert weiter und schließt am Ende */
function dsSay(text, { speaker = '', pages = null } = {}) {
  return new Promise((resolve) => {
    const list = pages || pagesOf(text);
    const wrap = document.createElement('div');
    wrap.className = 'say-backdrop';
    wrap.innerHTML = dsBoxHtml(speaker);
    sayRoot().appendChild(wrap);
    const p = wrap.querySelector('.ds-say-text');
    const box = wrap.querySelector('.ds-say');
    let idx = 0, typing = null;
    const show = () => {
      box.classList.remove('ready');
      box.classList.toggle('last', idx === list.length - 1);
      typing = typeText(p, list[idx]);
      typing.done.then(() => box.classList.add('ready'));
    };
    const next = () => {
      if (!typing.finished) { typing.finish(); return; }
      if (idx < list.length - 1) { idx++; show(); return; }
      wrap.classList.add('out');
      setTimeout(() => { wrap.remove(); resolve(); }, 140);
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => { if (['Enter', ' ', 'Escape'].includes(e.key)) { e.preventDefault(); next(); } };
    wrap.addEventListener('click', next);
    document.addEventListener('keydown', onKey);
    show();
  });
}

/** Ja/Nein-Frage wie im Spiel; liefert true/false */
function dsAsk(text, { yes = 'Ja', no = 'Nein', danger = false, speaker = '' } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'say-backdrop ask';
    wrap.innerHTML = `<div class="ds-choice" role="menu" hidden>
        <button type="button" class="ds-choice-btn${danger ? ' danger' : ''}" data-v="1" role="menuitem">${esc(yes)}</button>
        <button type="button" class="ds-choice-btn" data-v="0" role="menuitem">${esc(no)}</button>
      </div>${dsBoxHtml(speaker)}`;
    sayRoot().appendChild(wrap);
    const choice = wrap.querySelector('.ds-choice');
    const typing = typeText(wrap.querySelector('.ds-say-text'), text);
    const open = () => {
      choice.hidden = false;
      wrap.querySelector('.ds-say').classList.add('asking');
      choice.querySelector('[data-v="1"]').focus({ preventScroll: true });
    };
    typing.done.then(open);
    const end = (v) => {
      document.removeEventListener('keydown', onKey);
      wrap.classList.add('out');
      setTimeout(() => { wrap.remove(); resolve(v); }, 120);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') end(false);
      if (e.key === 'Enter' && !typing.finished) { e.preventDefault(); typing.finish(); }
    };
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]');
      if (b) { end(b.dataset.v === '1'); return; }
      if (!typing.finished) { typing.finish(); return; }
      if (!e.target.closest('.ds-choice, .ds-say')) end(false); // daneben tippen = Nein
    });
  });
}

/** Pokéball-Ladeanzeige */
function loaderHtml(text = 'Lädt …') {
  return `<div class="ball-loader"><span class="ball-loader-ball">${ballSvg('poke', 46)}</span><span class="ds-mini">${esc(text)}</span></div>`;
}

/** Leerer Bereich: eigener Trainer + Spiel-Textbox */
function emptyStateHtml(text, { icon = '' } = {}) {
  const me = state.me;
  const sprite = me && SPRITES[me.gender] ? `<img class="empty-trainer" src="${SPRITES[me.gender]}" alt="">` : (icon ? `<div class="big">${icon}</div>` : '');
  return `<div class="empty-ds">${sprite}<div class="ds-say static"><p class="ds-say-text">${esc(text)}</p></div></div>`;
}

/** Kurze „Gefangen!“-Animation als Bestätigung (Ball wackelt dreimal, dann klickt er zu) */
function catchAnimation(text = 'Gespeichert!') {
  if (reduceMotion) { toast(`✨ ${text}`); return; }
  const el = document.createElement('div');
  el.className = 'catch-fx';
  el.innerHTML = `<div class="catch-ball">${ballSvg('poke', 64)}</div><div class="catch-stars" aria-hidden="true"><i></i><i></i><i></i></div><div class="catch-text">${esc(text)}</div>`;
  sayRoot().appendChild(el);
  setTimeout(() => el.remove(), 1700);
}

function toast(text, onClick) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = '<span class="toast-text"></span><span class="ds-say-arrow" aria-hidden="true">▼</span>';
  typeText(el.firstChild, text, 12);
  el.addEventListener('click', () => {
    el.remove();
    onClick && onClick();
  });
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

/* -------------------------------------------------------------------------
 * Profil (Einrichten & Bearbeiten)
 * ---------------------------------------------------------------------- */
/* -------------------------------------------------------------------------
 * Profil (Einrichten & Bearbeiten)
 * ---------------------------------------------------------------------- */

function profileFormHtml(u, { familyExists = false, code = '' } = {}) {
  const color = u.color || COLOR_PRESETS[0];
  const isNew = !u.id;
  return `
  <form class="form" id="profile-form" novalidate>
    <div class="preview-wrap" id="card-preview">${trainerCardHtml({ ...u, color })}</div>
    ${isNew ? `
    <label class="field"><span>${familyExists ? 'Familien-Code' : 'Familien-Code festlegen'}</span>
      <input name="code" required minlength="4" maxlength="40" autocapitalize="characters" autocomplete="off" value="${esc(code)}"
        placeholder="${familyExists ? 'Bekommst du von deiner Familie' : 'z. B. MUELLER2026'}">
      <p class="hint">${familyExists
        ? 'Den Code findet jedes Familienmitglied im Reiter „Team“.'
        : 'Du bist die erste Person. Alle weiteren brauchen diesen Code, um beizutreten.'}</p>
    </label>` : ''}
    <div class="row2">
      <label class="field"><span>Vorname</span>
        <input name="firstName" autocomplete="given-name" required maxlength="40" value="${esc(u.firstName || '')}"></label>
      <label class="field"><span>Nachname</span>
        <input name="lastName" autocomplete="family-name" required maxlength="40" value="${esc(u.lastName || '')}"></label>
    </div>
    <label class="field"><span>Geburtsdatum</span>
      <input name="birthday" type="date" required value="${esc(u.birthday || '')}" max="${toLocalInput(new Date()).slice(0, 10)}"></label>
    <fieldset class="field">
      <legend>Geschlecht</legend>
      <div class="segmented two">
        <label style="--u:var(--accent)"><input type="radio" name="gender" value="m"${u.gender === 'm' ? ' checked' : ''}><span>Männlich</span></label>
        <label style="--u:var(--accent)"><input type="radio" name="gender" value="w"${u.gender === 'w' ? ' checked' : ''}><span>Weiblich</span></label>
      </div>
    </fieldset>
    <fieldset class="field">
      <legend>Lieblingsfarbe</legend>
      <div class="swatches">
        ${COLOR_PRESETS.map((c) => `<button type="button" class="swatch${c === color ? ' active' : ''}" data-color="${c}" style="background:${c}" aria-label="Farbe ${c}"></button>`).join('')}
        <label class="swatch-custom" title="Eigene Farbe"><input type="color" name="customColor" value="${esc(color)}" aria-label="Eigene Farbe"></label>
      </div>
      <input type="hidden" name="color" value="${esc(color)}">
    </fieldset>
    ${isNew ? '' : memoFieldsHtml(u)}
    <p class="error" id="profile-error"></p>
    <div class="modal-actions">
      ${isNew ? '' : '<button type="button" class="btn" data-close>Abbrechen</button>'}
      <button type="submit" class="btn primary">${isNew ? 'Konto einrichten' : 'Speichern'}</button>
    </div>
  </form>`;
}

function memoFieldsHtml(u) {
  const opts = (list, cur, label = (x) => x) =>
    `<option value="">– keine Angabe –</option>` +
    list.map((x) => `<option value="${esc(x)}"${x === cur ? ' selected' : ''}>${esc(label(x))}</option>`).join('');
  return `
    <fieldset class="field memo-fields">
      <legend>Trainer-Memo</legend>
      <label class="field"><span>Wesen</span><select name="nature">${opts(NATURES, u.nature)}</select></label>
      <label class="field"><span>Geburtsort</span><input name="region" maxlength="40" placeholder="z. B. Hamburg" value="${esc(u.region || '')}">
        <p class="hint">Frei eintragbar – steht im Memo an der Stelle der Region (wie „Kanto“ im Spiel).</p></label>
      <label class="field"><span>Liebt …</span><input name="loves" maxlength="60" placeholder="z. B. Kämpfe" value="${esc(u.loves || '')}"></label>
      <label class="field"><span>Mag … Essen</span><select name="flavor">${opts(Object.keys(FLAVORS), u.flavor, (k) => FLAVORS[k][0].toUpperCase() + FLAVORS[k].slice(1) + ' Essen')}</select></label>
      <label class="field"><span>Status</span><input name="statusText" maxlength="${STATUS_MAX}" placeholder="z. B. Im Urlaub 🌴" value="${esc(u.statusText || '')}"></label>
    </fieldset>`;
}

function validateProfile(d, isNew) {
  if (isNew && (d.code || '').trim().length < 4) return 'Der Familien-Code muss mindestens 4 Zeichen haben.';
  if (!d.firstName || !d.lastName) return 'Bitte Vor- und Nachnamen angeben.';
  if (!d.birthday) return 'Bitte das Geburtsdatum angeben.';
  if (parseBirthday(d.birthday) > new Date()) return 'Das Geburtsdatum liegt in der Zukunft.';
  if (!d.gender) return 'Bitte ein Geschlecht wählen.';
  return null;
}

function mountProfileForm(modal, close, base) {
  const form = $('#profile-form', modal);
  const preview = $('#card-preview', modal);
  const isNew = !base.id;
  const read = () => {
    const f = new FormData(form);
    return {
      ...base,
      code: (f.get('code') || '').trim().toUpperCase(),
      firstName: f.get('firstName').trim(),
      lastName: f.get('lastName').trim(),
      birthday: f.get('birthday'),
      gender: f.get('gender'),
      color: f.get('color'),
      nature: f.get('nature') || '',
      region: (f.get('region') || '').trim(),
      loves: (f.get('loves') || '').trim(),
      flavor: f.get('flavor') || '',
      statusText: (f.get('statusText') || '').trim(),
    };
  };
  const refresh = () => (preview.innerHTML = trainerCardHtml(read()));
  const setColor = (c) => {
    form.elements.color.value = c;
    form.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('active', s.dataset.color === c));
    refresh();
  };
  form.addEventListener('input', (e) => {
    if (e.target.name === 'customColor') setColor(e.target.value);
    else if (e.target.name !== 'code') refresh();
  });
  form.addEventListener('click', (e) => {
    const sw = e.target.closest('.swatch');
    if (sw) setColor(sw.dataset.color);
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = read();
    const err = $('#profile-error', modal);
    const btn = form.querySelector('[type=submit]');
    err.textContent = validateProfile(d, isNew) || '';
    if (err.textContent) return;
    btn.disabled = true;
    try {
      if (isNew) {
        if (!state.session) {
          const { session } = must(await sb.auth.signInAnonymously());
          state.session = session;
        }
        const row = must(await sb.rpc('join_family', {
          p_code: d.code,
          p_first_name: d.firstName,
          p_last_name: d.lastName,
          p_gender: d.gender,
          p_color: d.color,
          p_birthday: d.birthday,
        }));
        state.me = mapProfile(row);
        close();
        await startApp();
      } else {
        const row = must(await sb.from('profiles')
          .update({
            first_name: d.firstName, last_name: d.lastName, gender: d.gender, color: d.color, birthday: d.birthday,
            nature: d.nature || null, region: d.region || null, loves: d.loves || null,
            flavor: d.flavor || null, status_text: d.statusText || null,
          })
          .eq('id', base.id).select().single());
        state.me = mapProfile(row);
        close();
        await loadUsers();
        renderProfileButton();
        render();
      }
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
    }
  });
}

async function openSetup() {
  let familyExists = false;
  try {
    familyExists = Boolean(must(await sb.rpc('family_exists')));
  } catch (e) {
    toast(e.message);
  }
  const code = new URLSearchParams(location.search).get('code') || '';
  openModal(
    `<div class="modal-head"><h2>Willkommen! 👋</h2></div>
     <p class="setup-intro">Richte dein Konto ein. Daraus entsteht dein persönlicher Trainerpass – die Lieblingsfarbe wird zur Farbe deines Passes.</p>
     ${profileFormHtml({}, { familyExists, code })}`,
    { dismissible: false, onMount: (m, c) => mountProfileForm(m, c, {}) }
  );
}

function openInstallGuide() {
  openModal(
    `<div class="modal-head"><h2>Familie aufs iPhone holen</h2></div>
     <ol class="steps">
       <li>Unten in Safari auf <b>Teilen</b> <span aria-hidden="true">⬆︎</span> tippen.</li>
       <li><b>„Zum Home-Bildschirm“</b> wählen und <b>Hinzufügen</b> tippen.</li>
       <li>Die App über das neue Symbol auf dem Home-Bildschirm öffnen und dort das Konto einrichten.</li>
     </ol>
     <p class="hint">Nur die installierte App kann Benachrichtigungen empfangen (ab iOS 16.4). Ein Konto, das hier im Browser eingerichtet wird, ist in der installierten App nicht vorhanden.</p>
     <div class="modal-actions"><button class="btn" id="continue-browser">Trotzdem im Browser nutzen</button></div>`,
    {
      dismissible: false,
      onMount: (modal, close) => {
        $('#continue-browser', modal).addEventListener('click', () => { close(); openSetup(); });
      },
    }
  );
}

function openEditProfile() {
  openModal(
    `<div class="modal-head"><h2>Profil bearbeiten</h2><button class="icon-btn" data-close aria-label="Schließen">✕</button></div>
     ${profileFormHtml(state.me)}`,
    { onMount: (m, c) => mountProfileForm(m, c, state.me) }
  );
}

function trainerMemoHtml(u) {
  const red = (t) => `<span class="memo-red">${esc(t)}</span>`;
  return `
  <article class="memo memo-trainer" aria-label="Trainer-Memo von ${esc(fullName(u))}">
    <div class="memo-head">TRAINER-MEMO</div>
    <div class="memo-body">
      <div class="memo-right">
        <p>Wesen: ${u.nature ? red(u.nature) : '???'}</p>
        <p>${u.region ? red(u.region) : '???'}</p>
        <p>${u.loves ? `Liebt ${esc(u.loves)}.` : 'Liebt …'}</p>
        <p>${u.flavor ? `Mag ${red(FLAVORS[u.flavor])} Essen.` : 'Mag … Essen.'}</p>
        <p>&nbsp;</p>
        <p>Status:</p>
        <p class="memo-status-text">${esc(u.statusText || '–')}</p>
      </div>
    </div>
  </article>`;
}

function openTrainerCard(user) {
  const isMe = state.me && user.id === state.me.id;
  const title = user.kind === 'pokemon' ? 'Pokémon' : isMe ? 'Mein Trainerpass' : 'Trainerpass';
  openModal(
    `<div class="modal-head"><h2>${title}</h2><button class="icon-btn" data-close aria-label="Schließen">✕</button></div>
     <div class="card-stack">
       ${trainerCardHtml(user)}
       ${trainerMemoHtml(user)}
     </div>
     ${isMe ? '<div class="modal-actions"><button class="btn" id="edit-profile">Profil bearbeiten</button></div>' : ''}`,
    {
      full: true,
      onMount: (modal, close) => {
        const btn = $('#edit-profile', modal);
        if (btn) btn.addEventListener('click', () => { close(); openEditProfile(); });
      },
    }
  );
}

function renderProfileButton() {
  const label = $('#menu-me');
  if (label) label.textContent = state.me ? state.me.firstName : 'Profil';
}

/* -------------------------------------------------------------------------
 * Benachrichtigungen
 * ---------------------------------------------------------------------- */

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function enablePush() {
  if (!pushSupported) {
    toast(isIos
      ? 'Auf dem iPhone gehen Benachrichtigungen nur, wenn die App über „Zum Home-Bildschirm“ installiert wurde (ab iOS 16.4).'
      : 'Dieses Gerät/dieser Browser unterstützt keine Push-Benachrichtigungen.');
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    toast('Benachrichtigungen wurden nicht erlaubt.');
    render();
    return;
  }
  const ok = await syncPushSubscription();
  toast(ok ? 'Benachrichtigungen sind aktiv 🔔' : 'Benachrichtigungen konnten nicht eingerichtet werden.');
  render();
}

async function syncPushSubscription() {
  if (!pushSupported || Notification.permission !== 'granted' || !state.me) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { publicKey } = must(await sb.functions.invoke('push', { body: { action: 'key' } }));
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
    }
    must(await sb.rpc('save_push_subscription', { p_subscription: sub.toJSON() }));
    return true;
  } catch (e) {
    console.warn('Push-Anmeldung fehlgeschlagen', e);
    return false;
  }
}

/* -------------------------------------------------------------------------
 * Austausch
 * ---------------------------------------------------------------------- */

function urgencyLabel(key) {
  return urgencyInfo(key).label;
}

function icsUrl(m) {
  const token = state.session ? state.session.access_token : '';
  return `${CFG.supabaseUrl}/functions/v1/ics?id=${encodeURIComponent(m.id)}&t=${encodeURIComponent(token)}`;
}

const HELP = {
  strike: 'Wird die Meldung bis zur Deadline nicht erfüllt, gibt es einen Strich auf dem Board der Schande. Reagiert jemand vorher, friert der Timer ein und du nimmst das Ergebnis ab. Eine Meldung mit Androhung ist automatisch dringend.',
  autoDelete: 'Die Meldung verschwindet zum eingestellten Zeitpunkt automatisch für alle – praktisch für Dinge, die sich danach erledigt haben.',
  event: 'Für Termine mit Dauer: Zusätzlich zum Start gibst du das Ende des Zeitraums an (von Minuten bis Jahren). Der Zeitraum wird auch so in den Kalender übernommen.',
  deadline: 'Bis wann etwas erledigt sein muss. Die Meldung wird damit zu einem Ereignis vom Zeitpunkt bis zur Deadline – genau so landet sie auch im Kalender.',
  respondBy: 'Bis wann geantwortet werden soll. Wer bis eine Stunde vor Ablauf noch nicht geantwortet hat, bekommt eine Erinnerung.',
  notify: 'Wenn die Glocke an ist, bekommen alle anderen beim Absenden sofort eine Benachrichtigung. '
    + 'Ist sie aus, wird beim Absenden niemand benachrichtigt – spätere Benachrichtigungen (Erinnerung zum Beginn, Rückmeldungen) kommen trotzdem.',
  remind: 'Wenn die Glocke an ist, bekommen alle zum Beginn des Ereignisses eine Benachrichtigung – das Handy vibriert bzw. klingelt (je nach Einstellungen des Handys). '
    + 'Das funktioniert auch, wenn die App geschlossen ist.',
  ack: 'Die anderen sehen in der aufgeklappten Meldung Antwort-Knöpfe – standardmäßig „Erledigt“, oder was du vorgibst (z. B. „Ja“ und „Nein“). '
    + 'Antwortet jemand, bekommst du eine Benachrichtigung. Die Meldung bleibt stehen – löschen kannst sie nur du.',
  doneDelete: 'Die anderen können die Meldung in der aufgeklappten Ansicht als erledigt markieren. '
    + 'Sie wird dann für alle gelöscht und du bekommst eine Benachrichtigung, dass sie geschlossen wurde.',
};

function helpBtn(key) {
  return `<button type="button" class="help-btn" data-help="${key}" aria-label="Erklärung">?</button>`;
}

function bellToggle(name, checked, label) {
  return `<label class="bell-toggle" title="${esc(label)}">
    <input type="checkbox" name="${name}"${checked ? ' checked' : ''} aria-label="${esc(label)}">
    <span class="bell-on" aria-hidden="true">🔔</span><span class="bell-off" aria-hidden="true">🔕</span>
  </label>`;
}

function switchToggle(name, checked = false) {
  return `<label class="switch"><input type="checkbox" role="switch" name="${name}"${checked ? ' checked' : ''}><span aria-hidden="true"></span></label>`;
}

function ackOptionRow(value) {
  return `<div class="ack-opt">
    <input name="ackOpt" maxlength="40" value="${esc(value)}" placeholder="Antwort, z. B. Ja" aria-label="Antwortmöglichkeit">
    <button type="button" class="ack-del" aria-label="Antwortmöglichkeit entfernen">✕</button>
  </div>`;
}

function showHelp(key) {
  dsSay(HELP[key] || '', { speaker: 'Tipp' });
}
// Alle ?-Knöpfe öffnen die Erklärung als Spiel-Textbox
document.addEventListener('click', (e) => {
  const help = e.target.closest('[data-help]');
  if (!help) return;
  e.preventDefault();
  e.stopPropagation();
  showHelp(help.dataset.help);
}, true);

function formatTimeOnly(iso) {
  return new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

function formatRange(start, end) {
  if (!start) return '';
  if (!end) return formatDateTime(start);
  const a = new Date(start); const b = new Date(end);
  const sameDay = a.toDateString() === b.toDateString();
  return sameDay ? `${formatDateTime(start)} – ${formatTimeOnly(end)}` : `${formatDateTime(start)} – ${formatDateTime(end)}`;
}

function messageHtml(m) {
  const mine = state.me && m.authorId === state.me.id;
  const author = userById(m.authorId);
  const doneBy = m.doneBy ? userById(m.doneBy) : null;
  const expanded = isExpanded(m);
  if (expanded) markCommentsSeen(m.id);
  const unread = expanded ? 0 : unreadComments(m);
  const pin = prefs.pins[m.id] && Date.parse(prefs.pins[m.id]) > Date.now() ? prefs.pins[m.id] : null;
  const canMarkDone = !mine && !m.doneBy && !m.closedAt && !m.needsAck && (m.deleteOnDone || m.deadlineAt);
  const awaitingReview = m.threatStrike && !m.closedAt && isFrozen(m);
  const statusLine = m.closedAt
    ? (m.reviewStatus === 'accepted' ? '👍 Abgenommen – geschlossen'
      : m.reviewStatus === 'rejected' ? `😈 Strich vergeben: ${m.strikeNote || ''}`
      : m.reviewStatus === 'missed' ? '😈 Deadline verpasst – Strich vergeben'
      : '🔒 Geschlossen – Deadline abgelaufen')
    : awaitingReview ? `⏸️ Timer eingefroren – ${mine ? 'bitte abnehmen' : 'wartet auf Abnahme'}` : '';
  const options = m.needsAck ? (m.ackOptions || ['Erledigt']) : [];
  const resps = state.responses.get(m.id) || [];
  const myResp = state.me ? resps.find((r) => r.userId === state.me.id) : null;
  const comments = state.comments.get(m.id) || [];
  const portrait = author && PORTRAITS[author.gender]
    ? `<img class="msg-portrait" src="${PORTRAITS[author.gender]}" alt="${esc(fullName(author))}">` : '';
  return `
  <article class="msg u-${esc(m.urgency)}${m.closedAt ? ' is-closed' : ''}${expanded ? ' expanded' : ''}${unread ? ' has-unread' : ''}${m.doneBy && !awaitingReview ? ' is-done' : ''}${state.highlight === m.id ? ' flash' : ''}"
    id="msg-${esc(m.id)}" data-msg="${esc(m.id)}" tabindex="0" aria-expanded="${expanded}">
    <div class="msg-side">
      <div class="msg-urg">${ballSvg(urgencyInfo(m.urgency).ball, 26)}<span class="badge">${esc(urgencyLabel(m.urgency))}</span></div>
      ${portrait}
    </div>
    <div class="msg-body">
      <h3>${esc(m.title)}</h3>
      ${m.description ? `<p class="desc">${esc(m.description)}</p>` : ''}
      <div class="msg-meta">
        <span class="author"><span class="dot" style="--c:${esc(author ? author.color : '#888888')}"></span>${esc(author ? fullName(author) : 'Unbekannt')} · <span data-rel="${esc(m.createdAt)}">${esc(relative(m.createdAt))}</span></span>
        ${m.eventAt ? `<span>🕒 ${esc(formatRange(m.eventAt, m.endAt || m.deadlineAt))}${m.remindAtStart ? ' <span title="Erinnerung zum Beginn">🔔</span>' : ''}</span>` : ''}
        ${statusLine ? `<span class="status-line${m.reviewStatus === 'rejected' || m.reviewStatus === 'missed' ? ' bad' : ''}">${esc(statusLine)}</span>` : ''}
        ${m.threatStrike && !m.closedAt ? '<span class="strike-threat">😈 Strich auf dem Board der Schande bei Nichterfüllung</span>' : ''}
        ${m.deadlineAt ? `<span class="deadline${Date.parse(m.deadlineAt) < Date.now() ? ' over' : ''}">⏳ Deadline: ${esc(formatDateTime(m.deadlineAt))}</span>` : ''}
        ${m.needsAck && m.respondBy ? `<span class="more">✉️ Antworten bis ${esc(formatDateTime(m.respondBy))}</span>` : ''}
        ${m.doneBy ? `<span class="done-line">✓ Erledigt von ${esc(doneBy ? doneBy.firstName : 'jemandem')}</span>` : ''}
        ${m.needsAck ? `<span class="count">✉️ ${resps.length ? `${resps.length} Antwort${resps.length === 1 ? '' : 'en'}` : 'Rückmeldung erbeten'}</span>` : ''}
        ${comments.length ? `<span class="count${unread ? ' unread' : ''}">💬 ${comments.length} Kommentar${comments.length === 1 ? '' : 'e'}${unread ? ` <b>(${unread} neu)</b>` : ''}</span>` : ''}
        ${pin ? `<span class="pin-line">📌 In „Laufend“ bis ${esc(formatDateTime(pin))}</span>` : ''}
        ${!m.doneBy && m.deleteOnDone ? '<span class="flag">🧹 Wird gelöscht, wenn erledigt</span>' : ''}
        ${m.deleteAt ? `<span class="more">🗑️ Löscht sich <span data-rel="${esc(m.deleteAt)}">${esc(relative(m.deleteAt))}</span> (${esc(formatDateTime(m.deleteAt))})</span>` : ''}
      </div>
      <div class="msg-actions">
        ${canMarkDone ? `<button class="btn small primary" data-done="${esc(m.id)}">✓ Erledigt</button>` : ''}
        <a class="btn small" href="${esc(icsUrl(m))}" target="_blank" rel="noopener" title="In Kalender übernehmen">📅 In Kalender</a>
        ${mine ? `<button class="btn small danger" data-delete="${esc(m.id)}">Löschen</button>` : ''}
      </div>
      ${m.needsAck ? `<div class="msg-replies msg-extra">
        ${!mine && !m.closedAt ? `<div class="reply-btns">${options.map((o) => `<button class="btn small${myResp && myResp.option === o ? ' primary' : ''}" data-reply="${esc(m.id)}" data-option="${esc(o)}">${esc(o)}</button>`).join('')}</div>` : ''}
        ${resps.length
          ? `<ul class="reply-list">${resps.map((r) => { const u = userById(r.userId); return `<li><b>${esc(u ? u.firstName : '?')}:</b> ${esc(r.option)}</li>`; }).join('')}</ul>`
          : `<p class="hint">${mine ? 'Noch keine Antwort.' : 'Tippe auf eine Antwort.'}</p>`}
      </div>` : ''}
      ${mine && awaitingReview ? `<div class="msg-review msg-extra">
        <span class="hint">Rückmeldung ist da – nimm das Ergebnis ab:</span>
        <div class="reply-btns">
          <button type="button" class="btn small primary" data-review="${esc(m.id)}" data-verdict="accept">👍 Abnehmen</button>
          <button type="button" class="btn small danger" data-review="${esc(m.id)}" data-verdict="strike">😈 Strich vergeben</button>
        </div>
      </div>` : ''}
      ${m.urgency === 'info' ? `<div class="msg-pin msg-extra">
        <span class="hint">📌 In „Laufend“ behalten (nur für dich):</span>
        <div class="chips">
          ${[['1 Tag', 1], ['3 Tage', 3], ['1 Woche', 7], ['1 Monat', 30]].map(([l, d]) => `<button type="button" class="chip" data-pin="${esc(m.id)}" data-days="${d}">${l}</button>`).join('')}
          ${pin ? `<button type="button" class="chip" data-pin="${esc(m.id)}" data-days="0">Nicht mehr</button>` : ''}
        </div>
      </div>` : ''}
      <div class="msg-comments msg-extra">
        ${comments.map((c) => {
          const u = userById(c.authorId); const own = state.me && c.authorId === state.me.id;
          return `<div class="comment${own ? ' own' : ''}">
            <span class="c-head"><b>${esc(u ? u.firstName : '?')}</b> · <span data-rel="${esc(c.createdAt)}">${esc(relative(c.createdAt))}</span>${own ? ` <button class="c-del" data-del-comment="${esc(c.id)}" aria-label="Kommentar löschen">✕</button>` : ''}</span>
            <p>${esc(c.body)}</p>
          </div>`;
        }).join('')}
        <form class="comment-form" data-comment-form="${esc(m.id)}">
          <input name="body" maxlength="1000" placeholder="Kommentar schreiben …" autocomplete="off" aria-label="Kommentar">
          <button class="btn small primary" type="submit">Senden</button>
        </form>
      </div>
      <span class="msg-chevron" aria-hidden="true">▾</span>
    </div>
  </article>`;
}

function bindMessage(el) {
  el.addEventListener('click', (e) => {
    if (e.target.closest('a, button, input, textarea, form')) return;
    toggleMessage(el);
  });
  el.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === el) { e.preventDefault(); toggleMessage(el); }
  });
  el.querySelectorAll('[data-done]').forEach((b) => b.addEventListener('click', () => markDone(b.dataset.done, b)));
  el.querySelectorAll('[data-review]').forEach((b) => b.addEventListener('click', () => reviewMessage(b.dataset.review, b.dataset.verdict, b)));
  el.querySelectorAll('[data-pin]').forEach((b) => b.addEventListener('click', () => {
    const days = Number(b.dataset.days);
    setPin(b.dataset.pin, days ? new Date(Date.now() + days * 86400e3).toISOString() : null);
    toast(days ? `📌 Bleibt ${b.textContent} in „Laufend“` : 'Nicht mehr in „Laufend“');
  }));
  el.querySelectorAll('[data-reply]').forEach((b) => b.addEventListener('click', () => sendReply(b.dataset.reply, b.dataset.option, b)));
  el.querySelectorAll('[data-del-comment]').forEach((b) => b.addEventListener('click', () => deleteComment(b.dataset.delComment, el.dataset.msg)));
  el.querySelectorAll('[data-comment-form]').forEach((f) => f.addEventListener('submit', (e) => { e.preventDefault(); sendComment(f); }));
  el.querySelectorAll('[data-delete]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!(await dsAsk('Diese Nachricht wirklich löschen?', { yes: 'Löschen', danger: true }))) return;
      try {
        must(await sb.from('messages').delete().eq('id', b.dataset.delete));
        removeMessage(b.dataset.delete);
      } catch (e) {
        toast(e.message);
      }
    })
  );
}

/** Nur eine Karte neu zeichnen – ein angefangener Kommentar bleibt erhalten. */
function rerenderMessage(id) {
  if (state.tab !== 'start') return;
  const el = document.getElementById(`msg-${id}`);
  const m = state.messages.find((x) => x.id === id);
  if (!el || !m) { render(); return; }
  if (el.closest('[data-section]') && el.closest('[data-section]').dataset.section !== sectionOf(m)) { render(); return; }
  const input = el.querySelector('.comment-form input');
  const draft = input ? input.value : '';
  const focused = input && document.activeElement === input;
  const tpl = document.createElement('template');
  tpl.innerHTML = messageHtml(m).trim();
  const fresh = tpl.content.firstElementChild;
  fresh.classList.remove('flash');
  el.replaceWith(fresh);
  bindMessage(fresh);
  const ni = fresh.querySelector('.comment-form input');
  if (ni) { ni.value = draft; if (focused) ni.focus({ preventScroll: true }); }
}

async function invokeOrThrow(body) {
  const r = await sb.functions.invoke('push', { body });
  if (r.error) {
    let msg = 'Das hat nicht geklappt.';
    try { msg = (await r.error.context.json()).error || msg; } catch { /* egal */ }
    throw new Error(msg);
  }
  return r.data;
}

async function sendReply(id, option, btn) {
  btn.disabled = true;
  try {
    await invokeOrThrow({ action: 'respond', messageId: id, option });
    const list = (state.responses.get(id) || []).filter((r) => r.userId !== state.me.id);
    list.push({ userId: state.me.id, option, createdAt: new Date().toISOString() });
    state.responses.set(id, list);
    rerenderMessage(id);
    toast(`Antwort gesendet: ${option}`);
  } catch (e) {
    toast(e.message);
    btn.disabled = false;
  }
}

async function sendComment(form) {
  const id = form.dataset.commentForm;
  const input = form.elements.body;
  const body = input.value.trim();
  if (!body) return;
  const btn = form.querySelector('button');
  btn.disabled = true;
  try {
    const row = must(await sb.from('message_comments').insert({ message_id: id, body }).select().single());
    addComment(mapComment(row));
    input.value = '';
    rerenderMessage(id);
    sb.functions.invoke('push', { body: { action: 'comment', commentId: row.id } })
      .then((r) => r.error && console.warn('Benachrichtigung fehlgeschlagen', r.error));
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
  }
}

async function deleteComment(commentId, messageId) {
  if (!(await dsAsk('Kommentar löschen?', { yes: 'Löschen', danger: true }))) return;
  try {
    must(await sb.from('message_comments').delete().eq('id', commentId));
    removeComment(commentId, messageId);
  } catch (e) {
    toast(e.message);
  }
}

function mapComment(r) {
  return { id: r.id, messageId: r.message_id, authorId: r.author_id, body: r.body, createdAt: r.created_at };
}

function addComment(c) {
  const list = state.comments.get(c.messageId) || [];
  if (!list.some((x) => x.id === c.id)) list.push(c);
  list.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  state.comments.set(c.messageId, list);
}

function removeComment(id, messageId) {
  for (const [mid, list] of state.comments) {
    if (messageId && mid !== messageId) continue;
    const next = list.filter((c) => c.id !== id);
    if (next.length !== list.length) { state.comments.set(mid, next); rerenderMessage(mid); }
  }
}

function setResponse(r) {
  const list = (state.responses.get(r.message_id) || []).filter((x) => x.userId !== r.user_id);
  list.push({ userId: r.user_id, option: r.option, createdAt: r.created_at });
  state.responses.set(r.message_id, list);
}

/* ---- Pro Gerät gemerkt: gelesene Kommentare, zugeklappte Infos, „Laufend“-Pins, offene Bereiche ---- */
function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* privat */ }
}
const prefs = {
  seen: lsGet('familie.seenComments', {}),          // messageId -> Zeitpunkt des zuletzt gesehenen Kommentars
  infoClosed: new Set(lsGet('familie.infoClosed', [])), // Infos, die man zugeklappt hat
  pins: lsGet('familie.pins', {}),                   // messageId -> „in Laufend behalten bis“
  sections: lsGet('familie.sections', {}),           // Bereich -> offen?
};

function isExpanded(m) {
  return m.urgency === 'info' ? !prefs.infoClosed.has(m.id) : state.expanded.has(m.id);
}

function unreadComments(m) {
  const seen = prefs.seen[m.id] ? Date.parse(prefs.seen[m.id]) : 0;
  return (state.comments.get(m.id) || []).filter((c) => (!state.me || c.authorId !== state.me.id) && Date.parse(c.createdAt) > seen).length;
}

function markCommentsSeen(id) {
  const list = state.comments.get(id) || [];
  const last = list.length ? list[list.length - 1].createdAt : new Date().toISOString();
  if (prefs.seen[id] !== last) { prefs.seen[id] = last; lsSet('familie.seenComments', prefs.seen); }
}

function toggleMessage(el) {
  const id = el.dataset.msg;
  const m = state.messages.find((x) => x.id === id);
  if (!m) return;
  const open = !isExpanded(m);
  if (m.urgency === 'info') {
    if (open) prefs.infoClosed.delete(id); else prefs.infoClosed.add(id);
    lsSet('familie.infoClosed', [...prefs.infoClosed]);
  }
  if (open) state.expanded.add(id); else state.expanded.delete(id);
  if (open) markCommentsSeen(id);
  // Karte neu aufbauen → beim Zuklappen exakt wieder in der Ausgangsform
  rerenderMessage(id);
  if (!open) {
    const fresh = document.getElementById(`msg-${id}`);
    if (fresh && fresh.getBoundingClientRect().top < 70) fresh.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function setPin(id, until) {
  if (until) prefs.pins[id] = until; else delete prefs.pins[id];
  lsSet('familie.pins', prefs.pins);
  render();
}

async function reviewMessage(id, verdict, btn) {
  const send = async (reason) => {
    btn.disabled = true;
    try {
      await invokeOrThrow({ action: 'review', messageId: id, verdict, reason });
      const m = state.messages.find((x) => x.id === id);
      if (m) {
        m.closedAt = new Date().toISOString();
        m.reviewStatus = verdict === 'accept' ? 'accepted' : 'rejected';
        m.strikeNote = verdict === 'accept' ? null : reason;
        render();
      }
      toast(verdict === 'accept' ? '👍 Abgenommen – die Meldung ist geschlossen.' : '⚖️ Strich vergeben – wartet auf Anerkennung.');
    } catch (e) {
      toast(e.message);
      btn.disabled = false;
    }
  };
  if (verdict === 'accept') { send(); return; }
  openModal(
    `${judgeHeadHtml('Strich vergeben', 'Urteil nach Abnahme')}
     <form class="form" id="strike-form">
       <label class="field"><span>Grund (wird protokolliert)</span>
         <textarea name="reason" maxlength="200" required placeholder="z. B. Zimmer nur halb aufgeräumt"></textarea></label>
       <p class="error" id="strike-error"></p>
       <div class="modal-actions">
         <button type="button" class="btn" data-close>Abbrechen</button>
         <button type="submit" class="btn judge-btn">⚖️ Strich vergeben</button>
       </div>
     </form>`,
    {
      cls: 'judge',
      onMount: (modal, close) => {
        const form = $('#strike-form', modal);
        form.elements.reason.focus();
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          const reason = form.elements.reason.value.trim();
          if (!reason) { $('#strike-error', modal).textContent = 'Bitte einen Grund angeben.'; return; }
          close();
          send(reason);
        });
      },
    }
  );
}

async function markDone(id, btn) {
  btn.disabled = true;
  try {
    const r = await sb.functions.invoke('push', { body: { action: 'done', messageId: id } });
    if (r.error) {
      let msg = 'Das hat nicht geklappt.';
      try { msg = (await r.error.context.json()).error || msg; } catch { /* egal */ }
      throw new Error(msg);
    }
    if (r.data && r.data.review) {
      const m = state.messages.find((x) => x.id === id);
      if (m) { m.doneBy = state.me.id; m.doneAt = new Date().toISOString(); rerenderMessage(id); }
      toast('⏸️ Gemeldet – der Timer ist eingefroren, der Urheber nimmt ab.');
      return;
    }
    if (r.data && r.data.deleted) { removeMessage(id); toast('Erledigt – die Meldung wurde geschlossen ✓'); }
    else {
      const m = state.messages.find((x) => x.id === id);
      if (m) { m.doneBy = state.me.id; m.doneAt = new Date().toISOString(); render(); }
      toast('Als erledigt markiert ✓');
    }
  } catch (e) {
    toast(e.message);
    btn.disabled = false;
  }
}

/* ---- Bereiche der Startseite ---- */
const SECTIONS = [
  { key: 'heute', label: 'Heute', open: true },
  { key: 'morgen', label: 'Morgen', open: true },
  { key: 'woche', label: 'Diese Woche', open: true },
  { key: 'laufend', label: 'Laufend', open: true },
  { key: 'spaeter', label: 'Später', open: false },
  { key: 'vergangen', label: 'Vergangen', open: false },
];
const URGENCY_RANK = { dringend: 0, wichtig: 1, normal: 2, info: 3 };

/** Strich angedroht und jemand hat reagiert → Timer eingefroren, der Urheber nimmt ab */
function isFrozen(m) {
  return Boolean(m.doneBy) || (state.responses.get(m.id) || []).length > 0;
}

function sectionOpen(sec) {
  return sec.key in prefs.sections ? Boolean(prefs.sections[sec.key]) : sec.open;
}

function compareMessages(a, b) {
  const u = (URGENCY_RANK[a.urgency] ?? 2) - (URGENCY_RANK[b.urgency] ?? 2);
  if (u) return u;
  return Date.parse(a.eventAt || a.createdAt) - Date.parse(b.eventAt || b.createdAt);
}

/** Zuordnung nach Startzeitpunkt; laufende Zeiträume/Deadlines und gepinnte Infos → „Laufend“. */
function sectionOf(m, now = new Date()) {
  const t = now.getTime();
  const today = startOfDay(now);
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const dayAfter = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 2);
  const weekEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate() + (7 - ((today.getDay() + 6) % 7))); // nach Sonntag
  const start = Date.parse(m.eventAt || m.createdAt);
  const end = m.endAt ? Date.parse(m.endAt) : null;
  const deadline = m.deadlineAt ? Date.parse(m.deadlineAt) : null;
  const pin = prefs.pins[m.id] ? Date.parse(prefs.pins[m.id]) : null;

  if (m.closedAt) return 'vergangen';
  if (pin && pin > t) return 'laufend';
  if (m.threatStrike && deadline && deadline <= t && isFrozen(m)) return 'laufend';   // wartet auf Abnahme
  if (start <= t && end && end > t && end >= tomorrow.getTime()) return 'laufend';   // läuft über mehrere Tage
  if (start < today.getTime() && ((end && end > t) || (deadline && deadline > t))) return 'laufend'; // seit gestern o. früher, noch aktiv
  if (start >= today.getTime() && start < tomorrow.getTime()) return 'heute';
  if (start >= tomorrow.getTime() && start < dayAfter.getTime()) return 'morgen';
  if (start >= dayAfter.getTime() && start < weekEnd.getTime()) return 'woche';
  if (start >= weekEnd.getTime()) return 'spaeter';
  return 'vergangen';
}

function renderAustausch(view) {
  const showBanner = pushSupported && state.me ? Notification.permission === 'default' : false;
  const installHint = isIos && !isStandalone
    ? `<div class="notify-banner install"><p>📲 <b>Auf dem iPhone installieren:</b> Unten in Safari auf <b>Teilen</b> <span class="share-icon" aria-hidden="true">⬆︎</span> tippen → <b>„Zum Home-Bildschirm“</b>. Danach die App über das neue Symbol öffnen – nur so funktionieren Benachrichtigungen.</p></div>`
    : '';
  const banner = installHint + (showBanner
    ? `<div class="notify-banner"><p>🔔 Benachrichtigungen aktivieren, damit du neue Nachrichten sofort mitbekommst.</p><button class="btn primary small" id="enable-push">Aktivieren</button></div>`
    : '');
  const visible = state.messages.filter((m) => !m.deleteAt || Date.parse(m.deleteAt) > Date.now());
  const evItems = state.events.map((ev) => ({ ev, sec: eventSection(ev) })).filter((x) => x.sec);
  let list;
  if (!visible.length && !evItems.length && !compactStartItems().length) {
    list = emptyStateHtml('Hier ist gerade nichts los! Tippe unten rechts auf ＋ für eine Info, eine Meldung oder einen Termin.');
  } else {
    const groups = Object.fromEntries(SECTIONS.map((sec) => [sec.key, []]));
    for (const m of visible) groups[sectionOf(m)].push({ m });
    for (const x of evItems) groups[x.sec].push({ ev: x.ev });
    const compact = Object.fromEntries(SECTIONS.map((sec) => [sec.key, []]));
    for (const c of compactStartItems()) compact[c.sec].push(c);
    if (state.highlight) { const hm = visible.find((m) => m.id === state.highlight); if (hm) prefs.sections[sectionOf(hm)] = true; }
    // Termine stehen zwischen „dringend“ und „wichtig“, untereinander nach Beginn
    const rank = (x) => (x.ev ? 0.5 : (URGENCY_RANK[x.m.urgency] ?? 2));
    const time = (x) => Date.parse(x.ev ? x.ev.startAt : (x.m.eventAt || x.m.createdAt));
    const cmp = (a, b) => (a.ev || b.ev ? rank(a) - rank(b) || time(a) - time(b) : compareMessages(a.m, b.m));
    list = SECTIONS.filter((sec) => groups[sec.key].length || compact[sec.key].length).map((sec) => {
      const minis = compact[sec.key].sort((a, b) => a.t - b.t);
      const items = groups[sec.key].sort(cmp);
      const open = sectionOpen(sec);
      const unread = items.reduce((n, x) => n + (x.m ? unreadComments(x.m) : 0), 0);
      return `<section class="msg-section${open ? ' open' : ''}" data-section="${sec.key}">
        <button type="button" class="section-head" aria-expanded="${open}">
          <span class="section-title">${sec.label}</span>
          ${items.length ? `<span class="section-count">${items.length}</span>` : ''}${unread ? '<span class="section-dot" title="Neue Kommentare"></span>' : ''}
          <span class="section-chevron" aria-hidden="true">▾</span>
        </button>
        <div class="msg-list">${open ? (minis.length ? `<div class="mini-rows">${minis.map((c) => c.html).join('')}</div>` : '') + items.map((x) => (x.ev ? eventCardHtml(x.ev) : messageHtml(x.m))).join('') : ''}</div>
      </section>`;
    }).join('');
  }
  view.innerHTML = banner + invitationCardsHtml() + list;
  bindEventCards(view);
  view.querySelectorAll('.mini-hsv[data-hsv]').forEach((b) => b.addEventListener('click', () => openHsvMatch(b.dataset.hsv)));
  view.querySelectorAll('.section-head').forEach((h) => h.addEventListener('click', () => {
    const key = h.closest('[data-section]').dataset.section;
    const sec = SECTIONS.find((x) => x.key === key);
    prefs.sections[key] = !sectionOpen(sec);
    lsSet('familie.sections', prefs.sections);
    render();
  }));

  const pushBtn = $('#enable-push', view);
  if (pushBtn) pushBtn.addEventListener('click', enablePush);

  view.querySelectorAll('[data-msg]').forEach(bindMessage);

  if (state.highlight) {
    let el = document.getElementById(`msg-${state.highlight}`);
    if (el && !el.classList.contains('expanded')) { toggleMessage(el); el = document.getElementById(`msg-${state.highlight}`); }
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    state.highlight = null;
  }
}

/** ＋ auf Start: Auswahl im Stil des Kampfmenüs – Info, Meldung oder Termin */
function openCreateMenu() {
  const calIcon = `<img src="${asset('img/menu/cal.png')}" alt="" class="cm-cal">`;
  const items = [
    { key: 'info', label: 'Info', sub: 'Zum Wissen – ohne Handlungsbedarf', icon: ballSvg('master', 44), cls: 'cm-info' },
    { key: 'meldung', label: 'Meldung', sub: 'Etwas, das passieren muss', icon: ballSvg('poke', 44), cls: 'cm-msg' },
    { key: 'termin', label: 'Termin', sub: 'Eintrag in den Kalender', icon: calIcon, cls: 'cm-event' },
  ];
  openModal(
    `<div class="cm">
       <div class="cm-box"><p>Was möchtest du anlegen?</p><span class="cm-arrow" aria-hidden="true">▼</span></div>
       <div class="cm-grid">${items.map((it, i) => `<button type="button" class="cm-btn ${it.cls}" data-create="${it.key}" style="--i:${i}">
         <span class="cm-icon">${it.icon}</span>
         <span class="cm-text"><b>${it.label}</b><small>${it.sub}</small></span>
       </button>`).join('')}</div>
       <button type="button" class="cm-cancel" data-close><span class="ds-key ds-key-a">B</span> Zurück</button>
     </div>`,
    {
      cls: 'create-menu',
      onMount: (modal, close) => {
        typeText($('.cm-box p', modal), 'Was möchtest du anlegen?');
        modal.addEventListener('click', (e) => {
          const b = e.target.closest('[data-create]');
          if (!b) return;
          close();
          if (b.dataset.create === 'termin') openEventForm({ day: startOfDay(new Date()) });
          else openNewMessage(b.dataset.create === 'info' ? 'info' : 'normal');
        });
      },
    }
  );
}

function openNewMessage(preset = 'normal') {
  const now = new Date();
  // Schnellwahl für Deadline & Löschdatum: Morgen · in: +1d +1h +10min +1min · Nächste Woche
  const quickChips = (target) => `<div class="chips time-chips" data-target="${target}">
    <button type="button" class="chip" data-q="tomorrow">Morgen</button>
    <span class="mini">in:</span>
    <button type="button" class="chip" data-q="1440">+1d</button>
    <button type="button" class="chip" data-q="60">+1h</button>
    <button type="button" class="chip" data-q="10">+10min</button>
    <button type="button" class="chip" data-q="1">+1min</button>
    <button type="button" class="chip" data-q="week">Nächste Woche</button>
  </div>`;
  const quickValue = (field, q) => {
    const cur = field.value ? new Date(field.value) : null;
    if (q === 'tomorrow' || q === 'week') {
      // gleiche Uhrzeit wie bisher gewählt (sonst jetzt), morgen bzw. in 7 Tagen
      const t = cur || new Date();
      const d = new Date();
      d.setHours(t.getHours(), t.getMinutes(), 0, 0);
      d.setDate(d.getDate() + (q === 'tomorrow' ? 1 : 7));
      return toLocalInput(d);
    }
    // „in:“ zählt ab jetzt; mehrfach tippen addiert (z. B. +1d +1h)
    const base = cur && cur.getTime() >= Date.now() - 60e3 ? cur : new Date();
    return toLocalInput(new Date(base.getTime() + Number(q) * 60e3));
  };

  openModal(
    `<div class="modal-head"><h2>${preset === 'info' ? 'Neue Info' : 'Neue Meldung'}</h2><button class="icon-btn" data-close aria-label="Schließen">✕</button></div>
     <form class="form" id="msg-form" novalidate>
       <fieldset class="field">
         <div class="field-head"><legend>Dringlichkeit</legend>${bellToggle('notify', true, 'Beim Absenden benachrichtigen')}${helpBtn('notify')}</div>
         <div class="segmented">
           ${URGENCIES.map((u) => `<label class="u-${u.key}" style="--u:var(--u-${u.key})" title="${u.ballName}"><input type="radio" name="urgency" value="${u.key}"${u.key === preset ? ' checked' : ''}><span>${ballSvg(u.ball, 28)}<em>${u.label}</em></span></label>`).join('')}
         </div>
       </fieldset>
       <label class="field"><span>Titel</span><input name="title" required maxlength="120" placeholder="Worum geht's?"></label>
       <label class="field"><span>Beschreibung</span><textarea name="description" maxlength="4000" placeholder="Details …"></textarea></label>
       <label class="field"><span>Urheber</span><input value="${esc(fullName(state.me))}" readonly></label>
       <div class="field">
         <div class="field-head"><span>Zeitpunkt</span>${bellToggle('remind', true, 'Beim Beginn des Ereignisses vibrieren')}${helpBtn('remind')}</div>
         <input name="eventAt" type="datetime-local" value="${toLocalInput(now)}" aria-label="Startzeitpunkt" class="dt">
         <div class="chips time-chips">
           <button type="button" class="chip" data-time="now">Jetzt</button>
           <span class="mini">in:</span>
           <button type="button" class="chip" data-add="60">+1h</button>
           <button type="button" class="chip" data-add="10">+10min</button>
           <button type="button" class="chip" data-add="1">+1min</button>
           <button type="button" class="chip" data-time="allday">Ganzer Tag</button>
         </div>
       </div>
       <div class="toggle-row"><span>Ereignis?</span>${helpBtn('event')}${switchToggle('hasEnd')}</div>
       <label class="field" id="end-box" hidden><span>Ende des Zeitraums</span><input name="endAt" type="datetime-local" class="dt"></label>
       <div class="toggle-row"><span>Deadline?</span>${helpBtn('deadline')}${switchToggle('hasDeadline')}</div>
       <div class="field" id="deadline-box" hidden>
         <label class="field"><span>Deadline</span><input name="deadlineAt" type="datetime-local" class="dt"></label>
         ${quickChips('deadlineAt')}
         <div class="toggle-row strike-row"><span>😈 Strich androhen?</span>${helpBtn('strike')}${switchToggle('threatStrike')}</div>
       </div>
       <div class="toggle-row"><span>Automatisch löschen?</span>${helpBtn('autoDelete')}${switchToggle('autoDelete')}</div>
       <div class="field" id="auto-delete-box" hidden>
         <input name="deleteAt" type="datetime-local" min="${toLocalInput(now)}" aria-label="Automatisch löschen am">
         ${quickChips('deleteAt')}
         <p class="hint">Die Nachricht verschwindet zu diesem Zeitpunkt für alle.</p>
       </div>
       <div class="toggle-row"><span>Rückmeldung?</span>${helpBtn('ack')}${switchToggle('needsAck')}</div>
       <div class="field" id="ack-box" hidden>
         <div class="ack-list" id="ack-list">${ackOptionRow('Erledigt')}</div>
         <button type="button" class="btn small ack-add" id="ack-add" aria-label="Weitere Antwortmöglichkeit">＋</button>
         <div class="toggle-row"><span>Rückmeldung bis?</span>${helpBtn('respondBy')}${switchToggle('hasRespondBy')}</div>
         <input name="respondBy" type="datetime-local" class="dt" id="respond-by-box" hidden aria-label="Rückmeldung bis">
       </div>
       <div class="toggle-row"><span>Löschen, wenn erledigt?</span>${helpBtn('doneDelete')}${switchToggle('deleteOnDone')}</div>
       <p class="error" id="msg-error"></p>
       <div class="modal-actions">
         <button type="button" class="btn" data-close>Abbrechen</button>
         <button type="submit" class="btn primary">Senden</button>
       </div>
     </form>`,
    {
      onMount: (modal, close) => {
        const form = $('#msg-form', modal);
        form.addEventListener('click', (e) => {
          const qbtn = e.target.closest('[data-q]');
          if (qbtn) {
            e.preventDefault();
            const field = form.elements[qbtn.closest('.time-chips').dataset.target];
            field.value = quickValue(field, qbtn.dataset.q);
            return;
          }
          const tbtn = e.target.closest('[data-time], [data-add]');
          if (tbtn) {
            e.preventDefault();
            const field = form.elements.eventAt;
            const cur = field.value ? new Date(field.value) : new Date();
            if (tbtn.dataset.time === 'now') field.value = toLocalInput(new Date());
            else if (tbtn.dataset.add) {
              // „in:“ zählt ab jetzt; mehrfach tippen addiert (z. B. +1h +10min)
              const base = cur.getTime() < Date.now() - 60e3 ? new Date() : cur;
              field.value = toLocalInput(new Date(base.getTime() + Number(tbtn.dataset.add) * 60e3));
            } else if (tbtn.dataset.time === 'allday') {
              const d = startOfDay(cur);
              field.value = toLocalInput(d);
              form.elements.hasEnd.checked = true;
              $('#end-box', modal).hidden = false;
              form.elements.endAt.value = toLocalInput(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59));
              form.elements.remind.checked = false;
            }
            return;
          }
        });
        // Nur einer der drei Regler darf an sein
        // Zeilen klappen erst auf, wenn ihr Regler an ist
        [['hasEnd', '#end-box', 'endAt'], ['hasDeadline', '#deadline-box', 'deadlineAt'], ['hasRespondBy', '#respond-by-box', 'respondBy']]
          .forEach(([name, box, field]) => form.elements[name].addEventListener('change', () => {
            const on = form.elements[name].checked;
            $(box, modal).hidden = !on;
            if (on && !form.elements[field].value) {
              const base = form.elements.eventAt.value ? new Date(form.elements.eventAt.value) : new Date();
              form.elements[field].value = toLocalInput(new Date(base.getTime() + 3600e3));
            }
          }));
        // Strich androhen macht die Meldung automatisch dringend
        const forceUrgent = () => {
          if (form.elements.hasDeadline.checked && form.elements.threatStrike.checked) {
            const r = form.querySelector('input[name=urgency][value=dringend]');
            if (!r.checked) { r.checked = true; toast('😈 Mit Strich-Androhung ist die Meldung automatisch dringend.'); }
          }
        };
        form.elements.threatStrike.addEventListener('change', forceUrgent);
        form.elements.hasDeadline.addEventListener('change', forceUrgent);
        form.querySelectorAll('input[name=urgency]').forEach((r) => r.addEventListener('change', () => setTimeout(forceUrgent, 0)));
        const exclusive = ['autoDelete', 'needsAck', 'deleteOnDone'];
        const syncBoxes = () => {
          $('#auto-delete-box', modal).hidden = !form.elements.autoDelete.checked;
          $('#ack-box', modal).hidden = !form.elements.needsAck.checked;
        };
        exclusive.forEach((name) => form.elements[name].addEventListener('change', () => {
          if (form.elements[name].checked) exclusive.filter((n) => n !== name).forEach((n) => { form.elements[n].checked = false; });
          if (name === 'autoDelete' && form.elements.autoDelete.checked && !form.elements.deleteAt.value) {
            form.elements.deleteAt.value = quickValue(form.elements.deleteAt, 'tomorrow');
          }
          syncBoxes();
        }));
        const ackList = $('#ack-list', modal);
        const syncAck = () => {
          const rows = ackList.querySelectorAll('.ack-opt');
          rows.forEach((r) => { r.querySelector('.ack-del').hidden = rows.length <= 1; });
          $('#ack-add', modal).hidden = rows.length >= 6;
        };
        $('#ack-add', modal).addEventListener('click', () => {
          ackList.insertAdjacentHTML('beforeend', ackOptionRow(''));
          ackList.lastElementChild.querySelector('input').focus();
          syncAck();
        });
        ackList.addEventListener('click', (e) => {
          const del = e.target.closest('.ack-del');
          if (!del) return;
          del.closest('.ack-opt').remove();
          syncAck();
        });
        syncAck();
        if (!isIos) form.elements.title.focus();
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const f = new FormData(form);
          const err = $('#msg-error', modal);
          const toIso = (v) => (v ? new Date(v).toISOString() : null);
          const title = f.get('title').trim();
          const eventAt = toIso(f.get('eventAt'));
          const endAt = form.elements.hasEnd.checked ? toIso(f.get('endAt')) : null;
          const deadlineAt = form.elements.hasDeadline.checked ? toIso(f.get('deadlineAt')) : null;
          const respondBy = form.elements.needsAck.checked && form.elements.hasRespondBy.checked ? toIso(f.get('respondBy')) : null;
          const deleteAt = form.elements.autoDelete.checked ? toIso(f.get('deleteAt')) : null;
          // Erinnerung nur, wenn der Start noch mindestens 2 Minuten entfernt ist (sonst käme sie sofort)
          const remind = form.elements.remind.checked && eventAt && Date.parse(eventAt) > Date.now() + 2 * 60e3;
          err.textContent = '';
          if (!title) { err.textContent = 'Bitte einen Titel angeben.'; return; }
          if (!eventAt) { err.textContent = 'Bitte einen Startzeitpunkt angeben.'; return; }
          if (form.elements.hasEnd.checked && !endAt) { err.textContent = 'Bitte das Ende des Zeitraums angeben.'; return; }
          if (form.elements.hasDeadline.checked && !deadlineAt) { err.textContent = 'Bitte eine Deadline angeben.'; return; }
          if (form.elements.needsAck.checked && form.elements.hasRespondBy.checked && !respondBy) { err.textContent = 'Bitte angeben, bis wann geantwortet werden soll.'; return; }
          if (endAt && Date.parse(endAt) < Date.parse(eventAt)) { err.textContent = 'Das Ende liegt vor dem Beginn.'; return; }
          if (form.elements.autoDelete.checked && !deleteAt) { err.textContent = 'Bitte ein Löschdatum wählen.'; return; }
          const ackOptions = form.elements.needsAck.checked
            ? [...new Set([...modal.querySelectorAll('#ack-list input')].map((i) => i.value.trim()).filter(Boolean))]
            : null;
          if (ackOptions && !ackOptions.length) { err.textContent = 'Bitte mindestens eine Antwortmöglichkeit angeben.'; return; }
          if (deleteAt && Date.parse(deleteAt) <= Date.now()) { err.textContent = 'Das Löschdatum muss in der Zukunft liegen.'; return; }
          const btn = form.querySelector('[type=submit]');
          btn.disabled = true;
          try {
            const row = must(await sb.from('messages').insert({
              urgency: form.elements.hasDeadline.checked && form.elements.threatStrike.checked ? 'dringend' : f.get('urgency'),
              title,
              description: f.get('description').trim(),
              event_at: eventAt,
              end_at: endAt,
              deadline_at: deadlineAt,
              respond_by: respondBy,
              delete_at: deleteAt,
              remind_at_start: remind,
              needs_ack: form.elements.needsAck.checked,
              ack_options: ackOptions,
              delete_on_done: form.elements.deleteOnDone.checked,
              threat_strike: form.elements.hasDeadline.checked && form.elements.threatStrike.checked,
            }).select().single());
            upsertMessage(mapMessage(row));
            close();
            catchAnimation(f.get('urgency') === 'info' ? 'Info verschickt!' : 'Meldung verschickt!');
            if (form.elements.notify.checked) {
              sb.functions.invoke('push', { body: { action: 'notify', messageId: row.id } })
                .then((r) => r.error && console.warn('Benachrichtigung fehlgeschlagen', r.error));
            }
            if (pushSupported && Notification.permission === 'default') enablePush();
          } catch (ex) {
            err.textContent = ex.message;
            btn.disabled = false;
          }
        });
      },
    }
  );
}

function upsertMessage(m) {
  const i = state.messages.findIndex((x) => x.id === m.id);
  if (i >= 0) state.messages[i] = m;
  else state.messages.unshift(m);
  state.messages.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  if (state.tab !== 'start') return;
  if (i >= 0 && document.getElementById(`msg-${m.id}`)) rerenderMessage(m.id);
  else render();
}

function removeMessage(id) {
  state.messages = state.messages.filter((m) => m.id !== id);
  if (state.tab === 'start') render();
}

/* -------------------------------------------------------------------------
 * Team
 * ---------------------------------------------------------------------- */

function inviteLink() {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('code', state.familyCode || '');
  return url.toString();
}

function pokemonTileHtml(p) {
  const age = ageParts(parseBirthday(p.birthday));
  return `<button class="team-tile pokemon-tile" data-pokemon="${esc(p.id)}" style="${colorVars(p.color)}">
    <span class="avatar"><img class="sprite" src="${esc(p.sprite)}" alt=""></span>
    <span class="name">${esc(p.firstName)} ${genderSvg(p.gender)}</span>
    <span class="meta">Pokémon · Lv. ${age.years}</span>
  </button>`;
}

/* ---- Team-Ansichten: „Übersicht“ (Kacheln) und „Party“ (wie der Pokémon-Bildschirm im Spiel) ---- */
function getTeamView() {
  try { return localStorage.getItem('familie.teamView') === 'party' ? 'party' : 'uebersicht'; } catch { return 'uebersicht'; }
}

function partySlotHtml(entry, i) {
  const { kind, id, name, gender, sprite, birthday, selected } = entry;
  const xp = birthday ? xpInfo(parseBirthday(birthday)) : null;
  const pct = xp ? Math.min(100, (xp.xp / xp.total) * 100) : 0;
  return `<button type="button" class="party-slot${selected ? ' selected' : ''}${i % 2 ? ' right' : ''}" data-party-kind="${kind}" data-party-id="${esc(id)}">
    <span class="party-ball" aria-hidden="true"></span>
    <span class="party-icon">${sprite ? `<img class="sprite" src="${esc(sprite)}" alt="">` : ''}</span>
    <span class="party-name">${esc(name)}</span>
    ${gender ? `<span class="party-gender">${genderSvg(gender)}</span>` : ''}
    ${xp ? `<span class="party-bar"><span class="party-bar-tag">XP</span><span class="party-bar-track"><span class="party-bar-fill" style="width:${pct.toFixed(1)}%"></span></span></span>
    <span class="party-lv">Lv.${xp.level}</span>
    <span class="party-xp">${xp.xp} /${xp.total}</span>` : `<span class="party-egg-hint">SSW ${esc(eggInfo().ssw)} · ${eggInfo().remaining} T</span>`}
  </button>`;
}

function renderParty() {
  const users = state.users.slice().sort((a, b) => fullName(a).localeCompare(fullName(b), 'de'));
  const entries = [
    ...users.map((u) => ({ kind: 'user', id: u.id, name: u.firstName.toUpperCase(), gender: u.gender, sprite: SPRITES[u.gender], birthday: u.birthday, selected: state.me && u.id === state.me.id })),
    ...POKEMON.map((p) => ({ kind: 'pokemon', id: p.id, name: p.firstName.toUpperCase(), gender: p.gender, sprite: p.sprite, birthday: p.birthday })),
    { kind: 'egg', id: 'egg', name: 'EI', sprite: asset('img/egg.png') },
  ];
  return `<div class="party">
    <div class="party-grid">${entries.map(partySlotHtml).join('')}</div>
    <div class="party-foot">
      <button type="button" class="party-menu-btn" id="party-menu">MENÜ</button>
    </div>
  </div>`;
}

function renderTeam(view) {
  const users = state.users.slice().sort((a, b) => fullName(a).localeCompare(fullName(b), 'de'));
  const mode = getTeamView();
  const switcher = `<div class="card-tabs team-switch" role="tablist" aria-label="Team-Ansicht">
    <button type="button" role="tab" data-team-view="uebersicht" class="${mode === 'uebersicht' ? 'active' : ''}" aria-selected="${mode === 'uebersicht'}">Übersicht</button>
    <button type="button" role="tab" data-team-view="party" class="${mode === 'party' ? 'active' : ''}" aria-selected="${mode === 'party'}">Party</button>
  </div>`;
  const grid = mode === 'party' ? renderParty() : `<div class="team-grid">${users
    .map((u) => {
      const age = ageParts(parseBirthday(u.birthday));
      return `<button class="team-tile" data-user="${esc(u.id)}" style="${colorVars(u.color)}">
        <span class="avatar">${SPRITES[u.gender] ? `<img class="sprite sprite-${u.gender}" src="${SPRITES[u.gender]}" alt="">` : esc(initials(u))}</span>
        <span class="name">${esc(fullName(u))}${state.me && u.id === state.me.id ? '<span class="me-badge">Du</span>' : ''}</span>
        <span class="meta">ID ${esc(u.trainerId)} · Lv. ${age.years}</span>
      </button>`;
    })
    .join('')}${POKEMON.map(pokemonTileHtml).join('')}${eggTileHtml()}</div>`;
  const invite = state.familyCode
    ? `<div class="invite">
        <div><span class="hint">Familien-Code zum Einladen</span><div class="code">${esc(state.familyCode)}</div></div>
        <button class="btn small" id="share-invite">Einladen</button>
      </div>`
    : '';
  const version = `<p class="app-version">App-Version: ${esc(CFG.version || 'dev')}</p>`;
  view.innerHTML = switcher + grid + invite + version;
  view.querySelectorAll('[data-team-view]').forEach((b) => b.addEventListener('click', () => {
    try { localStorage.setItem('familie.teamView', b.dataset.teamView); } catch { /* privat */ }
    render();
  }));
  view.querySelectorAll('[data-party-kind]').forEach((b) => b.addEventListener('click', () => {
    const { partyKind: kind, partyId: id } = b.dataset;
    if (kind === 'user') openTrainerCard(userById(id));
    else if (kind === 'pokemon') openTrainerCard(pokemonById(id));
    else openEggMemo();
  }));
  const pm = $('#party-menu', view);
  if (pm) pm.addEventListener('click', openMenu);
  view.querySelectorAll('[data-user]').forEach((b) =>
    b.addEventListener('click', () => openTrainerCard(userById(b.dataset.user)))
  );
  view.querySelectorAll('[data-pokemon]').forEach((b) =>
    b.addEventListener('click', () => openTrainerCard(pokemonById(b.dataset.pokemon)))
  );
  const egg = view.querySelector('[data-egg]');
  if (egg) egg.addEventListener('click', openEggMemo);
  const share = $('#share-invite', view);
  if (share) share.addEventListener('click', async () => {
    const text = `Komm in unsere Familien-App! Familien-Code: ${state.familyCode}`;
    const url = inviteLink();
    try {
      if (navigator.share) await navigator.share({ title: 'Familie', text, url });
      else { await navigator.clipboard.writeText(`${text}\n${url}`); toast('Einladung kopiert 📋'); }
    } catch { /* abgebrochen */ }
  });
}

/* -------------------------------------------------------------------------
 * Das Ei (Platzhalter-Konto für die kommende Tochter)
 * ---------------------------------------------------------------------- */

const EGG = {
  name: '???',
  due: '2027-03-14', // errechneter Entbindungstermin
  from: 'Mama & Papa',
};

// Die vier Stufen der „Ei-Uhr“ aus dem Spiel (Gen. III/IV), auf die Schwangerschaft gelegt:
//  bis 27+6 SSW  → „wird noch lange dauern“          (Spiel: > 40 Ei-Zyklen übrig)
//  ab 28+0 SSW   → „scheint noch nicht so weit“      (3. Trimester;   11–40 Zyklen)
//  ab 37+0 SSW   → „bewegt sich ab und zu“           (ab termingerecht; 6–10 Zyklen)
//  ab 39+0 SSW   → „Geräusche … schlüpft bald!“      (letzte Woche;   ≤ 5 Zyklen)
const EGG_STAGES = [
  { week: 0, text: 'Es sieht so aus, als würde es noch sehr lange dauern, bis dieses Ei schlüpft.' },
  { week: 28, text: 'Was wohl daraus schlüpfen wird? Es scheint noch nicht kurz vorm Schlüpfen zu sein.' },
  { week: 37, text: 'Es bewegt sich ab und zu. Vielleicht schlüpft es bald.' },
  { week: 39, text: 'Aus dem Inneren sind Geräusche zu hören! Es schlüpft bald!' },
];

function eggInfo(now = new Date()) {
  const due = parseBirthday(EGG.due);
  const start = new Date(due.getFullYear(), due.getMonth(), due.getDate() - 280); // 40 Wochen vor ET
  const days = Math.max(0, daysBetween(start, now));
  const week = Math.floor(days / 7);
  const stage = EGG_STAGES.filter((s) => week >= s.week).pop();
  return {
    due,
    days,
    ssw: `${week}+${days % 7}`,
    remaining: daysBetween(now, due),
    pct: Math.min(100, (days / 280) * 100),
    text: stage.text,
  };
}

function eggTileHtml() {
  const e = eggInfo();
  return `<button class="team-tile egg-tile" data-egg>
    <span class="avatar"><img class="sprite" src="${asset('img/egg.png')}" alt=""></span>
    <span class="name">${esc(EGG.name)}</span>
    <span class="meta">SSW ${esc(e.ssw)} · ${e.remaining > 0 ? `${e.remaining} T` : 'bald!'}</span>
  </button>`;
}

function openEggMemo() {
  const e = eggInfo();
  openModal(
    `<div class="modal-head"><h2>Trainer-Memo</h2><button class="icon-btn" data-close aria-label="Schließen">✕</button></div>
     <article class="memo" aria-label="Trainer-Memo des Eies">
       <div class="memo-head">TRAINER-MEMO</div>
       <div class="memo-body">
         <div class="memo-left">
           <div class="memo-name"><span class="ball"></span>Ei</div>
           <div class="memo-egg"><img class="sprite" src="${asset('img/egg.png')}" alt="Ei"></div>
           <div class="memo-item"><span>Name</span><b>${esc(EGG.name)}</b></div>
         </div>
         <div class="memo-right">
           <p>ET ${esc(formatDate(e.due))}</p>
           <p>Ein geheimnisvolles Ei, erhalten von <span class="memo-red">${esc(EGG.from)}</span>.</p>
           <p>&nbsp;</p>
           <p>„Die Ei-Uhr“</p>
           <p class="memo-watch">${esc(e.text)}</p>
         </div>
       </div>
       <div class="xp memo-xp">
         <div class="xp-line"><span>SSW ${esc(e.ssw)}</span><span>${Math.min(e.days, 280)} / 280 Tage</span></div>
         <div class="xp-bar"><div class="xp-fill egg-fill" style="width:${e.pct.toFixed(1)}%"></div></div>
         <div class="xp-sub">${e.remaining > 0 ? `Noch ${e.remaining} Tage bis zum Schlupftermin` : 'Der Schlupftermin ist erreicht! 🐣'}</div>
       </div>
     </article>`
  );
}

/* -------------------------------------------------------------------------
 * Hell / Dunkel
 * ---------------------------------------------------------------------- */

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function isDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : darkQuery.matches;
}

function syncThemeToggle() {
  const dark = isDark();
  const btn = $('#theme-toggle');
  if (btn) {
    btn.setAttribute('aria-checked', String(dark));
    btn.title = dark ? 'Dunkel – tippen für hell' : 'Hell – tippen für dunkel';
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = dark ? '#212128' : '#ffffff';
}

function toggleTheme() {
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('familie.theme', next); } catch { /* privat */ }
  syncThemeToggle();
}

/* -------------------------------------------------------------------------
 * Menü (X-Knopf)
 * ---------------------------------------------------------------------- */

function openMenu() {
  const menu = $('#menu');
  if (!menu.hidden && !menu.classList.contains('closing')) return;
  renderProfileButton();
  menu.classList.remove('closing');
  $('#menu-backdrop').hidden = false;
  menu.hidden = false;
  // Startpunkt der Animation: der X-Knopf
  const b = $('#menu-btn').getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  menu.style.setProperty('--ox', `${b.left + b.width / 2 - m.left}px`);
  menu.style.setProperty('--oy', `${b.top + b.height / 2 - m.top}px`);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    menu.classList.add('open');
    $('#menu-backdrop').classList.add('open');
  }));
  $('#menu-btn').setAttribute('aria-expanded', 'true');
  document.body.classList.add('menu-open');
}

function closeMenu(after) {
  const menu = $('#menu');
  if (menu.hidden) { if (after) after(); return; }
  menu.classList.remove('open');
  menu.classList.add('closing');
  $('#menu-backdrop').classList.remove('open');
  $('#menu-btn').setAttribute('aria-expanded', 'false');
  document.body.classList.remove('menu-open');
  setTimeout(() => {
    if (menu.classList.contains('closing')) {
      menu.hidden = true;
      menu.classList.remove('closing');
      $('#menu-backdrop').hidden = true;
    }
  }, 280);
  if (after) setTimeout(after, 140);
}

/* Navigation: X-Menü oder Reiter unten (pro Gerät gespeichert) */
function getNavMode() {
  try { return localStorage.getItem('familie.nav') === 'tabs' ? 'tabs' : 'x'; } catch { return 'x'; }
}

function applyNavMode() {
  const tabs = getNavMode() === 'tabs';
  document.body.classList.toggle('nav-tabs', tabs);
}

function setNavMode(mode) {
  try { localStorage.setItem('familie.nav', mode); } catch { /* privat */ }
  applyNavMode();
  render();
}

function setupMenu() {
  applyNavMode();
  $('#menu-switch').addEventListener('click', () => {
    const next = getNavMode() === 'tabs' ? 'x' : 'tabs';
    closeMenu(() => {
      setNavMode(next);
      toast(next === 'tabs' ? 'Reiter-Ansicht aktiv – zurück zum X-Menü geht es unter Einstellungen.' : 'X-Menü aktiv');
    });
  });
  document.querySelectorAll('.tabbar [data-tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('#menu-btn').addEventListener('click', () => ($('#menu').hidden || $('#menu').classList.contains('closing') ? openMenu() : closeMenu()));
  $('#menu-back').addEventListener('click', () => closeMenu());
  $('#menu-backdrop').addEventListener('click', () => closeMenu());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#menu').hidden) closeMenu();
  });
  $('#menu').querySelectorAll('[data-go]').forEach((b) =>
    b.addEventListener('click', () => {
      const go = b.dataset.go;
      closeMenu(() => {
        if (go === 'profil') { if (state.me) openTrainerCard(state.me); }
        else setTab(go);
      });
    })
  );
}

/* -------------------------------------------------------------------------
 * Einstellungen
 * ---------------------------------------------------------------------- */

function renderSettings(view) {
  const dark = isDark();
  const pushState = !pushSupported ? 'nicht verfügbar' : Notification.permission === 'granted' ? 'aktiv' : Notification.permission === 'denied' ? 'blockiert' : 'aus';
  view.innerHTML = `
    <div class="settings">
      <div class="setting-row">
        <div><b>Anzeigemodus</b><p class="hint">${dark ? 'Dunkel' : 'Hell'}</p></div>
        <button id="theme-toggle" class="theme-toggle" type="button" role="switch" aria-checked="${dark}" aria-label="Dunkelmodus">
          <svg class="tt-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="currentColor"/><g stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 1.5v2.5M12 20v2.5M1.5 12h2.5M20 12h2.5M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8"/></g></svg>
          <svg class="tt-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z" fill="currentColor"/></svg>
          <span class="tt-knob"></span>
        </button>
      </div>
      <div class="setting-row">
        <div><b>Navigation</b><p class="hint">${getNavMode() === 'tabs' ? 'Reiter unten' : 'X-Menü'}</p></div>
        <button class="btn small" id="set-nav">${getNavMode() === 'tabs' ? 'X-Menü nutzen' : 'Reiter nutzen'}</button>
      </div>
      <div class="setting-row">
        <div><b>Benachrichtigungen</b><p class="hint">${pushState}</p></div>
        ${pushSupported && Notification.permission === 'default' ? '<button class="btn small primary" id="set-push">Aktivieren</button>' : ''}
      </div>
      ${state.me ? `<div class="setting-row">
        <div><b>Profil</b><p class="hint">${esc(fullName(state.me))}</p></div>
        <span class="row-btns"><button class="btn small" id="set-card">Ansehen</button><button class="btn small" id="set-profile">Bearbeiten</button></span>
      </div>` : ''}
      <div class="setting-row">
        <div><b>HSV-Spiele im Kalender</b><p class="hint">${hsvEnabled() ? 'an' : 'aus'}</p></div>
        <button class="btn small" id="set-hsv">${hsvEnabled() ? 'Ausblenden' : 'Einblenden'}</button>
      </div>
      <div class="setting-row">
        <div><b>App-Version</b><p class="hint">${esc(CFG.version || 'dev')}</p></div>
        <button class="btn small" id="set-update">Nach Updates suchen</button>
      </div>
    </div>`;
  $('#theme-toggle', view).addEventListener('click', () => { toggleTheme(); render(); });
  const push = $('#set-push', view); if (push) push.addEventListener('click', enablePush);
  const prof = $('#set-profile', view); if (prof) prof.addEventListener('click', openEditProfile);
  const card = $('#set-card', view); if (card) card.addEventListener('click', () => openTrainerCard(state.me));
  $('#set-update', view).addEventListener('click', checkForUpdate);
  $('#set-hsv', view).addEventListener('click', () => { lsSet('familie.hsvOn', !hsvEnabled()); render(); });
  $('#set-nav', view).addEventListener('click', () => setNavMode(getNavMode() === 'tabs' ? 'x' : 'tabs'));
}

/* -------------------------------------------------------------------------
 * Update-Prüfung
 * ---------------------------------------------------------------------- */

/** Alten Service Worker abmelden, Zwischenspeicher leeren und die neue Version frisch laden. */
async function hardRefresh(version) {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if (window.caches) await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
  } catch { /* weiter mit Neuladen */ }
  const url = new URL(location.href);
  url.searchParams.set('v', version || String(Date.now()));
  setTimeout(() => location.replace(url.toString()), 400);
}

async function fetchRemoteVersion() {
  const res = await fetch(`config.js?check=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('offline');
  const m = (await res.text()).match(/version:\s*'([^']*)'/);
  return m ? m[1] : null;
}

/** Leise im Hintergrund prüfen: Gibt es eine neue Version, wackelt der Pokéball. */
async function pollForUpdate() {
  try {
    const remote = await fetchRemoteVersion();
    const available = Boolean(remote && CFG.version && remote !== CFG.version);
    const btn = $('#update-btn');
    btn.classList.toggle('has-update', available);
    btn.title = available ? 'Neues Update – antippen zum Installieren' : 'App ist aktuell';
    btn.setAttribute('aria-label', btn.title);
  } catch { /* offline – später erneut */ }
}

async function checkForUpdate() {
  const btn = $('#update-btn');
  if (btn.classList.contains('busy')) return;
  btn.classList.add('busy');
  try {
    const remote = await fetchRemoteVersion();
    if (remote && remote !== CFG.version) {
      toast('Neue Version gefunden – wird installiert …');
      await hardRefresh(remote);
      return;
    }
    if (state.me) await refreshAll();
    toast('Alles aktuell ✓');
  } catch {
    toast('Update-Prüfung fehlgeschlagen – bist du online?');
  } finally {
    btn.classList.remove('busy');
  }
}

/* -------------------------------------------------------------------------
 * Platzhalter
 * ---------------------------------------------------------------------- */

function renderPlaceholder(view, icon, title, text) {
  view.innerHTML = emptyStateHtml(`${title}: ${text}`, { icon });
}

/* -------------------------------------------------------------------------
 * Kalender (Pokédex-Stil)
 *  – Monatsraster, Tag antippen → Tagesübersicht, nochmal tippen → neuer Termin
 *  – Termine: Titel, Ort, ganztägig / Zeitpunkt / Zeitraum (auch mehrtägig),
 *    Beschreibung, Hinweise (wie Apple + benutzerdefiniert), Einladungen
 *  – Farbe + Sprite zeigen, für wen der Termin gilt: Er / Sie / beide
 * ---------------------------------------------------------------------- */

const CAL_SPRITES = { m: asset('img/cal-m.png'), w: asset('img/cal-w.png') };
const CAL_HEADS = { m: asset('img/cal-m-head.png'), w: asset('img/cal-w-head.png') };
const GENDER_COLORS = { m: '#3b78d8', w: '#e0568c', both: '#8a5bd6' };
const GENDER_NAMES = { m: 'Er', w: 'Sie', both: 'Beide' };
const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

const REMINDERS_TIMED = [
  ['none', 'Ohne'], ['o:0', 'Zum Zeitpunkt des Ereignisses'], ['o:5', '5 Minuten vorher'], ['o:10', '10 Minuten vorher'],
  ['o:15', '15 Minuten vorher'], ['o:30', '30 Minuten vorher'], ['o:60', '1 Stunde vorher'], ['o:120', '2 Stunden vorher'],
  ['o:1440', '1 Tag vorher'], ['o:2880', '2 Tage vorher'], ['o:10080', '1 Woche vorher'], ['custom', 'Benutzerdefiniert …'],
];
const REMINDERS_ALLDAY = [
  ['none', 'Ohne'], ['d:0', 'Am Tag des Ereignisses (9:00)'], ['d:1', '1 Tag vorher (9:00)'], ['d:2', '2 Tage vorher (9:00)'],
  ['d:7', '1 Woche vorher (9:00)'], ['custom', 'Benutzerdefiniert …'],
];
const specToValue = (r) => (r.k === 'offset' ? `o:${r.m}` : r.k === 'day' ? `d:${r.d}` : 'custom');
function reminderLabel(r, allDay) {
  if (r.k === 'custom') return `Am ${formatDateTime(r.at)} Uhr`;
  const v = specToValue(r);
  const hit = (allDay ? REMINDERS_ALLDAY : REMINDERS_TIMED).find(([k]) => k === v)
    || REMINDERS_TIMED.find(([k]) => k === v) || REMINDERS_ALLDAY.find(([k]) => k === v);
  return hit ? hit[1] : '';
}

/* ---- Daten ------------------------------------------------------------ */

function mapEvent(r) {
  return {
    id: r.id, ownerId: r.owner_id, title: r.title, location: r.location || '', description: r.description || '',
    allDay: Boolean(r.all_day), startAt: r.start_at, endAt: r.end_at,
    reminders: Array.isArray(r.reminders) ? r.reminders : [], createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
async function loadEvents() {
  const [ev, inv, com] = await Promise.all([
    sb.from('events').select('*').order('start_at', { ascending: true }),
    sb.from('event_invites').select('*'),
    sb.from('event_comments').select('*').order('created_at', { ascending: true }),
  ]);
  state.events = must(ev).map(mapEvent);
  state.invites = must(inv).map((r) => ({ eventId: r.event_id, userId: r.user_id, status: r.status, respondedAt: r.responded_at }));
  state.eventComments = must(com).map((r) => ({ id: r.id, eventId: r.event_id, authorId: r.author_id, body: r.body, createdAt: r.created_at }));
  state.eventsLoaded = true;
}
const invitesOf = (ev) => state.invites.filter((i) => i.eventId === ev.id);
const myInvite = (ev) => state.me && state.invites.find((i) => i.eventId === ev.id && i.userId === state.me.id);
/** Für wen gilt der Termin? Ersteller + alle, die zugesagt haben */
function eventPeople(ev) {
  const ids = [ev.ownerId, ...invitesOf(ev).filter((i) => i.status === 'accepted').map((i) => i.userId)];
  return [...new Set(ids)].map(userById).filter(Boolean);
}
function eventGenders(ev) {
  const g = new Set(eventPeople(ev).map((u) => u.gender));
  return ['m', 'w'].filter((x) => g.has(x));
}
function eventColor(ev) {
  const g = eventGenders(ev);
  return GENDER_COLORS[g.length > 1 ? 'both' : g[0] || 'both'];
}
const eventHeads = (ev, cls = 'ev-head') => eventGenders(ev).map((g) => `<img class="${cls}" src="${CAL_HEADS[g]}" alt="">`).join('');
const eventSprites = (ev) => eventGenders(ev).map((g) => `<img class="ev-sprite" src="${CAL_SPRITES[g]}" alt="">`).join('');

/** Ende für die Tagesberechnung (ein Termin bis 0:00 zählt nicht mehr zum Folgetag) */
const evStartDay = (ev) => startOfDay(new Date(ev.startAt));
const evEndDay = (ev) => {
  const e = Date.parse(ev.endAt);
  return startOfDay(new Date(e > Date.parse(ev.startAt) ? e - 1000 : e));
};
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const sameDay = (a, b) => a.getTime() === b.getTime();

function eventTimeText(ev, short = false) {
  const s = new Date(ev.startAt), e = new Date(ev.endAt);
  const sd = evStartDay(ev), ed = evEndDay(ev);
  const dateFmt = (d) => d.toLocaleDateString('de-DE', short ? { day: 'numeric', month: 'numeric' } : { weekday: 'short', day: 'numeric', month: 'numeric' });
  if (ev.allDay) return sameDay(sd, ed) ? `${dateFmt(sd)} · ganztägig` : `${dateFmt(sd)} – ${dateFmt(ed)} · ganztägig`;
  if (s.getTime() === e.getTime()) return `${dateFmt(s)}, ${formatTimeOnly(ev.startAt)}`;
  if (sameDay(sd, ed)) return `${dateFmt(s)}, ${formatTimeOnly(ev.startAt)} – ${formatTimeOnly(ev.endAt)}`;
  return `${dateFmt(s)}, ${formatTimeOnly(ev.startAt)} – ${dateFmt(e)}, ${formatTimeOnly(ev.endAt)}`;
}
/** Uhrzeit-Anzeige an einem bestimmten Tag */
function eventTimeOnDay(ev, day) {
  if (ev.allDay) return 'ganztags';
  const sd = evStartDay(ev), ed = evEndDay(ev);
  if (!sameDay(sd, day) && !sameDay(ed, day)) return 'ganztags';
  if (!sameDay(sd, day)) return `bis ${formatTimeOnly(ev.endAt)}`;
  return formatTimeOnly(ev.startAt);
}
function eventsOnDay(day) {
  const t = day.getTime();
  return state.events.filter((ev) => evStartDay(ev).getTime() <= t && evEndDay(ev).getTime() >= t)
    .sort((a, b) => (b.allDay - a.allDay) || Date.parse(a.startAt) - Date.parse(b.startAt));
}

/* ---- Feiertage (bundesweit + Hamburg) -------------------------------- */

function easterSunday(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, month - 1, day);
}
const holidayCache = new Map();
/*
 * Deutscher Feiertagskalender
 *   kind: 'legal'    – gesetzlicher Feiertag in Hamburg (bzw. bundesweit)
 *         'regional' – gesetzlicher Feiertag nur in anderen Bundesländern
 *         'church'   – kirchlicher Feiertag/Gedenktag (evangelisch, katholisch oder beide)
 *         'custom'   – üblicher Tag ohne gesetzlichen Status (Heiligabend, Silvester …)
 */
function holidaysOf(y) {
  if (holidayCache.has(y)) return holidayCache.get(y);
  const e = easterSunday(y);
  const D = (m, d) => new Date(y, m - 1, d);
  // 4. Advent = letzter Sonntag vor dem 25.12.
  const xmas = D(12, 25);
  const advent4 = addDays(xmas, -(xmas.getDay() === 0 ? 7 : xmas.getDay()));
  const advent1 = addDays(advent4, -21);
  // Buß- und Bettag = letzter Mittwoch vor dem 23.11.
  const nov23 = D(11, 23);
  const bussTag = addDays(nov23, -(((nov23.getDay() - 3 + 7) % 7) || 7));
  // Erntedank = erster Sonntag im Oktober
  const oct1 = D(10, 1);
  const erntedank = addDays(oct1, (7 - oct1.getDay()) % 7);
  const list = [
    [D(1, 1), 'Neujahr', 'Neujahr', 'legal', 'bundesweit', '🎆'],
    [D(1, 6), 'Heilige Drei Könige', '3 Könige', 'regional', 'gesetzlich in BW, BY, ST · katholisch', '👑'],
    [D(3, 8), 'Internationaler Frauentag', 'Frauentag', 'regional', 'gesetzlich in BE, MV', '💐'],
    [addDays(e, -48), 'Rosenmontag', 'Rosenmo.', 'custom', 'Karneval – kein gesetzlicher Feiertag', '🎭'],
    [addDays(e, -46), 'Aschermittwoch', 'Aschermi.', 'church', 'Beginn der Fastenzeit · katholisch & evangelisch', '✝️'],
    [addDays(e, -7), 'Palmsonntag', 'Palmso.', 'church', 'katholisch & evangelisch', '🌿'],
    [addDays(e, -3), 'Gründonnerstag', 'Gründo.', 'church', 'katholisch & evangelisch', '🍞'],
    [addDays(e, -2), 'Karfreitag', 'Karfreitag', 'legal', 'bundesweit', '✝️'],
    [addDays(e, -1), 'Karsamstag', 'Karsa.', 'church', 'katholisch & evangelisch', '🕯️'],
    [e, 'Ostersonntag', 'Ostern', 'legal', 'gesetzlich in BB · bundesweit gefeiert', '🐣'],
    [addDays(e, 1), 'Ostermontag', 'Ostermo.', 'legal', 'bundesweit', '🐰'],
    [D(5, 1), 'Tag der Arbeit', '1. Mai', 'legal', 'bundesweit', '🌷'],
    [addDays(e, 39), 'Christi Himmelfahrt', 'Himmelf.', 'legal', 'bundesweit', '☁️'],
    [addDays(e, 49), 'Pfingstsonntag', 'Pfingsten', 'legal', 'gesetzlich in BB · bundesweit gefeiert', '🕊️'],
    [addDays(e, 50), 'Pfingstmontag', 'Pfingstmo.', 'legal', 'bundesweit', '🕊️'],
    [addDays(e, 60), 'Fronleichnam', 'Fronleichn.', 'regional', 'gesetzlich in BW, BY, HE, NW, RP, SL · katholisch', '🌼'],
    [D(8, 15), 'Mariä Himmelfahrt', 'Mariä Himmelf.', 'regional', 'gesetzlich im SL und in Teilen BYs · katholisch', '🌸'],
    [D(9, 20), 'Weltkindertag', 'Kindertag', 'regional', 'gesetzlich in TH', '🧸'],
    [erntedank, 'Erntedankfest', 'Erntedank', 'church', 'katholisch & evangelisch', '🌾'],
    [D(10, 3), 'Tag der Deutschen Einheit', 'Einheit', 'legal', 'bundesweit', '🇩🇪'],
    [D(10, 31), 'Reformationstag', 'Reformation', 'legal', 'gesetzlich in HH, BB, HB, MV, NI, SN, ST, SH, TH · evangelisch', '📜'],
    [D(11, 1), 'Allerheiligen', 'Allerheil.', 'regional', 'gesetzlich in BW, BY, NW, RP, SL · katholisch', '🕯️'],
    [D(11, 2), 'Allerseelen', 'Allerseelen', 'church', 'katholisch', '🕯️'],
    [D(11, 11), 'Martinstag', 'St. Martin', 'church', 'Laternenumzüge · katholisch & evangelisch', '🏮'],
    [addDays(advent1, -14), 'Volkstrauertag', 'Volkstrauert.', 'church', 'Gedenktag', '🕊️'],
    [bussTag, 'Buß- und Bettag', 'Buß- & Bettag', 'regional', 'gesetzlich in SN · evangelisch', '🙏'],
    [addDays(advent1, -7), 'Totensonntag', 'Totenso.', 'church', 'Ewigkeitssonntag · evangelisch (katholisch: Christkönig)', '🕯️'],
    [advent1, '1. Advent', '1. Advent', 'church', 'katholisch & evangelisch', '🕯️'],
    [addDays(advent1, 7), '2. Advent', '2. Advent', 'church', 'katholisch & evangelisch', '🕯️'],
    [D(12, 6), 'Nikolaus', 'Nikolaus', 'church', 'katholisch & evangelisch', '🎅'],
    [addDays(advent1, 14), '3. Advent', '3. Advent', 'church', 'katholisch & evangelisch', '🕯️'],
    [advent4, '4. Advent', '4. Advent', 'church', 'katholisch & evangelisch', '🕯️'],
    [D(12, 24), 'Heiligabend', 'Heiligabend', 'custom', 'kein gesetzlicher Feiertag', '🎄'],
    [D(12, 25), '1. Weihnachtsfeiertag', '1. Weihn.', 'legal', 'bundesweit', '🎁'],
    [D(12, 26), '2. Weihnachtsfeiertag', '2. Weihn.', 'legal', 'bundesweit', '⭐'],
    [D(12, 31), 'Silvester', 'Silvester', 'custom', 'kein gesetzlicher Feiertag', '🎇'],
  ];
  const rank = { legal: 0, regional: 1, custom: 2, church: 3 };
  const map = new Map();
  for (const [d, name, short, kind, note, emoji] of list) {
    const k = d.getTime();
    if (!map.has(k)) map.set(k, []);
    map.get(k).push({ name, short, kind, note, emoji, legal: kind === 'legal' });
  }
  for (const arr of map.values()) arr.sort((a, b) => rank[a.kind] - rank[b.kind]);
  holidayCache.set(y, map);
  return map;
}
/** Alle Feiertage eines Tages (wichtigster zuerst) */
const holidaysOn = (day) => holidaysOf(day.getFullYear()).get(day.getTime()) || [];
const holidayOn = (day) => holidaysOn(day)[0] || null;
const HOLIDAY_KIND = { legal: 'Gesetzlicher Feiertag', regional: 'Feiertag in anderen Bundesländern', church: 'Kirchlicher Feiertag', custom: 'Kein gesetzlicher Feiertag' };

/* ---- Feiertage & HSV kompakt auf Start ------------------------------ */

/** Bereich auf Start für einen Tag (nur Heute / Morgen / Diese Woche) */
function daySection(day) {
  const today = startOfDay(new Date());
  const diff = Math.round((day - today) / 86400e3);
  const weekEnd = addDays(today, 7 - ((today.getDay() + 6) % 7));
  if (diff === 0) return 'heute';
  if (diff === 1) return 'morgen';
  if (diff > 1 && day < weekEnd) return 'woche';
  return null;
}
function compactStartItems() {
  const out = [];
  const today = startOfDay(new Date());
  for (let i = 0; i < 8; i++) {
    const d = addDays(today, i);
    const sec = daySection(d);
    if (sec) for (const h of holidaysOn(d)) out.push({ sec, t: d.getTime(), html: holidayRowHtml(d, h) });
  }
  if (hsvEnabled() && state.hsv) {
    for (const m of state.hsv) {
      const k = new Date(m.kickoff);
      const sec = daySection(startOfDay(k));
      if (!sec) continue;
      if (m.finished && sec !== 'heute') continue;
      out.push({ sec, t: k.getTime(), html: hsvRowHtml(m) });
    }
  }
  return out;
}
function holidayRowHtml(d, h) {
  const date = d.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric' });
  return `<div class="mini-row mini-hol k-${h.kind}" title="${esc(h.note)}"><span class="mini-ico">${h.emoji || '🎉'}</span><span class="mini-when">${esc(date)}</span><span class="mini-what">${esc(h.name)}</span></div>`;
}
function hsvRowHtml(m) {
  const k = new Date(m.kickoff);
  const sameDayToday = startOfDay(k).getTime() === startOfDay(new Date()).getTime();
  const when = sameDayToday ? formatTimeOnly(m.kickoff) : `${k.toLocaleDateString('de-DE', { weekday: 'short' })} ${formatTimeOnly(m.kickoff)}`;
  const icon = m.isHome ? m.homeIcon : m.awayIcon;
  const crest = icon ? `<img src="${esc(icon)}" alt="HSV" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('i'),{className:'hsv-diamond'}))">` : '<i class="hsv-diamond"></i>';
  const vs = m.isHome ? `vs. ${hsvShort(m.away)}` : `@ ${hsvShort(m.home)}`;
  return `<button type="button" class="mini-row mini-hsv" data-hsv="${esc(m.id)}"><span class="mini-ico">${crest}</span><span class="mini-when">${esc(when)}</span><span class="mini-what">${esc(vs)}${m.finished && m.result ? ` · ${esc(m.result)}` : ''}</span></button>`;
}

/* ---- HSV-Spielplan ---------------------------------------------------- */

const HSV_KEY = 'familie.hsv';
const hsvEnabled = () => lsGet('familie.hsvOn', true) !== false;
function loadHsv(force = false) {
  const cached = lsGet(HSV_KEY, null);
  if (cached && Array.isArray(cached.matches)) state.hsv = cached.matches;
  if (!force && cached && Date.now() - cached.at < 3 * 3600e3) return Promise.resolve();
  if (state.hsvLoading) return state.hsvLoading;
  state.hsvLoading = sb.functions.invoke('hsv', { body: {} })
    .then((r) => {
      if (r.error || !r.data || !Array.isArray(r.data.matches)) return;
      state.hsv = r.data.matches;
      lsSet(HSV_KEY, { at: Date.now(), matches: state.hsv });
      if ((state.tab === 'kalender' || state.tab === 'start') && !document.querySelector('.modal-backdrop')) render();
    })
    .catch(() => {})
    .finally(() => { state.hsvLoading = null; });
  return state.hsvLoading;
}
function hsvOnDay(day) {
  if (!hsvEnabled() || !state.hsv) return [];
  const t = day.getTime();
  return state.hsv.filter((m) => startOfDay(new Date(m.kickoff)).getTime() === t);
}
const hsvOpponent = (m) => (m.isHome ? m.away : m.home);
const hsvTitle = (m) => `${m.home} – ${m.away}`;
function hsvShort(name) {
  return String(name).replace(/^(1\. |FC |SV |VfL |VfB |TSG |SC |SG |SpVgg |FSV |Borussia |Eintracht |Hertha )/, '').replace(/ (FC|04|05|1846|1899|1900|1907|1910|09)$/, '').slice(0, 14);
}

function openHsvMatch(id) {
  const m = (state.hsv || []).find((x) => String(x.id) === String(id));
  if (!m) return;
  const when = new Date(m.kickoff).toLocaleString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const crest = (url, name) => url ? `<img src="${esc(url)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : `<span class="hsv-crest-fallback">${esc(name.slice(0, 1))}</span>`;
  openModal(
    `<div class="hsv-detail">
      <div class="hsv-head">
        <span class="hsv-tag">⚽ ${esc(m.league)}${m.round ? ` · ${esc(m.round)}` : ''}</span>
        <button class="icon-btn" data-close aria-label="Schließen">✕</button>
      </div>
      <div class="hsv-vs">
        <div class="hsv-team">${crest(m.homeIcon, m.home)}<b>${esc(m.home)}</b></div>
        <div class="hsv-score">${m.finished && m.result ? esc(m.result) : 'vs.'}</div>
        <div class="hsv-team">${crest(m.awayIcon, m.away)}<b>${esc(m.away)}</b></div>
      </div>
      <div class="ev-rows">
        <div class="ev-row"><span>🕒</span><b>${esc(when)} Uhr</b></div>
        <div class="ev-row"><span>🏟️</span><b>${m.isHome ? 'Heimspiel' : 'Auswärtsspiel'}${m.stadium ? ` · ${esc(m.stadium)}` : ''}${m.city ? `, ${esc(m.city)}` : ''}</b></div>
        ${m.finished ? '' : '<p class="hint">Anstoßzeiten können sich ändern, bis die Spiele endgültig terminiert sind – der Kalender aktualisiert sich automatisch.</p>'}
      </div>
    </div>`,
    { cls: 'hsv-modal' }
  );
}

/* ---- Monatsraster ---------------------------------------------------- */

function calState() {
  if (!state.calMonth) {
    const t = startOfDay(new Date());
    state.calMonth = new Date(t.getFullYear(), t.getMonth(), 1);
    state.calDay = t;
  }
}

function weekHtml(weekStart, month, today) {
  const weekEnd = addDays(weekStart, 6);
  const evs = state.events.filter((ev) => evStartDay(ev) <= weekEnd && evEndDay(ev) >= weekStart)
    .sort((a, b) => evStartDay(a) - evStartDay(b) || (evEndDay(b) - evStartDay(b)) - (evEndDay(a) - evStartDay(a)) || Date.parse(a.startAt) - Date.parse(b.startAt));
  // Spuren vergeben, damit mehrtägige Termine durchgehend in einer Zeile liegen
  const lanes = [];
  const laneOf = new Map();
  for (const ev of evs) {
    const s = Math.max(0, Math.round((evStartDay(ev) - weekStart) / 86400e3));
    const e = Math.min(6, Math.round((evEndDay(ev) - weekStart) / 86400e3));
    let l = lanes.findIndex((last) => last < s);
    if (l < 0) { l = lanes.length; lanes.push(-1); }
    lanes[l] = e;
    laneOf.set(ev, { l, s, e });
  }
  const MAX = 3;
  let html = '';
  for (let i = 0; i < 7; i++) {
    const day = addDays(weekStart, i);
    const cls = ['cal-cell'];
    if (day.getMonth() !== month) cls.push('other');
    if (sameDay(day, today)) cls.push('today');
    if (state.calDay && sameDay(day, state.calDay)) cls.push('selected');
    if (i >= 5) cls.push('weekend');
    const hol = holidayOn(day);
    if (hol) cls.push(hol.legal ? 'holiday' : hol.kind === 'regional' ? 'holiday-regional' : 'holiday-soft');
    const games = hsvOnDay(day);
    const here = evs.filter((ev) => { const p = laneOf.get(ev); return p.s <= i && p.e >= i; });
    let bars = '';
    for (let l = 0; l < MAX; l++) {
      const ev = here.find((x) => laneOf.get(x).l === l);
      if (!ev) { bars += '<span class="cal-bar no-ev"></span>'; continue; }
      const p = laneOf.get(ev);
      const realStart = sameDay(evStartDay(ev), day), realEnd = sameDay(evEndDay(ev), day);
      const label = realStart || i === 0;
      const span = p.e - i + 1;
      bars += `<span class="cal-bar${realStart ? ' b-start' : ''}${realEnd ? ' b-end' : ''}" style="--c:${eventColor(ev)}">${label
        ? `<span class="cal-bar-label" style="--span:${span}">${eventHeads(ev, 'bar-head')}<span>${esc(ev.title)}</span></span>` : ''}</span>`;
    }
    const more = here.filter((ev) => laneOf.get(ev).l >= MAX).length;
    html += `<button type="button" class="${cls.join(' ')}" data-day="${day.getTime()}" aria-label="${esc(day.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }))}${hol ? `, ${esc(hol.name)}` : ''}${games.length ? ', HSV-Spiel' : ''}${here.length ? `, ${here.length} Termin${here.length === 1 ? '' : 'e'}` : ''}">
      <span class="cal-num">${day.getDate()}${hol ? `<em class="cal-hol">${esc(hol.short)}</em>` : ''}</span>
      <span class="cal-bars">${bars}</span>
      ${more ? `<span class="cal-more">+${more}</span>` : ''}
      ${games.map((g) => `<span class="cal-hsv${g.isHome ? ' home' : ''}">⚽ ${esc(formatTimeOnly(g.kickoff))}</span>`).join('')}
    </button>`;
  }
  return html;
}

function dayPanelHtml() {
  const day = state.calDay;
  const list = eventsOnDay(day);
  const hols = holidaysOn(day);
  const games = hsvOnDay(day);
  const label = day.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return `<section class="cal-info">
    <div class="cal-info-head"><span class="cal-info-tag">INFO</span><span>${esc(label)}</span></div>
    <div class="cal-info-body">
      ${hols.map((h) => `<div class="day-hol k-${h.kind}"><span>${h.emoji}</span><b>${esc(h.name)}</b><small>${esc(HOLIDAY_KIND[h.kind])} · ${esc(h.note)}</small></div>`).join('')}
      ${games.map((g) => `<button type="button" class="day-hsv${g.isHome ? ' home' : ''}" data-hsv="${esc(g.id)}">
        <span class="day-hsv-ball">⚽</span>
        <span class="day-ev-time">${esc(formatTimeOnly(g.kickoff))}</span>
        <span class="day-ev-main"><b>${esc(hsvTitle(g))}</b><small>${esc(g.league)}${g.round ? ` · ${esc(g.round)}` : ''} · ${g.isHome ? 'Heimspiel' : 'Auswärts'}${g.finished && g.result ? ` · ${esc(g.result)}` : ''}</small></span>
      </button>`).join('')}
      ${list.length ? list.map((ev) => {
        const inv = myInvite(ev);
        return `<button type="button" class="day-ev" data-event="${esc(ev.id)}" style="--c:${eventColor(ev)}">
          <span class="day-ev-heads">${eventHeads(ev)}</span>
          <span class="day-ev-time">${esc(eventTimeOnDay(ev, day))}</span>
          <span class="day-ev-main"><b>${esc(ev.title)}</b>${ev.location ? `<small>📍 ${esc(ev.location)}</small>` : ''}</span>
          ${inv && inv.status === 'pending' ? '<span class="day-ev-badge">Einladung</span>' : ''}
        </button>`;
      }).join('') : (games.length ? '' : '<p class="cal-empty">Keine Termine an diesem Tag.</p>')}
      <button type="button" class="cal-add" id="cal-add">＋ Termin am ${esc(day.toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric' }))}</button>
    </div>
  </section>`;
}

function renderCalendar(view) {
  if (!state.me) { view.innerHTML = ''; return; }
  if (!state.eventsLoaded) {
    view.innerHTML = loaderHtml('Kalender wird geladen …');
    loadEvents().then(render).catch((e) => toast(e.message));
    return;
  }
  calState();
  if (hsvEnabled() && !state.hsvRequested) { state.hsvRequested = true; loadHsv(); }
  const m = state.calMonth;
  const today = startOfDay(new Date());
  const first = new Date(m.getFullYear(), m.getMonth(), 1);
  const gridStart = addDays(first, -((first.getDay() + 6) % 7));
  const last = new Date(m.getFullYear(), m.getMonth() + 1, 0);
  const weeks = Math.ceil((((first.getDay() + 6) % 7) + last.getDate()) / 7);
  let grid = '';
  for (let w = 0; w < weeks; w++) grid += weekHtml(addDays(gridStart, w * 7), m.getMonth(), today);
  const title = m.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
  view.innerHTML = `<div class="cal-page">
    <div class="cal-dex">
      <div class="cal-head">
        <button type="button" class="cal-nav" data-month="-1" aria-label="Vorheriger Monat">◀</button>
        <h2 class="cal-title">${esc(title)}</h2>
        <button type="button" class="cal-nav" data-month="1" aria-label="Nächster Monat">▶</button>
      </div>
      <div class="cal-week">${WEEKDAYS.map((d, i) => `<span${i >= 5 ? ' class="weekend"' : ''}>${d}</span>`).join('')}</div>
      <div class="cal-grid" id="cal-grid">${grid}</div>
      <div class="cal-foot">
        <span class="cal-legend">${['m', 'w', 'both'].map((g) => `<span style="--c:${GENDER_COLORS[g]}">${g === 'both' ? `<img src="${CAL_HEADS.m}" alt=""><img src="${CAL_HEADS.w}" alt="">` : `<img src="${CAL_HEADS[g]}" alt="">`}${GENDER_NAMES[g]}</span>`).join('')}${hsvEnabled() ? '<span class="leg-hsv">⚽ HSV</span>' : ''}<span class="leg-hol">Feiertag</span></span>
        <button type="button" class="cal-today" id="cal-today">Heute</button>
      </div>
    </div>
    ${dayPanelHtml()}
  </div>`;

  view.querySelectorAll('[data-month]').forEach((b) => b.addEventListener('click', () => shiftMonth(Number(b.dataset.month))));
  $('#cal-today', view).addEventListener('click', () => {
    const t = startOfDay(new Date());
    state.calMonth = new Date(t.getFullYear(), t.getMonth(), 1);
    state.calDay = t;
    render();
  });
  view.querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', () => {
    const d = new Date(Number(b.dataset.day));
    if (state.calDay && sameDay(d, state.calDay)) { openEventForm({ day: d }); return; } // zweites Tippen → neuer Termin
    state.calDay = d;
    if (d.getMonth() !== state.calMonth.getMonth()) state.calMonth = new Date(d.getFullYear(), d.getMonth(), 1);
    render();
  }));
  $('#cal-add', view).addEventListener('click', () => openEventForm({ day: state.calDay }));
  view.querySelectorAll('[data-event]').forEach((b) => b.addEventListener('click', () => openEventDetail(b.dataset.event)));
  view.querySelectorAll('[data-hsv]').forEach((b) => b.addEventListener('click', () => openHsvMatch(b.dataset.hsv)));
  // Wischen wechselt den Monat
  const grid2 = $('#cal-grid', view);
  let sx = null, sy = null;
  grid2.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  grid2.addEventListener('touchend', (e) => {
    if (sx == null) return;
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    sx = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) shiftMonth(dx < 0 ? 1 : -1);
  });
}

function shiftMonth(n) {
  const m = state.calMonth;
  state.calMonth = new Date(m.getFullYear(), m.getMonth() + n, 1);
  const sel = state.calDay;
  if (!sel || sel.getMonth() !== state.calMonth.getMonth() || sel.getFullYear() !== state.calMonth.getFullYear()) {
    const t = startOfDay(new Date());
    state.calDay = t.getMonth() === state.calMonth.getMonth() && t.getFullYear() === state.calMonth.getFullYear() ? t : state.calMonth;
  }
  render();
}

/* ---- Termin anlegen / bearbeiten ------------------------------------ */

const toDateInput = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function reminderRowHtml(allDay, spec = null) {
  const opts = allDay ? REMINDERS_ALLDAY : REMINDERS_TIMED;
  const v = spec ? specToValue(spec) : 'none';
  return `<div class="rem-row">
    <select class="rem-sel" aria-label="Hinweis">${opts.map(([k, l]) => `<option value="${k}"${k === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
    <input type="datetime-local" class="rem-at dt"${spec && spec.k === 'custom' ? ` value="${toLocalInput(new Date(spec.at))}"` : ' hidden'} aria-label="Hinweis am">
    <button type="button" class="rem-del" aria-label="Hinweis entfernen">✕</button>
  </div>`;
}

function openEventForm({ day = null, event = null } = {}) {
  const ev = event;
  const base = day || startOfDay(new Date());
  const now = new Date();
  let start, end;
  if (ev) { start = new Date(ev.startAt); end = new Date(ev.endAt); } else {
    start = new Date(base.getFullYear(), base.getMonth(), base.getDate(), sameDay(base, startOfDay(now)) ? Math.min(now.getHours() + 1, 23) : 10, 0);
    end = new Date(start.getTime() + 3600e3);
  }
  const allDay = ev ? ev.allDay : false;
  const invited = ev ? invitesOf(ev).map((i) => i.userId) : [];
  const others = state.users.filter((u) => u.id !== state.me.id);
  const rems = ev && ev.reminders.length ? ev.reminders : [null];

  openModal(
    `<div class="modal-head ev-form-head"><h2>${ev ? 'Termin bearbeiten' : 'Neuer Termin'}</h2><button class="icon-btn" data-close aria-label="Schließen">✕</button></div>
     <form class="form" id="ev-form" novalidate>
       <label class="field"><span>Titel</span><input name="title" maxlength="120" required placeholder="z. B. Zahnarzt" value="${esc(ev ? ev.title : '')}"></label>
       <label class="field"><span>Ort</span><input name="location" maxlength="200" placeholder="optional" value="${esc(ev ? ev.location : '')}"></label>
       <div class="toggle-row"><span>Ganztägig</span>${switchToggle('allDay', allDay)}</div>
       <div class="ev-times">
         <label class="field"><span>Beginn</span><input name="start" class="dt" type="${allDay ? 'date' : 'datetime-local'}" value="${allDay ? toDateInput(start) : toLocalInput(start)}"></label>
         <label class="field"><span>Ende</span><input name="end" class="dt" type="${allDay ? 'date' : 'datetime-local'}" value="${allDay ? toDateInput(end) : toLocalInput(end)}"></label>
       </div>
       <label class="field"><span>Beschreibung</span><textarea name="description" maxlength="4000" placeholder="optional">${esc(ev ? ev.description : '')}</textarea></label>
       ${others.length ? `<div class="field"><span>Einladen</span>
         <div class="ev-invite">${others.map((u) => `<label class="ev-inv" style="--c:${GENDER_COLORS[u.gender] || GENDER_COLORS.both}">
           <input type="checkbox" name="invite" value="${esc(u.id)}"${invited.includes(u.id) ? ' checked' : ''}>
           <span>${u.gender && CAL_HEADS[u.gender] ? `<img src="${CAL_HEADS[u.gender]}" alt="">` : ''}${esc(u.firstName)}</span></label>`).join('')}</div>
         <p class="hint">Eingeladene bekommen die Einladung auf ihren Start-Bildschirm. Nach der Zusage gelten die Hinweise auch für sie.</p>
       </div>` : ''}
       <div class="field"><span>Hinweise</span>
         <div class="rem-list" id="rem-list">${rems.map((r) => reminderRowHtml(allDay, r)).join('')}</div>
         <button type="button" class="btn small rem-add" id="rem-add">＋ Hinweis</button>
         <p class="hint">Hinweise kommen als Benachrichtigung der App – für dich und alle, die zugesagt haben.</p>
       </div>
       <p class="error" id="ev-error"></p>
       <div class="modal-actions">
         ${ev ? '<button type="button" class="btn danger" id="ev-delete">Löschen</button>' : ''}
         <button type="button" class="btn" data-close>Abbrechen</button>
         <button type="submit" class="btn primary">${ev ? 'Speichern' : 'Anlegen'}</button>
       </div>
     </form>`,
    {
      onMount: (modal, close) => {
        const form = $('#ev-form', modal);
        const remList = $('#rem-list', modal);
        const isAllDay = () => form.elements.allDay.checked;
        const readStart = () => {
          const v = form.elements.start.value;
          if (!v) return null;
          return isAllDay() ? new Date(`${v}T00:00:00`) : new Date(v);
        };
        const syncCustomMax = () => {
          const s = readStart();
          remList.querySelectorAll('.rem-at').forEach((i) => { if (s) i.max = toLocalInput(s); });
        };
        const syncRows = () => {
          remList.querySelectorAll('.rem-row').forEach((row) => {
            row.querySelector('.rem-at').hidden = row.querySelector('.rem-sel').value !== 'custom';
            row.querySelector('.rem-del').hidden = remList.children.length <= 1;
          });
          $('#rem-add', modal).hidden = remList.children.length >= 6;
          syncCustomMax();
        };
        form.elements.allDay.addEventListener('change', () => {
          const s = readStart() || base;
          const eRaw = form.elements.end.value;
          const e = eRaw ? (form.elements.end.type === 'date' ? new Date(`${eRaw}T00:00:00`) : new Date(eRaw)) : s;
          const ad = isAllDay();
          form.elements.start.type = ad ? 'date' : 'datetime-local';
          form.elements.end.type = ad ? 'date' : 'datetime-local';
          if (ad) { form.elements.start.value = toDateInput(s); form.elements.end.value = toDateInput(e); } else {
            const st = new Date(s.getFullYear(), s.getMonth(), s.getDate(), 10, 0);
            form.elements.start.value = toLocalInput(st);
            form.elements.end.value = toLocalInput(new Date(Math.max(st.getTime() + 3600e3, new Date(e.getFullYear(), e.getMonth(), e.getDate(), 11, 0).getTime())));
          }
          // Hinweise auf die passenden Auswahlmöglichkeiten umstellen
          const n = remList.children.length;
          remList.innerHTML = Array.from({ length: n }, () => reminderRowHtml(ad)).join('');
          syncRows();
        });
        // Ende nie vor dem Beginn
        form.elements.start.addEventListener('change', () => {
          const s = readStart();
          if (!s) return;
          const eRaw = form.elements.end.value;
          const e = eRaw ? (isAllDay() ? new Date(`${eRaw}T00:00:00`) : new Date(eRaw)) : null;
          if (!e || e < s) form.elements.end.value = isAllDay() ? toDateInput(s) : toLocalInput(new Date(s.getTime() + 3600e3));
          syncCustomMax();
        });
        remList.addEventListener('change', (e) => {
          if (e.target.classList.contains('rem-sel')) {
            const row = e.target.closest('.rem-row');
            const at = row.querySelector('.rem-at');
            if (e.target.value === 'custom' && !at.value) {
              const s = readStart() || new Date();
              at.value = toLocalInput(new Date(s.getTime() - 3600e3));
            }
            syncRows();
          }
        });
        remList.addEventListener('click', (e) => {
          const del = e.target.closest('.rem-del');
          if (del) { del.closest('.rem-row').remove(); syncRows(); }
        });
        $('#rem-add', modal).addEventListener('click', () => {
          remList.insertAdjacentHTML('beforeend', reminderRowHtml(isAllDay()));
          syncRows();
        });
        syncRows();
        const delBtn = $('#ev-delete', modal);
        if (delBtn) delBtn.addEventListener('click', async () => {
          if (!(await dsAsk('Diesen Termin wirklich löschen? Eingeladene sehen ihn dann auch nicht mehr.', { yes: 'Löschen', danger: true }))) return;
          try {
            must(await sb.from('events').delete().eq('id', ev.id));
            state.events = state.events.filter((x) => x.id !== ev.id);
            close();
            render();
            toast('🗑️ Termin gelöscht.');
          } catch (ex) { toast(ex.message); }
        });
        if (!ev && !isIos) form.elements.title.focus();

        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const err = $('#ev-error', modal);
          err.textContent = '';
          const title = form.elements.title.value.trim();
          if (!title) { err.textContent = 'Bitte einen Titel angeben.'; return; }
          const ad = isAllDay();
          const sv = form.elements.start.value, evv = form.elements.end.value;
          if (!sv || !evv) { err.textContent = 'Bitte Beginn und Ende angeben.'; return; }
          const s = ad ? new Date(`${sv}T00:00:00`) : new Date(sv);
          const en = ad ? new Date(`${evv}T23:59:59`) : new Date(evv);
          if (en < s) { err.textContent = 'Das Ende liegt vor dem Beginn.'; return; }
          const reminders = [];
          for (const row of remList.querySelectorAll('.rem-row')) {
            const v = row.querySelector('.rem-sel').value;
            if (v === 'none') continue;
            if (v === 'custom') {
              const at = row.querySelector('.rem-at').value;
              if (!at) { err.textContent = 'Bitte für den benutzerdefinierten Hinweis Datum und Uhrzeit wählen.'; return; }
              const atD = new Date(at);
              if (atD > s) { err.textContent = 'Ein Hinweis darf nicht nach dem Beginn des Termins liegen.'; return; }
              reminders.push({ k: 'custom', at: atD.toISOString() });
            } else if (v.startsWith('o:')) reminders.push({ k: 'offset', m: Number(v.slice(2)) });
            else if (v.startsWith('d:')) reminders.push({ k: 'day', d: Number(v.slice(2)) });
          }
          const unique = [...new Map(reminders.map((r) => [JSON.stringify(r), r])).values()];
          const invitees = [...form.querySelectorAll('[name=invite]:checked')].map((i) => i.value);
          const btn = form.querySelector('[type=submit]');
          btn.disabled = true;
          try {
            const row = must(await sb.rpc('save_event', {
              p_id: ev ? ev.id : null, p_title: title, p_location: form.elements.location.value,
              p_description: form.elements.description.value.trim(), p_all_day: ad,
              p_start: s.toISOString(), p_end: en.toISOString(), p_reminders: unique, p_invitees: invitees,
            }));
            const saved = mapEvent(row);
            upsertBy(state.events, saved);
            await loadEvents().catch(() => {});
            const fresh = invitees.filter((id) => !invited.includes(id));
            if (fresh.length || ev) invokeQuiet({ action: 'event', eventId: saved.id, invited: fresh, changed: Boolean(ev) });
            close();
            state.calDay = startOfDay(s);
            state.calMonth = new Date(s.getFullYear(), s.getMonth(), 1);
            render();
            if (ev) toast('📅 Termin gespeichert.'); else catchAnimation(fresh.length ? 'Termin & Einladung raus!' : 'Termin eingetragen!');
          } catch (ex) {
            err.textContent = ex.message;
            btn.disabled = false;
          }
        });
      },
    }
  );
}

/* ---- Termin ansehen -------------------------------------------------- */

const INVITE_STATUS = { pending: '⏳ Eingeladen – Antwort offen', accepted: '✅ Zugesagt', declined: '❌ Abgesagt' };

function eventDetailHtml(ev) {
  const owner = userById(ev.ownerId);
  const mine = ev.ownerId === state.me.id;
  const inv = myInvite(ev);
  const comments = state.eventComments.filter((c) => c.eventId === ev.id);
  return `<div class="ev-detail" style="--c:${eventColor(ev)}">
    <div class="ev-banner">
      <div class="ev-banner-sprites">${eventSprites(ev)}</div>
      <div class="ev-banner-text">
        <span class="ev-tag">📅 TERMIN · ${esc(GENDER_NAMES[eventGenders(ev).length > 1 ? 'both' : eventGenders(ev)[0] || 'both'])}</span>
        <h2>${esc(ev.title)}</h2>
      </div>
      <button class="icon-btn" data-close aria-label="Schließen">✕</button>
    </div>
    <div class="ev-rows">
      <div class="ev-row"><span>🕒</span><b>${esc(eventTimeText(ev))}</b></div>
      ${ev.location ? `<div class="ev-row"><span>📍</span><b>${esc(ev.location)}</b></div>` : ''}
      ${ev.description ? `<div class="ev-row"><span>📝</span><p>${esc(ev.description)}</p></div>` : ''}
      <div class="ev-row"><span>👤</span><div class="ev-people">
        <div>${owner ? esc(fullName(owner)) : 'Unbekannt'} <small>· Ersteller</small></div>
        ${invitesOf(ev).map((i) => { const u = userById(i.userId); return `<div>${esc(u ? fullName(u) : '?')} <small>· ${INVITE_STATUS[i.status]}</small></div>`; }).join('')}
      </div></div>
      ${ev.reminders.length ? `<div class="ev-row"><span>🔔</span><div class="ev-people">${ev.reminders.map((r) => `<div>${esc(reminderLabel(r, ev.allDay))}</div>`).join('')}
        <small class="hint">${mine || (inv && inv.status === 'accepted') ? 'Gilt auch für dich.' : 'Gilt nur für den Ersteller und alle, die zugesagt haben.'}</small></div></div>` : ''}
    </div>
    ${inv ? `<div class="ev-answer">
      ${inv.status === 'pending' ? '<span>Du bist eingeladen:</span>' : `<span>${INVITE_STATUS[inv.status]}</span>`}
      <div class="ev-answer-btns">
        ${inv.status !== 'accepted' ? `<button type="button" class="btn primary" data-respond="1">✅ Zusagen</button>` : ''}
        ${inv.status !== 'declined' ? `<button type="button" class="btn" data-respond="0">❌ Absagen</button>` : ''}
      </div>
    </div>` : ''}
    <div class="ev-comments">
      <h3>Kommentare</h3>
      ${comments.length ? comments.map((c) => { const u = userById(c.authorId); const own = c.authorId === state.me.id; return `<div class="comment${own ? ' own' : ''}">
        <span class="c-head"><b>${esc(u ? u.firstName : '?')}</b> · <span>${esc(relative(c.createdAt))}</span>${own ? ` <button class="c-del" data-del-ev-comment="${esc(c.id)}" aria-label="Kommentar löschen">✕</button>` : ''}</span>
        <p>${esc(c.body)}</p></div>`; }).join('') : '<p class="hint">Noch keine Kommentare.</p>'}
      <form class="comment-form" id="ev-comment-form">
        <input name="body" maxlength="1000" placeholder="Kommentar schreiben …" autocomplete="off" aria-label="Kommentar">
        <button class="btn small primary" type="submit">Senden</button>
      </form>
    </div>
    ${mine ? '<div class="modal-actions"><button type="button" class="btn danger" id="ev-del">Löschen</button><button type="button" class="btn primary" id="ev-edit">✏️ Bearbeiten</button></div>' : ''}
  </div>`;
}

function openEventById(id) {
  const go = () => (state.events.some((e) => e.id === id) ? openEventDetail(id) : toast('Diesen Termin gibt es nicht mehr.'));
  if (state.eventsLoaded) go(); else loadEvents().then(go).catch((e) => toast(e.message));
}

function openEventDetail(id) {
  const ev = state.events.find((e) => e.id === id);
  if (!ev) return;
  openModal(eventDetailHtml(ev), {
    cls: 'ev-modal',
    onMount: (modal, close) => {
      const bind = () => {
        const cur = state.events.find((e) => e.id === id);
        if (!cur) { close(); return; }
        const edit = $('#ev-edit', modal);
        if (edit) edit.addEventListener('click', () => { close(); openEventForm({ event: cur }); });
        const del = $('#ev-del', modal);
        if (del) del.addEventListener('click', async () => {
          if (!(await dsAsk('Diesen Termin wirklich löschen? Eingeladene sehen ihn dann auch nicht mehr.', { yes: 'Löschen', danger: true }))) return;
          try {
            must(await sb.from('events').delete().eq('id', cur.id));
            state.events = state.events.filter((x) => x.id !== cur.id);
            close(); render(); toast('🗑️ Termin gelöscht.');
          } catch (ex) { toast(ex.message); }
        });
        modal.querySelectorAll('[data-respond]').forEach((b) => b.addEventListener('click', () => respondEvent(cur.id, b.dataset.respond === '1', b)));
        modal.querySelectorAll('[data-del-ev-comment]').forEach((b) => b.addEventListener('click', async () => {
          try {
            must(await sb.from('event_comments').delete().eq('id', b.dataset.delEvComment));
            state.eventComments = state.eventComments.filter((c) => c.id !== b.dataset.delEvComment);
            refresh();
          } catch (ex) { toast(ex.message); }
        }));
        const form = $('#ev-comment-form', modal);
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const body = form.elements.body.value.trim();
          if (!body) return;
          form.querySelector('button').disabled = true;
          try {
            const row = must(await sb.from('event_comments').insert({ event_id: cur.id, body }).select().single());
            state.eventComments.push({ id: row.id, eventId: row.event_id, authorId: row.author_id, body: row.body, createdAt: row.created_at });
            invokeQuiet({ action: 'eventComment', commentId: row.id });
            refresh();
            $('#ev-comment-form input', modal).focus();
          } catch (ex) { toast(ex.message); form.querySelector('button').disabled = false; }
        });
      };
      const refresh = () => {
        const cur = state.events.find((e) => e.id === id);
        if (!cur) { close(); return; }
        modal.innerHTML = eventDetailHtml(cur);
        bind();
      };
      modal.addEventListener('event-remote', refresh);
      bind();
    },
  });
}

async function respondEvent(id, accept, btn) {
  if (btn) btn.disabled = true;
  try {
    const r = must(await sb.rpc('respond_event', { p_event: id, p_accept: accept }));
    const i = state.invites.find((x) => x.eventId === id && x.userId === state.me.id);
    if (i) { i.status = r.status; i.respondedAt = r.responded_at; }
    invokeQuiet({ action: 'eventResponse', eventId: id });
    toast(accept ? '✅ Zugesagt – der Termin steht jetzt auch in deinem Kalender.' : '❌ Abgesagt.');
    render();
    document.querySelectorAll('.modal.ev-modal').forEach((m) => m.dispatchEvent(new Event('event-remote')));
  } catch (e) {
    toast(e.message);
    if (btn) btn.disabled = false;
  }
}

/* ---- Termine auf der Startseite -------------------------------------- */

/** In welchen Start-Bereich gehört ein Termin? (null = nicht auf Start) */
function eventSection(ev, now = new Date()) {
  const t = now.getTime();
  const today = startOfDay(now);
  const tomorrow = addDays(today, 1), dayAfter = addDays(today, 2);
  const weekEnd = addDays(today, 7 - ((today.getDay() + 6) % 7));
  const s = Date.parse(ev.startAt), e = Date.parse(ev.endAt);
  const sd = evStartDay(ev).getTime(), ed = evEndDay(ev).getTime();
  if (e < t && !(ev.allDay && ed >= today.getTime())) return null;      // vorbei
  if (sd < today.getTime() && ed >= tomorrow.getTime()) return 'laufend'; // läuft über mehrere Tage
  if (sd <= today.getTime() && ed >= today.getTime()) return 'heute';
  if (s >= tomorrow.getTime() && s < dayAfter.getTime()) return 'morgen';
  if (s >= dayAfter.getTime() && s < weekEnd.getTime()) return 'woche';
  return null;
}

function eventCardHtml(ev) {
  const inv = myInvite(ev);
  const comments = state.eventComments.filter((c) => c.eventId === ev.id).length;
  const pendingOthers = invitesOf(ev).filter((i) => i.status === 'pending').length;
  return `<article class="ev-card" data-event-card="${esc(ev.id)}" tabindex="0" style="--c:${eventColor(ev)}">
    <div class="ev-card-side">${eventHeads(ev, 'ev-card-head')}</div>
    <div class="ev-card-body">
      <span class="ev-tag">📅 TERMIN</span>
      <h3>${esc(ev.title)}</h3>
      <div class="ev-card-meta">
        <span>🕒 ${esc(eventTimeText(ev, true))}</span>
        ${ev.location ? `<span>📍 ${esc(ev.location)}</span>` : ''}
        ${inv && inv.status === 'accepted' ? '<span>✅ Du hast zugesagt</span>' : ''}
        ${pendingOthers && ev.ownerId === state.me.id ? `<span>⏳ ${pendingOthers} Antwort${pendingOthers === 1 ? '' : 'en'} offen</span>` : ''}
        ${comments ? `<span>💬 ${comments}</span>` : ''}
      </div>
    </div>
  </article>`;
}

function invitationCardsHtml() {
  if (!state.me) return '';
  const now = Date.now();
  const list = state.invites.filter((i) => i.userId === state.me.id && i.status === 'pending')
    .map((i) => state.events.find((e) => e.id === i.eventId))
    .filter((ev) => ev && Date.parse(ev.endAt) > now);
  if (!list.length) return '';
  return `<section class="invites">${list.map((ev) => {
    const owner = userById(ev.ownerId);
    return `<article class="invite-card" style="--c:${eventColor(ev)}">
      <div class="invite-top"><span class="invite-stamp">📨 EINLADUNG</span><span>von ${esc(owner ? owner.firstName : '?')}</span></div>
      <button type="button" class="invite-main" data-event-card="${esc(ev.id)}">
        <span class="invite-heads">${eventHeads(ev, 'ev-card-head')}</span>
        <span><b>${esc(ev.title)}</b><small>🕒 ${esc(eventTimeText(ev))}${ev.location ? ` · 📍 ${esc(ev.location)}` : ''}</small></span>
      </button>
      <div class="invite-btns">
        <button type="button" class="btn primary" data-invite-accept="${esc(ev.id)}">✅ Zusagen</button>
        <button type="button" class="btn" data-invite-decline="${esc(ev.id)}">❌ Absagen</button>
      </div>
    </article>`;
  }).join('')}</section>`;
}

function bindEventCards(view) {
  view.querySelectorAll('[data-event-card]').forEach((el) => {
    const open = () => openEventDetail(el.dataset.eventCard);
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  });
  view.querySelectorAll('[data-invite-accept]').forEach((b) => b.addEventListener('click', () => respondEvent(b.dataset.inviteAccept, true, b)));
  view.querySelectorAll('[data-invite-decline]').forEach((b) => b.addEventListener('click', () => respondEvent(b.dataset.inviteDecline, false, b)));
}

/* -------------------------------------------------------------------------
 * Notizen
 *  – eigene & gemeinsame Notizen (ein-/ausklappbar)
 *  – Überschrift, formatierter Text (Farbe, fett, unterstrichen, Aufzählung)
 *  – mit dem Finger malen
 *  – Briefpapier als Hintergrund
 *  – oben am Bildschirm: „Hochladen“, danach „Benachrichtigen“
 * ---------------------------------------------------------------------- */

const NOTE_COLORS = [
  { c: '#26262b', name: 'Schwarz' }, { c: '#d63b3b', name: 'Rot' }, { c: '#2f6fd8', name: 'Blau' },
  { c: '#2e9e55', name: 'Grün' }, { c: '#e8772e', name: 'Orange' }, { c: '#8a45c4', name: 'Lila' },
];

/* ---- Briefpapier (eigene Muster, angelehnt an die Briefe aus Platin) ---- */

const svgTile = (w, h, body) => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'>${body}</svg>`)}")`;

const PAPERS = [
  { key: 'schlicht', name: 'Schlicht', frame: '#e9e2cf', sheet: '#fffdf6', line: '#d8e3f0', tile: svgTile(20, 20, "<circle cx='10' cy='10' r='1.4' fill='#cfc4a6'/>") },
  { key: 'wiese', name: 'Wiesenbrief', frame: '#8fd16a', sheet: '#f6fdee', line: '#cfe9bb', tile: svgTile(40, 40,
    "<path d='M6 40C7 30 4 24 2 18M6 40C8 31 12 27 15 22M24 40c1-9-2-15-5-20M24 40c2-8 6-12 10-15M34 40c0-6 1-9 4-13' stroke='#3f9a3a' stroke-width='2.4' fill='none' stroke-linecap='round'/><circle cx='30' cy='10' r='3' fill='#f7e15a'/><circle cx='12' cy='6' r='2' fill='#fff'/>") },
  { key: 'flamme', name: 'Flammenbrief', frame: '#f6a04d', sheet: '#fff7ee', line: '#f6d8bd', tile: svgTile(40, 40,
    "<path d='M12 36c-6-4-6-11-1-16 0 4 2 5 3 5-1-6 3-10 6-12-1 5 3 8 3 13 1-1 2-3 2-5 4 5 3 12-3 15z' fill='#e2462a'/><path d='M15 35c-2-2-2-6 1-8 0 2 1 3 2 3 0-3 2-5 3-6 0 3 2 4 2 7 0 2-2 4-4 5z' fill='#ffd23f'/><circle cx='33' cy='8' r='2' fill='#ffd23f'/>") },
  { key: 'blase', name: 'Blasenbrief', frame: '#7cc6f0', sheet: '#f1f9ff', line: '#c8e3f6', tile: svgTile(40, 40,
    "<circle cx='11' cy='12' r='7' fill='#e8f6ff' stroke='#3b8fd0' stroke-width='1.6'/><circle cx='8.5' cy='9.5' r='2' fill='#fff'/><circle cx='29' cy='28' r='5' fill='#e8f6ff' stroke='#3b8fd0' stroke-width='1.4'/><circle cx='27.5' cy='26.5' r='1.4' fill='#fff'/><circle cx='31' cy='9' r='2.5' fill='none' stroke='#3b8fd0' stroke-width='1.2'/>") },
  { key: 'bluete', name: 'Blütenbrief', frame: '#f6b8d2', sheet: '#fff6fa', line: '#f5d5e2', tile: svgTile(40, 40,
    "<g transform='translate(12 12)'><circle r='4' cx='0' cy='-5' fill='#f07aa8'/><circle r='4' cx='5' cy='0' fill='#f07aa8'/><circle r='4' cx='0' cy='5' fill='#f07aa8'/><circle r='4' cx='-5' cy='0' fill='#f07aa8'/><circle r='2.6' fill='#ffe066'/></g><g transform='translate(30 30) scale(.65)'><circle r='4' cx='0' cy='-5' fill='#fff'/><circle r='4' cx='5' cy='0' fill='#fff'/><circle r='4' cx='0' cy='5' fill='#fff'/><circle r='4' cx='-5' cy='0' fill='#fff'/><circle r='2.6' fill='#ffb347'/></g>") },
  { key: 'tunnel', name: 'Tunnelbrief', frame: '#a98564', sheet: '#fbf6f0', line: '#e5d6c6', tile: svgTile(40, 40,
    "<path d='M3 14l6-7 9 2 3 8-7 6-9-2z' fill='#7d5d42' stroke='#5c4230' stroke-width='1.2'/><path d='M24 30l5-6 8 1 2 7-6 5-7-2z' fill='#8e6c4f' stroke='#5c4230' stroke-width='1.2'/><circle cx='30' cy='9' r='2' fill='#5c4230'/>") },
  { key: 'stahl', name: 'Stahlbrief', frame: '#a9b1bc', sheet: '#f7f8fa', line: '#dde2e8', tile: svgTile(40, 40,
    "<rect x='1' y='1' width='38' height='38' fill='none' stroke='#7d8794' stroke-width='1'/><circle cx='7' cy='7' r='2.6' fill='#e4e8ee' stroke='#59626e' stroke-width='1.2'/><circle cx='33' cy='33' r='2.6' fill='#e4e8ee' stroke='#59626e' stroke-width='1.2'/><path d='M14 26l12-12' stroke='#59626e' stroke-width='1.6'/>") },
  { key: 'herz', name: 'Herzbrief', frame: '#f58fa8', sheet: '#fff5f7', line: '#f7d3dc', tile: svgTile(40, 40,
    "<path d='M12 18c-6-4-8-7-8-10a4 4 0 0 1 8-1 4 4 0 0 1 8 1c0 3-2 6-8 10z' fill='#e23d6b'/><path d='M30 34c-4-3-6-5-6-7a3 3 0 0 1 6-1 3 3 0 0 1 6 1c0 2-2 4-6 7z' fill='#fff'/>") },
  { key: 'schnee', name: 'Schneebrief', frame: '#b9e1f5', sheet: '#f8fcff', line: '#d9ebf6', tile: svgTile(40, 40,
    "<g stroke='#4aa3d6' stroke-width='1.6' stroke-linecap='round'><path d='M12 4v16M5 8l14 8M5 16l14-8'/><path d='M30 24v10M25.7 26.5l8.6 5M25.7 31.5l8.6-5' stroke='#fff'/></g>") },
  { key: 'stern', name: 'Sternbrief', frame: '#33407a', sheet: '#f7f7ff', line: '#d9dbf2', tile: svgTile(40, 40,
    "<path d='M12 4l2.4 5 5.6.8-4 3.9 1 5.5-5-2.6-5 2.6 1-5.5-4-3.9 5.6-.8z' fill='#ffd84a'/><circle cx='31' cy='29' r='1.8' fill='#fff'/><circle cx='34' cy='12' r='1.2' fill='#cfd6ff'/><circle cx='22' cy='35' r='1' fill='#fff'/>") },
  { key: 'luft', name: 'Luftbrief', frame: '#9fd8f3', sheet: '#fbfeff', line: '#d6eef9', tile: svgTile(40, 40,
    "<path d='M6 16a5 5 0 0 1 9-3 4 4 0 0 1 7 2 3.5 3.5 0 0 1 0 7H8a4 4 0 0 1-2-6z' fill='#fff'/><path d='M24 32l8-4-8-4 2 4z' fill='#e85d4a'/>") },
  { key: 'mosaik', name: 'Mosaikbrief', frame: '#f2d16b', sheet: '#fffdf3', line: '#efe3b7', tile: svgTile(40, 40,
    "<rect x='2' y='2' width='16' height='16' fill='#e85d4a'/><rect x='22' y='2' width='16' height='16' fill='#4aa3d6'/><rect x='2' y='22' width='16' height='16' fill='#57b46a'/><rect x='22' y='22' width='16' height='16' fill='#fff7d6'/>") },
  { key: 'ziegel', name: 'Ziegelbrief', frame: '#c9654a', sheet: '#fff8f4', line: '#f0d5ca', tile: svgTile(40, 20,
    "<rect width='40' height='20' fill='#b4523a'/><path d='M0 .5h40M0 10h40M20 0v10M0 10v10M40 10v10' stroke='#e8c4b4' stroke-width='1.4'/>") },
];
const paperByKey = (k) => PAPERS.find((p) => p.key === k) || PAPERS[0];
function paperStyle(key) {
  const p = paperByKey(key);
  return `--frame:${p.frame};--sheet:${p.sheet};--line:${p.line};--tile:${p.tile}`;
}

/* ---- Daten ------------------------------------------------------------ */

function mapNote(r) {
  return {
    id: r.id, ownerId: r.owner_id, title: r.title || '', content: r.content || '',
    drawing: Array.isArray(r.drawing) ? r.drawing : [], paper: r.paper || 'schlicht',
    sharedWith: r.shared_with || [], updatedAt: r.updated_at, updatedBy: r.updated_by, createdAt: r.created_at,
  };
}
async function loadNotes() {
  state.notes = must(await sb.from('notes').select('*').order('updated_at', { ascending: false })).map(mapNote);
  state.notesLoaded = true;
}
const isShared = (n) => n.sharedWith.length > 0;
const noteParticipants = (n) => [n.ownerId, ...n.sharedWith];

/** Nur harmlose Formatierungen behalten (fett, unterstrichen, Farbe, Listen, Zeilen) */
function sanitizeNoteHtml(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html || '');
  const ALLOWED = new Set(['B', 'STRONG', 'U', 'I', 'EM', 'UL', 'OL', 'LI', 'BR', 'DIV', 'P', 'SPAN', 'FONT']);
  const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i;
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) continue;
      if (child.nodeType !== Node.ELEMENT_NODE || !ALLOWED.has(child.tagName)) {
        if (child.nodeType === Node.ELEMENT_NODE && !/^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED)$/.test(child.tagName)) {
          walk(child);
          child.replaceWith(...child.childNodes);
        } else child.remove();
        continue;
      }
      const color = child.tagName === 'FONT' ? child.getAttribute('color') : child.style && child.style.color;
      for (const a of [...child.attributes]) child.removeAttribute(a.name);
      if (color && COLOR.test(color.trim())) {
        if (child.tagName === 'FONT') child.setAttribute('color', color.trim());
        else child.style.color = color.trim();
      }
      walk(child);
    }
  };
  walk(tpl.content);
  return tpl.innerHTML;
}
function noteText(n) {
  const d = document.createElement('div');
  d.innerHTML = sanitizeNoteHtml(n.content.replace(/<\/?(div|p|li|ul|ol)\b[^>]*>|<br\s*\/?>/gi, ' $&'));
  return d.textContent.replace(/\s+/g, ' ').trim();
}

/* ---- Liste ------------------------------------------------------------ */

function noteCardHtml(n) {
  const text = noteText(n);
  const who = n.updatedBy ? userById(n.updatedBy) : null;
  const people = noteParticipants(n).map(userById).filter(Boolean);
  return `<button type="button" class="note-card" data-note="${esc(n.id)}" style="${esc(paperStyle(n.paper))}">
    <span class="note-card-sheet">
      <span class="note-card-title">${esc(n.title || 'Ohne Überschrift')}</span>
      <span class="note-card-text">${esc(text.slice(0, 160)) || (n.drawing.length ? '✏️ Zeichnung' : '<i>leer</i>')}</span>
      <span class="note-card-meta">
        <span>✎ <span data-rel="${esc(n.updatedAt)}">${esc(relative(n.updatedAt))}</span>${who ? ` · ${esc(who.firstName)}` : ''}${n.drawing.length && text ? ' · ✏️' : ''}</span>
        ${isShared(n) ? `<span class="note-people">${people.map((u) => `<span class="dot" style="--c:${esc(u.color)}" title="${esc(u.firstName)}"></span>`).join('')}</span>` : ''}
      </span>
    </span>
  </button>`;
}

function renderNotes(view) {
  if (!state.me) { view.innerHTML = ''; return; }
  if (!state.notesLoaded) {
    view.innerHTML = loaderHtml('Notizen werden geladen …');
    loadNotes().then(render).catch((e) => toast(e.message));
    return;
  }
  const open = lsGet('familie.noteSections', { eigene: true, gemeinsam: true });
  const own = state.notes.filter((n) => !isShared(n));
  const shared = state.notes.filter(isShared);
  const section = (key, title, list, empty) => `<section class="msg-section note-section${open[key] ? ' open' : ''}" data-sec="${key}">
    <button type="button" class="section-head" data-sec-toggle="${key}" aria-expanded="${Boolean(open[key])}">
      <span class="section-title">${title}</span><span class="section-count">${list.length}</span>
      <span class="section-chevron" aria-hidden="true">▾</span>
    </button>
    ${open[key] ? (list.length ? `<div class="note-grid">${list.map(noteCardHtml).join('')}</div>` : `<p class="hint note-empty">${empty}</p>`) : ''}
  </section>`;
  view.innerHTML = `<div class="notes">
    ${section('eigene', 'Eigene Notizen', own, 'Noch keine eigenen Notizen. Tippe auf ＋.')}
    ${section('gemeinsam', 'Gemeinsame Notizen', shared, 'Lade in einer Notiz jemanden ein – dann erscheint sie hier.')}
  </div>`;
  view.querySelectorAll('[data-sec-toggle]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.secToggle;
    open[k] = !open[k];
    lsSet('familie.noteSections', open);
    render();
  }));
  view.querySelectorAll('[data-note]').forEach((b) => b.addEventListener('click', () => openNoteEditor(b.dataset.note)));
}

function openNoteById(id) {
  const go = () => (state.notes.some((n) => n.id === id) ? openNoteEditor(id) : toast('Diese Notiz gibt es nicht mehr.'));
  if (state.notesLoaded) go(); else loadNotes().then(go).catch((e) => toast(e.message));
}

/* ---- Editor ----------------------------------------------------------- */

const draftKey = (id) => `familie.noteDraft.${id || 'neu'}`;

function openNoteEditor(id = null) {
  const note = id ? state.notes.find((n) => n.id === id) : null;
  if (id && !note) return;
  const mine = !note || note.ownerId === state.me.id;
  // Arbeitskopie (ggf. aus einem lokalen Entwurf)
  const base = note || { title: '', content: '', drawing: [], paper: 'schlicht', sharedWith: [], updatedAt: null };
  let draft = lsGet(draftKey(id), null);
  if (draft && note && draft.base !== note.updatedAt) draft = null; // inzwischen anderswo geändert
  const work = {
    title: draft ? draft.title : base.title,
    content: draft ? draft.content : base.content,
    drawing: draft ? draft.drawing : [...base.drawing],
    paper: draft ? draft.paper : base.paper,
    sharedWith: draft ? draft.sharedWith : [...base.sharedWith],
  };
  let noteId = id;
  let baseUpdatedAt = note ? note.updatedAt : null;
  let dirty = Boolean(draft) || !note;
  let uploaded = false;
  let mode = 'text';
  let color = NOTE_COLORS[0].c;
  let penWidth = 3;
  let eraser = false;

  const metaHtml = () => {
    const n = noteId && state.notes.find((x) => x.id === noteId);
    if (!n) return 'Neue Notiz – noch nicht hochgeladen';
    const who = n.updatedBy && userById(n.updatedBy);
    return `Zuletzt bearbeitet: ${formatDateTime(n.updatedAt)} Uhr${who ? ` von ${who.firstName}` : ''}`;
  };
  const peopleHtml = () => {
    const people = [mine ? state.me.id : (note ? note.ownerId : state.me.id), ...work.sharedWith].map(userById).filter(Boolean);
    return work.sharedWith.length
      ? `👥 Gemeinsam mit ${people.filter((u) => u.id !== state.me.id).map((u) => esc(u.firstName)).join(', ')}`
      : '🔒 Nur für dich';
  };

  openModal(
    `<header class="note-topbar">
       <button type="button" class="note-tb-btn" id="note-close" aria-label="Zurück">‹</button>
       <span class="note-tb-title">Notiz</span>
       <button type="button" class="note-tb-btn upload" id="note-upload">⬆️ Hochladen</button>
       <button type="button" class="note-tb-btn notify" id="note-notify" disabled>🔔 Benachrichtigen</button>
     </header>
     <div class="note-editor">
       <input class="note-title" id="note-title" maxlength="120" placeholder="Überschrift" value="${esc(work.title)}">
       <div class="note-meta"><span id="note-meta">${esc(metaHtml())}</span> · <span id="note-people">${peopleHtml()}</span></div>
       <div class="note-tools" role="toolbar" aria-label="Werkzeuge">
         <div class="seg" role="group" aria-label="Eingabe">
           <button type="button" class="tool active" data-mode="text" title="Tastatur">⌨️</button>
           <button type="button" class="tool" data-mode="draw" title="Mit dem Finger malen">✏️</button>
         </div>
         <div class="colors" role="group" aria-label="Farbe">${NOTE_COLORS.map((c, i) => `<button type="button" class="swatch-dot${i === 0 ? ' active' : ''}" data-color="${c.c}" style="--c:${c.c}" title="${c.name}" aria-label="${c.name}"></button>`).join('')}</div>
         <div class="tool-group text-tools">
           <button type="button" class="tool" data-cmd="bold" title="Fett"><b>B</b></button>
           <button type="button" class="tool" data-cmd="underline" title="Unterstreichen"><u>U</u></button>
           <button type="button" class="tool" data-cmd="insertUnorderedList" title="Aufzählung">•≡</button>
         </div>
         <div class="tool-group draw-tools" hidden>
           <button type="button" class="tool active" data-width="3" title="Dünn">✎</button>
           <button type="button" class="tool" data-width="8" title="Dick">🖌️</button>
           <button type="button" class="tool" data-eraser title="Radierer">🧽</button>
           <button type="button" class="tool" data-undo title="Rückgängig">↶</button>
         </div>
         <div class="tool-group">
           <button type="button" class="tool" data-paper title="Briefpapier">📄</button>
           ${mine ? '<button type="button" class="tool" data-invite title="Einladen">👥</button>' : ''}
           <button type="button" class="tool" data-delete title="${mine ? 'Löschen' : 'Verlassen'}">${mine ? '🗑️' : '🚪'}</button>
         </div>
       </div>
       <div class="note-paper" id="note-paper" style="${esc(paperStyle(work.paper))}">
         <div class="note-sheet" id="note-sheet">
           <div class="note-text" id="note-text" contenteditable="true" spellcheck="true" data-placeholder="Schreib los …">${sanitizeNoteHtml(work.content)}</div>
           <canvas class="note-canvas" id="note-canvas"></canvas>
         </div>
       </div>
     </div>`,
    {
      full: true,
      cls: 'note-modal',
      dismissible: false,
      onMount: (modal, close) => {
        const $m = (sel) => $(sel, modal);
        const titleEl = $m('#note-title');
        const textEl = $m('#note-text');
        const sheet = $m('#note-sheet');
        const canvas = $m('#note-canvas');
        const ctx = canvas.getContext('2d');
        const btnUp = $m('#note-upload');
        const btnNotify = $m('#note-notify');

        const syncButtons = () => {
          btnUp.disabled = !dirty;
          btnUp.textContent = dirty ? '⬆️ Hochladen' : '✓ Hochgeladen';
          btnNotify.disabled = !(uploaded && !dirty && work.sharedWith.length + (mine ? 0 : 1) > 0);
        };
        const saveDraft = () => lsSet(draftKey(noteId), { ...work, base: baseUpdatedAt });
        const markDirty = () => {
          dirty = true;
          uploaded = false;
          btnNotify.textContent = '🔔 Benachrichtigen';
          syncButtons();
          clearTimeout(markDirty.t);
          markDirty.t = setTimeout(saveDraft, 400);
        };

        /* Zeichnen */
        const ratio = () => window.devicePixelRatio || 1;
        const sizeCanvas = () => {
          const w = sheet.clientWidth;
          const maxY = work.drawing.reduce((m, s) => s.p.reduce((mm, pt) => Math.max(mm, pt[1]), m), 0) * w;
          sheet.style.minHeight = `${Math.max(window.innerHeight * 0.62, maxY + 160)}px`;
          const h = sheet.scrollHeight;
          canvas.width = Math.round(w * ratio());
          canvas.height = Math.round(h * ratio());
          canvas.style.height = `${h}px`;
          redraw();
        };
        const drawStroke = (s, w) => {
          if (!s.p.length) return;
          ctx.save();
          ctx.globalCompositeOperation = s.e ? 'destination-out' : 'source-over';
          ctx.strokeStyle = s.c || '#000';
          ctx.lineWidth = s.w * w;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.beginPath();
          ctx.moveTo(s.p[0][0] * w, s.p[0][1] * w);
          if (s.p.length === 1) ctx.lineTo(s.p[0][0] * w + 0.1, s.p[0][1] * w);
          for (let i = 1; i < s.p.length; i++) ctx.lineTo(s.p[i][0] * w, s.p[i][1] * w);
          ctx.stroke();
          ctx.restore();
        };
        function redraw() {
          const w = sheet.clientWidth;
          ctx.setTransform(ratio(), 0, 0, ratio(), 0, 0);
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          work.drawing.forEach((s) => drawStroke(s, w));
        }
        let current = null;
        const pos = (e) => {
          const r = canvas.getBoundingClientRect();
          const w = sheet.clientWidth;
          return [Math.round(((e.clientX - r.left) / w) * 10000) / 10000, Math.round(((e.clientY - r.top) / w) * 10000) / 10000];
        };
        canvas.addEventListener('pointerdown', (e) => {
          if (mode !== 'draw') return;
          e.preventDefault();
          canvas.setPointerCapture(e.pointerId);
          const w = sheet.clientWidth;
          current = { c: color, w: Math.round(((eraser ? 22 : penWidth) / w) * 10000) / 10000, p: [pos(e)] };
          if (eraser) current.e = 1;
          work.drawing.push(current);
          drawStroke(current, w);
        });
        canvas.addEventListener('pointermove', (e) => {
          if (!current) return;
          e.preventDefault();
          const p = pos(e);
          const last = current.p[current.p.length - 1];
          const w = sheet.clientWidth;
          if (Math.hypot((p[0] - last[0]) * w, (p[1] - last[1]) * w) < 1.5) return;
          current.p.push(p);
          // inkrementell zeichnen
          drawStroke({ ...current, p: [last, p] }, w);
          if (p[1] * w > sheet.clientHeight - 80) sizeCanvas();
        });
        const endStroke = () => {
          if (!current) return;
          current = null;
          markDirty();
        };
        canvas.addEventListener('pointerup', endStroke);
        canvas.addEventListener('pointercancel', endStroke);

        const setMode = (m) => {
          mode = m;
          modal.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
          $m('.text-tools').hidden = m !== 'text';
          $m('.draw-tools').hidden = m !== 'draw';
          sheet.classList.toggle('drawing', m === 'draw');
          textEl.contentEditable = m === 'text' ? 'true' : 'false';
          if (m === 'draw') textEl.blur();
        };

        /* Text */
        try { document.execCommand('styleWithCSS', false, false); } catch { /* egal */ }
        // Knöpfe zeigen an, ob fett/unterstrichen/Aufzählung gerade aktiv ist
        const syncFormatState = () => {
          if (mode !== 'text' || !textEl.contains(document.getSelection().anchorNode)) return;
          modal.querySelectorAll('[data-cmd]').forEach((b) => {
            let on = false;
            try { on = document.queryCommandState(b.dataset.cmd); } catch { /* egal */ }
            b.classList.toggle('active', on);
          });
        };
        document.addEventListener('selectionchange', syncFormatState);
        new MutationObserver(() => { if (!modal.isConnected) document.removeEventListener('selectionchange', syncFormatState); })
          .observe($('#modal-root'), { childList: true });
        textEl.addEventListener('input', () => {
          work.content = textEl.innerHTML;
          markDirty();
          if (sheet.scrollHeight > canvas.clientHeight + 4) sizeCanvas();
        });
        textEl.addEventListener('paste', (e) => {
          e.preventDefault();
          const txt = (e.clipboardData || window.clipboardData).getData('text/plain');
          document.execCommand('insertText', false, txt);
        });
        titleEl.addEventListener('input', () => { work.title = titleEl.value; markDirty(); });

        /* Werkzeugleiste */
        const tools = $m('.note-tools');
        // Fokus im Text behalten, wenn Knöpfe getippt werden
        tools.addEventListener('pointerdown', (e) => { if (mode === 'text' && e.target.closest('[data-cmd],[data-color]')) e.preventDefault(); });
        tools.addEventListener('click', (e) => {
          const b = e.target.closest('button');
          if (!b) return;
          if (b.dataset.mode) { setMode(b.dataset.mode); return; }
          if (b.dataset.color) {
            color = b.dataset.color;
            eraser = false;
            modal.querySelectorAll('[data-color]').forEach((x) => x.classList.toggle('active', x === b));
            modal.querySelectorAll('[data-eraser]').forEach((x) => x.classList.remove('active'));
            if (mode === 'text') { document.execCommand('foreColor', false, color); work.content = textEl.innerHTML; markDirty(); }
            return;
          }
          if (b.dataset.cmd) {
            if (!textEl.contains(document.getSelection().anchorNode)) textEl.focus();
            document.execCommand(b.dataset.cmd, false, null);
            work.content = textEl.innerHTML;
            markDirty();
            syncFormatState();
            return;
          }
          if (b.dataset.width) {
            penWidth = Number(b.dataset.width);
            eraser = false;
            modal.querySelectorAll('[data-width],[data-eraser]').forEach((x) => x.classList.toggle('active', x === b));
            return;
          }
          if (b.hasAttribute('data-eraser')) {
            eraser = !eraser;
            modal.querySelectorAll('[data-width]').forEach((x) => x.classList.toggle('active', !eraser && Number(x.dataset.width) === penWidth));
            b.classList.toggle('active', eraser);
            return;
          }
          if (b.hasAttribute('data-undo')) {
            if (work.drawing.length) { work.drawing.pop(); redraw(); markDirty(); }
            return;
          }
          if (b.hasAttribute('data-paper')) { pickPaper(); return; }
          if (b.hasAttribute('data-invite')) { pickPeople(); return; }
          if (b.hasAttribute('data-delete')) { removeNote(); }
        });

        const pickPaper = () => openModal(
          `<div class="modal-head"><h2>Briefpapier</h2><button class="icon-btn" data-close aria-label="Schließen">✕</button></div>
           <div class="paper-grid">${PAPERS.map((p) => `<button type="button" class="paper-opt${p.key === work.paper ? ' active' : ''}" data-key="${p.key}" style="${esc(paperStyle(p.key))}">
             <span class="paper-prev"><span></span></span><span class="paper-name">${esc(p.name)}</span></button>`).join('')}</div>`,
          {
            onMount: (m2, close2) => m2.addEventListener('click', (e) => {
              const o = e.target.closest('[data-key]');
              if (!o) return;
              work.paper = o.dataset.key;
              $m('#note-paper').setAttribute('style', paperStyle(work.paper));
              markDirty();
              close2();
            }),
          }
        );

        const pickPeople = () => {
          const others = state.users.filter((u) => u.id !== state.me.id);
          if (!others.length) { toast('Es gibt noch niemanden zum Einladen.'); return; }
          openModal(
            `<div class="modal-head"><h2>Einladen</h2><button class="icon-btn" data-close aria-label="Schließen">✕</button></div>
             <p class="hint">Eingeladene sehen und bearbeiten die Notiz. Sie wird dann zu einer gemeinsamen Notiz.</p>
             <div class="invite-list">${others.map((u) => `<label class="invite-row" style="${colorVars(u.color)}">
               <input type="checkbox" value="${esc(u.id)}" ${work.sharedWith.includes(u.id) ? 'checked' : ''}>
               <span class="mini-photo">${avatarHtml(u)}</span><span>${esc(fullName(u))}</span></label>`).join('')}</div>
             <div class="modal-actions"><button type="button" class="btn primary" id="invite-ok">Übernehmen</button></div>`,
            {
              onMount: (m2, close2) => $('#invite-ok', m2).addEventListener('click', () => {
                work.sharedWith = [...m2.querySelectorAll('input:checked')].map((i) => i.value);
                $m('#note-people').innerHTML = peopleHtml();
                markDirty();
                close2();
                toast(work.sharedWith.length ? '👥 Eingeladen – wird beim Hochladen übernommen.' : '🔒 Wieder nur für dich – wird beim Hochladen übernommen.');
              }),
            }
          );
        };

        const finish = () => { close(); render(); };
        const removeNote = async () => {
          if (!noteId) {
            if (!(await dsAsk('Diese neue Notiz verwerfen?', { yes: 'Verwerfen', danger: true }))) return;
            try { localStorage.removeItem(draftKey(null)); } catch { /* egal */ }
            finish();
            return;
          }
          if (!(await dsAsk(mine ? 'Diese Notiz für alle löschen?' : 'Diese gemeinsame Notiz verlassen? Du siehst sie dann nicht mehr.', { yes: mine ? 'Löschen' : 'Verlassen', danger: true }))) return;
          try {
            if (mine) must(await sb.from('notes').delete().eq('id', noteId));
            else must(await sb.rpc('leave_note', { p_note: noteId }));
            state.notes = state.notes.filter((n) => n.id !== noteId);
            try { localStorage.removeItem(draftKey(noteId)); } catch { /* egal */ }
            toast(mine ? '🗑️ Notiz gelöscht.' : '🚪 Notiz verlassen.');
            finish();
          } catch (ex) { toast(ex.message); }
        };

        btnUp.addEventListener('click', async () => {
          work.title = titleEl.value.trim();
          work.content = sanitizeNoteHtml(textEl.innerHTML);
          if (!work.title && !noteText({ content: work.content }) && !work.drawing.length) { toast('Die Notiz ist noch leer.'); return; }
          btnUp.disabled = true;
          btnUp.textContent = '⏳ Lädt …';
          try {
            const payload = { title: work.title, content: work.content, drawing: work.drawing, paper: work.paper };
            if (mine) payload.shared_with = work.sharedWith;
            let row;
            if (!noteId) {
              row = must(await sb.from('notes').insert(payload).select().single());
              try { localStorage.removeItem(draftKey(null)); } catch { /* egal */ }
            } else {
              const cur = must(await sb.from('notes').select('updated_at, updated_by').eq('id', noteId).maybeSingle());
              if (!cur) throw new Error('Die Notiz wurde inzwischen gelöscht.');
              if (cur.updated_at !== baseUpdatedAt && cur.updated_by !== state.me.id) {
                const who = userById(cur.updated_by);
                if (!(await dsAsk(`${who ? who.firstName : 'Jemand'} hat die Notiz inzwischen geändert. Mit deiner Version überschreiben?`, { yes: 'Überschreiben', danger: true }))) {
                  dirty = true; syncButtons(); return;
                }
              }
              row = must(await sb.from('notes').update(payload).eq('id', noteId).select().single());
            }
            const n = mapNote(row);
            upsertBy(state.notes, n, true);
            state.notes.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
            noteId = n.id;
            baseUpdatedAt = n.updatedAt;
            try { localStorage.removeItem(draftKey(noteId)); } catch { /* egal */ }
            dirty = false;
            uploaded = true;
            $m('#note-meta').textContent = metaHtml();
            syncButtons();
            catchAnimation('Hochgeladen!');
            if (isShared(n) || !mine) toast('Jetzt kannst du die anderen benachrichtigen.');
          } catch (ex) {
            toast(ex.message);
            dirty = true;
            syncButtons();
          }
        });

        btnNotify.addEventListener('click', async () => {
          btnNotify.disabled = true;
          try {
            await invokeOrThrow({ action: 'note', noteId });
            btnNotify.textContent = '✓ Benachrichtigt';
            uploaded = false;
            toast('🔔 Die anderen wurden benachrichtigt.');
          } catch (ex) {
            toast(ex.message);
            btnNotify.disabled = false;
          }
        });

        $m('#note-close').addEventListener('click', async () => {
          if (dirty && (titleEl.value.trim() || noteText({ content: textEl.innerHTML }) || work.drawing.length)) {
            if (!(await dsAsk('Noch nicht hochgeladen. Trotzdem schließen? Der Entwurf bleibt auf diesem Handy gespeichert.', { yes: 'Schließen', no: 'Weiter schreiben' }))) return;
            saveDraft();
          }
          finish();
        });

        // Live-Änderung von anderen übernehmen, wenn hier nichts Ungespeichertes ist
        modal.addEventListener('note-remote', () => {
          const n = state.notes.find((x) => x.id === noteId);
          if (!n || dirty || n.updatedAt === baseUpdatedAt) return;
          Object.assign(work, { title: n.title, content: n.content, drawing: [...n.drawing], paper: n.paper, sharedWith: [...n.sharedWith] });
          baseUpdatedAt = n.updatedAt;
          titleEl.value = n.title;
          textEl.innerHTML = sanitizeNoteHtml(n.content);
          $m('#note-paper').setAttribute('style', paperStyle(n.paper));
          $m('#note-meta').textContent = metaHtml();
          $m('#note-people').innerHTML = peopleHtml();
          sizeCanvas();
          toast('📝 Die Notiz wurde gerade von jemand anderem aktualisiert.');
        });

        const onResize = () => sizeCanvas();
        window.addEventListener('resize', onResize);
        new MutationObserver(() => { if (!modal.isConnected) window.removeEventListener('resize', onResize); })
          .observe($('#modal-root'), { childList: true });
        requestAnimationFrame(sizeCanvas);
        syncButtons();
        if (!id && !isIos) titleEl.focus();
      },
    }
  );
}

/* -------------------------------------------------------------------------
 * Board der Schande
 *  – Kreidetafel mit Polaroids der Trainer, darunter die Striche (bis 10)
 *  – Strafkatalog (Vorlagen müssen von allen beglaubigt werden)
 *  – Bestrafen → Urteil (weiß/gold) · Strafe für den Bestraften (schwarz/rot/gold)
 * ---------------------------------------------------------------------- */

const STRIKE_VALUES = [0.5, 1, 2];
const FINE_STRIKES = 10;
const STRIKE_STATUS = {
  pending: '⏳ vorläufig – wartet auf Anerkennung',
  appealed: '⚖️ Einspruch eingelegt',
  withdrawn: '🕊️ zurückgezogen',
};
const HISTORY_LABELS = {
  given: 'Urteil verkündet', acknowledged: 'Anerkannt', appealed: 'Einspruch eingelegt',
  upheld: 'Neu bewertet', forced: 'Durchgeboxt – rechtskräftig', withdrawn: 'Zurückgezogen',
};

function mapStrike(r) {
  return {
    id: r.id,
    userId: r.user_id,
    givenBy: r.given_by,
    messageId: r.message_id,
    value: Number(r.value) || 1,
    title: r.title || 'Strich',
    description: r.description || '',
    reason: r.reason || '',
    status: r.status || 'active',
    final: Boolean(r.final),
    appealText: r.appeal_text || '',
    verdictText: r.verdict_text || '',
    acknowledgedAt: r.acknowledged_at,
    hasPhoto: Boolean(r.has_photo),
    history: Array.isArray(r.history) ? r.history : [],
    createdAt: r.created_at,
  };
}
function mapRule(r) {
  return {
    id: r.id, title: r.title, description: r.description || '', value: Number(r.value) || 1,
    createdBy: r.created_by, approvedBy: r.approved_by || [], approvedAt: r.approved_at, createdAt: r.created_at,
  };
}
function mapFine(r) {
  return {
    id: r.id, userId: r.user_id, confirmedBy: r.confirmed_by || [], settledAt: r.settled_at, createdAt: r.created_at,
    confirmations: Array.isArray(r.confirmations) ? r.confirmations : [],
  };
}
function upsertBy(list, item, front = false) {
  const i = list.findIndex((x) => x.id === item.id);
  if (i >= 0) list[i] = item; else if (front) list.unshift(item); else list.push(item);
}

function strikeWord(v) {
  return `${fmtNum(v)} ${Number(v) === 1 ? 'Strich' : 'Striche'}`;
}
function strikeStatusLabel(s) {
  if (s.status === 'active') return s.final ? '🔨 durchgeboxt – rechtskräftig' : '✓ anerkannt – rechtskräftig';
  return STRIKE_STATUS[s.status] || s.status;
}
function nameOf(id, fallback = 'Unbekannt') {
  const u = id && userById(id);
  return u ? u.firstName : fallback;
}

/* ---- Motive ---------------------------------------------------------- */

/** Goldener Ring mit grünen Juwelen – fürs Vergeben und Urteilen */
function judgeEmblem(size = 74) {
  const spokes = [0, 90, 180, 270].map((a) =>
    `<path transform="rotate(${a} 50 50)" d="M50 4 57 20 50 16 43 20Z" fill="url(#jg)" stroke="#8a6410" stroke-width="1"/>`).join('');
  const gems = [[50, 14], [86, 50], [50, 86], [14, 50]].map(([x, y]) =>
    `<circle cx="${x}" cy="${y}" r="5" fill="#3fc070" stroke="#0e5c33" stroke-width="1.6"/><circle cx="${x - 1.5}" cy="${y - 1.6}" r="1.4" fill="#c9f7d9"/>`).join('');
  return `<svg class="judge-emblem" viewBox="0 0 100 100" width="${size}" height="${size}" aria-hidden="true">
    <defs><linearGradient id="jg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fff4c2"/><stop offset=".45" stop-color="#e3b93c"/><stop offset="1" stop-color="#9c7414"/></linearGradient></defs>
    ${spokes}
    <circle cx="50" cy="50" r="36" fill="none" stroke="url(#jg)" stroke-width="7"/>
    <circle cx="50" cy="50" r="36" fill="none" stroke="#8a6410" stroke-width="1" opacity=".6"/>
    <path d="M50 14Q63 50 50 86Q37 50 50 14Z M14 50Q50 63 86 50Q50 37 14 50Z" fill="none" stroke="url(#jg)" stroke-width="3.5"/>
    <circle cx="50" cy="50" r="9" fill="#f4f4ef" stroke="#a9a9a2" stroke-width="2"/>
    <circle cx="50" cy="50" r="3.6" fill="#3fc070"/>${gems}
  </svg>`;
}

function judgeHeadHtml(title, sub = '', closable = true) {
  return `<div class="judge-head">
    ${judgeEmblem()}
    <div class="judge-titles"><span class="judge-sub">${esc(sub || 'Gericht der Familie')}</span><h2>${esc(title)}</h2></div>
    ${closable ? '<button class="icon-btn" data-close aria-label="Schließen">✕</button>' : ''}
  </div>`;
}

/** Schattenarme mit roten Spitzen – nur für den Bestraften */
function shadowTendrils() {
  const arms = [
    [-8, 120, 'M20 130 C60 90 30 50 80 30 C110 18 120 40 150 22'],
    [-4, 120, 'M40 135 C90 100 70 60 120 52 C160 46 170 70 210 48'],
    [0, 120, 'M60 140 C120 115 110 80 160 82 C205 84 215 104 255 86'],
    [4, 120, 'M70 145 C130 140 150 112 200 120 C240 126 250 146 290 132'],
  ];
  return `<svg class="hell-tendrils" viewBox="0 0 300 150" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
    ${arms.map(([d, , path], i) => {
      const end = path.trim().split(' ').slice(-2).map(Number);
      return `<g class="tendril" style="--d:${i * 0.35}s;--r:${d}deg">
        <path d="${path}" fill="none" stroke="#0d0a0e" stroke-width="18" stroke-linecap="round"/>
        <path d="${path}" fill="none" stroke="#4b2b55" stroke-width="7" stroke-linecap="round" opacity=".55" stroke-dasharray="12 9"/>
        <circle cx="${end[0]}" cy="${end[1]}" r="9" fill="#d43a45"/><circle cx="${end[0] + 3}" cy="${end[1] - 2}" r="3" fill="#ff8a8a"/>
      </g>`;
    }).join('')}
  </svg>`;
}

/* ---- Kreidestriche --------------------------------------------------- */

/**
 * Strichliste in Kreide. Alles oberhalb von `burnFrom` wird eingebrannt (Animation).
 * Jede Linie endet bei einem Wert (1, 2, … bzw. x,5 für den halben Strich).
 */
function tallySvg(value, burnFrom = null) {
  const v = Math.min(Number(value) || 0, FINE_STRIKES);
  const whole = Math.floor(v);
  const half = v % 1 !== 0;
  const lines = [];
  const x0 = (g) => 8 + g * 64;
  const draw = (i, frac) => {
    const g = Math.floor(i / 5), k = i % 5;
    let d;
    if (k < 4) {
      const x = x0(g) + k * 11 + (i % 2 ? 1 : -1);
      d = `M${x} ${44 - 38 * frac} L${x + (k % 2 ? 1.5 : -1)} 46`;
    } else {
      const sx = x0(g) - 6, sy = 38, ex = x0(g) + 40, ey = 10;
      d = `M${sx} ${sy} L${sx + (ex - sx) * frac} ${sy + (ey - sy) * frac}`;
    }
    lines.push({ d, end: i + frac });
  };
  for (let i = 0; i < whole; i++) draw(i, 1);
  if (half) draw(whole, 0.5);
  const from = burnFrom == null ? Infinity : Math.max(0, Math.min(burnFrom, v));
  let n = 0;
  const burnDelay = new Map();
  for (const l of lines) if (l.end > from) burnDelay.set(l, 0.35 + 0.55 * n++);
  const delay = (l) => `--bd:${burnDelay.get(l).toFixed(2)}s`;
  return `<svg class="tally" viewBox="0 0 132 52" aria-label="${fmtNum(v)} Striche">
    <g class="scorch">${lines.map((l) => `<path d="${l.d}"${burnDelay.has(l) ? ` class="burn-scorch" style="${delay(l)}"` : ''}/>`).join('')}</g>
    <g class="embers">${lines.filter((l) => burnDelay.has(l)).map((l) => `<path class="e1" d="${l.d}" style="${delay(l)}"/><path class="e2" d="${l.d}" style="${delay(l)}"/>`).join('')}</g>
    <g filter="url(#chalk)" stroke="#f3f1e7" stroke-width="3.6" stroke-linecap="round" fill="none">${lines.map((l) =>
      burnDelay.has(l) ? `<path class="burn" pathLength="1" d="${l.d}" style="${delay(l)}"/>` : `<path d="${l.d}"/>`).join('')}</g>
  </svg>`;
}

const CHALK_DEFS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
  <filter id="chalk" x="-10%" y="-10%" width="120%" height="120%">
    <feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="2" seed="4" result="n"/>
    <feDisplacementMap in="SourceGraphic" in2="n" scale="2.6" result="d"/>
    <feComposite in="d" in2="n" operator="in" result="c"/>
    <feMerge><feMergeNode in="d"/><feMergeNode in="c"/></feMerge>
  </filter>
  <filter id="ember" filterUnits="userSpaceOnUse" x="-20" y="-20" width="172" height="92"><feGaussianBlur stdDeviation="2.4"/></filter></defs></svg>`;

/* ---- Einbrennen: neue Striche beim ersten Betreten des Boards ---------- */

const BURN_KEY = 'familie.burned';
const burning = new Set(); // läuft gerade (falls neu gezeichnet wird)

/** Liefert die Striche, die auf diesem Gerät noch nicht eingebrannt wurden, und merkt sie sich. */
function takeFreshStrikes() {
  // Solange eine Urteils-/Strafmeldung offen ist, warten – sonst verpasst man die Animation
  if (!state.boardLoaded || verdictOpen) return [];
  const visible = state.strikes.filter((s) => s.status !== 'withdrawn');
  let seen = lsGet(BURN_KEY, null);
  if (!Array.isArray(seen)) {
    // Erster Start mit dieser Version: Bestehendes nicht animieren
    lsSet(BURN_KEY, visible.map((s) => s.id));
    return [];
  }
  const seenSet = new Set(seen);
  const fresh = visible.filter((s) => !seenSet.has(s.id) || burning.has(s.id));
  for (const s of fresh) {
    if (!burning.has(s.id)) {
      burning.add(s.id);
      setTimeout(() => burning.delete(s.id), 5000);
    }
    seenSet.add(s.id);
  }
  if (fresh.length) lsSet(BURN_KEY, [...seenSet].slice(-500));
  return fresh;
}

/* ---- Zählen ------------------------------------------------------------ */

function settledFines(userId) {
  return state.fines.filter((f) => f.userId === userId && f.settledAt).length;
}
function strikeSum(userId, pred = (s) => s.status !== 'withdrawn') {
  return state.strikes.filter((s) => s.userId === userId && pred(s)).reduce((a, s) => a + s.value, 0);
}
/** Striche auf der Tafel = alle vergebenen − 10 je bezahlter Strafe */
function boardOpen(userId) {
  return Math.max(0, strikeSum(userId) - FINE_STRIKES * settledFines(userId));
}
/** Davon rechtskräftig (Voraussetzung fürs Bezahlen) */
function boardActive(userId) {
  return strikeSum(userId, (s) => s.status === 'active') - FINE_STRIKES * settledFines(userId);
}

/* ---- Board ----------------------------------------------------------- */

function openFine(userId) {
  return state.fines.find((f) => f.userId === userId && !f.settledAt);
}

function polaroidHtml(u, i, freshValue = 0) {
  const open = boardOpen(u.id);
  const over = Math.max(0, open - FINE_STRIKES);
  const pending = strikeSum(u.id, (s) => s.status === 'pending' || s.status === 'appealed');
  const rot = [-4, 3, -2, 5, -3][i % 5];
  const fine = open >= FINE_STRIKES ? openFine(u.id) : null;
  const confirmed = fine ? fine.confirmedBy : [];
  const payable = boardActive(u.id) >= FINE_STRIKES;
  return `<div class="pin-col${freshValue ? ' burning' : ''}">
    <button type="button" class="polaroid" style="--rot:${rot}deg;${colorVars(u.color)}" data-dossier="${esc(u.id)}" aria-label="Akte von ${esc(u.firstName)}">
      <span class="pin" aria-hidden="true"></span>
      <span class="photo">${avatarHtml(u)}</span>
      <span class="caption">${esc(u.firstName)}</span>
    </button>
    <div class="tally-wrap">
      ${tallySvg(open, freshValue ? open - freshValue : null)}
      ${freshValue ? `<span class="burn-plus" aria-hidden="true">+${fmtNum(freshValue)}</span>` : ''}
    </div>
    <div class="chalk count">${fmtNum(Math.min(open, FINE_STRIKES))} / ${FINE_STRIKES}${over ? ` <span class="over">+${fmtNum(over)} warten</span>` : ''}</div>
    ${pending ? `<div class="chalk pending">davon ${fmtNum(pending)} vorläufig</div>` : ''}
    ${open >= FINE_STRIKES ? `<div class="fine-box">
      <div class="fine-head">💶 10 € fällig!</div>
      ${!payable ? '<div class="chalk small">Bezahlen geht, sobald alle 10 Striche rechtskräftig sind.</div>' : `
      <div class="fine-confirm">${state.users.map((x) => `<span class="${confirmed.includes(x.id) ? 'ok' : ''}">${confirmed.includes(x.id) ? '✓' : '○'} ${esc(x.firstName)}</span>`).join('')}</div>
      ${confirmed.includes(state.me.id) ? '<div class="chalk small">Warte auf die anderen …</div>'
        : `<button type="button" class="btn small chalk-btn" data-fine="${esc(u.id)}">Bezahlung bestätigen</button>`}`}
    </div>` : ''}
  </div>`;
}

function ruleHtml(r) {
  const pendingRule = !r.approvedAt;
  const iApproved = r.approvedBy.includes(state.me.id);
  const mine = r.createdBy === state.me.id;
  return `<li class="rule${pendingRule ? ' proposal' : ''}">
    <div class="rule-top"><b>${esc(r.title)}</b><span class="rule-value">${strikeWord(r.value)}</span></div>
    ${r.description ? `<p>${esc(r.description)}</p>` : ''}
    ${pendingRule ? `<div class="rule-meta">Eingereicht von ${esc(nameOf(r.createdBy))} · beglaubigt ${r.approvedBy.length}/${state.users.length}
        (${state.users.map((u) => `${r.approvedBy.includes(u.id) ? '✓' : '○'} ${esc(u.firstName)}`).join(', ')})</div>
      <div class="rule-actions">
        ${iApproved ? '' : `<button type="button" class="btn small chalk-btn" data-approve="${esc(r.id)}">✓ Beglaubigen</button>`}
        <button type="button" class="btn small chalk-btn ghost" data-reject="${esc(r.id)}">${mine ? 'Zurückziehen' : '✕ Ablehnen'}</button>
      </div>` : ''}
  </li>`;
}

function logRowHtml(s) {
  return `<li><button type="button" class="log-row status-${esc(s.status)}" data-strike="${esc(s.id)}">
    <span class="log-who">${esc(nameOf(s.userId))}</span>
    <span class="log-what">${esc(s.title)}${s.hasPhoto ? ' 📷' : ''}</span>
    <span class="log-val">${s.status === 'withdrawn' ? '<s>' : ''}${strikeWord(s.value)}${s.status === 'withdrawn' ? '</s>' : ''}</span>
    <span class="log-meta">${esc(strikeStatusLabel(s))} · ${esc(formatDate(new Date(s.createdAt)))}</span>
  </button></li>`;
}

function renderBoard(view) {
  if (!state.me) { view.innerHTML = ''; return; }
  const users = [...state.users].sort((a, b) => a.firstName.localeCompare(b.firstName, 'de'));
  const approved = state.rules.filter((r) => r.approvedAt);
  const proposals = state.rules.filter((r) => !r.approvedAt);
  const toApprove = proposals.filter((r) => !r.approvedBy.includes(state.me.id)).length;
  const showAll = view.dataset.logAll === '1';
  const log = showAll ? state.strikes : state.strikes.slice(0, 12);
  const fresh = takeFreshStrikes();
  const freshOf = (id) => fresh.filter((s) => s.userId === id).reduce((a, s) => a + s.value, 0);
  view.innerHTML = `${CHALK_DEFS}
  <div class="board">
    <div class="stone-frame">
      <div class="slate">
        <h2 class="chalk chalk-title">Board der Schande</h2>
        <div class="pins${fresh.length ? ' has-burn' : ''}">${users.map((u, i) => polaroidHtml(u, i, freshOf(u.id))).join('')}</div>
        <p class="chalk small board-note">Bei ${FINE_STRIKES} Strichen sind 10 € fällig – erst wenn alle die Bezahlung bestätigen, werden sie von der Tafel gewischt. Im Trainerpass bleiben alle Striche stehen.</p>
        ${toApprove ? `<button type="button" class="chalk chalk-link" data-goto="katalog">⚖️ ${toApprove} ${toApprove === 1 ? 'Grund wartet' : 'Gründe warten'} auf deine Beglaubigung</button>` : ''}
        <div class="chalk-ledge" aria-hidden="true"><i></i><i></i></div>
      </div>
    </div>

    <section class="slate slate-small" id="katalog">
      <div class="chalk-head"><h3 class="chalk">Strafkatalog</h3>
        <button type="button" class="btn small chalk-btn" id="rule-new">＋ Grund einreichen</button></div>
      ${proposals.length ? `<h4 class="chalk">Zur Beglaubigung</h4><ul class="rules">${proposals.map(ruleHtml).join('')}</ul>` : ''}
      ${approved.length ? `<h4 class="chalk">Rechtskräftig</h4><ul class="rules">${approved.map(ruleHtml).join('')}</ul>`
        : '<p class="chalk small">Noch keine beglaubigten Gründe. Reiche den ersten ein – alle müssen ihn beglaubigen.</p>'}
    </section>

    <section class="slate slate-small">
      <div class="chalk-head"><h3 class="chalk">Protokoll</h3></div>
      <p class="chalk small">Tippe auf einen Eintrag oder ein Polaroid – dort steht alles mit Datum und Uhrzeit.</p>
      ${log.length ? `<ul class="log">${log.map(logRowHtml).join('')}</ul>` : '<p class="chalk small">Noch keine Striche. Erstaunlich.</p>'}
      ${!showAll && state.strikes.length > log.length ? '<button type="button" class="chalk chalk-link" id="log-all">Alle anzeigen</button>' : ''}
    </section>
    <button type="button" class="punish-field" id="punish-btn">
      <span class="punish-chain" aria-hidden="true"></span>
      <span class="punish-label">Bestrafen</span>
      <span class="punish-chain" aria-hidden="true"></span>
    </button>
  </div>`;

  $('#punish-btn', view).addEventListener('click', openPunishForm);
  $('#rule-new', view).addEventListener('click', openRuleForm);
  const all = $('#log-all', view);
  if (all) all.addEventListener('click', () => { view.dataset.logAll = '1'; render(); });
  view.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () =>
    document.getElementById(b.dataset.goto).scrollIntoView({ behavior: 'smooth' })));
  view.querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', () => ruleAction('approve_rule', b)));
  view.querySelectorAll('[data-reject]').forEach((b) => b.addEventListener('click', () => ruleAction('reject_rule', b)));
  view.querySelectorAll('[data-strike]').forEach((b) => b.addEventListener('click', () => openStrikeDetail(b.dataset.strike)));
  view.querySelectorAll('[data-fine]').forEach((b) => b.addEventListener('click', () => confirmFine(b.dataset.fine, b)));
  view.querySelectorAll('[data-dossier]').forEach((b) => b.addEventListener('click', () => openDossier(b.dataset.dossier)));
}

async function ruleAction(fn, btn) {
  const id = btn.dataset.approve || btn.dataset.reject;
  if (fn === 'reject_rule' && !(await dsAsk('Diesen Vorschlag wirklich verwerfen?', { yes: 'Verwerfen', danger: true }))) return;
  btn.disabled = true;
  try {
    const r = must(await sb.rpc(fn, { p_rule: id }));
    if (fn === 'reject_rule') state.rules = state.rules.filter((x) => x.id !== id);
    else {
      upsertBy(state.rules, mapRule(r));
      toast(r.approved_at ? '⚖️ Beglaubigt – der Grund ist jetzt rechtskräftig.' : '✓ Beglaubigt – es fehlen noch weitere Stimmen.');
    }
    render();
  } catch (e) {
    toast(e.message);
    btn.disabled = false;
  }
}

async function confirmFine(userId, btn) {
  const u = userById(userId);
  if (!(await dsAsk(`Bestätigst du, dass ${u ? u.firstName : 'die Person'} die 10 € bezahlt hat?`, { yes: 'Bezahlt', no: 'Noch nicht' }))) return;
  btn.disabled = true;
  try {
    const f = mapFine(must(await sb.rpc('confirm_fine', { p_user: userId })));
    upsertBy(state.fines, f, true);
    if (f.settledAt) {
      await loadUsers();
      toast('🧽 Bezahlt – 10 Striche wurden von der Tafel gewischt (im Trainerpass bleiben sie).');
    } else {
      toast('💶 Bestätigt – jetzt müssen die anderen noch bestätigen.');
      invokeQuiet({ action: 'board', event: 'fine' });
    }
    render();
  } catch (e) {
    toast(e.message);
    btn.disabled = false;
  }
}

/** Push auslösen, ohne bei Fehlern zu stören */
function invokeQuiet(body) {
  sb.functions.invoke('push', { body }).catch(() => {});
}

/* ---- Neuer Grund (Vorlage) ------------------------------------------- */

function valuePickerHtml(name, selected = 1) {
  return `<div class="value-pick">${STRIKE_VALUES.map((v) => `<label class="value-opt">
    <input type="radio" name="${name}" value="${v}" ${v === selected ? 'checked' : ''}><span>${strikeWord(v)}</span></label>`).join('')}</div>`;
}

function openRuleForm() {
  openModal(
    `${judgeHeadHtml('Neuer Grund', 'Gesetzesvorschlag')}
     <form class="form" id="rule-form">
       <label class="field"><span>Titel</span><input name="title" maxlength="60" required placeholder="z. B. Geschirr stehen lassen"></label>
       <label class="field"><span>Beschreibung</span><textarea name="description" maxlength="500" placeholder="Was genau ist der Verstoß?"></textarea></label>
       <div class="field"><span>Wertigkeit</span>${valuePickerHtml('value')}</div>
       <p class="hint">Der Grund ist erst rechtskräftig und in der Schnellauswahl, wenn alle ihn beglaubigt haben.</p>
       <p class="error" id="rule-error"></p>
       <div class="modal-actions">
         <button type="button" class="btn" data-close>Abbrechen</button>
         <button type="submit" class="btn judge-btn">⚖️ Zur Beglaubigung einreichen</button>
       </div>
     </form>`,
    {
      cls: 'judge',
      onMount: (modal, close) => {
        const form = $('#rule-form', modal);
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const btn = form.querySelector('[type=submit]');
          btn.disabled = true;
          try {
            const r = mapRule(must(await sb.rpc('propose_rule', {
              p_title: form.elements.title.value, p_description: form.elements.description.value, p_value: Number(form.elements.value.value),
            })));
            upsertBy(state.rules, r);
            close();
            render();
            if (r.approvedAt) toast('⚖️ Der Grund ist rechtskräftig.');
            else { toast('📜 Eingereicht – wartet auf die Beglaubigung durch alle.'); invokeQuiet({ action: 'board', event: 'rule', ruleId: r.id }); }
          } catch (ex) {
            $('#rule-error', modal).textContent = ex.message;
            btn.disabled = false;
          }
        });
      },
    }
  );
}

/* ---- Bestrafen (Urteil fällen) --------------------------------------- */

async function compressImage(file, max = 1100, quality = 0.72) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    let data = c.toDataURL('image/jpeg', quality);
    if (data.length > 1_400_000) data = c.toDataURL('image/jpeg', 0.5);
    return data;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function openPunishForm() {
  let others = state.users.filter((u) => u.id !== state.me.id);
  if (!others.length) {
    await loadUsers().catch(() => {});
    others = state.users.filter((u) => u.id !== state.me.id);
  }
  const rules = state.rules.filter((r) => r.approvedAt);
  if (!others.length) { toast('Es gibt noch niemanden, den du bestrafen könntest.'); return; }
  let photo = null;
  openModal(
    `${judgeHeadHtml('Urteil fällen', 'Im Namen der Familie')}
     <form class="form" id="punish-form">
       <div class="field"><span>Angeklagt</span>
         <div class="defendants">${others.map((u, i) => `<label class="defendant" style="${colorVars(u.color)}">
           <input type="radio" name="user" value="${esc(u.id)}" ${i === 0 ? 'checked' : ''}>
           <span><span class="mini-photo">${avatarHtml(u)}</span>${esc(u.firstName)}</span></label>`).join('')}</div>
       </div>
       <div class="field"><span>Vergehen</span>
         ${rules.length ? `<div class="rule-pick">${rules.map((r) => `<label class="rule-opt">
            <input type="radio" name="rule" value="${esc(r.id)}">
            <span><b>${esc(r.title)}</b><em>${strikeWord(r.value)}</em>${r.description ? `<small>${esc(r.description)}</small>` : ''}</span></label>`).join('')}</div>`
          : '<p class="hint">Noch keine beglaubigten Gründe. Reiche zuerst einen im Strafkatalog ein.</p>'}
       </div>
       <label class="field"><span>Begründung – warum vergibst du den Strich jetzt?</span>
         <textarea name="reason" maxlength="500" required placeholder="z. B. Heute Abend schon wieder alles stehen gelassen"></textarea></label>
       <div class="field"><span>Beweisfoto (optional)</span>
         <label class="photo-pick"><input type="file" name="photo" accept="image/*"><span>📷 Foto hinzufügen</span></label>
         <div class="photo-preview" hidden><img alt=""><button type="button" class="btn small" id="photo-clear">Entfernen</button></div>
       </div>
       <p class="error" id="punish-error"></p>
       <div class="modal-actions">
         <button type="button" class="btn" data-close>Abbrechen</button>
         <button type="submit" class="btn judge-btn" ${rules.length ? '' : 'disabled'}>⚖️ Urteil verkünden</button>
       </div>
     </form>`,
    {
      cls: 'judge',
      onMount: (modal, close) => {
        const form = $('#punish-form', modal);
        const prev = $('.photo-preview', modal);
        const err = $('#punish-error', modal);
        form.elements.photo.addEventListener('change', async () => {
          const f = form.elements.photo.files[0];
          if (!f) return;
          try {
            photo = await compressImage(f);
            prev.querySelector('img').src = photo;
            prev.hidden = false;
          } catch {
            err.textContent = 'Das Foto konnte nicht gelesen werden.';
          }
        });
        $('#photo-clear', modal).addEventListener('click', () => { photo = null; form.elements.photo.value = ''; prev.hidden = true; });
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const rule = form.elements.rule && (form.querySelector('[name=rule]:checked') || {}).value;
          const reason = form.elements.reason.value.trim();
          if (!rule) { err.textContent = 'Bitte ein Vergehen aus dem Strafkatalog wählen.'; return; }
          if (!reason) { err.textContent = 'Bitte begründen, warum du den Strich jetzt vergibst.'; return; }
          const btn = form.querySelector('[type=submit]');
          btn.disabled = true;
          try {
            const userId = form.querySelector('[name=user]:checked').value;
            const s = mapStrike(must(await sb.rpc('give_strike', { p_user: userId, p_rule: rule, p_reason: reason, p_photo: photo })));
            upsertBy(state.strikes, s, true);
            invokeQuiet({ action: 'strike', event: 'given', strikeId: s.id });
            close();
            render();
            toast(`⚖️ Urteil verkündet: ${strikeWord(s.value)} für ${nameOf(userId)} – wartet auf Anerkennung.`);
          } catch (ex) {
            err.textContent = ex.message;
            btn.disabled = false;
          }
        });
      },
    }
  );
}

/* ---- Fotos ----------------------------------------------------------- */

const photoCache = new Map();
async function loadStrikePhoto(id, img) {
  try {
    if (!photoCache.has(id)) {
      const row = must(await sb.from('strike_photos').select('data').eq('strike_id', id).maybeSingle());
      photoCache.set(id, row ? row.data : null);
    }
    const data = photoCache.get(id);
    if (data) { img.src = data; img.closest('.evidence').hidden = false; }
  } catch { /* ohne Foto weiter */ }
}
function evidenceHtml(s) {
  return s.hasPhoto ? `<figure class="evidence" hidden><img alt="Beweisfoto" data-photo="${esc(s.id)}"><figcaption>Beweisfoto</figcaption></figure>` : '';
}
function mountEvidence(root) {
  root.querySelectorAll('[data-photo]').forEach((img) => loadStrikePhoto(img.dataset.photo, img));
}

/* ---- Meldung für den Bestraften -------------------------------------- */

let verdictOpen = false;
const snoozedAppeals = new Set();

function checkVerdicts() {
  if (!state.me || verdictOpen || $('#modal-root').children.length) return;
  const mine = state.strikes
    .filter((s) => s.userId === state.me.id && (s.status === 'pending' || (s.status === 'active' && !s.acknowledgedAt)))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
  if (mine) { openPunishment(mine); return; }
  const appeal = state.strikes.find((s) => s.givenBy === state.me.id && s.status === 'appealed' && !snoozedAppeals.has(s.id));
  if (appeal) openJudgement(appeal);
}

function openPunishment(s) {
  verdictOpen = true;
  const judge = nameOf(s.givenBy, 'Das Board');
  const forced = s.status === 'active' && s.final;
  const canAppeal = !forced && !s.final && s.givenBy;
  const again = s.history.some((h) => h.type === 'upheld');
  openModal(
    `<div class="hell-sky">${shadowTendrils()}</div>
     <div class="hell-band" aria-hidden="true"></div>
     <div class="hell-body">
       <p class="hell-kicker">${forced ? 'Das Urteil ist rechtskräftig' : again ? 'Dein Einspruch wurde abgewiesen' : `${esc(judge)} hat dich bestraft`}</p>
       <h2 class="hell-title">VERURTEILT!</h2>
       <div class="hell-value">+${fmtNum(s.value)}<span>${Number(s.value) === 1 ? 'Strich' : 'Striche'}</span></div>
       <div class="hell-card">
         <div class="hell-label">Verstoß</div>
         <div class="hell-offense">${esc(s.title)}</div>
         ${s.description ? `<p>${esc(s.description)}</p>` : ''}
         <div class="hell-label">Begründung von ${esc(judge)}</div>
         <p class="hell-reason">„${esc(s.reason)}“</p>
         ${s.verdictText ? `<div class="hell-label">${forced ? 'Urteil (ohne weiteren Einspruch)' : 'Neues Urteil'}</div><p class="hell-reason">„${esc(s.verdictText)}“</p>` : ''}
         ${evidenceHtml(s)}
       </div>
       ${forced ? '<p class="hell-note">🔨 Durchgeboxt – ein weiterer Einspruch ist nicht möglich.</p>' : ''}
       <form class="hell-appeal" id="appeal-form" hidden>
         <label class="field"><span>Dein Einspruch</span>
           <textarea name="text" maxlength="1000" required placeholder="Erkläre dich …"></textarea></label>
         <p class="error" id="appeal-error"></p>
         <div class="hell-actions">
           <button type="button" class="btn hell-ghost" id="appeal-cancel">Zurück</button>
           <button type="submit" class="btn hell-btn">Einspruch einreichen</button>
         </div>
       </form>
       <div class="hell-actions" id="hell-main">
         ${canAppeal ? '<button type="button" class="btn hell-ghost" id="appeal-open">⚖️ Einspruch einlegen</button>' : ''}
         <button type="button" class="btn hell-btn" id="ack">${forced ? 'Hinnehmen' : 'Strich anerkennen'}</button>
       </div>
     </div>`,
    {
      dismissible: false,
      full: true,
      cls: 'hell',
      onMount: (modal, close) => {
        mountEvidence(modal);
        const done = () => { verdictOpen = false; close(); render(); };
        const form = $('#appeal-form', modal);
        const main = $('#hell-main', modal);
        const openBtn = $('#appeal-open', modal);
        if (openBtn) openBtn.addEventListener('click', () => { form.hidden = false; main.hidden = true; form.elements.text.focus(); });
        $('#appeal-cancel', modal).addEventListener('click', () => { form.hidden = true; main.hidden = false; });
        $('#ack', modal).addEventListener('click', async (e) => {
          e.target.disabled = true;
          try {
            upsertBy(state.strikes, mapStrike(must(await sb.rpc('acknowledge_strike', { p_strike: s.id }))));
            invokeQuiet({ action: 'strike', event: 'acknowledged', strikeId: s.id });
            await loadUsers().catch(() => {});
            renderProfileButton();
            done();
          } catch (ex) {
            toast(ex.message);
            e.target.disabled = false;
          }
        });
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const text = form.elements.text.value.trim();
          if (!text) { $('#appeal-error', modal).textContent = 'Bitte den Einspruch begründen.'; return; }
          const btn = form.querySelector('[type=submit]');
          btn.disabled = true;
          try {
            upsertBy(state.strikes, mapStrike(must(await sb.rpc('appeal_strike', { p_strike: s.id, p_text: text }))));
            invokeQuiet({ action: 'strike', event: 'appealed', strikeId: s.id });
            done();
            toast(`⚖️ Einspruch eingereicht – ${judge} muss neu entscheiden.`);
          } catch (ex) {
            $('#appeal-error', modal).textContent = ex.message;
            btn.disabled = false;
          }
        });
      },
    }
  );
}

/* ---- Einspruch prüfen (Urheber) -------------------------------------- */

function openJudgement(s) {
  verdictOpen = true;
  const who = nameOf(s.userId);
  openModal(
    `${judgeHeadHtml('Einspruch', `${who} widerspricht deinem Urteil`, false)}
     <div class="judge-case">
       <div class="case-row"><span>Verstoß</span><b>${esc(s.title)} · ${strikeWord(s.value)}</b></div>
       <div class="case-row"><span>Deine Begründung</span><p>„${esc(s.reason)}“</p></div>
       ${s.verdictText ? `<div class="case-row"><span>Dein letztes Urteil</span><p>„${esc(s.verdictText)}“</p></div>` : ''}
       <div class="case-row appeal"><span>Einspruch von ${esc(who)}</span><p>„${esc(s.appealText)}“</p></div>
       ${evidenceHtml(s)}
     </div>
     <form class="form" id="judge-form">
       <div class="field"><span>Dein Urteil</span>
         <div class="verdicts">
           <label class="verdict"><input type="radio" name="decision" value="withdraw"><span><b>🕊️ Zurückziehen</b><small>Dem Einspruch wird stattgegeben, der Strich entfällt.</small></span></label>
           <label class="verdict"><input type="radio" name="decision" value="uphold"><span><b>⚖️ Neu bewerten</b><small>Strich bleibt (ggf. mit anderer Wertigkeit). ${esc(who)} kann erneut Einspruch einlegen.</small></span></label>
           <label class="verdict force"><input type="radio" name="decision" value="force"><span><b>🔨 Durchboxen</b><small>Der Strich ist sofort rechtskräftig – kein weiterer Einspruch.</small></span></label>
         </div>
       </div>
       <div class="field" id="new-value" hidden><span>Wertigkeit</span>${valuePickerHtml('value', s.value)}</div>
       <label class="field"><span>Urteilsbegründung</span>
         <textarea name="text" maxlength="500" placeholder="Begründe dein Urteil"></textarea></label>
       <p class="error" id="judge-error"></p>
       <div class="modal-actions">
         <button type="button" class="btn" id="judge-later">Später</button>
         <button type="submit" class="btn judge-btn">⚖️ Urteil verkünden</button>
       </div>
     </form>`,
    {
      dismissible: false,
      cls: 'judge',
      onMount: (modal, close) => {
        mountEvidence(modal);
        const form = $('#judge-form', modal);
        const err = $('#judge-error', modal);
        let later = false;
        $('#judge-later', modal).addEventListener('click', () => {
          later = true;
          // Bis zum nächsten Start der App nicht erneut zeigen
          snoozedAppeals.add(s.id);
          verdictOpen = false;
          close();
        });
        form.addEventListener('change', () => {
          $('#new-value', modal).hidden = form.elements.decision.value !== 'uphold';
        });
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          if (later) return;
          const decision = form.elements.decision.value;
          const text = form.elements.text.value.trim();
          if (!decision) { err.textContent = 'Bitte ein Urteil wählen.'; return; }
          if (decision !== 'withdraw' && !text) { err.textContent = 'Bitte das Urteil begründen.'; return; }
          const btn = form.querySelector('[type=submit]');
          btn.disabled = true;
          try {
            const r = mapStrike(must(await sb.rpc('decide_strike', {
              p_strike: s.id, p_decision: decision, p_text: text || null,
              p_value: decision === 'uphold' ? Number(form.elements.value.value) : null,
            })));
            upsertBy(state.strikes, r);
            invokeQuiet({ action: 'strike', event: 'decided', strikeId: s.id });
            verdictOpen = false;
            close();
            render();
            toast(decision === 'withdraw' ? '🕊️ Strich zurückgezogen.' : decision === 'force' ? '🔨 Durchgeboxt – der Strich ist rechtskräftig.' : '⚖️ Neues Urteil verkündet.');
          } catch (ex) {
            err.textContent = ex.message;
            btn.disabled = false;
          }
        });
      },
    }
  );
}

/* ---- Akte eines Strichs (lückenlos mit Zeitstempeln) ------------------ */

const HISTORY_ICONS = { given: '⚖️', acknowledged: '✓', appealed: '📣', upheld: '⚖️', forced: '🔨', withdrawn: '🕊️' };

function timelineHtml(s) {
  const entries = [...s.history].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (!entries.length) entries.push({ type: 'given', by: s.givenBy, at: s.createdAt, text: s.reason });
  return `<ol class="timeline">${entries.map((h, i) => `<li class="tl-${esc(h.type)}">
    <span class="tl-dot" aria-hidden="true">${HISTORY_ICONS[h.type] || '•'}</span>
    <div class="tl-body">
      <div class="tl-head"><b>${esc(HISTORY_LABELS[h.type] || h.type)}</b> · ${esc(nameOf(h.by, 'System'))}</div>
      <time datetime="${esc(h.at)}">${esc(formatDateTime(h.at))} Uhr</time>
      ${h.type === 'given' && i === 0 ? `<div class="tl-extra">Vergehen: ${esc(s.title)}${s.description ? ` – ${esc(s.description)}` : ''}</div>` : ''}
      ${h.value != null ? `<div class="tl-extra">Wertigkeit: ${strikeWord(h.value)}</div>` : ''}
      ${h.text ? `<p>„${esc(h.text)}“</p>` : ''}
      ${h.type === 'given' && i === 0 && s.hasPhoto ? '<div class="tl-extra">📷 Beweisfoto angehängt (unten)</div>' : ''}
    </div>
  </li>`).join('')}</ol>`;
}

function openStrikeDetail(id) {
  const s = state.strikes.find((x) => x.id === id);
  if (!s) return;
  const msg = s.messageId && state.messages.find((m) => m.id === s.messageId);
  openModal(
    `${judgeHeadHtml(s.title, `Akte · ${nameOf(s.userId)}`)}
     <div class="judge-case">
       <div class="case-grid">
         <div><span>Bestraft</span><b>${esc(nameOf(s.userId))}</b></div>
         <div><span>Vergeben von</span><b>${esc(nameOf(s.givenBy, 'automatisch'))}</b></div>
         <div><span>Wertigkeit</span><b>${strikeWord(s.value)}</b></div>
         <div><span>Status</span><b>${esc(strikeStatusLabel(s))}</b></div>
       </div>
       ${s.description ? `<div class="case-row"><span>Verstoß</span><p>${esc(s.description)}</p></div>` : ''}
       ${msg ? `<div class="case-row"><span>Zur Meldung</span><p>${esc(msg.title)}</p></div>` : ''}
       <div class="case-row"><span>Verlauf</span>${timelineHtml(s)}</div>
       ${evidenceHtml(s)}
     </div>`,
    { cls: 'judge', onMount: (modal) => mountEvidence(modal) }
  );
}

/** Alle Striche und Bezahlungen einer Person */
function openDossier(userId) {
  const u = userById(userId);
  if (!u) return;
  const list = state.strikes.filter((s) => s.userId === userId);
  const fines = state.fines.filter((f) => f.userId === userId);
  const total = strikeSum(userId);
  openModal(
    `${judgeHeadHtml(u.firstName, 'Strafregister')}
     <div class="judge-case">
       <div class="case-grid">
         <div><span>Trainerpass</span><b>${strikeWord(total)}</b></div>
         <div><span>Auf der Tafel</span><b>${fmtNum(Math.min(boardOpen(userId), FINE_STRIKES))} / ${FINE_STRIKES}</b></div>
         <div><span>Bezahlt</span><b>${settledFines(userId)} × 10 €</b></div>
         <div><span>Zurückgezogen</span><b>${list.filter((s) => s.status === 'withdrawn').length}</b></div>
       </div>
       ${list.length ? `<ul class="dossier">${list.map((s) => `<li><button type="button" class="dossier-row status-${esc(s.status)}" data-strike="${esc(s.id)}">
           <span class="d-title">${esc(s.title)}${s.hasPhoto ? ' 📷' : ''}</span>
           <span class="d-val">${s.status === 'withdrawn' ? `<s>${strikeWord(s.value)}</s>` : strikeWord(s.value)}</span>
           <span class="d-meta">${esc(formatDateTime(s.createdAt))} · von ${esc(nameOf(s.givenBy, 'automatisch'))} · ${esc(strikeStatusLabel(s))}</span>
         </button></li>`).join('')}</ul>` : '<p class="hint">Eine weiße Weste – noch keine Striche.</p>'}
       ${fines.length ? `<div class="case-row"><span>Strafen</span><ol class="timeline">${fines.map((f) => `<li class="tl-${f.settledAt ? 'acknowledged' : 'appealed'}">
           <span class="tl-dot" aria-hidden="true">💶</span>
           <div class="tl-body"><div class="tl-head"><b>10 € ${f.settledAt ? 'bezahlt' : 'fällig'}</b></div>
             ${f.confirmations.map((c) => `<div class="tl-extra">✓ bestätigt von ${esc(nameOf(c.by))} · <time>${esc(formatDateTime(c.at))} Uhr</time></div>`).join('')}
             ${f.settledAt ? `<div class="tl-extra">🧽 Von der Tafel gewischt · <time>${esc(formatDateTime(f.settledAt))} Uhr</time></div>` : ''}
           </div></li>`).join('')}</ol></div>` : ''}
     </div>`,
    {
      cls: 'judge',
      onMount: (modal, close) => {
        modal.querySelectorAll('[data-strike]').forEach((b) => b.addEventListener('click', () => {
          close();
          openStrikeDetail(b.dataset.strike);
        }));
      },
    }
  );
}

/* -------------------------------------------------------------------------
 * Rendering & Navigation
 * ---------------------------------------------------------------------- */

function render() {
  const view = $('#view');
  $('#tab-title').textContent = TABS[state.tab];
  document.title = state.tab === 'start' ? 'Familie' : `${TABS[state.tab]} · Familie`;
  document.querySelectorAll('.tabbar [data-tab]').forEach((b) => {
    const active = b.dataset.tab === state.tab;
    b.classList.toggle('active', active);
    if (active) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  $('#fab').hidden = !((state.tab === 'start' || state.tab === 'notizen') && state.me);
  $('#fab').setAttribute('aria-label', state.tab === 'notizen' ? 'Neue Notiz' : 'Neue Nachricht');

  if (!configured) {
    view.innerHTML = `<div class="empty"><div class="big">🛠️</div><h2>Noch nicht eingerichtet</h2><p>In <code>config.js</code> fehlen die Supabase-Zugangsdaten. Siehe Anleitung in der README.</p></div>`;
    return;
  }

  switch (state.tab) {
    case 'start': return renderAustausch(view);
    case 'einstellungen': return renderSettings(view);
    case 'notizen': return renderNotes(view);
    case 'kalender': return renderCalendar(view);
    case 'schande': return renderBoard(view);
    case 'team': return renderTeam(view);
  }
}

function setTab(tab) {
  tab = TAB_ALIASES[tab] || tab;
  if (!TABS[tab]) return;
  state.tab = tab;
  const url = new URL(location.href);
  url.searchParams.set('tab', tab);
  url.searchParams.delete('msg');
  url.searchParams.delete('note');
  url.searchParams.delete('event');
  url.searchParams.delete('code');
  history.replaceState(null, '', url);
  render();
  window.scrollTo(0, 0);
  // kurzer Bildwechsel wie beim Szenenwechsel im Spiel
  const v = $('#view');
  v.classList.remove('scene-in');
  void v.offsetWidth;
  v.classList.add('scene-in');
}

/* -------------------------------------------------------------------------
 * Daten laden & Live-Updates
 * ---------------------------------------------------------------------- */

async function loadUsers() {
  state.users = must(await sb.from('profiles').select('*')).map(mapProfile);
  const me = state.me && userById(state.me.id);
  if (me) state.me = me;
}

async function loadMessages() {
  const [msgs, resps, comments] = await Promise.all([
    sb.from('messages').select('*').order('created_at', { ascending: false }),
    sb.from('message_responses').select('*'),
    sb.from('message_comments').select('*').order('created_at', { ascending: true }),
  ]);
  state.messages = must(msgs).map(mapMessage);
  state.responses = new Map();
  for (const r of must(resps)) setResponse(r);
  state.comments = new Map();
  for (const c of must(comments)) addComment(mapComment(c));
}

async function loadBoard() {
  const [strikes, rules, fines] = await Promise.all([
    sb.from('strikes').select('*').order('created_at', { ascending: false }),
    sb.from('strike_rules').select('*').order('created_at', { ascending: true }),
    sb.from('fines').select('*').order('created_at', { ascending: false }),
  ]);
  state.strikes = must(strikes).map(mapStrike);
  state.rules = must(rules).map(mapRule);
  state.fines = must(fines).map(mapFine);
  state.boardLoaded = true;
}

async function loadFamilyCode() {
  state.familyCode = must(await sb.rpc('get_family_code'));
}

async function refreshAll() {
  try {
    await Promise.all([loadUsers(), loadMessages(), loadBoard(), loadNotes(), loadEvents()]);
    renderProfileButton();
    render();
    checkVerdicts();
  } catch (e) {
    toast(e.message);
  }
}

// Termine neu laden (gebündelt, falls mehrere Änderungen gleichzeitig kommen)
let eventsReload = null;
function refreshEvents() {
  clearTimeout(eventsReload);
  eventsReload = setTimeout(async () => {
    await loadEvents().catch(() => {});
    if ((state.tab === 'kalender' || state.tab === 'start') && !document.querySelector('.modal-backdrop:not(.bd-ev-modal)')) render();
    document.querySelectorAll('.modal.ev-modal').forEach((m) => m.dispatchEvent(new Event('event-remote')));
  }, 250);
}

let channel;
function startRealtime() {
  if (channel) return;
  channel = sb
    .channel('familie')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, ({ new: row }) => {
      const m = mapMessage(row);
      const known = state.messages.some((x) => x.id === m.id);
      upsertMessage(m);
      const author = userById(m.authorId);
      if (!known && state.me && m.authorId !== state.me.id && document.visibilityState === 'visible') {
        toast(`💬 ${author ? fullName(author) : 'Neu'}: ${m.title}`, () => {
          state.highlight = m.id;
          setTab('start');
        });
      }
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, ({ new: row }) => {
      const before = state.messages.find((x) => x.id === row.id);
      const m = mapMessage(row);
      upsertMessage(m);
      if (before && !before.doneBy && m.doneBy && state.me && m.authorId === state.me.id) {
        const who = userById(m.doneBy);
        toast(`✓ ${who ? who.firstName : 'Jemand'} hat „${m.title}“ erledigt`);
      }
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, ({ old }) => removeMessage(old.id))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'message_responses' }, ({ eventType, new: row, old }) => {
      if (eventType === 'DELETE') {
        for (const [mid, list] of state.responses) state.responses.set(mid, list.filter((x) => !(x.userId === old.user_id && mid === old.message_id)));
        if (old.message_id) rerenderMessage(old.message_id);
        return;
      }
      setResponse(row);
      rerenderMessage(row.message_id);
      const m = state.messages.find((x) => x.id === row.message_id);
      if (m && state.me && m.authorId === state.me.id && row.user_id !== state.me.id && document.visibilityState === 'visible') {
        const u = userById(row.user_id);
        toast(`✉️ ${u ? u.firstName : 'Jemand'}: ${row.option} – „${m.title}“`);
      }
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'message_comments' }, ({ new: row }) => {
      addComment(mapComment(row));
      rerenderMessage(row.message_id);
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'message_comments' }, ({ old }) => removeComment(old.id))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, async () => {
      await loadUsers().catch(() => {});
      renderProfileButton();
      if (state.tab === 'team' || state.tab === 'start' || state.tab === 'schande') render();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'strikes' }, ({ eventType, new: row, old }) => {
      if (eventType === 'DELETE') state.strikes = state.strikes.filter((x) => x.id !== old.id);
      else upsertBy(state.strikes, mapStrike(row), true);
      if (state.tab === 'schande') render();
      checkVerdicts();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'events' }, () => refreshEvents())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'event_invites' }, () => refreshEvents())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'event_comments' }, () => refreshEvents())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'notes' }, async () => {
      await loadNotes().catch(() => {});
      const ed = document.querySelector('.modal.note-modal');
      if (ed) ed.dispatchEvent(new Event('note-remote'));
      else if (state.tab === 'notizen') render();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'strike_rules' }, ({ eventType, new: row, old }) => {
      if (eventType === 'DELETE') state.rules = state.rules.filter((x) => x.id !== old.id);
      else upsertBy(state.rules, mapRule(row));
      if (state.tab === 'schande') render();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'fines' }, ({ eventType, new: row, old }) => {
      if (eventType === 'DELETE') state.fines = state.fines.filter((x) => x.id !== old.id);
      else upsertBy(state.fines, mapFine(row), true);
      if (state.tab === 'schande') render();
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') refreshAll();
    });
}

// Countdown-Anzeigen aktualisieren & abgelaufene Nachrichten lokal ausblenden
// Nur Zeitangaben aktualisieren statt alles neu zu zeichnen – sonst springen die Meldungen
setInterval(() => {
  if (!state.me || (state.tab !== 'start' && state.tab !== 'notizen')) return;
  const expired = state.messages.some((m) => m.deleteAt && Date.parse(m.deleteAt) <= Date.now() && document.getElementById(`msg-${m.id}`));
  if (expired && !$('.modal-backdrop')) { render(); return; }
  document.querySelectorAll('#view [data-rel]').forEach((el) => {
    const t = relative(el.dataset.rel);
    if (el.textContent !== t) el.textContent = t;
  });
}, 30_000);

// iOS beendet Verbindungen im Hintergrund – beim Zurückkehren neu laden
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') pollForUpdate();
  if (document.visibilityState === 'visible' && state.me) refreshAll();
});

/* -------------------------------------------------------------------------
 * Start
 * ---------------------------------------------------------------------- */

async function startApp() {
  renderProfileButton();
  await Promise.all([loadUsers(), loadMessages(), loadFamilyCode(), loadBoard(), loadNotes(), loadEvents()]).catch((e) => toast(e.message));
  if (state.openNote) { const id = state.openNote; state.openNote = null; openNoteById(id); }
  if (state.openEvent) { const id = state.openEvent; state.openEvent = null; openEventById(id); }
  renderProfileButton();
  render();
  checkVerdicts();
  if (hsvEnabled()) { state.hsvRequested = true; loadHsv(); }
  startRealtime();
  syncPushSubscription();
  if (!state.me.gender) openEditProfile();
  else if (!lsGet('familie.introSeen', false)) {
    lsSet('familie.introSeen', true);
    setTimeout(() => dsSay('', { speaker: 'Prof. Familie', pages: [
      `Hallo ${state.me.firstName}! Willkommen in der Welt der Familie!`,
      'Auf START siehst du alles, was heute, morgen und diese Woche ansteht – Meldungen, Infos und Termine.',
      'Mit dem ＋ unten rechts legst du eine Info, eine Meldung oder einen Termin an.',
      'Über den X-Knopf erreichst du Team, Notizen, Kalender und das gefürchtete Board der Schande.',
      'Siehst du ein ?, tippe darauf – dann erkläre ich dir, was es damit auf sich hat. Viel Spaß!',
    ] }), 600);
  }
}

async function init() {
  $('#fab').addEventListener('click', () => (state.tab === 'notizen' ? openNoteEditor() : openCreateMenu()));
  $('#update-btn').addEventListener('click', checkForUpdate);
  setupMenu();
  darkQuery.addEventListener('change', syncThemeToggle);
  syncThemeToggle();
  pollForUpdate();
  setInterval(pollForUpdate, 5 * 60_000);

  const params = new URLSearchParams(location.search);
  const startTab = TAB_ALIASES[params.get('tab')] || params.get('tab');
  if (TABS[startTab]) state.tab = startTab;
  if (params.get('msg')) state.highlight = params.get('msg');
  if (params.get('note')) state.openNote = params.get('note');
  if (params.get('event')) state.openEvent = params.get('event');

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch((e) => console.warn('SW-Registrierung fehlgeschlagen', e));
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'open-message') {
        const id = String(e.data.id || '');
        if (id.startsWith('note-')) { setTab('notizen'); openNoteById(id.slice(5)); return; }
        if (id.startsWith('event-')) { openEventById(id.slice(6)); return; }
        if (/^(strike|board)-/.test(id)) { setTab('schande'); return; }
        state.highlight = id.replace(/^(done|resp|comment|review|start|frist)-/, '').slice(0, 36);
        setTab('start');
      }
    });
  }

  if (!configured) { render(); return; }

  sb.auth.onAuthStateChange((_event, session) => { state.session = session; });
  state.session = (await sb.auth.getSession()).data.session;

  if (state.session) {
    try {
      const row = must(await sb.from('profiles').select('*').eq('id', state.session.user.id).maybeSingle());
      if (row) state.me = mapProfile(row);
    } catch (e) {
      toast(e.message);
    }
  }

  if (!state.me) {
    render();
    if (isIos && !isStandalone) openInstallGuide();
    else openSetup();
    return;
  }

  await startApp();
}

init();
