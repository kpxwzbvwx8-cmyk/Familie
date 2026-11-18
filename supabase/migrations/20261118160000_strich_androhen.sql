-- Androhung eines Strichs auf dem Board der Schande bei Nichterfüllung (Automatik folgt später)
alter table public.messages add column threat_strike boolean not null default false;
grant insert (threat_strike) on public.messages to authenticated;
