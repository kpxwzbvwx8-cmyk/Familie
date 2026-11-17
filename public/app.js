'use strict';

/* =========================================================================
 * Familie – Client
 * ======================================================================= */

const TOKEN_KEY = 'familie.token';

const state = {
  token: localStorage.getItem(TOKEN_KEY),
  me: null,
  users: [],
  messages: [],
  tab: 'austausch',
  highlight: null,
};

const TABS = {
  austausch: 'Austausch',
  notizen: 'Notizen',
  kalender: 'Kalender',
  schande: 'Board der Schande',
  team: 'Team',
};

const URGENCIES = [
  { key: 'info', label: 'Info' },
  { key: 'normal', label: 'Normal' },
  { key: 'wichtig', label: 'Wichtig' },
  { key: 'dringend', label: 'Dringend' },
];

const COLOR_PRESETS = [
  '#d63b3b', '#e8772e', '#f2c12e', '#4caf50', '#1fa39a',
  '#2f80ed', '#6a4fd6', '#c04fc9', '#e85d9c', '#8d6e63', '#546e7a',
];

const $ = (sel, root = document) => root.querySelector(sel);

/* -------------------------------------------------------------------------
 * Hilfsfunktionen
 * ---------------------------------------------------------------------- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Fehler ${res.status}`), { status: res.status });
  return data;
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
function colorVars(hex) {
  return `--c:${hex};--c-dark:${mix(hex, '#000000', 0.45)};--c-light:${mix(hex, '#ffffff', 0.55)};`;
}

function initials(u) {
  return ((u.firstName || '?')[0] + (u.lastName || '')[0]).toUpperCase();
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

  return `
  <article class="tcard" style="${colorVars(u.color || '#d63b3b')}" aria-label="Trainerpass von ${esc(name)}">
    <div class="tcard-head"><span class="ball"></span>TRAINERPASS<span class="ball"></span></div>
    <div class="tcard-top">
      <div class="tcard-rows">
        <div class="trow"><span class="k">ID Nr.</span><span class="v">${esc(u.trainerId || '?????')}</span></div>
        <div class="trow"><span class="k">Trainer</span><span class="v">${esc(name)}</span></div>
        <div class="trow strikes"><span class="k">Striche</span><span class="v">${esc(strikesLabel(u.strikes || 0))}</span></div>
      </div>
      <div class="tcard-avatar">
        ${TRAINER_SVG}
        <span class="initials">${esc(initials(u))}</span>
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

function openModal(html, { dismissible = true, onMount } = {}) {
  const root = $('#modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
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

function profileFormHtml(u) {
  const color = u.color || COLOR_PRESETS[0];
  return `
  <form class="form" id="profile-form" novalidate>
    <div class="preview-wrap" id="card-preview">${trainerCardHtml({ ...u, color })}</div>
    <div class="row2">
      <label class="field"><span>Vorname</span>
        <input name="firstName" autocomplete="given-name" required maxlength="40" value="${esc(u.firstName || '')}"></label>
      <label class="field"><span>Nachname</span>
        <input name="lastName" autocomplete="family-name" required maxlength="40" value="${esc(u.lastName || '')}"></label>
    </div>
    <label class="field"><span>Geburtsdatum</span>
      <input name="birthday" type="date" required value="${esc(u.birthday || '')}" max="${toLocalInput(new Date()).slice(0, 10)}"></label>
    <fieldset class="field">
      <legend>Lieblingsfarbe</legend>
      <div class="swatches">
        ${COLOR_PRESETS.map((c) => `<button type="button" class="swatch${c === color ? ' active' : ''}" data-color="${c}" style="background:${c}" aria-label="Farbe ${c}"></button>`).join('')}
        <label class="swatch-custom" title="Eigene Farbe"><input type="color" name="customColor" value="${esc(color)}" aria-label="Eigene Farbe"></label>
      </div>
      <input type="hidden" name="color" value="${esc(color)}">
    </fieldset>
    <p class="error" id="profile-error"></p>
    <div class="modal-actions">
      ${u.id ? '<button type="button" class="btn" data-close>Abbrechen</button>' : ''}
      <button type="submit" class="btn primary">${u.id ? 'Speichern' : 'Konto einrichten'}</button>
    </div>
  </form>`;
}

function mountProfileForm(modal, close, base) {
  const form = $('#profile-form', modal);
  const preview = $('#card-preview', modal);
  const read = () => {
    const f = new FormData(form);
    return {
      ...base,
      firstName: f.get('firstName').trim(),
      lastName: f.get('lastName').trim(),
      birthday: f.get('birthday'),
      color: f.get('color'),
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
    else refresh();
  });
  form.addEventListener('click', (e) => {
    const sw = e.target.closest('.swatch');
    if (sw) setColor(sw.dataset.color);
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = read();
    const err = $('#profile-error', modal);
    err.textContent = '';
    try {
      const body = { firstName: data.firstName, lastName: data.lastName, birthday: data.birthday, color: data.color };
      if (base.id) {
        state.me = await api('/api/me', { method: 'PUT', body });
      } else {
        const res = await api('/api/users', { method: 'POST', body });
        state.token = res.token;
        localStorage.setItem(TOKEN_KEY, res.token);
        state.me = res.user;
        startStream();
      }
      close();
      await loadUsers();
      renderProfileButton();
      render();
    } catch (ex) {
      err.textContent = ex.message;
    }
  });
}

function openSetup() {
  openModal(
    `<div class="modal-head"><h2>Willkommen! 👋</h2></div>
     <p class="setup-intro">Richte dein Konto ein. Daraus entsteht dein persönlicher Trainerpass – die Lieblingsfarbe wird zur Farbe deines Passes.</p>
     ${profileFormHtml({})}`,
    { dismissible: false, onMount: (m, c) => mountProfileForm(m, c, {}) }
  );
}

function openEditProfile() {
  openModal(
    `<div class="modal-head"><h2>Profil bearbeiten</h2><button class="icon-btn" data-close aria-label="Schließen">✕</button></div>
     ${profileFormHtml(state.me)}`,
    { onMount: (m, c) => mountProfileForm(m, c, state.me) }
  );
}

function openTrainerCard(user) {
  const isMe = state.me && user.id === state.me.id;
  openModal(
    `<div class="modal-head"><h2>${isMe ? 'Mein Trainerpass' : 'Trainerpass'}</h2><button class="icon-btn" data-close aria-label="Schließen">✕</button></div>
     ${trainerCardHtml(user)}
     ${isMe ? '<div class="modal-actions"><button class="btn" id="edit-profile">Profil bearbeiten</button></div>' : ''}`,
    {
      onMount: (modal, close) => {
        const btn = $('#edit-profile', modal);
        if (btn) btn.addEventListener('click', () => { close(); openEditProfile(); });
      },
    }
  );
}

function renderProfileButton() {
  const btn = $('#profile-btn');
  if (!state.me) { btn.hidden = true; return; }
  btn.hidden = false;
  btn.textContent = initials(state.me);
  btn.style.setProperty('--user-color', state.me.color);
}

/* -------------------------------------------------------------------------
 * Benachrichtigungen
 * ---------------------------------------------------------------------- */

