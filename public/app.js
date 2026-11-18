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
    strikes: r.strikes || 0,
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
    deleteAt: r.delete_at,
    createdAt: r.created_at,
  };
}

function userById(id) {
  return state.users.find((u) => u.id === id);
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

function strikesLabel(n) {
  if (!n) return '0';
  if (n > 15) return String(n);
  const tally = ('||||/ '.repeat(Math.floor(n / 5)) + '|'.repeat(n % 5)).trim();
  return `${tally} (${n})`;
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

function openModal(html, { dismissible = true, onMount, full = false } = {}) {
  const root = $('#modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal${full ? ' full' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  root.appendChild(backdrop);
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
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

function messageHtml(m) {
  const mine = state.me && m.authorId === state.me.id;
  const author = userById(m.authorId);
  return `
  <article class="msg u-${esc(m.urgency)}${state.highlight === m.id ? ' flash' : ''}${author && PORTRAITS[author.gender] ? ' has-portrait' : ''}" id="msg-${esc(m.id)}">
    <div class="msg-body">
    <div class="msg-head">${ballSvg(urgencyInfo(m.urgency).ball, 26)}<span class="badge">${esc(urgencyLabel(m.urgency))}</span></div>
    <h3>${esc(m.title)}</h3>
    ${m.description ? `<p class="desc">${esc(m.description)}</p>` : ''}
    <div class="msg-meta">
      <span class="author"><span class="dot" style="--c:${esc(author ? author.color : '#888888')}"></span>${esc(author ? fullName(author) : 'Unbekannt')} · <span data-rel="${esc(m.createdAt)}">${esc(relative(m.createdAt))}</span></span>
      ${m.eventAt ? `<span>🕒 Zeitpunkt: ${esc(formatDateTime(m.eventAt))}</span>` : ''}
      ${m.deleteAt ? `<span>🗑️ Löscht sich <span data-rel="${esc(m.deleteAt)}">${esc(relative(m.deleteAt))}</span> (${esc(formatDateTime(m.deleteAt))})</span>` : ''}
    </div>
    <div class="msg-actions">
      <a class="btn small" href="${esc(icsUrl(m))}" target="_blank" rel="noopener" title="In Kalender übernehmen">📅 In Kalender</a>
      ${mine ? `<button class="btn small danger" data-delete="${esc(m.id)}">Löschen</button>` : ''}
    </div>
    </div>
    ${author && PORTRAITS[author.gender] ? `<img class="msg-portrait" src="${PORTRAITS[author.gender]}" alt="${esc(fullName(author))}">` : ''}
  </article>`;
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
  const list = visible.length
    ? `<div class="msg-list">${visible.map(messageHtml).join('')}</div>`
    : `<div class="empty"><div class="big">💬</div><h2>Noch nichts im Austausch</h2><p>Tippe auf <b>+</b>, um eine Nachricht an alle zu schicken.</p></div>`;
  view.innerHTML = banner + list;

  const pushBtn = $('#enable-push', view);
  if (pushBtn) pushBtn.addEventListener('click', enablePush);

  view.querySelectorAll('[data-delete]').forEach((b) =>
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

  if (state.highlight) {
    const el = document.getElementById(`msg-${state.highlight}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    state.highlight = null;
  }
}

function openNewMessage() {
  const now = new Date();
  const presets = [
    { label: 'Nie', fn: () => '' },
    { label: 'In 1 Stunde', fn: () => toLocalInput(new Date(Date.now() + 3600e3)) },
    { label: 'Heute Abend', fn: () => { const d = new Date(); d.setHours(23, 59, 0, 0); return toLocalInput(d); } },
    { label: 'Morgen', fn: () => toLocalInput(new Date(Date.now() + 86400e3)) },
    { label: 'In 1 Woche', fn: () => toLocalInput(new Date(Date.now() + 7 * 86400e3)) },
    { label: 'Nach Zeitpunkt', fn: (form) => {
      const v = form.elements.eventAt.value;
      if (!v) return null;
      return toLocalInput(new Date(new Date(v).getTime() + 3600e3));
    } },
  ];

  openModal(
    `<div class="modal-head"><h2>Neue Nachricht</h2><button class="icon-btn" data-close aria-label="Schließen">✕</button></div>
     <form class="form" id="msg-form" novalidate>
       <fieldset class="field">
         <legend>Dringlichkeit</legend>
         <div class="segmented">
           ${URGENCIES.map((u) => `<label class="u-${u.key}" style="--u:var(--u-${u.key})" title="${u.ballName}"><input type="radio" name="urgency" value="${u.key}"${u.key === 'normal' ? ' checked' : ''}><span>${ballSvg(u.ball, 28)}<em>${u.label}</em></span></label>`).join('')}
         </div>
       </fieldset>
       <label class="field"><span>Titel</span><input name="title" required maxlength="120" placeholder="Worum geht's?"></label>
       <label class="field"><span>Beschreibung</span><textarea name="description" maxlength="4000" placeholder="Details …"></textarea></label>
       <label class="field"><span>Urheber</span><input value="${esc(fullName(state.me))}" readonly></label>
       <label class="field"><span>Zeitpunkt</span><input name="eventAt" type="datetime-local" value="${toLocalInput(now)}"></label>
       <div class="field">
         <span>Automatisch löschen am</span>
         <input name="deleteAt" type="datetime-local" min="${toLocalInput(now)}">
         <div class="chips">${presets.map((p, i) => `<button type="button" class="chip${i === 0 ? ' active' : ''}" data-preset="${i}">${p.label}</button>`).join('')}</div>
         <p class="hint">Die Nachricht verschwindet zu diesem Zeitpunkt für alle.</p>
       </div>
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
          const chip = e.target.closest('[data-preset]');
          if (!chip) return;
          const i = Number(chip.dataset.preset);
          const v = presets[i].fn(form);
          if (v === null) { toast('Bitte zuerst einen Zeitpunkt wählen.'); return; }
          form.elements.deleteAt.value = v;
          setActive(i);
        });
        form.elements.deleteAt.addEventListener('input', () => setActive(form.elements.deleteAt.value ? -1 : 0));
        if (!isIos) form.elements.title.focus();
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const f = new FormData(form);
          const err = $('#msg-error', modal);
          const toIso = (v) => (v ? new Date(v).toISOString() : null);
          const title = f.get('title').trim();
          const deleteAt = toIso(f.get('deleteAt'));
          err.textContent = '';
          if (!title) { err.textContent = 'Bitte einen Titel angeben.'; return; }
          if (deleteAt && Date.parse(deleteAt) <= Date.now()) { err.textContent = 'Das Löschdatum muss in der Zukunft liegen.'; return; }
          const btn = form.querySelector('[type=submit]');
          btn.disabled = true;
          try {
            const row = must(await sb.from('messages').insert({
              urgency: f.get('urgency'),
              title,
              description: f.get('description').trim(),
              event_at: toIso(f.get('eventAt')),
              delete_at: deleteAt,
            }).select().single());
            upsertMessage(mapMessage(row));
            close();
            sb.functions.invoke('push', { body: { action: 'notify', messageId: row.id } })
              .then((r) => r.error && console.warn('Benachrichtigung fehlgeschlagen', r.error));
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
  if (state.tab === 'start') render();
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

function renderTeam(view) {
  const users = state.users.slice().sort((a, b) => fullName(a).localeCompare(fullName(b), 'de'));
  const grid = `<div class="team-grid">${users
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
  view.innerHTML = grid + invite + version;
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

function setupMenu() {
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
        <div><b>Benachrichtigungen</b><p class="hint">${pushState}</p></div>
        ${pushSupported && Notification.permission === 'default' ? '<button class="btn small primary" id="set-push">Aktivieren</button>' : ''}
      </div>
      ${state.me ? `<div class="setting-row">
        <div><b>Profil</b><p class="hint">${esc(fullName(state.me))}</p></div>
        <button class="btn small" id="set-profile">Bearbeiten</button>
      </div>` : ''}
      <div class="setting-row">
        <div><b>App-Version</b><p class="hint">${esc(CFG.version || 'dev')}</p></div>
        <button class="btn small" id="set-update">Nach Updates suchen</button>
      </div>
    </div>`;
  $('#theme-toggle', view).addEventListener('click', () => { toggleTheme(); render(); });
  const push = $('#set-push', view); if (push) push.addEventListener('click', enablePush);
  const prof = $('#set-profile', view); if (prof) prof.addEventListener('click', openEditProfile);
  $('#set-update', view).addEventListener('click', checkForUpdate);
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
 * Rendering & Navigation
 * ---------------------------------------------------------------------- */

function render() {
  const view = $('#view');
  $('#tab-title').textContent = TABS[state.tab];
  document.title = state.tab === 'start' ? 'Familie' : `${TABS[state.tab]} · Familie`;
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
    case 'schande': return renderPlaceholder(view, '😈', 'Board der Schande', 'Hier werden bald Striche verteilt – sie landen dann auf dem Trainerpass.');
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
  state.messages = must(await sb.from('messages').select('*').order('created_at', { ascending: false })).map(mapMessage);
}

async function loadFamilyCode() {
  state.familyCode = must(await sb.rpc('get_family_code'));
}

async function refreshAll() {
  try {
    await Promise.all([loadUsers(), loadMessages()]);
    renderProfileButton();
    render();
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
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, ({ old }) => removeMessage(old.id))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, async () => {
      await loadUsers().catch(() => {});
      renderProfileButton();
      if (state.tab === 'team' || state.tab === 'start') render();
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
  await Promise.all([loadUsers(), loadMessages(), loadFamilyCode()]).catch((e) => toast(e.message));
  renderProfileButton();
  render();
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
