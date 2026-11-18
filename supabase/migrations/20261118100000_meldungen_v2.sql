-- Meldungen: Zeitraum, Erinnerung zum Beginn, Rückmeldung / Löschen wenn erledigt
alter table public.messages
  add column end_at timestamptz,
  add column remind_at_start boolean not null default false,
  add column reminder_sent boolean not null default false,
  add column needs_ack boolean not null default false,
  add column delete_on_done boolean not null default false,
  add column done_by uuid references public.profiles (id) on delete set null,
  add column done_at timestamptz,
  add constraint messages_end_after_start check (end_at is null or event_at is null or end_at >= event_at);

-- Clients dürfen diese Felder nicht direkt setzen (erledigen läuft über die Edge Function)
revoke insert on public.messages from authenticated;
grant insert (urgency, title, description, event_at, end_at, delete_at, remind_at_start, needs_ack, delete_on_done)
  on public.messages to authenticated;

-- Erinnerungen: jede Minute die Edge Function „tick“ anstoßen.
-- URL und Geheimnis legt die Edge Function „push“ selbst in app_secrets ab (Schlüssel 'tick').
create extension if not exists pg_net;

select cron.schedule(
  'familie-erinnerungen',
  '* * * * *',
  $$
  select net.http_post(
    url := c.value ->> 'url',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-familie-secret', c.value ->> 'secret'),
    body := '{}'::jsonb
  )
  from public.app_secrets c
  where c.key = 'tick'
    and exists (
      select 1 from public.messages m
      where m.remind_at_start and not m.reminder_sent and m.event_at <= now()
    )
  $$
);
