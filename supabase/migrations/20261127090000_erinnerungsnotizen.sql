alter table public.events
  add column attached_notes jsonb not null default '[]' check (jsonb_typeof(attached_notes) = 'array'),
  add column notes_revision integer not null default 0;
create or replace function public.todo_no_done()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.kind='todo' then
    new.needs_done := exists(select from jsonb_array_elements(new.attached_notes) n where (n->>'checkCount')::int>0);
  end if;
  return new;
end;
$$;

alter table public.card_photos drop constraint card_photos_event_id_key,
  add unique(event_id, slot);

create table public.event_note_checks (
  event_id uuid not null references public.events on delete cascade,
  occ timestamptz not null,
  note_id uuid not null,
  item_index integer not null check (item_index >= 0),
  checked boolean not null,
  primary key(event_id, occ, note_id, item_index)
);
alter table public.event_note_checks enable row level security;
revoke all on public.event_note_checks from public, anon, authenticated;
grant select on public.event_note_checks to authenticated;
create policy family_scope on public.event_note_checks for select to authenticated using (
  exists(select from public.events e where e.id = event_id)
);
alter publication supabase_realtime add table public.event_note_checks;

create function public.save_event_with_notes(
  p_id uuid, p_title text, p_location text, p_description text, p_all_day boolean,
  p_start timestamptz, p_end timestamptz, p_reminders jsonb, p_invitees uuid[],
  p_kind text, p_assignees uuid[], p_recurrence jsonb, p_photos text[],
  p_notes jsonb, p_notes_revision integer,
  p_split_id uuid default null, p_split_occ timestamptz default null, p_single boolean default false
) returns public.events language plpgsql security definer set search_path = '' as $$
declare
  previous public.events;
  saved public.events;
  source public.notes;
  choice jsonb;
  attachment jsonb;
  attachments jsonb := '[]';
  next_slot integer;
begin
  if not public.is_member() then raise exception 'Kein Mitglied'; end if;
  if jsonb_typeof(p_notes) is distinct from 'array' or jsonb_array_length(p_notes) > 30 then
    raise exception 'Bitte bis zu 30 Notizen auswählen.';
  end if;
  if coalesce(p_split_id,p_id) is not null then
    select * into previous from public.events where id=coalesce(p_split_id,p_id)
      and family_id=public.current_family_id() and owner_id=auth.uid() for update;
    if previous.id is null then raise exception 'Nur der Ersteller kann den Eintrag bearbeiten'; end if;
    if previous.notes_revision is distinct from p_notes_revision then
      raise exception 'Die eingebetteten Notizen wurden geändert. Bitte den Eintrag erneut öffnen.';
    end if;
  end if;
  saved := public.save_event_with_photos(p_id,p_title,p_location,p_description,p_all_day,
    p_start,p_end,p_reminders,p_invitees,p_kind,p_assignees,p_recurrence,p_photos,p_split_id,p_split_occ,p_single);
  select coalesce(max((n->>'slot')::int),0) into next_slot from jsonb_array_elements(coalesce(previous.attached_notes,'[]')) n;
  for choice in select value from jsonb_array_elements(p_notes) loop
    if choice ? 'keep' then
      select n into attachment from jsonb_array_elements(previous.attached_notes) n where n->>'id'=choice->>'keep';
      if attachment is null then raise exception 'Eine eingebettete Notiz ist nicht mehr vorhanden.'; end if;
      if saved.id <> previous.id and attachment->>'photoSource' is not null then
        insert into public.card_photos(event_id,slot,photos)
          select saved.id,p.slot,p.photos from public.card_photos p
          where p.event_id=previous.id and p.slot=(attachment->>'slot')::int;
      end if;
    else
      select * into source from public.notes n where n.id=(choice->>'note_id')::uuid
        and n.family_id=public.current_family_id() and public.note_visible(n.owner_id,n.shared_with) for share;
      if source.id is null then raise exception 'Die Notiz ist nicht mehr verfügbar.'; end if;
      if source.updated_at is distinct from (choice->>'updated_at')::timestamptz then
        raise exception 'Die Notiz wurde geändert. Bitte die Auswahl erneut öffnen.';
      end if;
      if coalesce((choice->>'check_count')::int,-1) not between 0 and 10000 then raise exception 'Ungültige Checkliste'; end if;
      next_slot := next_slot + 1;
      attachment := jsonb_build_object('id',gen_random_uuid(),'slot',next_slot,'title',source.title,
        'content',source.content,'paper',source.paper,'drawing',source.drawing,'checkCount',(choice->>'check_count')::int);
      if source.has_photos then
        attachment := attachment || jsonb_build_object('photoSource',source.id);
        insert into public.card_photos(event_id,slot,photos)
          select saved.id,next_slot,p.photos from public.card_photos p where p.note_id=source.id;
      end if;
    end if;
    if attachments @> jsonb_build_array(jsonb_build_object('id',attachment->>'id')) then raise exception 'Notiz doppelt ausgewählt'; end if;
    attachments := attachments || jsonb_build_array(attachment);
  end loop;
  update public.events set attached_notes=attachments, notes_revision=notes_revision+1 where id=saved.id returning * into saved;
  delete from public.card_photos p where p.event_id=saved.id and p.slot>0
    and not exists(select from jsonb_array_elements(attachments) n where (n->>'slot')::int=p.slot);
  if saved.id is distinct from previous.id and previous.id is not null then
    insert into public.event_note_checks
      select saved.id,c.occ,c.note_id,c.item_index,c.checked from public.event_note_checks c
      where c.event_id=previous.id and c.occ>=p_split_occ and (not p_single or c.occ=p_split_occ)
        and exists(select from jsonb_array_elements(attachments) n where (n->>'id')::uuid=c.note_id);
  end if;
  return saved;
