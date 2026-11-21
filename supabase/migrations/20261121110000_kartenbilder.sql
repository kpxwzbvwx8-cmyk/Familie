-- Die Karten bleiben klein. Bilder werden erst in der geöffneten Karte geladen.
create table public.card_photos (
  id bigint generated always as identity primary key,
  message_id uuid references public.messages on delete cascade deferrable initially deferred,
  note_id uuid references public.notes on delete cascade deferrable initially deferred,
  event_id uuid references public.events on delete cascade deferrable initially deferred,
  rule_id uuid references public.strike_rules on delete cascade deferrable initially deferred,
  strike_id uuid references public.strikes on delete cascade deferrable initially deferred,
  slot integer not null default 0, -- 0: Karte selbst, 1..n: eingebettete Notiz
  photos text[] not null,
  check (num_nonnulls(message_id, note_id, event_id, rule_id, strike_id) = 1),
  unique(message_id, slot), unique(note_id), unique(event_id), unique(rule_id), unique(strike_id)
);
alter table public.card_photos enable row level security;
revoke all on public.card_photos from public, anon, authenticated;
grant select on public.card_photos to authenticated;
create policy "Bilder folgen der Sichtbarkeit der Karte" on public.card_photos
for select to authenticated using (public.is_member() and
  (note_id is null or exists (select 1 from public.notes n where n.id = note_id)));

alter table public.messages add column photos_input text[], add column has_photos boolean not null default false,
  add column additional_notes jsonb not null default '[]' check (jsonb_typeof(additional_notes) = 'array'),
  add column additional_info_ids uuid[] not null default '{}',
  add check (cardinality(additional_info_ids) = 0 or urgency <> 'info'),
  add check (additional_notes = '[]' or attached_note is not null);
alter table public.notes add column photos_input text[], add column has_photos boolean not null default false;
alter table public.events add column photos_input text[], add column has_photos boolean not null default false;
alter table public.strike_rules add column photos_input text[], add column has_photos boolean not null default false;
alter table public.strikes add column photos_input text[], add column has_photos boolean not null default false;
grant insert (photos_input, additional_notes, additional_info_ids) on public.messages to authenticated;
grant update (photos_input) on public.notes to authenticated;

create function public.store_card_photos() returns trigger
language plpgsql security definer set search_path = '' as $$
declare already_exists boolean;
begin
  -- Ein ignorierter INSERT-Konflikt darf keine Bilder an eine fremde Karte hängen.
  if tg_op = 'INSERT' and tg_table_name in ('notes','messages') then
    perform pg_advisory_xact_lock(hashtextextended(new.id::text, 0));
    if cardinality(new.photos_input) > 0 then
      execute format('select exists(select 1 from public.%I where id = $1)', tg_table_name)
        into already_exists using new.id;
      if already_exists then raise exception 'Diese Karte ist bereits vorhanden.'; end if;
    end if;
  end if;
  if new.photos_input is null then return new; end if;
  if cardinality(new.photos_input) > 4 or exists (
    select 1 from unnest(new.photos_input) p where p is null or length(p) > 600000
      or p not like 'data:image/jpeg;base64,/%' or substr(p,24) ~ '[^A-Za-z0-9+/=]'
  ) then raise exception 'Bitte bis zu vier gültige, verkleinerte Fotos auswählen.'; end if;
  if tg_op = 'UPDATE' then
    execute format('delete from public.card_photos where %I = $1 and slot = 0', tg_argv[0]) using new.id;
  end if;
  new.has_photos := cardinality(new.photos_input) > 0;
  if new.has_photos then
    execute format('insert into public.card_photos (%I, photos) values ($1,$2)', tg_argv[0])
      using new.id, new.photos_input;
  end if;
  new.photos_input := null;
  if tg_table_name = 'notes' and tg_op = 'UPDATE' then
    new.updated_at := now();
    new.updated_by := auth.uid();
  end if;
  return new;
end;
$$;
-- Läuft nach notes_before_write, damit auch reine Bildänderungen datiert werden.
create trigger store_photos before insert or update of photos_input on public.notes for each row execute function public.store_card_photos('note_id');
create trigger store_photos before insert or update of photos_input on public.messages for each row execute function public.store_card_photos('message_id');
create trigger store_photos before insert or update of photos_input on public.events for each row execute function public.store_card_photos('event_id');
create trigger store_photos before insert or update of photos_input on public.strike_rules for each row execute function public.store_card_photos('rule_id');
create trigger store_photos before insert or update of photos_input on public.strikes for each row execute function public.store_card_photos('strike_id');

