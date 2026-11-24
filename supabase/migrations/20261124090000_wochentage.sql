alter table public.events add constraint valid_recurrence_weekdays check (
  not (recurrence ? 'weekdays') or (
    recurrence @> '{"u":"week","n":1}' and jsonb_typeof(recurrence->'weekdays') = 'array'
    and recurrence->'weekdays' <> '[]'::jsonb and recurrence->'weekdays' <@ '[1,2,3,4,5,6,7]'::jsonb
  )
);

create or replace function public.event_occurrences(e public.events, p_from timestamptz, p_to timestamptz)
returns setof timestamptz
language plpgsql
stable
as $$
declare
  u text := e.recurrence ->> 'u';
  n int := greatest(1, coalesce((e.recurrence ->> 'n')::int, 1));
  until_d date := nullif(e.recurrence ->> 'until', '')::date;
  base timestamp := e.start_at at time zone 'Europe/Berlin';
  dur interval := e.end_at - e.start_at;
  occ timestamptz;
  i int := 0;
begin
  if e.recurrence is null or u is null then
    if e.start_at <= p_to and e.end_at >= p_from then return next e.start_at; end if;
    return;
  end if;
  if e.recurrence ? 'weekdays' then
    return query
      select t from generate_series(
        greatest(base::date, ((p_from - dur) at time zone 'Europe/Berlin')::date)::timestamp,
        least((p_to at time zone 'Europe/Berlin')::date, until_d)::timestamp, interval '1 day'
      ) d
      cross join lateral (select (d::date + base::time) at time zone 'Europe/Berlin' as t) occurrence
      where e.recurrence->'weekdays' @> to_jsonb(extract(isodow from d)::int)
        and t >= e.start_at and t <= p_to and t + dur >= p_from and not (t = any(e.exdates))
      order by t;
    return;
  end if;
  loop
    occ := (base + case u when 'day' then make_interval(days => i * n)
                         when 'week' then make_interval(days => 7 * i * n)
                         else make_interval(months => i * n) end) at time zone 'Europe/Berlin';
    exit when occ > p_to or i > 3000;
    exit when until_d is not null and (occ at time zone 'Europe/Berlin')::date > until_d;
    if occ + dur >= p_from and not (occ = any (e.exdates)) then return next occ; end if;
    i := i + 1;
  end loop;
end;
$$;
