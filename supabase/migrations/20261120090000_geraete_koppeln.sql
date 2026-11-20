-- Am PC anmelden: Einmal-Code vom Handy (10 Minuten gültig, nur einmal nutzbar).
-- Nur die Edge Function „pair“ (Service-Rolle) liest/schreibt diese Tabelle.
create table public.device_pairings (
  code_hash text primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.device_pairings enable row level security;
revoke all on public.device_pairings from anon, authenticated;
