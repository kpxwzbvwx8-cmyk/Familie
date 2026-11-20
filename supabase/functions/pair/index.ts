// Am PC (oder einem anderen Gerät) mit dem Konto vom Handy anmelden.
//  create – angemeldetes Mitglied erzeugt einen Einmal-Code (10 Minuten gültig)
//  redeem – neues Gerät löst den Code ein und bekommt einen Anmelde-Schlüssel für dasselbe Konto
import { admin, bearer, cors, json, memberFromToken } from '../_shared/common.ts';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne 0/O/1/I – gut abzutippen
const LIFETIME_MS = 10 * 60e3;

async function sha256(text: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}
const normalize = (c: unknown) => String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const body = await req.json().catch(() => ({}));

  if (body.action === 'create') {
    const me = await memberFromToken(bearer(req));
    if (!me) return json({ error: 'Nicht angemeldet' }, 401);
    await admin.from('device_pairings').delete().eq('user_id', me.id);
    const code = newCode();
    const expiresAt = new Date(Date.now() + LIFETIME_MS).toISOString();
    const { error } = await admin.from('device_pairings').insert({ code_hash: await sha256(code), user_id: me.id, expires_at: expiresAt });
    if (error) return json({ error: error.message }, 500);
    return json({ code, expiresAt });
  }

  if (body.action === 'redeem') {
    const code = normalize(body.code);
    if (code.length !== 8) return json({ error: 'Der Code hat 8 Zeichen.' }, 400);
    // kurz warten – erschwert das Durchprobieren
    await new Promise((r) => setTimeout(r, 400));
    const hash = await sha256(code);
    const { data: row } = await admin.from('device_pairings')
      .update({ used_at: new Date().toISOString() })
      .eq('code_hash', hash).is('used_at', null).gt('expires_at', new Date().toISOString())
      .select('*').maybeSingle();
    if (!row) return json({ error: 'Der Code ist falsch, schon benutzt oder abgelaufen. Erzeuge am Handy einen neuen.' }, 400);

    const { data: u, error: ue } = await admin.auth.admin.getUserById(row.user_id);
    if (ue || !u.user) return json({ error: 'Konto nicht gefunden' }, 404);
    let email = u.user.email;
    if (!email) {
      // Konto vom Handy ist anonym → bekommt eine interne Anmelde-Adresse (es werden nie E-Mails verschickt)
      email = `${row.user_id}@geraete.familie-app.de`;
      const { error } = await admin.auth.admin.updateUserById(row.user_id, { email, email_confirm: true });
      if (error) return json({ error: error.message }, 500);
    }
    const { data: link, error: le } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
    if (le || !link?.properties?.hashed_token) return json({ error: le?.message || 'Anmeldung fehlgeschlagen' }, 500);
    return json({ tokenHash: link.properties.hashed_token });
  }

  return json({ error: 'Unbekannte Aktion' }, 400);
});
