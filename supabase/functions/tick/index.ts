// Minuten-Takt (aufgerufen von pg_cron über pg_net): verschickt Erinnerungen zum Beginn eines Ereignisses,
// Rückmelde-Fristen und die Hinweise der Kalendertermine.
import { admin, cors, json } from '../_shared/common.ts';
import { sendPush } from '../_shared/webpush.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const { data: cfg } = await admin.from('app_secrets').select('value').eq('key', 'tick').maybeSingle();
  if (!cfg || req.headers.get('x-familie-secret') !== cfg.value?.secret) return json({ error: 'Nicht erlaubt' }, 403);

  // Fällige Erinnerungen atomar „abholen“ (nur nicht älter als 2 Stunden, damit nach Ausfällen nichts nachtrudelt)
  const since = new Date(Date.now() - 2 * 3600e3).toISOString();
  const { data: due } = await admin.from('messages')
    .update({ reminder_sent: true })
    .eq('remind_at_start', true).eq('reminder_sent', false)
    .lte('event_at', new Date().toISOString()).gte('event_at', since)
    .select('*');

  let sent = 0;
  for (const msg of due ?? []) {
    const r = await sendPush({
      title: `⏰ Jetzt: ${msg.title}`,
      body: msg.description ? msg.description.slice(0, 140) : 'Das Ereignis beginnt.',
      tag: `start-${msg.id}`,
      url: `?tab=start&msg=${msg.id}`,
      urgency: 'dringend',
    }, { high: true });
    sent += r.sent;
  }
  // zu alte, nie verschickte Erinnerungen abhaken
  await admin.from('messages').update({ reminder_sent: true })
    .eq('remind_at_start', true).eq('reminder_sent', false).lt('event_at', since);
  // Rückmelde-Fristen: 1 Stunde vor Ablauf alle erinnern, die noch nicht geantwortet haben (außer dem Urheber)
  const { data: deadlines } = await admin.from('messages')
    .update({ respond_reminder_sent: true })
    .eq('needs_ack', true).eq('respond_reminder_sent', false)
    .not('respond_by', 'is', null)
    .lte('respond_by', new Date(Date.now() + 3600e3).toISOString())
    .select('*');
  let fristen = 0;
  for (const msg of deadlines ?? []) {
    if (Date.parse(msg.respond_by) < Date.now()) continue; // Frist schon vorbei – nicht mehr erinnern
    const { data: answered } = await admin.from('message_responses').select('user_id').eq('message_id', msg.id);
    const done = new Set([msg.author_id, ...(answered ?? []).map((r) => r.user_id)]);
    const { data: members } = await admin.from('profiles').select('id');
    const toUsers = (members ?? []).map((m) => m.id).filter((id) => !done.has(id));
    if (!toUsers.length) continue;
    const time = new Date(msg.respond_by).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
    const r = await sendPush({
      title: `⏳ Rückmeldung bis ${time}: ${msg.title}`,
      body: 'Noch eine Stunde – bitte antworte in der Meldung.',
      tag: `frist-${msg.id}`,
      url: `?tab=start&msg=${msg.id}`,
      urgency: 'wichtig',
    }, { toUsers, high: true });
    sent += r.sent; fristen++;
  }
  // Kalender-Hinweise: an den Ersteller und alle, die zugesagt haben
  const { data: evDue } = await admin.from('event_reminders')
    .update({ sent_at: new Date().toISOString() })
    .is('sent_at', null)
    .lte('remind_at', new Date().toISOString()).gte('remind_at', since)
    .select('*');
  let termine = 0;
  for (const rem of evDue ?? []) {
    const { data: ev } = await admin.from('events').select('*').eq('id', rem.event_id).maybeSingle();
    if (!ev) continue;
    const { data: acc } = await admin.from('event_invites').select('user_id').eq('event_id', ev.id).eq('status', 'accepted');
    const toUsers = [ev.owner_id, ...(acc ?? []).map((a) => a.user_id)];
    const mins = Math.round((Date.parse(ev.start_at) - Date.now()) / 60000);
    const when = ev.all_day
      ? (mins <= 0 ? 'heute' : mins < 1440 * 1.5 ? 'morgen' : `in ${Math.round(mins / 1440)} Tagen`)
      : mins <= 0 ? 'jetzt' : mins < 60 ? `in ${mins} Minuten` : mins < 1440 ? `in ${Math.round(mins / 60)} Stunden` : `in ${Math.round(mins / 1440)} Tagen`;
    const time = ev.all_day ? 'ganztägig' : new Date(ev.start_at).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const r = await sendPush({
      title: `📅 ${ev.title} – ${when}`,
      body: [time, ev.location ? `📍 ${ev.location}` : ''].filter(Boolean).join(' · '),
      tag: `event-${ev.id}`,
      url: `?tab=kalender&event=${ev.id}`,
      urgency: 'wichtig',
    }, { toUsers, high: true });
    sent += r.sent; termine++;
  }
  await admin.from('event_reminders').update({ sent_at: new Date().toISOString() }).is('sent_at', null).lt('remind_at', since);
  return json({ reminders: due?.length ?? 0, fristen, termine, sent });
});
