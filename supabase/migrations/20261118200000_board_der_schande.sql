-- =========================================================================
-- Board der Schande
--  * Strafkatalog: Vorlagen (Titel, Beschreibung, Wertigkeit 0,5 / 1 / 2).
--    Neue Vorlagen werden eingereicht und gelten erst, wenn ALLE Mitglieder
--    sie beglaubigt haben.
--  * Bestrafen: Vorlage wählen + Begründung (+ optional Foto) → Strich ist
--    „vorläufig“, bis der Bestrafte ihn anerkennt oder Einspruch einlegt.
--  * Einspruch: Der Urheber zieht zurück, bewertet neu (erneuter Einspruch
--    möglich) oder boxt den Strich durch (rechtskräftig, kein Einspruch).
--  * Bei 10 Strichen sind 10 € fällig. Die 10 Striche verschwinden erst,
--    wenn alle Mitglieder die Bezahlung bestätigt haben.
-- =========================================================================

-- ---------------------------------------------------------------------------
-- Strafkatalog
-- ---------------------------------------------------------------------------
create table public.strike_rules (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 60),
  description text not null default '' check (char_length(description) <= 500),
  value numeric(3,1) not null check (value in (0.5, 1, 2)),
  created_by uuid references public.profiles (id) on delete set null,
  approved_by uuid[] not null default '{}',
  approved_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.strike_rules enable row level security;
create policy "Mitglieder sehen den Strafkatalog" on public.strike_rules for select to authenticated using (public.is_member());
revoke all on public.strike_rules from anon, authenticated;
grant select on public.strike_rules to authenticated;

