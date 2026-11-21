// Kalender-Export: liefert eine Nachricht aus dem Austausch als .ics-Datei,
// die iPhone/Android direkt in den Kalender übernehmen.
// Aufruf: GET /functions/v1/ics?id=<Nachricht>&t=<Zugriffstoken>
// Kalender-Abo: GET /functions/v1/ics?feed=<persönlicher Schlüssel> (z. B. als webcal://-Link)
import { admin, cors, memberFromToken, URGENCY_LABELS } from '../_shared/common.ts';

const icsDate = (d: string | Date) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsEscape = (s: string) =>
  String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

function fold(line: string) {
  const enc = new TextEncoder();
  const out: string[] = [];
  let cur = '';
  for (const ch of line) {
    if (enc.encode(cur + ch).length > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = ch;
    } else cur += ch;
  }
  out.push(cur);
  return out.join('\r\n ');
}

const URGENCY_ICON: Record<string, string> = { info: '🟣', normal: '🔴', wichtig: '🔵', dringend: '⚫' };

/** Ende eines Termins: Ende des Zeitraums, sonst Deadline, sonst 1 Stunde */
function endOf(msg: { event_at: string; end_at: string | null; deadline_at: string | null }, start: string) {
  const endIso = msg.end_at ?? msg.deadline_at;
  return endIso && Date.parse(endIso) > Date.parse(start) ? new Date(endIso) : new Date(Date.parse(start) + 60 * 60 * 1000);
}

