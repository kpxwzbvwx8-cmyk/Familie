-- v1.1.1: Infos gelesen/ausgeblendet (pro Person) · Erinnerungen ohne Erledigt-Knopf

-- Wer hat welche Info gelesen bzw. für sich ausgeblendet?
create table public.message_reads (
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  read_at timestamptz not null default now(),
  hidden boolean not null default false,
  primary key (message_id, user_id)
);
alter table public.message_reads enable row level security;
create policy "Eigene Lesebestätigungen sehen" on public.message_reads for select to authenticated
  using (user_id = auth.uid());
create policy "Eigene Lesebestätigungen anlegen" on public.message_reads for insert to authenticated
  with check (user_id = auth.uid() and public.is_member());
create policy "Eigene Lesebestätigungen ändern" on public.message_reads for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "Eigene Lesebestätigungen löschen" on public.message_reads for delete to authenticated
  using (user_id = auth.uid());
grant select, insert, update, delete on public.message_reads to authenticated;

-- Erinnerung mit Erledigt-Knopf (bleibt bis abgehakt) oder nur als Hinweis-Balken
alter table public.events add column needs_done boolean not null default true;

create function public.set_event_needs_done(p_event uuid, p_value boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.events set needs_done = coalesce(p_value, true) where id = p_event and owner_id = auth.uid();
  if not found then raise exception 'Nur der Ersteller kann den Eintrag ändern'; end if;
end;
$$;
revoke all on function public.set_event_needs_done(uuid, boolean) from public, anon;
grant execute on function public.set_event_needs_done(uuid, boolean) to authenticated;
