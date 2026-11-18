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

function toast(text, onClick) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
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
  deadline: 'Bis wann etwas erledigt sein muss. Die Deadline steht gut sichtbar in der Meldung.',
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
  openModal(
    `<div class="modal-head"><h2>Erklärung</h2><button class="icon-btn" data-close aria-label="Schließen">✕</button></div>
     <p class="help-text">${esc(HELP[key] || '')}</p>
     <div class="modal-actions"><button class="btn primary" data-close>Verstanden</button></div>`
  );
}

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
        ${m.eventAt ? `<span>🕒 ${esc(formatRange(m.eventAt, m.endAt))}${m.remindAtStart ? ' <span title="Erinnerung zum Beginn">🔔</span>' : ''}</span>` : ''}
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
      if (!confirm('Nachricht wirklich löschen?')) return;
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
  if (!confirm('Kommentar löschen?')) return;
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
  let list;
  if (!visible.length) {
    list = `<div class="empty"><div class="big">💬</div><h2>Noch nichts im Austausch</h2><p>Tippe auf <b>+</b>, um eine Nachricht an alle zu schicken.</p></div>`;
  } else {
    const groups = Object.fromEntries(SECTIONS.map((sec) => [sec.key, []]));
    for (const m of visible) groups[sectionOf(m)].push(m);
    if (state.highlight) { const hm = visible.find((m) => m.id === state.highlight); if (hm) prefs.sections[sectionOf(hm)] = true; }
    list = SECTIONS.filter((sec) => groups[sec.key].length).map((sec) => {
      const items = groups[sec.key].sort(compareMessages);
      const open = sectionOpen(sec);
      const unread = items.reduce((n, m) => n + unreadComments(m), 0);
      return `<section class="msg-section${open ? ' open' : ''}" data-section="${sec.key}">
        <button type="button" class="section-head" aria-expanded="${open}">
          <span class="section-title">${sec.label}</span>
          <span class="section-count">${items.length}</span>${unread ? '<span class="section-dot" title="Neue Kommentare"></span>' : ''}
          <span class="section-chevron" aria-hidden="true">▾</span>
        </button>
        <div class="msg-list">${open ? items.map(messageHtml).join('') : ''}</div>
      </section>`;
    }).join('');
  }
  view.innerHTML = banner + list;
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

