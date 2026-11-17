// Kalender-Export: liefert eine Nachricht aus dem Austausch als .ics-Datei,
// die iPhone/Android direkt in den Kalender übernehmen.
// Aufruf: GET /functions/v1/ics?id=<Nachricht>&t=<Zugriffstoken>
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const url = new URL(req.url);
  const me = await memberFromToken(url.searchParams.get('t'));
  if (!me) return new Response('Nicht angemeldet', { status: 401, headers: cors });

  const { data: msg } = await admin
    .from('messages')
    .select('*, author:profiles!messages_author_id_fkey(first_name, last_name)')
    .eq('id', url.searchParams.get('id') ?? '')
    .maybeSingle();
  if (!msg) return new Response('Nachricht nicht gefunden', { status: 404, headers: cors });

  const start = msg.event_at ?? msg.created_at;
  const end = new Date(Date.parse(start) + 60 * 60 * 1000);
  const author = msg.author ? `${msg.author.first_name} ${msg.author.last_name}` : 'Unbekannt';
  const desc = [msg.description, `Dringlichkeit: ${URGENCY_LABELS[msg.urgency] ?? msg.urgency}`, `Von: ${author}`]
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
