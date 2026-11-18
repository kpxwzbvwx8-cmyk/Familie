// Minuten-Takt (aufgerufen von pg_cron über pg_net): verschickt Erinnerungen zum Beginn eines Ereignisses.
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
  return json({ reminders: due?.length ?? 0, sent });
});