-- Alle Mitglieder in der Liste?
create function public.all_members_in(p_ids uuid[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not exists (select 1 from public.profiles where id <> all (coalesce(p_ids, '{}')));
$$;
revoke all on function public.all_members_in(uuid[]) from public, anon;

create function public.propose_rule(p_title text, p_description text, p_value numeric)
returns public.strike_rules
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.strike_rules;
begin
  if not public.is_member() then raise exception 'Kein Mitglied'; end if;
  p_title := trim(coalesce(p_title, ''));
  if p_title = '' then raise exception 'Bitte einen Titel angeben'; end if;
  if p_value not in (0.5, 1, 2) then raise exception 'Ungültige Wertigkeit'; end if;
  insert into public.strike_rules (title, description, value, created_by, approved_by)
  values (p_title, trim(coalesce(p_description, '')), p_value, auth.uid(), array[auth.uid()])
  returning * into r;
  if public.all_members_in(r.approved_by) then
    update public.strike_rules set approved_at = now() where id = r.id returning * into r;
  end if;
  return r;
end;
$$;

create function public.approve_rule(p_rule uuid)
returns public.strike_rules
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.strike_rules;
begin
  if not public.is_member() then raise exception 'Kein Mitglied'; end if;
  select * into r from public.strike_rules where id = p_rule for update;
  if r.id is null then raise exception 'Vorlage nicht gefunden'; end if;
  if r.approved_at is not null then return r; end if;
  update public.strike_rules
     set approved_by = array(select distinct unnest(approved_by || auth.uid()))
   where id = p_rule returning * into r;
  if public.all_members_in(r.approved_by) then
    update public.strike_rules set approved_at = now() where id = r.id returning * into r;
  end if;
  return r;
end;
$$;

-- Ablehnen (oder als Einreicher zurückziehen): Vorschlag verschwindet
create function public.reject_rule(p_rule uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_member() then raise exception 'Kein Mitglied'; end if;
  delete from public.strike_rules where id = p_rule and approved_at is null;
  if not found then raise exception 'Nur Vorschläge, die noch nicht beglaubigt sind, können abgelehnt werden'; end if;
end;
$$;

revoke all on function public.propose_rule(text, text, numeric) from public, anon;
revoke all on function public.approve_rule(uuid) from public, anon;
revoke all on function public.reject_rule(uuid) from public, anon;
grant execute on function public.propose_rule(text, text, numeric) to authenticated;
grant execute on function public.approve_rule(uuid) to authenticated;
grant execute on function public.reject_rule(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Striche: Wertigkeit, Status, Einspruch, Urteil, Verlauf
-- ---------------------------------------------------------------------------
alter table public.strikes
  add column value numeric(3,1) not null default 1 check (value in (0.5, 1, 2)),
  add column title text,
  add column description text,
  add column rule_id uuid references public.strike_rules (id) on delete set null,
  add column status text not null default 'pending' check (status in ('pending', 'appealed', 'active', 'withdrawn')),
  add column final boolean not null default false,
  add column appeal_text text,
  add column verdict_text text,
  add column acknowledged_at timestamptz,
  add column decided_at timestamptz,
  add column has_photo boolean not null default false,
  add column history jsonb not null default '[]';
alter table public.strikes alter column reason type text;
alter table public.strikes drop constraint if exists strikes_reason_check;
alter table public.strikes add constraint strikes_reason_check check (char_length(reason) between 1 and 500);

-- Bisherige Striche gelten als anerkannt
update public.strikes set status = 'active', acknowledged_at = created_at,
  title = coalesce(title, case when reason like 'Deadline verpasst%' then 'Deadline verpasst' else 'Strich bei Abnahme' end);

-- Fotos getrennt (groß, nicht im Live-Kanal)
create table public.strike_photos (
  strike_id uuid primary key references public.strikes (id) on delete cascade,
  data text not null check (char_length(data) <= 1500000)
);
alter table public.strike_photos enable row level security;
create policy "Mitglieder sehen Beweisfotos" on public.strike_photos for select to authenticated using (public.is_member());
revoke all on public.strike_photos from anon, authenticated;
grant select on public.strike_photos to authenticated;

-- ---------------------------------------------------------------------------
-- Bezahlte Strafen (je 10 Striche = 10 €)
-- ---------------------------------------------------------------------------
create table public.fines (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  confirmed_by uuid[] not null default '{}',
  settled_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index fines_one_open on public.fines (user_id) where settled_at is null;
alter table public.fines enable row level security;
create policy "Mitglieder sehen Strafen" on public.fines for select to authenticated using (public.is_member());
revoke all on public.fines from anon, authenticated;
grant select on public.fines to authenticated;

-- Offene Striche = rechtskräftige Striche − 10 je bezahlter Strafe
alter table public.profiles alter column strikes type numeric(6,1);

create function public.recalc_strikes(p_user uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.profiles set strikes =
      coalesce((select sum(value) from public.strikes where user_id = p_user and status = 'active'), 0)
    - 10 * (select count(*) from public.fines where user_id = p_user and settled_at is not null)
  where id = p_user;
$$;
revoke all on function public.recalc_strikes(uuid) from public, anon, authenticated;

create function public.strikes_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then perform public.recalc_strikes(old.user_id); end if;
  if tg_op in ('INSERT', 'UPDATE') then perform public.recalc_strikes(new.user_id); end if;
  return null;
end;
$$;
create trigger strikes_recalc after insert or update or delete on public.strikes
  for each row execute function public.strikes_changed();

select public.recalc_strikes(id) from public.profiles;

create function public.log_entry(p_type text, p_text text default null)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object('type', p_type, 'by', auth.uid(), 'at', now(), 'text', p_text);
$$;

-- Bestrafen
create function public.give_strike(p_user uuid, p_rule uuid, p_reason text, p_photo text default null)
returns public.strikes
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.strike_rules;
  s public.strikes;
begin
  if not public.is_member() then raise exception 'Kein Mitglied'; end if;
  if p_user = auth.uid() then raise exception 'Du kannst dich nicht selbst bestrafen'; end if;
  if not exists (select 1 from public.profiles where id = p_user) then raise exception 'Unbekannter Trainer'; end if;
  select * into r from public.strike_rules where id = p_rule and approved_at is not null;
  if r.id is null then raise exception 'Diese Vorlage ist nicht (mehr) rechtskräftig'; end if;
  p_reason := trim(coalesce(p_reason, ''));
  if p_reason = '' then raise exception 'Bitte begründen, warum der Strich jetzt vergeben wird'; end if;
  insert into public.strikes (user_id, given_by, rule_id, title, description, value, reason, has_photo, history)
  values (p_user, auth.uid(), r.id, r.title, r.description, r.value, left(p_reason, 500), p_photo is not null,
          jsonb_build_array(public.log_entry('given', left(p_reason, 500))))
  returning * into s;
  if p_photo is not null then
    insert into public.strike_photos (strike_id, data) values (s.id, p_photo);
  end if;
  return s;
end;
$$;

-- Der Bestrafte erkennt an
create function public.acknowledge_strike(p_strike uuid)
returns public.strikes
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.strikes;
begin
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

-- Der Bestrafte legt Einspruch ein
create function public.appeal_strike(p_strike uuid, p_text text)
returns public.strikes
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.strikes;
begin
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

-- Der Urheber entscheidet über den Einspruch
--   withdraw – Strich zurückziehen
--   uphold   – neu bewertet (ggf. andere Wertigkeit) → erneut vorläufig, erneuter Einspruch möglich
--   force    – durchboxen: rechtskräftig, kein weiterer Einspruch
create function public.decide_strike(p_strike uuid, p_decision text, p_text text default null, p_value numeric default null)
returns public.strikes
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.strikes;
begin
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

-- Bezahlung der 10 € bestätigen – erst wenn alle bestätigt haben, verschwinden 10 Striche
create function public.confirm_fine(p_user uuid)
returns public.fines
language plpgsql
security definer
set search_path = public
as $$
declare
  f public.fines;
  v_open numeric;
begin
  if not public.is_member() then raise exception 'Kein Mitglied'; end if;
  select strikes into v_open from public.profiles where id = p_user for update;
  if v_open is null then raise exception 'Unbekannter Trainer'; end if;
  if v_open < 10 then raise exception 'Noch keine 10 Striche – keine Strafe fällig'; end if;
  insert into public.fines (user_id) values (p_user) on conflict (user_id) where settled_at is null do nothing;
  update public.fines set confirmed_by = array(select distinct unnest(confirmed_by || auth.uid()))
   where user_id = p_user and settled_at is null returning * into f;
  if public.all_members_in(f.confirmed_by) then
    update public.fines set settled_at = now() where id = f.id returning * into f;
    perform public.recalc_strikes(p_user);
  end if;
  return f;
end;
$$;

revoke all on function public.give_strike(uuid, uuid, text, text) from public, anon;
revoke all on function public.acknowledge_strike(uuid) from public, anon;
revoke all on function public.appeal_strike(uuid, text) from public, anon;
revoke all on function public.decide_strike(uuid, text, text, numeric) from public, anon;
revoke all on function public.confirm_fine(uuid) from public, anon;
grant execute on function public.give_strike(uuid, uuid, text, text) to authenticated;
grant execute on function public.acknowledge_strike(uuid) to authenticated;
grant execute on function public.appeal_strike(uuid, text) to authenticated;
grant execute on function public.decide_strike(uuid, text, text, numeric) to authenticated;
grant execute on function public.confirm_fine(uuid) to authenticated;

-- Deadline-Striche: Urheber der Meldung vergibt (Einspruch geht an ihn), Zähler per Trigger
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
      from public.profiles p where p.id <> m.author_id;
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

alter publication supabase_realtime add table public.strike_rules, public.fines;
