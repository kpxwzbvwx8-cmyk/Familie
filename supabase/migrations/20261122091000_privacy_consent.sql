-- Eigene, versionierte Einwilligungen. Ein leerer Widerrufszeitpunkt bedeutet aktiv.
create table public.privacy_consents (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  notice_version text not null,
  accepted_at timestamptz not null default now(),
  withdrawn_at timestamptz
);
create unique index one_active_consent on public.privacy_consents(user_id, notice_version) where withdrawn_at is null;
alter table public.privacy_consents enable row level security;
revoke all on public.privacy_consents from public, anon, authenticated;
grant select on public.privacy_consents to authenticated;
create policy own_consent on public.privacy_consents for select to authenticated using (user_id = (select auth.uid()));

create function public.privacy_notice_version() returns text language sql immutable
set search_path = '' as $$ select '2026-11-22'::text $$;

create function public.has_privacy_consent() returns boolean language sql stable
security definer set search_path = '' as $$
  select exists (select from public.privacy_consents where user_id = auth.uid()
    and notice_version = public.privacy_notice_version() and withdrawn_at is null)
$$;

create function public.set_privacy_consent(p_version text, p_accept boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or p_version is distinct from public.privacy_notice_version() or p_accept is null then
    raise exception 'Bitte lade den aktuellen Datenschutzhinweis.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 1));
  if p_accept then
    insert into public.privacy_consents(user_id, notice_version) values (auth.uid(), p_version)
      on conflict (user_id, notice_version) where withdrawn_at is null do nothing;
  else
    update public.privacy_consents set withdrawn_at = now() where user_id = auth.uid()
      and notice_version = p_version and withdrawn_at is null;
    delete from public.push_subscriptions where user_id = auth.uid();
    delete from public.calendar_feeds where user_id = auth.uid();
    delete from public.device_pairings where user_id = auth.uid();
  end if;
end;
$$;
revoke all on function public.has_privacy_consent(), public.set_privacy_consent(text,boolean) from public, anon;
grant execute on function public.has_privacy_consent(), public.set_privacy_consent(text,boolean) to authenticated;

create or replace function public.current_family_id() returns integer
language sql stable security definer set search_path = '' as $$
  select family_id from public.profiles where id = auth.uid() and public.has_privacy_consent()
$$;

create or replace function public.is_member() returns boolean language sql stable security definer set search_path = '' as $$
  select public.current_family_id() is not null
$$;

create function public.require_trainer_consent() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.id is distinct from auth.uid() or not public.has_privacy_consent() then
    raise exception 'Bitte lies zuerst den Datenschutzhinweis und entscheide über die Nutzung.';
  end if;
  return new;
end;
$$;
create trigger require_trainer_consent before insert on public.profiles
  for each row execute function public.require_trainer_consent();

-- Dienstzugriffe (Push und Kalender-Abos) laufen mit dem Service-Schlüssel.
create view public.consenting_profiles with (security_invoker = true) as
  select p.* from public.profiles p join public.privacy_consents c on c.user_id = p.id
  where c.notice_version = public.privacy_notice_version() and c.withdrawn_at is null;
create view public.consenting_push_subscriptions with (security_invoker = true) as
  select s.*, p.family_id from public.push_subscriptions s join public.consenting_profiles p on p.id = s.user_id;
revoke all on public.consenting_profiles, public.consenting_push_subscriptions from public, anon, authenticated;
grant select on public.consenting_profiles, public.consenting_push_subscriptions to service_role;

-- Ältere Benutzer-RPCs prüfen die Einwilligung auch mit gespeicherten Karten-IDs.

create or replace function public.acknowledge_strike(p_strike uuid)
returns public.strikes
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.strikes;
begin
  if not public.has_privacy_consent() then raise exception 'Einwilligung erforderlich'; end if;
  select * into s from public.strikes where id = p_strike and user_id = auth.uid() for update;
  if s.id is null then raise exception 'Strich nicht gefunden'; end if;
  if s.status = 'pending' or (s.status = 'active' and s.acknowledged_at is null) then
    update public.strikes
       set status = 'active', acknowledged_at = now(),
           history = history || public.log_entry('acknowledged')
     where id = s.id returning * into s;
  end if;
  return s;
end;
$$;

create or replace function public.appeal_strike(p_strike uuid, p_text text)
returns public.strikes
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.strikes;
begin
  if not public.has_privacy_consent() then raise exception 'Einwilligung erforderlich'; end if;
  select * into s from public.strikes where id = p_strike and user_id = auth.uid() for update;
  if s.id is null then raise exception 'Strich nicht gefunden'; end if;
  if s.status <> 'pending' or s.final then raise exception 'Gegen diesen Strich ist kein Einspruch möglich'; end if;
  if s.given_by is null then raise exception 'Gegen automatische Striche ohne Urheber ist kein Einspruch möglich'; end if;
  p_text := trim(coalesce(p_text, ''));
  if p_text = '' then raise exception 'Bitte den Einspruch begründen'; end if;
  update public.strikes
     set status = 'appealed', appeal_text = left(p_text, 1000),
         history = history || public.log_entry('appealed', left(p_text, 1000))
   where id = s.id returning * into s;
  return s;
end;
$$;

create or replace function public.decide_strike(p_strike uuid, p_decision text, p_text text default null, p_value numeric default null)
returns public.strikes
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.strikes;
begin
  if not public.has_privacy_consent() then raise exception 'Einwilligung erforderlich'; end if;
  select * into s from public.strikes where id = p_strike and given_by = auth.uid() for update;
  if s.id is null then raise exception 'Strich nicht gefunden'; end if;
  if s.status <> 'appealed' then raise exception 'Es liegt kein Einspruch vor'; end if;
  p_text := nullif(trim(coalesce(p_text, '')), '');
  if p_decision = 'withdraw' then
    update public.strikes set status = 'withdrawn', decided_at = now(), verdict_text = p_text,
           history = history || public.log_entry('withdrawn', p_text)
     where id = s.id returning * into s;
  elsif p_decision = 'uphold' then
    if p_text is null then raise exception 'Bitte das neue Urteil begründen'; end if;
    if p_value is not null and p_value not in (0.5, 1, 2) then raise exception 'Ungültige Wertigkeit'; end if;
    update public.strikes set status = 'pending', decided_at = now(), verdict_text = p_text,
           value = coalesce(p_value, value),
           history = history || (public.log_entry('upheld', p_text) || jsonb_build_object('value', coalesce(p_value, value)))
     where id = s.id returning * into s;
  elsif p_decision = 'force' then
    if p_text is null then raise exception 'Bitte das Urteil begründen'; end if;
    update public.strikes set status = 'active', final = true, acknowledged_at = null, decided_at = now(),
           verdict_text = p_text, history = history || public.log_entry('forced', p_text)
     where id = s.id returning * into s;
  else
    raise exception 'Unbekannte Entscheidung';
  end if;
  return s;
end;
$$;

create or replace function public.event_exclude(p_event uuid, p_occ timestamptz)
returns public.events
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.events;
begin
  if not public.has_privacy_consent() then raise exception 'Einwilligung erforderlich'; end if;
  update public.events set exdates = array(select distinct unnest(exdates || p_occ)), updated_at = now()
   where id = p_event and owner_id = auth.uid() returning * into e;
  if e.id is null then raise exception 'Nur der Ersteller kann den Eintrag ändern'; end if;
  perform public.refresh_event_reminders(e.id);
  return e;
end;
$$;

create or replace function public.event_split(p_event uuid, p_occ timestamptz)
returns public.events
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.events;
begin
  if not public.has_privacy_consent() then raise exception 'Einwilligung erforderlich'; end if;
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

create or replace function public.respond_event(p_event uuid, p_accept boolean)
returns public.event_invites
language plpgsql
security definer
set search_path = public
as $$
declare
  i public.event_invites;
begin
  if not public.has_privacy_consent() then raise exception 'Einwilligung erforderlich'; end if;
  update public.event_invites set status = case when p_accept then 'accepted' else 'declined' end, responded_at = now()
   where event_id = p_event and user_id = auth.uid()
   returning * into i;
  if i.event_id is null then raise exception 'Keine Einladung gefunden'; end if;
  return i;
end;
$$;

create or replace function public.leave_note(p_note uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_privacy_consent() then raise exception 'Einwilligung erforderlich'; end if;
  update public.notes set shared_with = array_remove(shared_with, auth.uid())
   where id = p_note and auth.uid() = any (shared_with);
  if not found then raise exception 'Notiz nicht gefunden'; end if;
end;
$$;

create or replace function public.set_event_needs_done(p_event uuid, p_value boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_privacy_consent() then raise exception 'Einwilligung erforderlich'; end if;
  update public.events set needs_done = coalesce(p_value, true) where id = p_event and owner_id = auth.uid();
  if not found then raise exception 'Nur der Ersteller kann den Eintrag ändern'; end if;
end;
$$;
