create table public.pets (
  id uuid primary key default gen_random_uuid(),
  family_id integer not null default public.current_family_id() references public.family on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 40),
  birthday date check (birthday <= current_date),
  photo text check (length(photo) <= 900000 and photo ~ '^data:image/(webp|png);base64,[A-Za-z0-9+/]+=*$')
);
create index pets_family_idx on public.pets(family_id);
alter table public.pets enable row level security;
revoke all on public.pets from public, anon, authenticated;
grant select, insert(name,birthday,photo) on public.pets to authenticated;
create policy read_team_pets on public.pets for select to authenticated using (family_id = (select public.current_family_id()));
create policy create_team_pet on public.pets for insert to authenticated with check (family_id = (select public.current_family_id()));
