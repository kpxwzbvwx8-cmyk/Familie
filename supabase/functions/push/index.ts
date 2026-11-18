// Web-Push für den Austausch:
//  key    – öffentlicher VAPID-Schlüssel (und Einrichtung des Minuten-Takts)
//  notify – neue Meldung an alle anderen
//  done    – Meldung erledigen (bei „Löschen, wenn erledigt“) und den Urheber benachrichtigen
//  respond – auf eine Meldung mit Rückmeldung antworten (eine der Optionen), Urheber wird benachrichtigt
//  comment – nach einem neuen Kommentar die anderen Beteiligten benachrichtigen
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
      if (!msg.delete_on_done && !msg.needs_ack) return json({ error: 'Für diese Meldung ist keine Rückmeldung vorgesehen' }, 400);
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

    if (body.action === 'respond') {
      const { data: msg } = await admin.from('messages').select('*').eq('id', body.messageId).maybeSingle();
      if (!msg) return json({ error: 'Meldung nicht gefunden' }, 404);
      if (!msg.needs_ack) return json({ error: 'Für diese Meldung ist keine Rückmeldung vorgesehen' }, 400);
      if (msg.author_id === me.id) return json({ error: 'Auf die eigene Meldung kann man nicht antworten' }, 400);
      const options: string[] = msg.ack_options?.length ? msg.ack_options : ['Erledigt'];
      const option = String(body.option ?? '');
      if (!options.includes(option)) return json({ error: 'Diese Antwort gibt es nicht' }, 400);
      const { error } = await admin.from('message_responses')
        .upsert({ message_id: msg.id, user_id: me.id, option, created_at: new Date().toISOString() });
      if (error) throw error;
      await sendPush({
        title: `Antwort: ${msg.title}`,
        body: `${meName}: ${option}`,
        tag: `resp-${msg.id}-${me.id}`,
        url: `?tab=start&msg=${msg.id}`,
        urgency: 'info',
      }, { toUsers: [msg.author_id], contact: origin });
      return json({ ok: true });
    }

    if (body.action === 'comment') {
      const { data: c } = await admin.from('message_comments').select('*')
        .eq('id', body.commentId).eq('author_id', me.id).maybeSingle();
      if (!c) return json({ error: 'Kommentar nicht gefunden' }, 404);
      const { data: msg } = await admin.from('messages').select('id, title, author_id').eq('id', c.message_id).maybeSingle();
      if (!msg) return json({ error: 'Meldung nicht gefunden' }, 404);
      const { data: others } = await admin.from('message_comments').select('author_id').eq('message_id', msg.id);
      const recipients = [...new Set([msg.author_id, ...(others ?? []).map((o) => o.author_id)])].filter((id) => id !== me.id);
      if (!recipients.length) return json({ sent: 0 });
      const r = await sendPush({
        title: `💬 ${msg.title}`,
        body: `${me.first_name}: ${c.body.slice(0, 140)}`,
        tag: `comment-${msg.id}`,
        url: `?tab=start&msg=${msg.id}`,
        urgency: 'info',
      }, { toUsers: recipients, contact: origin });
      return json(r);
    }

    return json({ error: 'Unbekannte Aktion' }, 400);
  } catch (err) {
    console.error(err);
    return json({ error: 'Serverfehler' }, 500);
  }
});