const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function enablePush() {
  if (!pushSupported) {
    toast('Dieses Gerät/dieser Browser unterstützt keine Push-Benachrichtigungen. Auf dem iPhone: App zuerst zum Home-Bildschirm hinzufügen.');
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    toast('Benachrichtigungen wurden nicht erlaubt.');
    render();
    return;
  }
  await syncPushSubscription();
  toast('Benachrichtigungen sind aktiv 🔔');
  render();
}

async function syncPushSubscription() {
  if (!pushSupported || Notification.permission !== 'granted' || !state.token) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { publicKey } = await api('/api/push/key');
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
    }
    await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
  } catch (e) {
    console.warn('Push-Anmeldung fehlgeschlagen', e);
  }
}

/* -------------------------------------------------------------------------
 * Austausch
 * ---------------------------------------------------------------------- */

function urgencyLabel(key) {
  return (URGENCIES.find((u) => u.key === key) || URGENCIES[1]).label;
}

function messageHtml(m) {
  const mine = state.me && m.authorId === state.me.id;
  const ics = `/api/messages/${encodeURIComponent(m.id)}.ics?t=${encodeURIComponent(state.token)}`;
  return `
  <article class="msg u-${esc(m.urgency)}${state.highlight === m.id ? ' flash' : ''}" id="msg-${esc(m.id)}">
    <div class="msg-head"><span class="badge">${esc(urgencyLabel(m.urgency))}</span></div>
    <h3>${esc(m.title)}</h3>
    ${m.description ? `<p class="desc">${esc(m.description)}</p>` : ''}
    <div class="msg-meta">
      <span class="author"><span class="dot" style="--c:${esc(m.authorColor)}"></span>${esc(m.authorName)} · ${esc(relative(m.createdAt))}</span>
      ${m.eventAt ? `<span>🕒 Zeitpunkt: ${esc(formatDateTime(m.eventAt))}</span>` : ''}
      ${m.deleteAt ? `<span>🗑️ Löscht sich ${esc(relative(m.deleteAt))} (${esc(formatDateTime(m.deleteAt))})</span>` : ''}
    </div>
    <div class="msg-actions">
      <a class="btn small" href="${ics}" target="_blank" rel="noopener">📅 In Kalender übernehmen</a>
      ${mine ? `<button class="btn small danger" data-delete="${esc(m.id)}">Löschen</button>` : ''}
    </div>
  </article>`;
}