end;
$$;
revoke all on function public.save_event_with_notes(uuid,text,text,text,boolean,timestamptz,timestamptz,jsonb,uuid[],text,uuid[],jsonb,text[],jsonb,integer,uuid,timestamptz,boolean) from public, anon;
grant execute on function public.save_event_with_notes(uuid,text,text,text,boolean,timestamptz,timestamptz,jsonb,uuid[],text,uuid[],jsonb,text[],jsonb,integer,uuid,timestamptz,boolean) to authenticated;

create function public.check_event_note_item(p_event uuid,p_occ timestamptz,p_note uuid,p_index integer,p_checked boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare e public.events; n jsonb;
begin
  select * into e from public.events where id=p_event and family_id=public.current_family_id() for update;
  if e.id is null then raise exception 'Eintrag nicht gefunden'; end if;
  if not (auth.uid()=any(e.assignees) or (cardinality(e.assignees)=0 and e.owner_id=auth.uid())) then
    raise exception 'Nur die zuständige Person kann abhaken';
  end if;
  select value into n from jsonb_array_elements(e.attached_notes) where value->>'id'=p_note::text;
  if n is null or p_index is null or p_index<0 or p_index >= (n->>'checkCount')::int or p_checked is null then raise exception 'Listenpunkt nicht gefunden'; end if;
  if not exists(select from public.event_occurrences(e,p_occ,p_occ) o where o=p_occ) then raise exception 'Ungültiges Vorkommen'; end if;
  if exists(select from public.event_done where event_id=p_event and occ=p_occ) then raise exception 'Bitte die Erinnerung zuerst wieder öffnen'; end if;
  insert into public.event_note_checks values (p_event,p_occ,p_note,p_index,p_checked)
    on conflict(event_id,occ,note_id,item_index) do update set checked=excluded.checked;
end;
$$;
revoke all on function public.check_event_note_item(uuid,timestamptz,uuid,integer,boolean) from public,anon;
grant execute on function public.check_event_note_item(uuid,timestamptz,uuid,integer,boolean) to authenticated;

create or replace function public.set_event_done(p_event uuid,p_occ timestamptz,p_done boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare e public.events;
begin
  select * into e from public.events where id=p_event and family_id=public.current_family_id() for update;
  if e.id is null then raise exception 'Eintrag nicht gefunden'; end if;
  if not (auth.uid()=any(e.assignees) or (cardinality(e.assignees)=0 and e.owner_id=auth.uid())) then
    raise exception 'Nur die zuständige Person kann abhaken';
  end if;
  if not exists(select from public.event_occurrences(e,p_occ,p_occ) o where o=p_occ) then raise exception 'Ungültiges Vorkommen'; end if;
  if p_done then
    if exists(select from jsonb_array_elements(e.attached_notes) n
      cross join lateral generate_series(0,(n->>'checkCount')::int-1) i
      where not exists(select from public.event_note_checks c where c.event_id=e.id and c.occ=p_occ
        and c.note_id=(n->>'id')::uuid and c.item_index=i and c.checked)) then
      raise exception 'Bitte zuerst alle Listenpunkte abhaken.';
    end if;
    insert into public.event_done(event_id,occ,done_by) values(p_event,p_occ,auth.uid()) on conflict do nothing;
  else
    delete from public.event_done where event_id=p_event and occ=p_occ;
  end if;
  perform public.refresh_event_reminders(e.id);
end;
$$;

-- Ein frei gewählter Hinweis einer Serie beschreibt den Abstand zum ersten Tag.
create function public.series_reminder_spec(r jsonb, series_start timestamptz)
returns jsonb language sql stable set search_path = '' as $$
  select case when r->>'k'='custom' then jsonb_build_object('k','day',
    'd',(series_start at time zone 'Europe/Berlin')::date - ((r->>'at')::timestamptz at time zone 'Europe/Berlin')::date,
    'h',to_char((r->>'at')::timestamptz at time zone 'Europe/Berlin','HH24:MI')) else r end
$$;
create function public.normalize_series_reminders() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.recurrence is not null then
    select coalesce(jsonb_agg(public.series_reminder_spec(r,new.start_at) order by ord),'[]')
      into new.reminders from jsonb_array_elements(new.reminders) with ordinality x(r,ord);
  end if;
  return new;
end;
$$;
revoke all on function public.normalize_series_reminders() from public,anon,authenticated;
create trigger normalize_series_reminders before insert or update of reminders,recurrence,start_at
  on public.events for each row execute function public.normalize_series_reminders();
update public.events set reminders=reminders
  where recurrence is not null and reminders @> '[{"k":"custom"}]';

create or replace function public.refresh_event_reminders(p_event uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  e public.events;
  o timestamptz;
  r jsonb;
  t timestamptz;
  lead interval;
  lag interval;
begin
  select * into e from public.events where id=p_event for update;
  if e.id is null then return; end if;
  delete from public.event_reminders where event_id=p_event and sent_at is null;
  select coalesce(greatest(max(e.start_at-public.event_reminder_time(spec,e.start_at)),interval '0'),interval '0') + interval '1 day',
         coalesce(greatest(max(public.event_reminder_time(spec,e.start_at)-e.start_at),interval '0'),interval '0') + interval '1 day'
    into lead,lag from jsonb_array_elements(e.reminders) x(spec);
  for o in select * from public.event_occurrences(e,now()-lag-interval '5 minutes',now()+interval '35 days'+lead) loop
    continue when e.kind='todo' and exists(select from public.event_done d where d.event_id=e.id and d.occ=o);
    for r in select * from jsonb_array_elements(e.reminders) loop
      t := public.event_reminder_time(r,o);
      if t>now()-interval '5 minutes' and t<=now()+interval '35 days' then
        insert into public.event_reminders(event_id,remind_at,label,occ) values(e.id,t,r::text,o)
          on conflict(event_id,remind_at) do nothing;
      end if;
    end loop;
  end loop;
end;
$$;
select public.refresh_event_reminders(id) from public.events where recurrence is not null;
