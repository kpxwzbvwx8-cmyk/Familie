// Web-Push: liefert den öffentlichen VAPID-Schlüssel und verschickt Benachrichtigungen
// über neue Nachrichten im Austausch an alle anderen Familienmitglieder.
import * as webpush from 'jsr:@negrel/webpush@0.5.0';
import { admin, bearer, cors, json, memberFromToken, URGENCY_LABELS } from '../_shared/common.ts';

let cachedKeys: CryptoKeyPair | null = null;

async function getVapidKeys(): Promise<CryptoKeyPair> {
  if (cachedKeys) return cachedKeys;
  const read = async () => (await admin.from('app_secrets').select('value').eq('key', 'vapid').maybeSingle()).data;
  let row = await read();
  if (!row) {
    // Beim allerersten Aufruf werden die Schlüssel erzeugt und gespeichert.
    const keys = await webpush.generateVapidKeys({ extractable: true });
    const exported = await webpush.exportVapidKeys(keys);
    await admin.from('app_secrets').insert({ key: 'vapid', value: exported });
    row = await read(); // falls parallel jemand anderes schneller war
  }
  cachedKeys = await webpush.importVapidKeys(row!.value as webpush.ExportedVapidKeys, { extractable: false });
  return cachedKeys;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const me = await memberFromToken(bearer(req));
    if (!me) return json({ error: 'Nicht angemeldet' }, 401);

    const body = await req.json().catch(() => ({}));
    const vapidKeys = await getVapidKeys();

    if (body.action === 'key') {
      return json({ publicKey: await webpush.exportApplicationServerKey(vapidKeys) });
    }

    if (body.action === 'notify') {
      const { data: msg } = await admin
        .from('messages')
        .select('*')
        .eq('id', body.messageId)
        .eq('author_id', me.id)
        .maybeSingle();
      if (!msg) return json({ error: 'Nachricht nicht gefunden' }, 404);

      const { data: subs } = await admin.from('push_subscriptions').select('*').neq('user_id', me.id);
      const origin = req.headers.get('Origin');
      const appServer = await webpush.ApplicationServer.new({
        contactInformation: origin && origin.startsWith('https://') ? origin : 'mailto:familie@users.noreply.github.com',
        vapidKeys,
      });

      const payload = JSON.stringify({
        title: `${URGENCY_LABELS[msg.urgency] ?? msg.urgency}: ${msg.title}`,
        body: `${me.first_name} ${me.last_name}${msg.description ? ' – ' + msg.description.slice(0, 140) : ''}`,
        tag: msg.id,
        url: `?tab=austausch&msg=${msg.id}`,
        urgency: msg.urgency,
      });

      let sent = 0;
      const gone: string[] = [];
      await Promise.all(
        (subs ?? []).map(async (s) => {
          try {
            await appServer.subscribe(s.subscription).pushTextMessage(payload, {
              urgency: msg.urgency === 'dringend' ? webpush.Urgency.High : webpush.Urgency.Normal,
              ttl: 60 * 60 * 24,
            });
            sent++;
          } catch (err) {
            const status = err instanceof webpush.PushMessageError ? err.response.status : 0;
            if (status === 404 || status === 410) gone.push(s.endpoint);
            else console.warn('Push fehlgeschlagen', status, String(err));
          }
        }),
      );
      if (gone.length) await admin.from('push_subscriptions').delete().in('endpoint', gone);
      return json({ sent, removed: gone.length });
    }

    return json({ error: 'Unbekannte Aktion' }, 400);
  } catch (err) {
    console.error(err);
    return json({ error: 'Serverfehler' }, 500);
  }
});
