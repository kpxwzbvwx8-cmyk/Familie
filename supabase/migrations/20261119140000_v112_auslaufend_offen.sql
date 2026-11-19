-- v1.1.2: Meldungen „sofort & offen“ (ohne Termin, bleiben bis erledigt)
--         + Warnung 12 Stunden bevor eine Deadline / Rückmelde-Frist ausläuft

alter table public.messages add column open_ended boolean not null default false;
alter table public.messages add column deadline_warned boolean not null default false;
alter table public.messages add column respond_warned boolean not null default false;
grant insert (open_ended) on public.messages to authenticated;

-- Minuten-Takt: tick auch anstoßen, wenn eine Frist in die letzten 12 Stunden kommt
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
           or (m.deadline_at is not null and not m.deadline_warned and m.closed_at is null
               and m.deadline_at - interval '12 hours' <= now())
           or (m.needs_ack and m.respond_by is not null and not m.respond_warned
               and m.respond_by - interval '12 hours' <= now())
      )
      or exists (
        select 1 from public.event_reminders r
        where r.sent_at is null and r.remind_at <= now()
      )
    )
  $$
);
