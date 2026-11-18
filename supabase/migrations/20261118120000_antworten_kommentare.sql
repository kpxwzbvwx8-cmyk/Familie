-- Rückmelde-Optionen (z. B. „Erledigt“ oder „Ja“/„Nein“), Antworten und Kommentare
alter table public.messages
  add column ack_options text[] check (ack_options is null or array_length(ack_options, 1) between 1 and 6);
grant insert (ack_options) on public.messages to authenticated;

-- Antworten: eine pro Person und Meldung; geschrieben nur über die Edge Function (mit Benachrichtigung)
create table public.message_responses (
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  option text not null check (char_length(option) between 1 and 40),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);
alter table public.message_responses enable row level security;
create policy "Mitglieder lesen Antworten" on public.message_responses
  for select to authenticated using (public.is_member());
revoke all on public.message_responses from anon, authenticated;
grant select on public.message_responses to authenticated;

-- Kommentare
create table public.message_comments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages (id) on delete cascade,
  author_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index message_comments_message_idx on public.message_comments (message_id, created_at);
alter table public.message_comments enable row level security;
create policy "Mitglieder lesen Kommentare" on public.message_comments
  for select to authenticated using (public.is_member());
create policy "Mitglieder kommentieren" on public.message_comments
  for insert to authenticated with check (author_id = auth.uid() and public.is_member());
create policy "Eigene Kommentare löschen" on public.message_comments
  for delete to authenticated using (author_id = auth.uid());
revoke all on public.message_comments from anon, authenticated;
grant select, delete on public.message_comments to authenticated;
grant insert (message_id, body) on public.message_comments to authenticated;

alter publication supabase_realtime add table public.message_responses, public.message_comments;
