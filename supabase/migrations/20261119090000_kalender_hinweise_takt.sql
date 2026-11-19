-- Fehlerbehebung: Der Minuten-Takt hat die Edge Function „tick“ nur angestoßen, wenn bei einer
-- Meldung etwas fällig war. Fällige Kalender-Hinweise (event_reminders) lösen jetzt ebenfalls aus.
-- (gleicher Job-Name = bestehender Job wird ersetzt)
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
    and (
      exists (
        select 1 from public.messages m
        where (m.remind_at_start and not m.reminder_sent and m.event_at <= now())
           or (m.needs_ack and m.respond_by is not null and not m.respond_reminder_sent
               and m.respond_by - interval '1 hour' <= now())
      )
      or exists (
        select 1 from public.event_reminders r
        where r.sent_at is null and r.remind_at <= now()
      )
    )
  $$
);
