-- =========================================================================
-- Version 1.1.0
--  * Termine wiederholen (täglich, wöchentlich, 14-tägig, monatlich, benutzerdefiniert)
--    mit Ausnahmen (einzelner Termin gelöscht/geändert) und Ende.
--  * Neue Art „Erinnerung“ (kind = 'todo'): für bestimmte Personen, abhakbar pro Termin.
--  * Meldungen: „Für wen“ (assignees).
-- =========================================================================

-- ---------- Termine & Erinnerungen ----------
alter table public.events
  add column kind text not null default 'event' check (kind in ('event', 'todo')),
  add column assignees uuid[] not null default '{}',
  -- {"u": "day"|"week"|"month", "n": 1.., "until": "YYYY-MM-DD" | null}
  add column recurrence jsonb,
  add column exdates timestamptz[] not null default '{}';

-- Erledigt-Status je Vorkommen (für Erinnerungen)
create table public.event_done (
  event_id uuid not null references public.events (id) on delete cascade,
  occ timestamptz not null,
  done_by uuid references public.profiles (id) on delete set null,
  done_at timestamptz not null default now(),
  primary key (event_id, occ)
);
alter table public.event_done enable row level security;
create policy "Mitglieder sehen Erledigt-Status" on public.event_done for select to authenticated using (public.is_member());
revoke all on public.event_done from anon, authenticated;
grant select on public.event_done to authenticated;

-- Hinweise gehören jetzt zu einem Vorkommen
alter table public.event_reminders add column occ timestamptz;
delete from public.event_reminders a using public.event_reminders b
 where a.ctid < b.ctid and a.event_id = b.event_id and a.remind_at = b.remind_at;
create unique index event_reminders_unique on public.event_reminders (event_id, remind_at);

-- Alle Vorkommen eines Termins im Zeitfenster (Rechnen in deutscher Ortszeit, damit die Uhrzeit über die Zeitumstellung gleich bleibt)
create function public.event_occurrences(e public.events, p_from timestamptz, p_to timestamptz)
returns setof timestamptz
language plpgsql
stable
as $$
declare
  u text := e.recurrence ->> 'u';
  n int := greatest(1, coalesce((e.recurrence ->> 'n')::int, 1));
  until_d date := nullif(e.recurrence ->> 'until', '')::date;
  base timestamp := e.start_at at time zone 'Europe/Berlin';
  dur interval := e.end_at - e.start_at;
  occ timestamptz;
  i int := 0;
begin
  if e.recurrence is null or u is null then
    if e.start_at <= p_to and e.end_at >= p_from then return next e.start_at; end if;
    return;
  end if;
  loop
    occ := (base + case u when 'day' then make_interval(days => i * n)
                         when 'week' then make_interval(days => 7 * i * n)
                         else make_interval(months => i * n) end) at time zone 'Europe/Berlin';
    exit when occ > p_to or i > 3000;
    exit when until_d is not null and (occ at time zone 'Europe/Berlin')::date > until_d;
    if occ + dur >= p_from and not (occ = any (e.exdates)) then return next occ; end if;
    i := i + 1;
  end loop;
end;
$$;