/** Datum/Uhrzeit in deutscher Zeit (für Ganztagstermine) */
function berlinParts(d: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}${p.month}${p.day}`, time: `${p.hour}:${p.minute}`, y: +p.year, m: +p.month, d: +p.day };
}
/** „Ganzer Tag“ (00:00 bis 23:59) → echter Ganztagstermin */
function allDayLines(start: string, end: Date): string[] | null {
  const s = berlinParts(new Date(start));
  const e = berlinParts(end);
  if (s.time !== '00:00' || e.time !== '23:59') return null;
  const next = new Date(Date.UTC(e.y, e.m - 1, e.d + 1));
  const endDate = next.toISOString().slice(0, 10).replace(/-/g, '');
  return [`DTSTART;VALUE=DATE:${s.date}`, `DTEND;VALUE=DATE:${endDate}`];
}

/** Kalender-Abo: alle Termine der Familie (ab 60 Tagen zurück) als ein Kalender */
async function feed(token: string) {
  const { data: f } = await admin.from('calendar_feeds').select('user_id').eq('token', token).maybeSingle();
  const { data: member } = f
    ? await admin.from('profiles').select('family_id').eq('id', f.user_id).maybeSingle()
    : { data: null };
  if (!member) return new Response('Unbekannter Kalender-Link', { status: 404, headers: cors });
  const since = new Date(Date.now() - 60 * 86400e3).toISOString();
  const { data: msgs } = await admin
    .from('messages')
    .select('*, author:profiles!messages_author_id_fkey(first_name, last_name)')
    .eq('family_id', member.family_id)
    .not('event_at', 'is', null)
    .or(`event_at.gte.${since},end_at.gte.${since},deadline_at.gte.${since}`)
    .order('event_at', { ascending: true })
    .limit(1000);
  const now = Date.now();
  const fmt = (d: string) => new Date(d).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short' });
  const events = (msgs ?? [])
    .filter((m) => !m.delete_at || Date.parse(m.delete_at) > now)
    .flatMap((m) => {
      const start = m.event_at;
      const end = endOf(m, start);
      const author = m.author ? `${m.author.first_name} ${m.author.last_name}` : 'Unbekannt';
      const status = m.closed_at ? ' (geschlossen)' : m.done_by ? ' ✓' : '';
      const desc = [
        m.description,
        m.deadline_at ? `Deadline: ${fmt(m.deadline_at)}` : '',
        m.threat_strike ? 'Bei Nichterfüllung droht ein Strich auf dem Board der Schande.' : '',
        `Dringlichkeit: ${URGENCY_LABELS[m.urgency] ?? m.urgency}`,
        `Von: ${author}`,
      ].filter(Boolean).join('\n');
      return [
        'BEGIN:VEVENT',
        `UID:${m.id}@familie`,
        `DTSTAMP:${icsDate(m.created_at)}`,
        `LAST-MODIFIED:${icsDate(m.closed_at ?? m.done_at ?? m.created_at)}`,
        ...(allDayLines(start, end) ?? [`DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`]),
        `SUMMARY:${icsEscape(`${URGENCY_ICON[m.urgency] ?? ''} ${m.deadline_at && !m.end_at ? '⏳ ' : ''}${m.title}${status}`.trim())}`,
        `DESCRIPTION:${icsEscape(desc)}`,
        m.urgency === 'dringend' || m.urgency === 'wichtig' ? 'PRIORITY:1' : 'PRIORITY:5',
        'END:VEVENT',
      ];
    });
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Familie//Kalender-Abo//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Familie',
    'X-WR-CALDESC:Termine, Ereignisse und Deadlines aus der Familien-App',
    'X-WR-TIMEZONE:Europe/Berlin',
    'REFRESH-INTERVAL;VALUE=DURATION:PT15M',
    'X-PUBLISHED-TTL:PT15M',
    ...events,
    'END:VCALENDAR',
  ].map(fold).join('\r\n') + '\r\n';
  return new Response(ics, {
    headers: {
      ...cors,
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="familie.ics"',
      'Cache-Control': 'no-store',
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const url = new URL(req.url);
  const feedToken = url.searchParams.get('feed');
  if (feedToken) return feed(feedToken);
  const me = await memberFromToken(url.searchParams.get('t'));
  if (!me) return new Response('Nicht angemeldet', { status: 401, headers: cors });

  const { data: msg } = await admin
    .from('messages')
    .select('*, author:profiles!messages_author_id_fkey(first_name, last_name)')
    .eq('family_id', me.family_id)
    .eq('id', url.searchParams.get('id') ?? '')
    .maybeSingle();
  if (!msg) return new Response('Nachricht nicht gefunden', { status: 404, headers: cors });

  const start = msg.event_at ?? msg.created_at;
  // Ende: Ende des Zeitraums, sonst die Deadline (Ereignis vom Start bis zur Deadline), sonst 1 Stunde
  const end = endOf(msg, start);
  const author = msg.author ? `${msg.author.first_name} ${msg.author.last_name}` : 'Unbekannt';
  const fmt = (d: string) => new Date(d).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short' });
  const desc = [msg.description, msg.deadline_at ? `Deadline: ${fmt(msg.deadline_at)}` : '', `Dringlichkeit: ${URGENCY_LABELS[msg.urgency] ?? msg.urgency}`, `Von: ${author}`]
    .filter(Boolean)
    .join('\n');

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Familie//Austausch//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${msg.id}@familie`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsEscape(msg.title)}`,
    `DESCRIPTION:${icsEscape(desc)}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsEscape(msg.title)}`,
    'TRIGGER:-PT30M',
    'END:VALARM',
    ...(msg.deadline_at && !msg.end_at ? [
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape('Deadline in 1 Stunde: ' + msg.title)}`,
      'TRIGGER;RELATED=END:-PT1H', 'END:VALARM',
    ] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ].map(fold).join('\r\n') + '\r\n';

  const name = (msg.title.replace(/[^\w\-äöüÄÖÜß ]+/g, '').trim() || 'termin').slice(0, 60);
  return new Response(ics, {
    headers: {
      ...cors,
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `inline; filename="termin.ics"; filename*=UTF-8''${encodeURIComponent(name)}.ics`,
      'Cache-Control': 'no-store',
    },
  });
});
