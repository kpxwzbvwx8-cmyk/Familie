-- =========================================================================
-- Familie – Datenbankschema (Supabase)
-- =========================================================================

create extension if not exists pg_cron with schema pg_catalog;

-- ---------------------------------------------------------------------------
-- Familie (genau eine Zeile): Familien-Code zum Beitreten
-- ---------------------------------------------------------------------------
create table public.family (
  id int primary key default 1 check (id = 1),
  code text not null,
  created_at timestamptz not null default now()
);
alter table public.family enable row level security;
revoke all on public.family from anon, authenticated;

-- Private Einstellungen (z. B. VAPID-Schlüssel); nur für den Service-Role-Key.
create table public.app_secrets (
  key text primary key,
  value jsonb not null
);
alter table public.app_secrets enable row level security;
revoke all on public.app_secrets from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Profile (= Trainerpässe)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  trainer_id text not null unique,
  first_name text not null check (char_length(first_name) between 1 and 40),
  last_name text not null check (char_length(last_name) between 1 and 40),
  gender text not null check (gender in ('m', 'w')),
  color text not null check (color ~ '^#[0-9a-f]{6}$'),
  birthday date not null check (birthday <= current_date),
  strikes int not null default 0,
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

create function public.is_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid());
$$;

create policy "Mitglieder sehen alle Profile" on public.profiles
  for select to authenticated using (public.is_member());

create policy "Eigenes Profil bearbeiten" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

revoke insert, update, delete on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (first_name, last_name, gender, color, birthday) on public.profiles to authenticated;

-- Beitreten: Der/die Erste legt den Familien-Code fest, alle anderen brauchen ihn.
create function public.join_family(
  p_code text,
  p_first_name text,
  p_last_name text,
  p_gender text,
  p_color text,
  p_birthday date
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_code text;
  v_tid text;
  v_profile public.profiles;
begin
  if v_uid is null then
    raise exception 'Nicht angemeldet';
  end if;
  if exists (select 1 from public.profiles where id = v_uid) then
    raise exception 'Dieses Gerät hat bereits ein Konto';
  end if;

  p_code := upper(trim(coalesce(p_code, '')));
  if char_length(p_code) < 4 then
    raise exception 'Der Familien-Code muss mindestens 4 Zeichen haben';
  end if;

  select code into v_code from public.family where id = 1 for update;
  if v_code is null then
    insert into public.family (id, code) values (1, p_code);
  elsif v_code <> p_code then
    raise exception 'Falscher Familien-Code';
  end if;

  loop
    v_tid := lpad((floor(random() * 100000))::int::text, 5, '0');
    exit when not exists (select 1 from public.profiles where trainer_id = v_tid);
  end loop;

  insert into public.profiles (id, trainer_id, first_name, last_name, gender, color, birthday)
  values (v_uid, v_tid, trim(p_first_name), trim(p_last_name), p_gender, lower(p_color), p_birthday)
  returning * into v_profile;

  return v_profile;
end;
$$;

revoke all on function public.join_family(text, text, text, text, text, date) from public, anon;
grant execute on function public.join_family(text, text, text, text, text, date) to authenticated;

-- Gibt an, ob schon eine Familie existiert (für den Einrichtungsdialog).
create function public.family_exists()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.family);
$$;
grant execute on function public.family_exists() to anon, authenticated;

-- Familien-Code nur für Mitglieder (zum Einladen weiterer Personen).
create function public.get_family_code()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select code from public.family where public.is_member();
$$;
revoke all on function public.get_family_code() from public, anon;
grant execute on function public.get_family_code() to authenticated;

-- ---------------------------------------------------------------------------
-- Austausch
-- ---------------------------------------------------------------------------
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  urgency text not null default 'normal' check (urgency in ('info', 'normal', 'wichtig', 'dringend')),
  title text not null check (char_length(title) between 1 and 120),
  description text not null default '' check (char_length(description) <= 4000),
  event_at timestamptz,
  delete_at timestamptz,
  created_at timestamptz not null default now()
);
create index messages_delete_at_idx on public.messages (delete_at) where delete_at is not null;
alter table public.messages enable row level security;

create policy "Mitglieder lesen Nachrichten" on public.messages
  for select to authenticated
  using (public.is_member() and (delete_at is null or delete_at > now()));

create policy "Mitglieder schreiben Nachrichten" on public.messages
  for insert to authenticated
  with check (
    author_id = auth.uid()
    and public.is_member()
    and (delete_at is null or delete_at > now())
  );

create policy "Urheber löscht eigene Nachricht" on public.messages
  for delete to authenticated using (author_id = auth.uid());

revoke all on public.messages from anon;
revoke update on public.messages from authenticated;
grant select, insert, delete on public.messages to authenticated;

-- Abgelaufene Nachrichten jede Minute automatisch löschen
select cron.schedule(
  'familie-abgelaufene-nachrichten',
  '* * * * *',
  $$delete from public.messages where delete_at is not null and delete_at <= now()$$
);

-- ---------------------------------------------------------------------------
-- Push-Abonnements
-- ---------------------------------------------------------------------------
create table public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  subscription jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;

create function public.save_push_subscription(p_subscription jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_member() then
    raise exception 'Kein Mitglied';
  end if;
  if p_subscription ->> 'endpoint' is null then
    raise exception 'Ungültiges Abonnement';
  end if;
  insert into public.push_subscriptions (endpoint, user_id, subscription)
  values (p_subscription ->> 'endpoint', auth.uid(), p_subscription)
  on conflict (endpoint) do update
    set user_id = excluded.user_id, subscription = excluded.subscription, created_at = now();
end;
$$;
revoke all on function public.save_push_subscription(jsonb) from public, anon;
grant execute on function public.save_push_subscription(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Live-Updates
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table public.messages, public.profiles;
