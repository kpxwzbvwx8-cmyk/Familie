-- Deadline und Frist für Rückmeldungen (mit Erinnerung 1 Stunde vorher)
alter table public.messages
  add column deadline_at timestamptz,
  add column respond_by timestamptz,
  add column respond_reminder_sent boolean not null default false;
grant insert (deadline_at, respond_by) on public.messages to authenticated;

-- Minuten-Takt: jetzt auch für Rückmelde-Fristen auslösen (gleicher Job-Name = Job wird aktualisiert)
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
      where (m.remind_at_start and not m.reminder_sent and m.event_at <= now())
         or (m.needs_ack and m.respond_by is not null and not m.respond_reminder_sent
             and m.respond_by - interval '1 hour' <= now())
    )
  $$
);
