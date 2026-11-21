// Web-Push für den Austausch:
//  key    – öffentlicher VAPID-Schlüssel (und Einrichtung des Minuten-Takts)
//  notify – neue Aufgabe an alle anderen
//  done    – Aufgabe erledigen (bei „Löschen, wenn erledigt“) und den Urheber benachrichtigen
//  respond – auf eine Aufgabe mit Rückmeldung antworten (eine der Optionen), Urheber wird benachrichtigt
//  comment – nach einem neuen Kommentar die anderen Beteiligten benachrichtigen
//  review  – Urheber nimmt eine Aufgabe mit Strich-Androhung ab (accept) oder vergibt den Strich (strike + Grund)
//  strike  – Board der Schande: Urteil, Einspruch, Entscheidung, Anerkennung
//  board   – Board der Schande: neuer Grund zur Beglaubigung, Bezahlung bestätigt
//  note    – Notizen: Beteiligte über eine Änderung benachrichtigen
//  event / eventResponse / eventComment – Kalender: Einladung & Änderung, Zu-/Absage, Kommentar
import { admin, memberClient, bearer, cors, json, memberFromToken, URGENCY_LABELS } from '../_shared/common.ts';
import { ensureTickConfig, publicKey, sendPush } from '../_shared/webpush.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const token = bearer(req);
    const me = await memberFromToken(token);
    if (!me || !token) return json({ error: 'Nicht angemeldet' }, 401);
    const db = memberClient(token);
    const body = await req.json().catch(() => ({}));
    const origin = req.headers.get('Origin');
    await ensureTickConfig().catch((e) => console.warn('tick-Konfiguration', e));
    const meName = `${me.first_name} ${me.last_name}`;

    if (body.action === 'key') {
      return json({ publicKey: await publicKey() });
    }

    if (body.action === 'notify') {
      const { data: msg } = await db.from('messages').select('*')
        .eq('id', body.messageId).eq('author_id', me.id).maybeSingle();
      if (!msg) return json({ error: 'Nachricht nicht gefunden' }, 404);
      if (msg.in_handbook) return json({ sent: 0 });
      // Für wen? Zuständige (ohne einen selbst), sonst alle anderen
      const assignees: string[] = (msg.assignees ?? []).filter((id: string) => id !== me.id);
      if (msg.assignees?.length && !assignees.length) return json({ sent: 0 }); // nur für sich selbst
      const result = await sendPush(me.family_id, {
        title: `${URGENCY_LABELS[msg.urgency] ?? msg.urgency}: ${msg.title}`,
        body: `${meName}${msg.description ? ' – ' + msg.description.slice(0, 140) : ''}`,
        tag: msg.id,
        url: `?tab=start&msg=${msg.id}`,
        urgency: msg.urgency,
      }, assignees.length ? { toUsers: assignees, high: msg.urgency === 'dringend', contact: origin }
        : { exceptUser: me.id, high: msg.urgency === 'dringend', contact: origin });
      return json(result);
    }

    if (body.action === 'done') {
      const { data: msg } = await db.from('messages').select('*').eq('id', body.messageId).maybeSingle();
      if (!msg) return json({ error: 'Aufgabe nicht gefunden' }, 404);
      const responsible = msg.assignees?.length ? msg.assignees.includes(me.id) : msg.author_id !== me.id;
      if (!responsible) return json({ error: 'Nur die zuständige Person kann die Aufgabe erledigen' }, 400);
      if (msg.note_checks?.includes(false)) return json({ error: 'Erst alle Listenpunkte abhaken.' }, 409);
      if (!msg.note_checks?.length && !msg.delete_on_done && !msg.needs_ack && !msg.deadline_at && !msg.open_ended) return json({ error: 'Für diese Aufgabe ist keine Rückmeldung vorgesehen' }, 400);
      if (msg.done_by) return json({ error: 'Schon erledigt' }, 409);
      if (msg.closed_at) return json({ error: 'Die Aufgabe ist bereits geschlossen' }, 409);

      // Zustand beim Schreiben erneut prüfen, auch bei gleichzeitigem Abhaken oder Löschen.
      const write = msg.delete_on_done && !msg.threat_strike
        ? admin.from('messages').delete()
        : admin.from('messages').update({ done_by: me.id, done_at: new Date().toISOString() });
      const { data: changed, error } = await write.eq('id', msg.id).is('closed_at', null)
        .is('done_by', null).not('note_checks', 'cs', '{false}').select('id').maybeSingle();
      if (error) throw error;
      if (!changed) return json({ error: 'Die Aufgabe wurde geändert. Bitte prüfe die Liste erneut.' }, 409);

      if (msg.threat_strike) {
        await sendPush(me.family_id, {
          title: `Bitte abnehmen: ${msg.title}`,
          body: `${meName} meldet „erledigt“. Nimm das Ergebnis ab oder vergib den Strich.`,
          tag: `done-${msg.id}`,
          url: `?tab=start&msg=${msg.id}`,
          urgency: 'dringend',
        }, { toUsers: [msg.author_id].filter((id) => id !== me.id), high: true, contact: origin });
        return json({ ok: true, deleted: false, review: true });
      }

      await sendPush(me.family_id, {
        title: msg.delete_on_done ? `Geschlossen: ${msg.title}` : `Erledigt: ${msg.title}`,
        body: msg.delete_on_done
          ? `${meName} hat die Aufgabe erledigt – sie wurde gelöscht.`
          : `${meName} hat die Aufgabe als erledigt markiert.`,
        tag: `done-${msg.id}`,
        url: `?tab=start&msg=${msg.id}`,
        urgency: 'info',
      }, { toUsers: [msg.author_id], contact: origin });
      return json({ ok: true, deleted: msg.delete_on_done });
    }

    if (body.action === 'respond') {
      const { data: msg } = await db.from('messages').select('*').eq('id', body.messageId).maybeSingle();
      if (!msg) return json({ error: 'Aufgabe nicht gefunden' }, 404);
      if (!msg.needs_ack) return json({ error: 'Für diese Aufgabe ist keine Rückmeldung vorgesehen' }, 400);
      const mayRespond = msg.assignees?.length ? msg.assignees.includes(me.id) : msg.author_id !== me.id;
      if (!mayRespond) return json({ error: 'Nur die zuständige Person kann antworten' }, 400);
      if (msg.closed_at) return json({ error: 'Die Aufgabe ist bereits geschlossen' }, 409);
      const options: string[] = msg.ack_options?.length ? msg.ack_options : ['Erledigt'];
      const option = String(body.option ?? '');
      if (!options.includes(option)) return json({ error: 'Diese Antwort gibt es nicht' }, 400);
      const { error } = await admin.from('message_responses')
        .upsert({ message_id: msg.id, user_id: me.id, option, created_at: new Date().toISOString() });
      if (error) throw error;
      await sendPush(me.family_id, {
        title: `Antwort: ${msg.title}`,
        body: `${meName}: ${option}`,
        tag: `resp-${msg.id}-${me.id}`,
        url: `?tab=start&msg=${msg.id}`,
        urgency: 'info',
      }, { toUsers: [msg.author_id], contact: origin });
      return json({ ok: true });
    }

    if (body.action === 'comment') {
      const { data: c } = await db.from('message_comments').select('*')
        .eq('id', body.commentId).eq('author_id', me.id).maybeSingle();
      if (!c) return json({ error: 'Kommentar nicht gefunden' }, 404);
      const { data: msg } = await db.from('messages').select('id, title, author_id').eq('id', c.message_id).maybeSingle();
      if (!msg) return json({ error: 'Aufgabe nicht gefunden' }, 404);
      const { data: others } = await db.from('message_comments').select('author_id').eq('message_id', msg.id);
      const recipients = [...new Set([msg.author_id, ...(others ?? []).map((o) => o.author_id)])].filter((id) => id !== me.id);
      if (!recipients.length) return json({ sent: 0 });
      const r = await sendPush(me.family_id, {
        title: `💬 ${msg.title}`,
        body: `${me.first_name}: ${c.body.slice(0, 140)}`,
        tag: `comment-${msg.id}`,
        url: `?tab=start&msg=${msg.id}`,
        urgency: 'info',
      }, { toUsers: recipients, contact: origin });
      return json(r);
    }

    if (body.action === 'review') {
      const { data: msg } = await db.from('messages').select('*').eq('id', body.messageId).maybeSingle();
      if (!msg) return json({ error: 'Aufgabe nicht gefunden' }, 404);
      if (msg.author_id !== me.id) return json({ error: 'Nur der Urheber kann abnehmen' }, 403);
      if (!msg.threat_strike) return json({ error: 'Für diese Aufgabe wurde kein Strich angedroht' }, 400);
      if (msg.closed_at) return json({ error: 'Die Aufgabe ist bereits geschlossen' }, 409);
      const { data: resps } = await db.from('message_responses').select('user_id').eq('message_id', msg.id);
      const reacted = [...new Set([msg.done_by, ...(resps ?? []).map((r) => r.user_id)].filter(Boolean))] as string[];
      if (!reacted.length) return json({ error: 'Es gibt noch keine Rückmeldung zum Abnehmen' }, 400);
      const now = new Date().toISOString();

      if (body.verdict === 'accept') {
        await admin.from('messages').update({ closed_at: now, review_status: 'accepted' }).eq('id', msg.id);
        await sendPush(me.family_id, {
          title: `👍 Abgenommen: ${msg.title}`, body: `${meName} hat das Ergebnis abgenommen.`,
          tag: `review-${msg.id}`, url: `?tab=start&msg=${msg.id}`, urgency: 'info',
        }, { toUsers: reacted, contact: origin });
        return json({ ok: true });
      }

      if (body.verdict === 'strike') {
        const reason = String(body.reason ?? '').trim().slice(0, 200);
        if (!reason) return json({ error: 'Bitte einen Grund angeben' }, 400);
        const { error } = await admin.from('strikes').insert(reacted.map((uid) => ({
          user_id: uid, message_id: msg.id, given_by: me.id, value: 1,
          title: 'Strich bei Abnahme', description: msg.title, reason,
          history: [{ type: 'given', by: me.id, at: now, text: reason }],
        })));
        if (error) throw error;
        await admin.from('messages').update({ closed_at: now, review_status: 'rejected', strike_note: reason }).eq('id', msg.id);
        await sendPush(me.family_id, {
          title: `😈 VERURTEILT: ${msg.title}`, body: `${meName}: ${reason} – Anerkennen oder Einspruch einlegen.`,
          tag: `review-${msg.id}`, url: `?tab=schande`, urgency: 'dringend',
        }, { toUsers: reacted, high: true, contact: origin });
        return json({ ok: true });
      }
      return json({ error: 'Unbekannte Entscheidung' }, 400);
    }

    if (body.action === 'strike') {
      // Benachrichtigungen rund um das Board der Schande (Zustand kommt aus der Datenbank)
      const { data: st } = await db.from('strikes').select('*').eq('id', body.strikeId).maybeSingle();
      if (!st) return json({ error: 'Strich nicht gefunden' }, 404);
      const v = String(st.value).replace('.', ',');
      const n = `${v} ${Number(st.value) === 1 ? 'Strich' : 'Striche'}`;
      let payload: { to: string; title: string; body: string } | null = null;
      if (body.event === 'given' && st.given_by === me.id && st.status === 'pending') {
        payload = { to: st.user_id, title: `😈 VERURTEILT: ${st.title} (${n})`, body: `${meName}: ${st.reason} – Anerkennen oder Einspruch einlegen.` };
      } else if (body.event === 'appealed' && st.user_id === me.id && st.status === 'appealed' && st.given_by) {
        payload = { to: st.given_by, title: `⚖️ Einspruch: ${st.title}`, body: `${meName}: ${String(st.appeal_text ?? '').slice(0, 140)}` };
      } else if (body.event === 'decided' && st.given_by === me.id) {
        const t = st.status === 'withdrawn' ? `⚖️ Strich zurückgezogen: ${st.title}`
          : st.final ? `😈 Urteil rechtskräftig: ${st.title} (${n})` : `⚖️ Neues Urteil: ${st.title} (${n})`;
        payload = { to: st.user_id, title: t, body: `${meName}: ${String(st.verdict_text ?? 'Einspruch stattgegeben').slice(0, 140)}` };
      } else if (body.event === 'acknowledged' && st.user_id === me.id && st.given_by) {
        payload = { to: st.given_by, title: `✓ Strich anerkannt: ${st.title}`, body: `${meName} hat den Strich (${n}) anerkannt.` };
      }
      if (!payload) return json({ sent: 0 });
      const r = await sendPush(me.family_id, {
        title: payload.title, body: payload.body, tag: `strike-${st.id}`, url: '?tab=schande', urgency: 'dringend',
      }, { toUsers: [payload.to], high: true, contact: origin });
      return json(r);
    }

    if (body.action === 'board') {
      // Neuer Vorschlag für den Strafkatalog oder fällige Strafe → alle anderen informieren
      let title = '', text = '';
      if (body.event === 'rule') {
        const { data: r } = await db.from('strike_rules').select('*').eq('id', body.ruleId).maybeSingle();
        if (!r || r.approved_at) return json({ sent: 0 });
        title = `⚖️ Bitte beglaubigen: ${r.title}`;
        text = `${meName} hat einen neuen Grund für Striche eingereicht.`;
      } else if (body.event === 'fine') {
        title = '💶 Strafe bezahlt?';
        text = `${meName} hat die Bezahlung von 10 € bestätigt – bitte ebenfalls bestätigen.`;
      } else return json({ sent: 0 });
      const r = await sendPush(me.family_id, { title, body: text, tag: `board-${body.ruleId ?? 'fine'}`, url: '?tab=schande', urgency: 'wichtig' },
        { exceptUser: me.id, contact: origin });
      return json(r);
    }

    if (body.action === 'note') {
      // Gemeinsame Notiz wurde hochgeladen → die anderen Beteiligten benachrichtigen
      const { data: note } = await db.from('notes').select('id, title, owner_id, shared_with').eq('id', body.noteId).maybeSingle();
      if (!note) return json({ error: 'Notiz nicht gefunden' }, 404);
      const people: string[] = [note.owner_id, ...(note.shared_with ?? [])];
      if (!people.includes(me.id)) return json({ error: 'Keine Berechtigung' }, 403);
      const recipients = [...new Set(people)].filter((id) => id !== me.id);
      if (!recipients.length) return json({ sent: 0 });
      const r = await sendPush(me.family_id, {
        title: `📝 ${note.title || 'Notiz'}`,
        body: `${meName} hat die gemeinsame Notiz geändert.`,
        tag: `note-${note.id}`,
        url: `?tab=notizen&note=${note.id}`,
        urgency: 'info',
      }, { toUsers: recipients, contact: origin });
      return json(r);
    }

    if (body.action === 'event') {
      // Ersteller hat einen Termin gespeichert: neue Einladungen verschicken, Zugesagte über Änderungen informieren
      const { data: ev } = await db.from('events').select('*').eq('id', body.eventId).eq('owner_id', me.id).maybeSingle();
      if (!ev) return json({ error: 'Termin nicht gefunden' }, 404);
      if (ev.kind === 'todo') {
        // Neue/geänderte Erinnerung für andere → Zuständige informieren
        const to = (ev.assignees ?? []).filter((id: string) => id !== me.id);
        if (!to.length) return json({ sent: 0 });
        const r = await sendPush(me.family_id, {
          title: `🔔 ${body.changed ? 'Erinnerung geändert' : 'Neue Erinnerung'}: ${ev.title}`,
          body: `${meName}${ev.description ? ' – ' + String(ev.description).slice(0, 120) : ''}`,
          tag: `todo-${ev.id}`, url: '?tab=start', urgency: 'info',
        }, { toUsers: to, contact: origin });
        return json(r);
      }
      const { data: inv } = await db.from('event_invites').select('user_id, status').eq('event_id', ev.id);
      const fresh: string[] = (body.invited ?? []).filter((id: string) => (inv ?? []).some((i) => i.user_id === id && i.status === 'pending'));
      const when = ev.all_day
        ? new Date(ev.start_at).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', weekday: 'short', day: '2-digit', month: '2-digit' }) + ' (ganztägig)'
        : new Date(ev.start_at).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      let sent = 0;
      if (fresh.length) {
        sent += (await sendPush(me.family_id, {
          title: `📨 Einladung: ${ev.title}`, body: `${meName} lädt dich ein – ${when}. Zusagen oder absagen?`,
          tag: `event-${ev.id}`, url: `?tab=start&event=${ev.id}`, urgency: 'wichtig',
        }, { toUsers: fresh, high: true, contact: origin })).sent;
      }
      if (body.changed) {
        const acc = (inv ?? []).filter((i) => i.status === 'accepted').map((i) => i.user_id).filter((id) => !fresh.includes(id));
        if (acc.length) sent += (await sendPush(me.family_id, {
          title: `📅 Geändert: ${ev.title}`, body: `${meName} hat den Termin geändert – ${when}.`,
          tag: `event-${ev.id}`, url: `?tab=kalender&event=${ev.id}`, urgency: 'info',
        }, { toUsers: acc, contact: origin })).sent;
      }
      return json({ sent });
    }

    if (body.action === 'eventResponse') {
      const { data: inv } = await db.from('event_invites').select('status').eq('event_id', body.eventId).eq('user_id', me.id).maybeSingle();
      const { data: ev } = await db.from('events').select('id, title, owner_id').eq('id', body.eventId).maybeSingle();
      if (!inv || !ev) return json({ error: 'Einladung nicht gefunden' }, 404);
      const r = await sendPush(me.family_id, {
        title: inv.status === 'accepted' ? `✅ Zugesagt: ${ev.title}` : `❌ Abgesagt: ${ev.title}`,
        body: `${meName} hat ${inv.status === 'accepted' ? 'zugesagt' : 'abgesagt'}.`,
        tag: `event-${ev.id}`, url: `?tab=kalender&event=${ev.id}`, urgency: 'info',
      }, { toUsers: [ev.owner_id], contact: origin });
      return json(r);
    }

    if (body.action === 'eventComment') {
      const { data: c } = await db.from('event_comments').select('*').eq('id', body.commentId).eq('author_id', me.id).maybeSingle();
      if (!c) return json({ error: 'Kommentar nicht gefunden' }, 404);
      const { data: ev } = await db.from('events').select('id, title, owner_id').eq('id', c.event_id).maybeSingle();
      if (!ev) return json({ error: 'Termin nicht gefunden' }, 404);
      const { data: inv } = await db.from('event_invites').select('user_id').eq('event_id', ev.id).neq('status', 'declined');
      const { data: others } = await db.from('event_comments').select('author_id').eq('event_id', ev.id);
      const recipients = [...new Set([ev.owner_id, ...(inv ?? []).map((i) => i.user_id), ...(others ?? []).map((o) => o.author_id)])]
        .filter((id) => id !== me.id);
      if (!recipients.length) return json({ sent: 0 });
      const r = await sendPush(me.family_id, {
        title: `💬 ${ev.title}`, body: `${me.first_name}: ${c.body.slice(0, 140)}`,
        tag: `event-${ev.id}`, url: `?tab=kalender&event=${ev.id}`, urgency: 'info',
      }, { toUsers: recipients, contact: origin });
      return json(r);
    }

    return json({ error: 'Unbekannte Aktion' }, 400);
  } catch (err) {
    console.error(err);
    return json({ error: 'Serverfehler' }, 500);
  }
});
