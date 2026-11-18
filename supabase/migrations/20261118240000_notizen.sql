-- =========================================================================
-- Notizen
--  * Eigene Notizen (nur der Besitzer) und gemeinsame Notizen (Besitzer lädt ein).
--  * Überschrift, formatierter Text, Fingerzeichnung, Briefpapier.
--  * Zeitstempel und Person der letzten Bearbeitung.
--  * Nur der Besitzer lädt ein bzw. löscht; Eingeladene können die Notiz verlassen.
-- =========================================================================
create table public.notes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  title text not null default '' check (char_length(title) <= 120),
  content text not null default '' check (char_length(content) <= 100000),
  drawing jsonb not null default '[]' check (pg_column_size(drawing) < 900000),
  paper text not null default 'schlicht' check (paper ~ '^[a-z]{1,20}$'),
  shared_with uuid[] not null default '{}',
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index notes_shared_idx on public.notes using gin (shared_with);
alter table public.notes enable row level security;

create function public.note_visible(p_owner uuid, p_shared uuid[])
returns boolean
language sql
stable
as $$
  select public.is_member() and (p_owner = auth.uid() or auth.uid() = any (p_shared));
$$;

create policy "Eigene und gemeinsame Notizen lesen" on public.notes
  for select to authenticated using (public.note_visible(owner_id, shared_with));
create policy "Notizen anlegen" on public.notes
  for insert to authenticated with check (owner_id = auth.uid() and public.is_member());
create policy "Notizen bearbeiten" on public.notes
  for update to authenticated
  using (public.note_visible(owner_id, shared_with))
  with check (public.note_visible(owner_id, shared_with));
create policy "Besitzer löscht Notiz" on public.notes
  for delete to authenticated using (owner_id = auth.uid());

revoke all on public.notes from anon, authenticated;
grant select, insert, delete on public.notes to authenticated;
grant update (title, content, drawing, paper, shared_with) on public.notes to authenticated;

-- Zeitstempel/Bearbeiter setzen; nur der Besitzer ändert die Eingeladenen
create function public.notes_before_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    new.owner_id := old.owner_id;
    new.created_at := old.created_at;
    if new.shared_with is distinct from old.shared_with and auth.uid() is distinct from old.owner_id
       and new.shared_with is distinct from array_remove(old.shared_with, auth.uid()) then
      raise exception 'Nur der Besitzer kann Personen einladen';
    end if;
  end if;
  new.shared_with := array(
    select distinct u from unnest(new.shared_with) u
    where u <> new.owner_id and exists (select 1 from public.profiles p where p.id = u)
  );
  if tg_op = 'UPDATE' and new.title = old.title and new.content = old.content
     and new.drawing = old.drawing and new.paper = old.paper then
    -- nur Einladungen geändert → keine inhaltliche Bearbeitung
    new.updated_at := old.updated_at;
    new.updated_by := old.updated_by;
    return new;
  end if;
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end;
$$;
create trigger notes_before_write before insert or update on public.notes
  for each row execute function public.notes_before_write();

-- Eingeladene verlassen eine gemeinsame Notiz
create function public.leave_note(p_note uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.notes set shared_with = array_remove(shared_with, auth.uid())
   where id = p_note and auth.uid() = any (shared_with);
  if not found then raise exception 'Notiz nicht gefunden'; end if;
end;
$$;
revoke all on function public.leave_note(uuid) from public, anon;
grant execute on function public.leave_note(uuid) to authenticated;

alter publication supabase_realtime add table public.notes;
