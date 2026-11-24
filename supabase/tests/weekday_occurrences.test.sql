begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(3);
set local timezone = 'Europe/Berlin';

create temporary table series as select (jsonb_populate_record(null::public.events, '{
  "start_at":"2027-03-25T07:30:00+01", "end_at":"2027-03-25T07:30:00+01",
  "recurrence":{"u":"week","n":1,"weekdays":[1,5],"until":"2027-04-05"},
  "exdates":["2027-04-02T07:30:00+02"]
}')).*;
select is(array(select to_char(o,'YYYY-MM-DD HH24:MI') from series e,
  public.event_occurrences(row(e.*)::public.events,'2027-03-24','2027-04-12') o),
  array['2027-03-26 07:30','2027-03-29 07:30','2027-04-05 07:30'],
  'Auswahltage, Zeitumstellung, Ausnahme und einschließlich Enddatum');
update series set recurrence = '{"u":"week","n":2}';
select is(array(select to_char(o,'YYYY-MM-DD') from series e,
  public.event_occurrences(row(e.*)::public.events,'2027-03-24','2027-04-12') o),
  array['2027-03-25','2027-04-08'], 'Bisheriges zweiwöchiges Intervall');
update series set end_at = start_at + interval '12 hours', recurrence = '{"u":"week","n":1,"weekdays":[5]}';
select is((select count(*) from series e, public.event_occurrences(row(e.*)::public.events,
  '2027-03-26 12:00','2027-03-26 12:15') o),1::bigint,'Überlappender Termin im Tagesfenster');
select * from finish();
rollback;
