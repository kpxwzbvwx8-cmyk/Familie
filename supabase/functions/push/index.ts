// Web-Push für den Austausch:
//  key    – öffentlicher VAPID-Schlüssel (und Einrichtung des Minuten-Takts)
//  notify – neue Meldung an alle anderen
//  done   – Meldung als erledigt markieren (bzw. löschen) und den Urheber benachrichtigen
import { admin, bearer, cors, json, memberFromToken, URGENCY_LABELS } from '../_shared/common.ts';
import { ensureTickConfig, publicKey, sendPush } from '../_shared/webpush.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const me = await memberFromToken(bearer(req));
    if (!me) return json({ error: 'Nicht angemeldet' }, 401);
    const body = await req.json().catch(() => ({}));
    const origin = req.headers.get('Origin');
    await ensureTickConfig().catch((e) => console.warn('tick-Konfiguration', e));
    const meName = `${me.first_name} ${me.last_name}`;

    if (body.action === 'key') {
      return json({ publicKey: await publicKey() });
    }

    if (body.action === 'notify') {
      const { data: msg } = await admin.from('messages').select('*')
        .eq('id', body.messageId).eq('author_id', me.id).maybeSingle();
      if (!msg) return json({ error: 'Nachricht nicht gefunden' }, 404);
      const result = await sendPush({
        title: `${URGENCY_LABELS[msg.urgency] ?? msg.urgency}: ${msg.title}`,
        body: `${meName}${msg.description ? ' – ' + msg.description.slice(0, 140) : ''}`,
        tag: msg.id,
        url: `?tab=start&msg=${msg.id}`,
        urgency: msg.urgency,
      }, { exceptUser: me.id, high: msg.urgency === 'dringend', contact: origin });
      return json(result);
    }

    if (body.action === 'done') {
      const { data: msg } = await admin.from('messages').select('*').eq('id', body.messageId).maybeSingle();
      if (!msg) return json({ error: 'Meldung nicht gefunden' }, 404);
      if (msg.author_id === me.id) return json({ error: 'Der Urheber kann die eigene Meldung nicht als erledigt markieren' }, 400);
      if (!msg.needs_ack && !msg.delete_on_done) return json({ error: 'Für diese Meldung ist keine Rückmeldung vorgesehen' }, 400);
      if (msg.done_by) return json({ error: 'Schon erledigt' }, 409);

      if (msg.delete_on_done) {
        await admin.from('messages').delete().eq('id', msg.id);
      } else {
        await admin.from('messages').update({ done_by: me.id, done_at: new Date().toISOString() }).eq('id', msg.id);
      }
      await sendPush({
        title: msg.delete_on_done ? `Geschlossen: ${msg.title}` : `Erledigt: ${msg.title}`,
        body: msg.delete_on_done
          ? `${meName} hat die Meldung erledigt – sie wurde gelöscht.`
          : `${meName} hat die Meldung als erledigt markiert.`,
        tag: `done-${msg.id}`,
        url: `?tab=start&msg=${msg.id}`,
        urgency: 'info',
      }, { toUsers: [msg.author_id], contact: origin });
      return json({ ok: true, deleted: msg.delete_on_done });
    }

    return json({ error: 'Unbekannte Aktion' }, 400);
  } catch (err) {
    console.error(err);
    return json({ error: 'Serverfehler' }, 500);
  }
});
