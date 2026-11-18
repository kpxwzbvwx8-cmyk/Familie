-- =========================================================================
-- Kalender: Termine
--  * Termine sind für alle sichtbar; bearbeiten/löschen nur der Ersteller.
--  * Einladungen: Eingeladene sagen zu oder ab. Hinweise gelten für den Ersteller
--    und für alle, die zugesagt haben.
--  * Hinweise (Erinnerungen) wie im Apple-Kalender + benutzerdefiniert.
--  * Kommentare von allen Mitgliedern.
-- =========================================================================
create table public.events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  location text check (char_length(location) <= 200),
  description text not null default '' check (char_length(description) <= 4000),
  all_day boolean not null default false,
  start_at timestamptz not null,
  end_at timestamptz not null,
  reminders jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_at >= start_at)
);
create index events_range_idx on public.events (start_at, end_at);
alter table public.events enable row level security;
create policy "Mitglieder sehen Termine" on public.events for select to authenticated using (public.is_member());
create policy "Ersteller löscht Termin" on public.events for delete to authenticated using (owner_id = auth.uid());
revoke all on public.events from anon, authenticated;
grant select, delete on public.events to authenticated;

create table public.event_invites (
  event_id uuid not null references public.events (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  responded_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (event_id, user_id)
);
alter table public.event_invites enable row level security;
create policy "Mitglieder sehen Einladungen" on public.event_invites for select to authenticated using (public.is_member());
revoke all on public.event_invites from anon, authenticated;
grant select on public.event_invites to authenticated;

create table public.event_comments (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  author_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now()
);
alter table public.event_comments enable row level security;
create policy "Mitglieder sehen Termin-Kommentare" on public.event_comments for select to authenticated using (public.is_member());
create policy "Mitglieder kommentieren Termine" on public.event_comments for insert to authenticated
  with check (author_id = auth.uid() and public.is_member());
create policy "Eigene Termin-Kommentare löschen" on public.event_comments for delete to authenticated using (author_id = auth.uid());
revoke all on public.event_comments from anon, authenticated;
grant select, insert, delete on public.event_comments to authenticated;

-- Fällige Hinweise (nur Server)
create table public.event_reminders (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  remind_at timestamptz not null,
  label text not null,
  sent_at timestamptz
);
create index event_reminders_due_idx on public.event_reminders (remind_at) where sent_at is null;
alter table public.event_reminders enable row level security;
revoke all on public.event_reminders from anon, authenticated;

-- Hinweis-Angabe → Zeitpunkt
--   {"k":"offset","m":<Minuten vorher>}        (0 = zum Zeitpunkt)
--   {"k":"day","d":<Tage vorher>}             (ganztägig: an dem Tag um 9:00)
--   {"k":"custom","at":"<Zeitpunkt>"}          (benutzerdefiniert, nicht nach dem Beginn)
create function public.event_reminder_time(p_spec jsonb, p_start timestamptz)
returns timestamptz
language sql
stable
as $$
  select case p_spec ->> 'k'
    when 'offset' then p_start - make_interval(mins => (p_spec ->> 'm')::int)
    when 'day' then ((p_start at time zone 'Europe/Berlin')::date - (p_spec ->> 'd')::int + time '09:00') at time zone 'Europe/Berlin'
    when 'custom' then (p_spec ->> 'at')::timestamptz
  end;
$$;

-- Anlegen/Bearbeiten (nur der Ersteller) inkl. Einladungen und Hinweisen
create function public.save_event(
  p_id uuid, p_title text, p_location text, p_description text, p_all_day boolean,
  p_start timestamptz, p_end timestamptz, p_reminders jsonb, p_invitees uuid[]
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
  p_reminders := coalesce(p_reminders, '[]');
  if jsonb_typeof(p_reminders) <> 'array' or jsonb_array_length(p_reminders) > 10 then raise exception 'Ungültige Hinweise'; end if;
  for r in select * from jsonb_array_elements(p_reminders) loop
    if r ->> 'k' not in ('offset', 'day', 'custom') then raise exception 'Ungültiger Hinweis'; end if;
    t := public.event_reminder_time(r, p_start);
    if t is null then raise exception 'Ungültiger Hinweis'; end if;
    if r ->> 'k' = 'custom' and t > p_start then raise exception 'Ein Hinweis darf nicht nach dem Beginn liegen'; end if;
  end loop;

  if p_id is null then
    insert into public.events (owner_id, title, location, description, all_day, start_at, end_at, reminders)
    values (auth.uid(), p_title, nullif(trim(coalesce(p_location, '')), ''), coalesce(p_description, ''), p_all_day, p_start, p_end, p_reminders)
    returning * into e;
  else
    update public.events set title = p_title, location = nullif(trim(coalesce(p_location, '')), ''),
           description = coalesce(p_description, ''), all_day = p_all_day, start_at = p_start, end_at = p_end,
           reminders = p_reminders, updated_at = now()
     where id = p_id and owner_id = auth.uid()
     returning * into e;
    if e.id is null then raise exception 'Nur der Ersteller kann den Termin bearbeiten'; end if;
  end if;

  -- Einladungen abgleichen (bestehende Antworten bleiben erhalten)
  delete from public.event_invites where event_id = e.id and user_id <> all (coalesce(p_invitees, '{}'));
  insert into public.event_invites (event_id, user_id)
  select e.id, u from unnest(coalesce(p_invitees, '{}')) u
  where u <> e.owner_id and exists (select 1 from public.profiles p where p.id = u)
  on conflict do nothing;

  -- Hinweise neu berechnen (nur zukünftige)
  delete from public.event_reminders where event_id = e.id and sent_at is null;
  insert into public.event_reminders (event_id, remind_at, label)
  select e.id, public.event_reminder_time(x, e.start_at), x::text
  from jsonb_array_elements(p_reminders) x
  where public.event_reminder_time(x, e.start_at) > now();
  return e;
end;
$$;
revoke all on function public.save_event(uuid, text, text, text, boolean, timestamptz, timestamptz, jsonb, uuid[]) from public, anon;
grant execute on function public.save_event(uuid, text, text, text, boolean, timestamptz, timestamptz, jsonb, uuid[]) to authenticated;

-- Einladung beantworten
create function public.respond_event(p_event uuid, p_accept boolean)
returns public.event_invites
language plpgsql
security definer
set search_path = public
as $$
declare
  i public.event_invites;
begin
  update public.event_invites set status = case when p_accept then 'accepted' else 'declined' end, responded_at = now()
   where event_id = p_event and user_id = auth.uid()
   returning * into i;
  if i.event_id is null then raise exception 'Keine Einladung gefunden'; end if;
  return i;
end;
$$;
revoke all on function public.respond_event(uuid, boolean) from public, anon;
grant execute on function public.respond_event(uuid, boolean) to authenticated;

alter publication supabase_realtime add table public.events, public.event_invites, public.event_comments;