-- Hinweise für die nächsten 35 Tage erzeugen (bereits verschickte bleiben unberührt)
create function public.refresh_event_reminders(p_event uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.events;
  o timestamptz;
  r jsonb;
  t timestamptz;
begin
  select * into e from public.events where id = p_event;
  delete from public.event_reminders where event_id = p_event and sent_at is null;
  if e.id is null then return; end if;
  for o in select * from public.event_occurrences(e, now(), now() + interval '35 days') loop
    continue when e.kind = 'todo' and exists (select 1 from public.event_done d where d.event_id = e.id and d.occ = o);
    for r in select * from jsonb_array_elements(e.reminders) loop
      t := public.event_reminder_time(r, o);
      -- benutzerdefinierte Hinweise gelten nur für das erste Vorkommen
      continue when r ->> 'k' = 'custom' and o <> e.start_at;
      if t > now() then
        insert into public.event_reminders (event_id, remind_at, label, occ) values (e.id, t, r::text, o)
        on conflict (event_id, remind_at) do nothing;
      end if;
    end loop;
  end loop;
end;
$$;
revoke all on function public.refresh_event_reminders(uuid) from public, anon, authenticated;

-- Speichern (ersetzt die alte Version) – inkl. Art, Für wen, Wiederholung
drop function public.save_event(uuid, text, text, text, boolean, timestamptz, timestamptz, jsonb, uuid[]);
create function public.save_event(
  p_id uuid, p_title text, p_location text, p_description text, p_all_day boolean,
  p_start timestamptz, p_end timestamptz, p_reminders jsonb, p_invitees uuid[],
  p_kind text default 'event', p_assignees uuid[] default '{}', p_recurrence jsonb default null
)
returns public.events
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.events;
  r jsonb;
  t timestamptz;
begin
  if not public.is_member() then raise exception 'Kein Mitglied'; end if;
  p_title := trim(coalesce(p_title, ''));
  if p_title = '' then raise exception 'Bitte einen Titel angeben'; end if;
  if p_end < p_start then raise exception 'Das Ende liegt vor dem Beginn'; end if;
  if p_kind not in ('event', 'todo') then raise exception 'Ungültige Art'; end if;
  if p_recurrence is not null and (p_recurrence ->> 'u' not in ('day', 'week', 'month')
     or coalesce((p_recurrence ->> 'n')::int, 0) not between 1 and 365) then
    raise exception 'Ungültige Wiederholung';
  end if;
  p_reminders := coalesce(p_reminders, '[]');
  if jsonb_typeof(p_reminders) <> 'array' or jsonb_array_length(p_reminders) > 10 then raise exception 'Ungültige Hinweise'; end if;
  for r in select * from jsonb_array_elements(p_reminders) loop
    if r ->> 'k' not in ('offset', 'day', 'custom') then raise exception 'Ungültiger Hinweis'; end if;
    t := public.event_reminder_time(r, p_start);
    if t is null then raise exception 'Ungültiger Hinweis'; end if;
    if r ->> 'k' = 'custom' and t > p_start then raise exception 'Ein Hinweis darf nicht nach dem Beginn liegen'; end if;
  end loop;
  p_assignees := array(select distinct u from unnest(coalesce(p_assignees, '{}')) u where exists (select 1 from public.profiles p where p.id = u));

  if p_id is null then
    insert into public.events (owner_id, title, location, description, all_day, start_at, end_at, reminders, kind, assignees, recurrence)
    values (auth.uid(), p_title, nullif(trim(coalesce(p_location, '')), ''), coalesce(p_description, ''), p_all_day, p_start, p_end,
            p_reminders, p_kind, p_assignees, p_recurrence)
    returning * into e;
  else
    update public.events set title = p_title, location = nullif(trim(coalesce(p_location, '')), ''),
           description = coalesce(p_description, ''), all_day = p_all_day, start_at = p_start, end_at = p_end,
           reminders = p_reminders, kind = p_kind, assignees = p_assignees, recurrence = p_recurrence, updated_at = now()
     where id = p_id and owner_id = auth.uid()
     returning * into e;
    if e.id is null then raise exception 'Nur der Ersteller kann den Eintrag bearbeiten'; end if;
  end if;

  if p_kind = 'event' then
    delete from public.event_invites where event_id = e.id and user_id <> all (coalesce(p_invitees, '{}'));
    insert into public.event_invites (event_id, user_id)
    select e.id, u from unnest(coalesce(p_invitees, '{}')) u
    where u <> e.owner_id and exists (select 1 from public.profiles p where p.id = u)
    on conflict do nothing;
  end if;

  perform public.refresh_event_reminders(e.id);
  return e;
end;
$$;
revoke all on function public.save_event(uuid, text, text, text, boolean, timestamptz, timestamptz, jsonb, uuid[], text, uuid[], jsonb) from public, anon;
grant execute on function public.save_event(uuid, text, text, text, boolean, timestamptz, timestamptz, jsonb, uuid[], text, uuid[], jsonb) to authenticated;

-- Einzelnes Vorkommen ausnehmen („nur dieser Termin“ löschen/ändern)
create function public.event_exclude(p_event uuid, p_occ timestamptz)
returns public.events
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.events;
begin
  update public.events set exdates = array(select distinct unnest(exdates || p_occ)), updated_at = now()
   where id = p_event and owner_id = auth.uid() returning * into e;
  if e.id is null then raise exception 'Nur der Ersteller kann den Eintrag ändern'; end if;
  perform public.refresh_event_reminders(e.id);
  return e;
end;
$$;

-- Serie vor einem Vorkommen beenden („dieser und alle folgenden“)
create function public.event_split(p_event uuid, p_occ timestamptz)
returns public.events
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.events;
begin
  select * into e from public.events where id = p_event and owner_id = auth.uid();
  if e.id is null then raise exception 'Nur der Ersteller kann den Eintrag ändern'; end if;
  if p_occ <= e.start_at then
    delete from public.events where id = e.id;
    return e;
  end if;
  update public.events
     set recurrence = jsonb_set(coalesce(recurrence, '{}'), '{until}', to_jsonb(((p_occ at time zone 'Europe/Berlin')::date - 1)::text)),
         updated_at = now()
   where id = e.id returning * into e;
  perform public.refresh_event_reminders(e.id);
  return e;
end;
$$;

-- Erinnerung (Vorkommen) erledigt / wieder offen – nur für die zuständigen Personen
create function public.set_event_done(p_event uuid, p_occ timestamptz, p_done boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.events;
begin
  select * into e from public.events where id = p_event;
  if e.id is null then raise exception 'Eintrag nicht gefunden'; end if;
  if not (auth.uid() = any (e.assignees) or (cardinality(e.assignees) = 0 and e.owner_id = auth.uid())) then
    raise exception 'Nur die zuständige Person kann abhaken';
  end if;
  if p_done then
    insert into public.event_done (event_id, occ, done_by) values (p_event, p_occ, auth.uid()) on conflict do nothing;
  else
    delete from public.event_done where event_id = p_event and occ = p_occ;
  end if;
  perform public.refresh_event_reminders(e.id);
end;
$$;

revoke all on function public.event_exclude(uuid, timestamptz) from public, anon;
revoke all on function public.event_split(uuid, timestamptz) from public, anon;
revoke all on function public.set_event_done(uuid, timestamptz, boolean) from public, anon;
grant execute on function public.event_exclude(uuid, timestamptz) to authenticated;
grant execute on function public.event_split(uuid, timestamptz) to authenticated;
grant execute on function public.set_event_done(uuid, timestamptz, boolean) to authenticated;

-- Wiederkehrende Hinweise stündlich nachfüllen
select cron.schedule('familie-wiederholungen', '7 * * * *',
  $$select public.refresh_event_reminders(id) from public.events where recurrence is not null$$);

alter publication supabase_realtime add table public.event_done;

-- ---------- Meldungen: Für wen ----------
alter table public.messages add column assignees uuid[] not null default '{}';
grant insert (assignees) on public.messages to authenticated;

-- Deadline-Striche gehen an die Zuständigen (falls gesetzt), sonst wie bisher an alle anderen
create or replace function public.process_deadlines()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  m record;
  n integer := 0;
begin
  for m in
    select * from public.messages
    where deadline_at is not null and deadline_at <= now() and closed_at is null
    for update skip locked
  loop
    if m.threat_strike then
      continue when public.message_frozen(m.id);
      insert into public.strikes (user_id, message_id, given_by, title, description, value, reason, history)
      select p.id, m.id, m.author_id, 'Deadline verpasst', m.title, 1, 'Deadline verpasst: ' || m.title,
             jsonb_build_array(jsonb_build_object('type', 'given', 'by', m.author_id, 'at', now(), 'text', 'Deadline verpasst (automatisch)'))
      from public.profiles p
      where case when cardinality(m.assignees) > 0 then p.id = any (m.assignees) else p.id <> m.author_id end;
      update public.messages
         set closed_at = now(), review_status = 'missed', strike_note = 'Deadline verpasst'
       where id = m.id;
    else
      update public.messages set closed_at = now() where id = m.id;
    end if;
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke all on function public.process_deadlines() from public, anon, authenticated;
