-- Deadlines & Striche
--  * Läuft die Deadline ab, wird die Meldung geschlossen.
--  * Bei Strich-Androhung:
--      - keine Rückmeldung bis zur Deadline → Strich für alle anderen (nicht den Urheber), Grund „Deadline verpasst“
--      - Rückmeldung („Erledigt“ oder Antwort) vor Ablauf → Timer eingefroren, der Urheber nimmt ab
--        (abnehmen = schließen ohne Strich; ablehnen = Strich mit Begründung)
--  * Jeder Strich wird mit Grund protokolliert.
alter table public.messages
  add column closed_at timestamptz,
  add column review_status text check (review_status in ('accepted', 'rejected', 'missed')),
  add column strike_note text;

create table public.strikes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  message_id uuid references public.messages (id) on delete set null,
  given_by uuid references public.profiles (id) on delete set null,
  reason text not null check (char_length(reason) between 1 and 300),
  created_at timestamptz not null default now()
);
alter table public.strikes enable row level security;
create policy "Mitglieder sehen Striche" on public.strikes for select to authenticated using (public.is_member());
revoke all on public.strikes from anon, authenticated;
grant select on public.strikes to authenticated;

-- Hat jemand auf die Meldung reagiert? (Erledigt gedrückt oder geantwortet) → Timer eingefroren
create function public.message_frozen(p_message uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.messages where id = p_message and done_by is not null)
      or exists (select 1 from public.message_responses where message_id = p_message);
$$;

create function public.process_deadlines()
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
      -- Rückmeldung vorhanden → Timer eingefroren, der Urheber entscheidet
      continue when public.message_frozen(m.id);
      with log as (
        insert into public.strikes (user_id, message_id, reason)
        select p.id, m.id, 'Deadline verpasst: ' || m.title
        from public.profiles p where p.id <> m.author_id
        returning user_id
      )
      update public.profiles set strikes = strikes + 1 where id in (select user_id from log);
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
revoke all on function public.message_frozen(uuid) from public, anon;

select cron.schedule('familie-deadlines', '* * * * *', $$select public.process_deadlines()$$);

alter publication supabase_realtime add table public.strikes;