function openNewMessage() {
  const now = new Date();
  const presets = [
    { label: 'In 1 Stunde', fn: () => toLocalInput(new Date(Date.now() + 3600e3)) },
    { label: 'Heute Abend', fn: () => { const d = new Date(); d.setHours(23, 59, 0, 0); return toLocalInput(d); } },
    { label: 'Morgen', fn: () => toLocalInput(new Date(Date.now() + 86400e3)) },
    { label: 'In 1 Woche', fn: () => toLocalInput(new Date(Date.now() + 7 * 86400e3)) },
    { label: 'Nach Ereignis', fn: (form) => {
      const v = form.elements.endAt.value || form.elements.eventAt.value;
      if (!v) return null;
      return toLocalInput(new Date(new Date(v).getTime() + 3600e3));
    } },
  ];

  openModal(
    `<div class="modal-head"><h2>Neue Nachricht</h2><button class="icon-btn" data-close aria-label="Schließen">✕</button></div>
     <form class="form" id="msg-form" novalidate>
       <fieldset class="field">
         <div class="field-head"><legend>Dringlichkeit</legend>${bellToggle('notify', true, 'Beim Absenden benachrichtigen')}${helpBtn('notify')}</div>
         <div class="segmented">
           ${URGENCIES.map((u) => `<label class="u-${u.key}" style="--u:var(--u-${u.key})" title="${u.ballName}"><input type="radio" name="urgency" value="${u.key}"${u.key === 'normal' ? ' checked' : ''}><span>${ballSvg(u.ball, 28)}<em>${u.label}</em></span></label>`).join('')}
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
         <div class="toggle-row strike-row"><span>😈 Strich androhen?</span>${helpBtn('strike')}${switchToggle('threatStrike')}</div>
       </div>
       <div class="toggle-row"><span>Automatisch löschen?</span>${helpBtn('autoDelete')}${switchToggle('autoDelete')}</div>
       <div class="field" id="auto-delete-box" hidden>
         <input name="deleteAt" type="datetime-local" min="${toLocalInput(now)}" aria-label="Automatisch löschen am">
         <div class="chips">${presets.map((p, i) => `<button type="button" class="chip" data-preset="${i}">${p.label}</button>`).join('')}</div>
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
        const chips = [...form.querySelectorAll('.chip')];
        const setActive = (i) => chips.forEach((c, j) => c.classList.toggle('active', j === i));
        form.addEventListener('click', (e) => {
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
          const help = e.target.closest('[data-help]');
          if (help) { e.preventDefault(); showHelp(help.dataset.help); return; }
          const chip = e.target.closest('[data-preset]');
          if (!chip) return;
          const i = Number(chip.dataset.preset);
          const v = presets[i].fn(form);
          if (v === null) { toast('Bitte zuerst einen Zeitpunkt wählen.'); return; }
          form.elements.deleteAt.value = v;
          setActive(i);
        });
        form.elements.deleteAt.addEventListener('input', () => setActive(-1));
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
            form.elements.deleteAt.value = presets[2].fn(form); setActive(2);
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
        <div><b>App-Version</b><p class="hint">${esc(CFG.version || 'dev')}</p></div>
        <button class="btn small" id="set-update">Nach Updates suchen</button>
      </div>
    </div>`;
  $('#theme-toggle', view).addEventListener('click', () => { toggleTheme(); render(); });
  const push = $('#set-push', view); if (push) push.addEventListener('click', enablePush);
  const prof = $('#set-profile', view); if (prof) prof.addEventListener('click', openEditProfile);
  const card = $('#set-card', view); if (card) card.addEventListener('click', () => openTrainerCard(state.me));
  $('#set-update', view).addEventListener('click', checkForUpdate);
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
  view.innerHTML = `<div class="empty"><div class="big">${icon}</div><h2>${esc(title)}</h2><p>${esc(text)}</p></div>`;
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
  if (fn === 'reject_rule' && !confirm('Diesen Vorschlag wirklich verwerfen?')) return;
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
  if (!confirm(`Bestätigst du, dass ${u ? u.firstName : 'die Person'} die 10 € bezahlt hat?`)) return;
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
  $('#fab').hidden = !(state.tab === 'start' && state.me);

  if (!configured) {
    view.innerHTML = `<div class="empty"><div class="big">🛠️</div><h2>Noch nicht eingerichtet</h2><p>In <code>config.js</code> fehlen die Supabase-Zugangsdaten. Siehe Anleitung in der README.</p></div>`;
    return;
  }

  switch (state.tab) {
    case 'start': return renderAustausch(view);
    case 'einstellungen': return renderSettings(view);
    case 'notizen': return renderPlaceholder(view, '📝', 'Notizen', 'Dieser Bereich kommt im nächsten Schritt.');
    case 'kalender': return renderPlaceholder(view, '📅', 'Kalender', 'Dieser Bereich kommt im nächsten Schritt.');
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
  url.searchParams.delete('code');
  history.replaceState(null, '', url);
  render();
  window.scrollTo(0, 0);
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
    await Promise.all([loadUsers(), loadMessages(), loadBoard()]);
    renderProfileButton();
    render();
    checkVerdicts();
  } catch (e) {
    toast(e.message);
  }
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
  if (!state.me || state.tab !== 'start') return;
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
  await Promise.all([loadUsers(), loadMessages(), loadFamilyCode(), loadBoard()]).catch((e) => toast(e.message));
  renderProfileButton();
  render();
  checkVerdicts();
  startRealtime();
  syncPushSubscription();
  if (!state.me.gender) openEditProfile();
}

async function init() {
  $('#fab').addEventListener('click', openNewMessage);
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

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch((e) => console.warn('SW-Registrierung fehlgeschlagen', e));
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'open-message') {
        state.highlight = e.data.id;
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
