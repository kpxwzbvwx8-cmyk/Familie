// Gemeinsame Web-Push-Hilfen (VAPID-Schlüssel, Versand an Abonnements)
import * as webpush from 'jsr:@negrel/webpush@0.5.0';
import { admin } from './common.ts';

let cachedKeys: CryptoKeyPair | null = null;

export async function getVapidKeys(): Promise<CryptoKeyPair> {
  if (cachedKeys) return cachedKeys;
  const read = async () => (await admin.from('app_secrets').select('value').eq('key', 'vapid').maybeSingle()).data;
  let row = await read();
  if (!row) {
    // Beim allerersten Aufruf werden die Schlüssel erzeugt und gespeichert.
    const keys = await webpush.generateVapidKeys({ extractable: true });
    const exported = await webpush.exportVapidKeys(keys);
    await admin.from('app_secrets').insert({ key: 'vapid', value: exported });
    row = await read();
  }
  cachedKeys = await webpush.importVapidKeys(row!.value as webpush.ExportedVapidKeys, { extractable: false });
  return cachedKeys;
}

export async function publicKey() {
  return webpush.exportApplicationServerKey(await getVapidKeys());
}

export type PushPayload = { title: string; body: string; tag?: string; url?: string; urgency?: string };

/** Schickt eine Benachrichtigung an die Abonnements der angegebenen Nutzer (oder an alle außer `exceptUser`). */
export async function sendPush(
  payload: PushPayload,
  opts: { toUsers?: string[]; exceptUser?: string; high?: boolean; contact?: string | null } = {},
) {
  let q = admin.from('push_subscriptions').select('*');
  if (opts.toUsers) q = q.in('user_id', opts.toUsers);
  if (opts.exceptUser) q = q.neq('user_id', opts.exceptUser);
  const { data: subs } = await q;
  if (!subs?.length) return { sent: 0, removed: 0 };

  const appServer = await webpush.ApplicationServer.new({
    contactInformation: opts.contact && opts.contact.startsWith('https://') ? opts.contact : 'mailto:familie@users.noreply.github.com',
    vapidKeys: await getVapidKeys(),
  });
  const text = JSON.stringify(payload);
  let sent = 0;
  const gone: string[] = [];
  await Promise.all(
    subs.map(async (s) => {
      try {
        await appServer.subscribe(s.subscription).pushTextMessage(text, {
          urgency: opts.high ? webpush.Urgency.High : webpush.Urgency.Normal,
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
  return { sent, removed: gone.length };
}

/** Legt URL + Geheimnis für den Minuten-Takt (pg_cron → Funktion „tick“) an, falls noch nicht vorhanden. */
export async function ensureTickConfig() {
  const { data } = await admin.from('app_secrets').select('value').eq('key', 'tick').maybeSingle();
  const url = `${Deno.env.get('SUPABASE_URL')}/functions/v1/tick`;
  if (data && data.value?.url === url) return;
  const secret = data?.value?.secret ?? crypto.randomUUID() + crypto.randomUUID();
  await admin.from('app_secrets').upsert({ key: 'tick', value: { url, secret } });
}