create function public.copy_task_note_photos() returns trigger
language plpgsql security definer set search_path = '' as $$
declare n jsonb; i integer := 0;
begin
  for n in select value from jsonb_array_elements(jsonb_build_array(new.attached_note) || new.additional_notes) loop
    i := i + 1;
    if n->>'photoSource' is not null then
      insert into public.card_photos(message_id, slot, photos)
        select new.id, i, p.photos from public.card_photos p join public.notes src on src.id = p.note_id
        where src.id = (n->>'photoSource')::uuid and public.note_visible(src.owner_id, src.shared_with);
      if not found then raise exception 'Die Notizbilder sind nicht mehr verfügbar. Bitte die Auswahl aktualisieren.'; end if;
    end if;
  end loop;
  return new;
end;
$$;
create trigger copy_task_note_photos after insert on public.messages for each row
when (new.attached_note is not null) execute function public.copy_task_note_photos();

create function public.validate_extra_info_links() returns trigger language plpgsql security definer set search_path = '' as $$
declare target uuid;
begin
  foreach target in array new.additional_info_ids loop
    perform id from public.messages where id = target and urgency = 'info' for key share;
    if not found then raise exception 'Eine verlinkte Info-Karte ist nicht mehr verfügbar.'; end if;
  end loop;
  return new;
end;
$$;
create trigger validate_extra_info_links before insert on public.messages
  for each row when (cardinality(new.additional_info_ids) > 0) execute function public.validate_extra_info_links();
create index messages_extra_info_idx on public.messages using gin(additional_info_ids);
create function public.remove_extra_info_links() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.messages set additional_info_ids = array_remove(additional_info_ids, old.id)
    where additional_info_ids @> array[old.id];
  return old;
end;
$$;
create trigger remove_extra_info_links after delete on public.messages for each row
  when (old.urgency = 'info') execute function public.remove_extra_info_links();

-- Die bestehenden RPCs prüfen weiterhin Besitzer, Teilnehmer, Serien und Regeln.
create function public.save_event_with_photos(
  p_id uuid, p_title text, p_location text, p_description text, p_all_day boolean,
  p_start timestamptz, p_end timestamptz, p_reminders jsonb, p_invitees uuid[],
  p_kind text, p_assignees uuid[], p_recurrence jsonb, p_photos text[],
  p_split_id uuid default null, p_split_occ timestamptz default null, p_single boolean default false
) returns public.events language plpgsql security definer set search_path = '' as $$
declare e public.events;
begin
  if p_split_id is not null then
    if p_single then perform public.event_exclude(p_split_id, p_split_occ);
    else perform public.event_split(p_split_id, p_split_occ); end if;
  end if;
  e := public.save_event(p_id,p_title,p_location,p_description,p_all_day,p_start,p_end,p_reminders,p_invitees,p_kind,p_assignees,p_recurrence);
  if p_photos is not null then update public.events set photos_input = p_photos where id = e.id returning * into e; end if;
  return e;
end;
$$;
create function public.propose_rule_with_photos(p_title text, p_description text, p_value numeric, p_photos text[])
returns public.strike_rules language plpgsql security definer set search_path = '' as $$
declare r public.strike_rules;
begin
  r := public.propose_rule(p_title,p_description,p_value);
  update public.strike_rules set photos_input = p_photos where id = r.id returning * into r;
  return r;
end;
$$;
create function public.give_strike_with_photos(p_user uuid, p_rule uuid, p_reason text, p_photos text[])
returns public.strikes language plpgsql security definer set search_path = '' as $$
declare s public.strikes;
begin
  s := public.give_strike(p_user,p_rule,p_reason,null);
  update public.strikes set photos_input = p_photos where id = s.id returning * into s;
  return s;
end;
$$;
revoke all on function public.save_event_with_photos(uuid,text,text,text,boolean,timestamptz,timestamptz,jsonb,uuid[],text,uuid[],jsonb,text[],uuid,timestamptz,boolean), public.propose_rule_with_photos(text,text,numeric,text[]), public.give_strike_with_photos(uuid,uuid,text,text[]) from public, anon;
grant execute on function public.save_event_with_photos(uuid,text,text,text,boolean,timestamptz,timestamptz,jsonb,uuid[],text,uuid[],jsonb,text[],uuid,timestamptz,boolean), public.propose_rule_with_photos(text,text,numeric,text[]), public.give_strike_with_photos(uuid,uuid,text,text[]) to authenticated;
revoke all on function public.store_card_photos(), public.copy_task_note_photos(),
  public.validate_extra_info_links(), public.remove_extra_info_links() from public, anon, authenticated;
