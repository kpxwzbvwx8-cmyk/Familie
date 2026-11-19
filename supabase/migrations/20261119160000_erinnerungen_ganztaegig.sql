-- Erinnerungen sind ab jetzt immer ganztägig und ohne Erledigt-Knopf.
-- Die eigene Uhrzeit setzt man über den Hinweis – bei ganztägigen Einträgen darf ein eigener Hinweis
-- deshalb auch noch am Tag selbst liegen.

update public.events set needs_done = false where kind = 'todo';

create or replace function public.todo_no_done()
returns trigger
language plpgsql
as $$
begin
  if new.kind = 'todo' then new.needs_done := false; end if;
  return new;
end;
$$;
create trigger events_todo_no_done before insert or update on public.events
  for each row execute function public.todo_no_done();

create or replace function public.save_event(
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
    -- ganztägig: eigener Hinweis bis zum Ende des Tages erlaubt (die Uhrzeit bestimmt man selbst)
    if r ->> 'k' = 'custom' and t > (case when p_all_day then p_end else p_start end) then
      raise exception 'Ein Hinweis darf nicht nach dem Beginn liegen';
    end if;
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

-- Hinweis „am Tag / X Tage vorher“ mit frei wählbarer Uhrzeit (h = 'HH:MM', sonst 9:00)
create or replace function public.event_reminder_time(p_spec jsonb, p_start timestamptz)
returns timestamptz
language sql
stable
as $$
  select case p_spec ->> 'k'
    when 'offset' then p_start - make_interval(mins => (p_spec ->> 'm')::int)
    when 'day' then ((p_start at time zone 'Europe/Berlin')::date - (p_spec ->> 'd')::int
                     + coalesce(nullif(p_spec ->> 'h', ''), '09:00')::time) at time zone 'Europe/Berlin'
    when 'custom' then (p_spec ->> 'at')::timestamptz
  end;
$$;

-- bestehende Hinweise mit der neuen Berechnung neu aufbauen
select public.refresh_event_reminders(id) from public.events;
