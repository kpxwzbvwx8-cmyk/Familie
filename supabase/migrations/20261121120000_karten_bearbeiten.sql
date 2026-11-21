alter table public.messages add column edit_revision integer not null default 0;

create function public.edit_message_card(
  p_id uuid, p_revision integer, p_card jsonb, p_keep_slots integer[] default '{}',
  p_check_counts integer[] default '{}', p_add_notes jsonb default '[]'
) returns public.messages
language plpgsql security definer set search_path = '' as $$
declare
  m public.messages;
  edited public.messages;
  old_notes jsonb;
  notes jsonb := '[]';
  checks boolean[] := '{}';
  pos integer := 1;
  i integer;
  new_slot integer := 0;
  entry jsonb;
  target uuid;
begin
  if not public.is_member() then raise exception 'Bitte als Familienmitglied anmelden.'; end if;
  select * into m from public.messages where id = p_id
    and (delete_at is null or delete_at > clock_timestamp()) for update;
  if not found or not (m.in_handbook or (m.urgency <> 'info' and m.author_id = auth.uid())) then
    raise exception 'Du kannst diese Karte nicht bearbeiten.';
  end if;
  if m.edit_revision is distinct from p_revision then
    raise exception 'Diese Karte wurde inzwischen bearbeitet. Bitte öffne sie erneut.';
  end if;
  edited := jsonb_populate_record(m, p_card);
  if btrim(edited.title) = '' then raise exception 'Bitte einen Titel angeben.'; end if;
  if m.in_handbook then
    update public.messages set title = btrim(edited.title), description = btrim(edited.description),
      photos_input = edited.photos_input, edit_revision = m.edit_revision + 1
      where id = p_id returning * into m;
    return m;
  end if;
  if edited.urgency = 'info' then raise exception 'Eine Aufgabe muss eine Aufgabe bleiben.'; end if;
  if edited.deadline_at is distinct from m.deadline_at and edited.deadline_at is not null
      and (not isfinite(edited.deadline_at) or edited.deadline_at < clock_timestamp() + interval '2 hours') then
    raise exception 'Eine geänderte Deadline muss mindestens zwei Stunden in der Zukunft liegen.';
  end if;
  if edited.delete_at is not null and edited.delete_at <= clock_timestamp() then
    raise exception 'Das Löschdatum muss in der Zukunft liegen.';
  end if;
  if edited.open_ended and edited.deadline_at is not null then
    raise exception 'Eine Aufgabe mit Deadline kann nicht zeitlich offen sein.';
  end if;
  if edited.additional_info_ids is distinct from m.additional_info_ids then
    foreach target in array edited.additional_info_ids loop
      perform id from public.messages where id = target and urgency = 'info'
        and (delete_at is null or delete_at > now()) for key share;
      if not found then raise exception 'Eine verlinkte Info-Karte ist nicht mehr verfügbar.'; end if;
    end loop;
  end if;
  -- Vorhandene Kopien behalten ihre Bilder und den aktuellen gemeinsamen Listenstand,
  -- auch wenn die Ursprungsnotiz inzwischen geändert oder gelöscht wurde.
  old_notes := (case when m.attached_note is null then '[]'::jsonb else jsonb_build_array(m.attached_note) end) || m.additional_notes;
  if cardinality(p_check_counts) is distinct from jsonb_array_length(old_notes)
      or exists (select from unnest(p_check_counts) c where c is null or c < 0)
      or (select coalesce(sum(c),0) from unnest(p_check_counts) c) <> cardinality(m.note_checks) then
    raise exception 'Die Checklisten haben sich geändert. Bitte öffne die Aufgabe erneut.';
  end if;
  for i in 1..jsonb_array_length(old_notes) loop
    if i = any(p_keep_slots) then
      new_slot := new_slot + 1;
      notes := notes || jsonb_build_array(old_notes->(i-1));
      checks := checks || m.note_checks[pos:pos+p_check_counts[i]-1];
      if new_slot <> i then update public.card_photos set slot = new_slot
        where message_id = p_id and card_photos.slot = i; end if;
    else
      delete from public.card_photos where message_id = p_id and card_photos.slot = i;
    end if;
    pos := pos + p_check_counts[i];
  end loop;
  for entry in select value from jsonb_array_elements(p_add_notes) loop
    new_slot := new_slot + 1;
    if jsonb_typeof(entry->'attached_note') is distinct from 'object' then raise exception 'Ungültige Notiz.'; end if;
    notes := notes || jsonb_build_array(entry->'attached_note');
    checks := checks || array(select value::boolean from jsonb_array_elements_text(entry->'note_checks'));
    if entry->'attached_note'->>'photoSource' is not null then
      insert into public.card_photos(message_id,slot,photos)
        select p_id, new_slot, p.photos from public.card_photos p join public.notes n on n.id = p.note_id
        where n.id = (entry->'attached_note'->>'photoSource')::uuid and public.note_visible(n.owner_id,n.shared_with);
      if not found then raise exception 'Die Notizbilder sind nicht mehr verfügbar.'; end if;
    end if;
  end loop;
  update public.messages set title = btrim(edited.title), description = btrim(edited.description),
    urgency = edited.urgency, assignees = edited.assignees, event_at = edited.event_at, end_at = edited.end_at,
    open_ended = edited.open_ended, deadline_at = edited.deadline_at, threat_strike = edited.threat_strike,
    delete_at = edited.delete_at, delete_on_done = edited.delete_on_done, remind_at_start = edited.remind_at_start,
    needs_ack = edited.needs_ack, ack_options = edited.ack_options, respond_by = edited.respond_by,
    reminder_sent = m.reminder_sent and m.event_at is not distinct from edited.event_at,
    deadline_warned = m.deadline_warned and m.deadline_at is not distinct from edited.deadline_at,
    respond_warned = m.respond_warned and m.respond_by is not distinct from edited.respond_by,
    respond_reminder_sent = m.respond_reminder_sent and m.respond_by is not distinct from edited.respond_by,
    linked_info_id = edited.linked_info_id, additional_info_ids = edited.additional_info_ids,
    attached_note = notes->0, additional_notes = notes - 0, note_checks = checks,
    photos_input = edited.photos_input, edit_revision = m.edit_revision + 1
    where id = p_id returning * into m;
  return m;
end;
$$;
revoke all on function public.edit_message_card(uuid,integer,jsonb,integer[],integer[],jsonb) from public, anon;
grant execute on function public.edit_message_card(uuid,integer,jsonb,integer[],integer[],jsonb) to authenticated;

create function public.check_card_item(p_message uuid, p_revision integer, p_index integer, p_checked boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform id from public.messages where id = p_message and edit_revision = p_revision and public.is_member() for update;
  if not found then raise exception 'Die Aufgabe wurde bearbeitet. Bitte öffne sie erneut.'; end if;
  perform public.set_task_note_check(p_message,p_index,p_checked);
end;
$$;
revoke all on function public.check_card_item(uuid,integer,integer,boolean) from public, anon;
grant execute on function public.check_card_item(uuid,integer,integer,boolean) to authenticated;
