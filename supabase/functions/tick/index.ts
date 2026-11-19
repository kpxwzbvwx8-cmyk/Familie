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
  // Läuft aus: 12 Stunden vor Deadline / Rückmelde-Frist die Zuständigen warnen (Handlungsbedarf)
  const in12h = new Date(Date.now() + 12 * 3600e3).toISOString();
  const { data: members } = await admin.from('profiles').select('id');
  const allIds = (members ?? []).map((m) => m.id as string);
  const responsibleOf = (msg: { assignees: string[] | null; author_id: string }) =>
    msg.assignees?.length ? msg.assignees : allIds.filter((id) => id !== msg.author_id);
  const fmt = (iso: string) => new Date(iso).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const left = (iso: string) => {
    const mins = Math.max(1, Math.round((Date.parse(iso) - Date.now()) / 60000));
    return mins < 60 ? `${mins} Minuten` : `${Math.round(mins / 60)} Stunde${Math.round(mins / 60) === 1 ? '' : 'n'}`;
  };
  // gerade erst angelegt → die Meldung selbst kam eben schon als Benachrichtigung
  const fresh = (msg: { created_at: string }) => Date.parse(msg.created_at) > Date.now() - 15 * 60e3;
  let auslaufend = 0;
  const { data: dl } = await admin.from('messages')
    .update({ deadline_warned: true })
    .eq('deadline_warned', false).not('deadline_at', 'is', null).is('closed_at', null)
    .lte('deadline_at', in12h)
    .select('*');
  for (const msg of dl ?? []) {
    if (Date.parse(msg.deadline_at) < Date.now() || msg.done_by || fresh(msg)) continue;
    const toUsers = responsibleOf(msg);
    if (!toUsers.length) continue;
    const r = await sendPush({
      title: `⌛ Läuft aus: ${msg.title}`,
      body: `Noch ${left(msg.deadline_at)} bis zur Deadline (${fmt(msg.deadline_at)}) – hier ist Handlungsbedarf!${msg.threat_strike ? ' 😈 Sonst gibt es einen Strich.' : ''}`,
      tag: `expiry-${msg.id}`,
      url: `?tab=start&msg=${msg.id}`,
      urgency: 'dringend',
    }, { toUsers, high: true });
    sent += r.sent; auslaufend++;
  }
  const { data: rb } = await admin.from('messages')
    .update({ respond_warned: true })
    .eq('respond_warned', false).eq('needs_ack', true).not('respond_by', 'is', null)
    .lte('respond_by', in12h)
    .select('*');
  for (const msg of rb ?? []) {
    if (Date.parse(msg.respond_by) < Date.now() || msg.closed_at || fresh(msg)) continue;
    const { data: answered } = await admin.from('message_responses').select('user_id').eq('message_id', msg.id);
    const done = new Set((answered ?? []).map((r) => r.user_id));
    const toUsers = responsibleOf(msg).filter((id) => !done.has(id));
    if (!toUsers.length) continue;
    const r = await sendPush({
      title: `⌛ Läuft aus: ${msg.title}`,
      body: `Noch ${left(msg.respond_by)} für deine Rückmeldung (bis ${fmt(msg.respond_by)}) – bitte antworte!`,
      tag: `expiry-${msg.id}`,
      url: `?tab=start&msg=${msg.id}`,
      urgency: 'dringend',
    }, { toUsers, high: true });
    sent += r.sent; auslaufend++;
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
    // Erinnerungen gehen an die Zuständigen, Termine an Ersteller + Zugesagte
    const toUsers = ev.kind === 'todo'
      ? (ev.assignees?.length ? ev.assignees : [ev.owner_id])
      : [ev.owner_id, ...(acc ?? []).map((a) => a.user_id)];
    const occStart = rem.occ ?? ev.start_at;
    const mins = Math.round((Date.parse(occStart) - Date.now()) / 60000);
    const when = ev.all_day
      ? (mins <= 0 ? 'heute' : mins < 1440 * 1.5 ? 'morgen' : `in ${Math.round(mins / 1440)} Tagen`)
      : mins <= 0 ? 'jetzt' : mins < 60 ? `in ${mins} Minuten` : mins < 1440 ? `in ${Math.round(mins / 60)} Stunden` : `in ${Math.round(mins / 1440)} Tagen`;
    const time = ev.all_day ? 'ganztägig' : new Date(occStart).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const r = await sendPush({
      title: `${ev.kind === 'todo' ? '🔔 Erinnerung: ' : '📅 '}${ev.title} – ${when}`,
      body: [time, ev.location ? `📍 ${ev.location}` : ''].filter(Boolean).join(' · '),
      tag: `event-${ev.id}`,
      url: ev.kind === 'todo' ? '?tab=start' : `?tab=kalender&event=${ev.id}`,
      urgency: 'wichtig',
    }, { toUsers, high: true });
    sent += r.sent; termine++;
  }
  await admin.from('event_reminders').update({ sent_at: new Date().toISOString() }).is('sent_at', null).lt('remind_at', since);
  return json({ reminders: due?.length ?? 0, fristen, termine, auslaufend, sent });
});
