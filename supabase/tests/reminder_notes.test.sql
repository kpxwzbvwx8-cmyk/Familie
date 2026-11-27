begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();
set local timezone = 'Europe/Berlin';
insert into auth.users(id) values ('12900000-0000-4000-8000-000000000001'),('12900000-0000-4000-8000-000000000002');
set local role authenticated;
set local request.jwt.claim.sub = '12900000-0000-4000-8000-000000000001';
select public.set_privacy_consent(public.privacy_notice_version(),true);
select public.join_family('TEST-NOTES129','Test','Eins','m','#123456','2000-01-01');
insert into public.notes(title,content,photos_input)
values ('Einkauf','<ul data-checklist="true"><li data-checked="true">Milch</li><li>Brot</li></ul>',array['data:image/jpeg;base64,/9j/']);
select set_config('test.note',id::text,true) from public.notes where title='Einkauf';
select set_config('test.start',((now() at time zone 'Europe/Berlin')::date+1)::timestamptz::text,true);
select set_config('test.event',(public.save_event_with_notes(
  null,'Einkaufsrunde','','Eigene Beschreibung',true,
  current_setting('test.start')::timestamptz,current_setting('test.start')::timestamptz+interval '23 hours 59 minutes',
  jsonb_build_array(jsonb_build_object('k','custom','at',current_setting('test.start')::timestamptz+interval '9 hours')),
  '{}','todo',array[auth.uid()],
  jsonb_build_object('u','week','n',1,'weekdays',jsonb_build_array(
    extract(isodow from current_setting('test.start')::timestamptz)::int,
    extract(isodow from current_setting('test.start')::timestamptz+interval '3 days')::int)),
  '{}',jsonb_build_array(jsonb_build_object('note_id',id,'updated_at',updated_at,'check_count',2)),0
)).id::text,true) from public.notes where id=current_setting('test.note')::uuid;
select is((select reminders from public.events where id=current_setting('test.event')::uuid),
  '[{"k":"day","d":0,"h":"09:00"}]'::jsonb,'Festes Datum wird für Serien auf jeden Wiederholungstag bezogen');
select ok((select needs_done from public.events where id=current_setting('test.event')::uuid),'Erinnerung mit Checkliste bietet Erledigt an');
select is((select description from public.events where id=current_setting('test.event')::uuid),'Eigene Beschreibung','Beschreibung zusätzlich zur Notiz');
select is((select count(*) from public.card_photos where event_id=current_setting('test.event')::uuid and slot=1),1::bigint,'Notizbilder werden kopiert');
select set_config('test.attached',(select attached_notes->0->>'id' from public.events where id=current_setting('test.event')::uuid),true);
select throws_ok(format('select public.set_event_done(%L,%L,true)',current_setting('test.event'),current_setting('test.start')),
  'P0001','Bitte zuerst alle Listenpunkte abhaken.','Erledigt erst nach vollständiger Checkliste');
select public.check_event_note_item(current_setting('test.event')::uuid,current_setting('test.start')::timestamptz,current_setting('test.attached')::uuid,0,true);
select public.check_event_note_item(current_setting('test.event')::uuid,current_setting('test.start')::timestamptz,current_setting('test.attached')::uuid,1,true);
select public.set_event_done(current_setting('test.event')::uuid,current_setting('test.start')::timestamptz,true);
select is((select count(*) from public.event_done where event_id=current_setting('test.event')::uuid),1::bigint,'Vollständige Liste kann erledigt werden');
select is((select count(*) from public.event_note_checks where event_id=current_setting('test.event')::uuid
  and occ=current_setting('test.start')::timestamptz+interval '3 days'),0::bigint,'Nächste Wiederholung hat neue offene Liste');
select throws_ok(format('select public.set_event_done(%L,%L,true)',current_setting('test.event'),
  current_setting('test.start')::timestamptz+interval '3 days'),'P0001','Bitte zuerst alle Listenpunkte abhaken.','Häkchen gelten ausschließlich für ihr Vorkommen');
select public.set_event_done(current_setting('test.event')::uuid,current_setting('test.start')::timestamptz,false);
select is((select content from public.notes where id=current_setting('test.note')::uuid),
  '<ul data-checklist="true"><li data-checked="true">Milch</li><li>Brot</li></ul>','Originalnotiz bleibt beim Abhaken erhalten');
reset role;
select ok((select count(*)>=8 and bool_and((remind_at at time zone 'Europe/Berlin')::time='09:00'
  and (remind_at at time zone 'Europe/Berlin')::date=(occ at time zone 'Europe/Berlin')::date)
  from public.event_reminders where event_id=current_setting('test.event')::uuid),'Hinweis um 09 Uhr für jedes der zwei wöchentlichen Vorkommen eingeplant');
select is(public.event_reminder_time('{"k":"day","d":0,"h":"09:00"}','2027-03-29 00:00+02'),
  '2027-03-29 09:00+02'::timestamptz,'Hinweis behält Ortszeit nach Sommerzeitwechsel');
set local role authenticated;
select set_config('test.detached',(public.save_event_with_notes(
  null,e.title,e.location,e.description,e.all_day,e.start_at,e.end_at,e.reminders,'{}',
  e.kind,e.assignees,null,'{}',jsonb_build_array(jsonb_build_object('keep',e.attached_notes->0->>'id')),
  e.notes_revision,e.id,e.start_at,true
)).id::text,true) from public.events e where e.id=current_setting('test.event')::uuid;
select is((select count(*) from public.event_note_checks where event_id=current_setting('test.detached')::uuid and checked),2::bigint,
  'Einzelnes Vorkommen bearbeiten übernimmt seine Häkchen');
select is((select count(*) from public.card_photos where event_id=current_setting('test.detached')::uuid and slot=1),1::bigint,
  'Einzelnes Vorkommen übernimmt die Notizbilder');
set local request.jwt.claim.sub = '12900000-0000-4000-8000-000000000002';
select public.set_privacy_consent(public.privacy_notice_version(),true);
select public.join_family('TEST-OTHER129','Test','Zwei','w','#123456','2000-01-01');
select is((select count(*) from public.event_note_checks),0::bigint,'Andere Familie sieht keine Häkchen');
select throws_ok(format('select public.check_event_note_item(%L,%L,%L,0,false)',current_setting('test.event'),current_setting('test.start'),current_setting('test.attached')),
  'P0001','Eintrag nicht gefunden','Andere Familie kann keine Häkchen verändern');
select * from finish();
rollback;