function renderAustausch(view) {
  const showBanner = pushSupported ? Notification.permission === 'default' : false;
  const banner = showBanner
    ? `<div class="notify-banner"><p>🔔 Benachrichtigungen aktivieren, damit du neue Nachrichten sofort mitbekommst.</p><button class="btn primary small" id="enable-push">Aktivieren</button></div>`
    : '';
  const list = state.messages.length
    ? `<div class="msg-list">${state.messages.map(messageHtml).join('')}</div>`
    : `<div class="empty"><div class="big">💬</div><h2>Noch nichts im Austausch</h2><p>Tippe auf <b>+</b>, um eine Nachricht an alle zu schicken.</p></div>`;
  view.innerHTML = banner + list;

  const pushBtn = $('#enable-push', view);
  if (pushBtn) pushBtn.addEventListener('click', enablePush);

  view.querySelectorAll('[data-delete]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('Nachricht wirklich löschen?')) return;
      try {
        await api(`/api/messages/${encodeURIComponent(b.dataset.delete)}`, { method: 'DELETE' });
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
           ${URGENCIES.map((u) => `<label style="--u:var(--u-${u.key})"><input type="radio" name="urgency" value="${u.key}"${u.key === 'normal' ? ' checked' : ''}><span>${u.label}</span></label>`).join('')}
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
        form.elements.title.focus();
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const f = new FormData(form);
          const err = $('#msg-error', modal);
          err.textContent = '';
          const toIso = (v) => (v ? new Date(v).toISOString() : null);
          const btn = form.querySelector('[type=submit]');
          btn.disabled = true;
          try {
            const msg = await api('/api/messages', {
              method: 'POST',
              body: {
                urgency: f.get('urgency'),
                title: f.get('title').trim(),
                description: f.get('description').trim(),
                eventAt: toIso(f.get('eventAt')),
                deleteAt: toIso(f.get('deleteAt')),
              },
            });
            upsertMessage(msg);
            close();
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
  if (state.tab === 'austausch') render();
}

function removeMessage(id) {
  state.messages = state.messages.filter((m) => m.id !== id);
  if (state.tab === 'austausch') render();
}

/* -------------------------------------------------------------------------
 * Team
 * ---------------------------------------------------------------------- */

function renderTeam(view) {
  if (!state.users.length) {
    view.innerHTML = `<div class="empty"><div class="big">👨‍👩‍👧‍👦</div><h2>Noch kein Team</h2></div>`;
    return;
  }
  const users = state.users.slice().sort((a, b) => fullName(a).localeCompare(fullName(b), 'de'));
  view.innerHTML = `<div class="team-grid">${users
    .map((u) => {
      const age = ageParts(parseBirthday(u.birthday));
      return `<button class="team-tile" data-user="${esc(u.id)}" style="${colorVars(u.color)}">
        <span class="avatar">${esc(initials(u))}</span>
        <span class="name">${esc(fullName(u))}${state.me && u.id === state.me.id ? '<span class="me-badge">Du</span>' : ''}</span>
        <span class="meta">ID ${esc(u.trainerId)} · Lv. ${age.years}</span>
      </button>`;
    })
    .join('')}</div>`;
  view.querySelectorAll('[data-user]').forEach((b) =>
    b.addEventListener('click', () => openTrainerCard(state.users.find((u) => u.id === b.dataset.user)))
  );
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
  document.querySelectorAll('.tabbar button').forEach((b) => {
    const active = b.dataset.tab === state.tab;
    b.classList.toggle('active', active);
    if (active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  $('#fab').hidden = !(state.tab === 'austausch' && state.me);

  switch (state.tab) {
    case 'austausch': return renderAustausch(view);
    case 'notizen': return renderPlaceholder(view, '📝', 'Notizen', 'Dieser Bereich kommt im nächsten Schritt.');
    case 'kalender': return renderPlaceholder(view, '📅', 'Kalender', 'Dieser Bereich kommt im nächsten Schritt.');
    case 'schande': return renderPlaceholder(view, '😈', 'Board der Schande', 'Hier werden bald Striche verteilt – sie landen dann auf dem Trainerpass.');
    case 'team': return renderTeam(view);
  }
}

function setTab(tab) {
  if (!TABS[tab]) return;
  state.tab = tab;
  const url = new URL(location.href);
  url.searchParams.set('tab', tab);
  url.searchParams.delete('msg');
  history.replaceState(null, '', url);
  render();
  window.scrollTo(0, 0);
}

/* -------------------------------------------------------------------------
 * Daten laden & Live-Updates
 * ---------------------------------------------------------------------- */

async function loadUsers() {
  state.users = await api('/api/users');
}

async function loadMessages() {
  state.messages = await api('/api/messages');
}

let stream;
function startStream() {
  if (stream || !state.token) return;
  stream = new EventSource(`/api/stream?t=${encodeURIComponent(state.token)}`);
  stream.addEventListener('message-created', (e) => {
    const m = JSON.parse(e.data);
    const fromOther = !state.me || m.authorId !== state.me.id;
    upsertMessage(m);
    if (fromOther && document.visibilityState === 'visible') {
      toast(`💬 ${m.authorName}: ${m.title}`, () => {
        state.highlight = m.id;
        setTab('austausch');
      });
    }
  });
  stream.addEventListener('message-deleted', (e) => removeMessage(JSON.parse(e.data).id));
  stream.addEventListener('users-changed', async () => {
    await loadUsers();
    const me = state.users.find((u) => state.me && u.id === state.me.id);
    if (me) { state.me = me; renderProfileButton(); }
    if (state.tab === 'team') render();
  });
  stream.addEventListener('open', () => {
    // Nach Verbindungsabbruch alles neu laden
    Promise.all([loadUsers(), loadMessages()]).then(render).catch(() => {});
  });
}

// Countdown-Anzeigen aktualisieren & abgelaufene lokal ausblenden
setInterval(() => {
  const before = state.messages.length;
  state.messages = state.messages.filter((m) => !m.deleteAt || Date.parse(m.deleteAt) > Date.now());
  if (state.tab === 'austausch' && !$('.modal-backdrop')) render();
  else if (before !== state.messages.length && state.tab === 'austausch') render();
}, 30_000);

/* -------------------------------------------------------------------------
 * Start
 * ---------------------------------------------------------------------- */

async function init() {
  document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('#profile-btn').addEventListener('click', () => state.me && openTrainerCard(state.me));
  $('#fab').addEventListener('click', openNewMessage);

  const params = new URLSearchParams(location.search);
  if (TABS[params.get('tab')]) state.tab = params.get('tab');
  if (params.get('msg')) state.highlight = params.get('msg');

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('SW-Registrierung fehlgeschlagen', e));
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'open-message') {
        state.highlight = e.data.id;
        setTab('austausch');
      }
    });
  }

  if (state.token) {
    try {
      state.me = await api('/api/me');
    } catch (e) {
      if (e.status === 401) {
        localStorage.removeItem(TOKEN_KEY);
        state.token = null;
      }
    }
  }

  renderProfileButton();

  if (!state.me) {
    render();
    openSetup();
    return;
  }

  await Promise.all([loadUsers(), loadMessages()]).catch((e) => toast(e.message));
  render();
  startStream();
  syncPushSubscription();
}

init();
