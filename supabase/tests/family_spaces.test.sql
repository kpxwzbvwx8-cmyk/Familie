begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

insert into auth.users(id) values
  ('11111111-aaaa-4000-8000-000000000001'),
  ('11111111-aaaa-4000-8000-000000000002'),
  ('11111111-aaaa-4000-8000-000000000003');
set local role authenticated;
set local request.jwt.claim.sub = '11111111-aaaa-4000-8000-000000000001';
select is((public.join_family('  tAP-team-a  ','A','Eins','w','#123456','2000-01-01','pikachu-ds')).avatar,
  'pikachu-ds', 'Neues Team per Trainerpass anlegen');
select is(public.get_family_code(), 'TAP-TEAM-A', 'Familiencode wird normalisiert');
insert into public.messages(title, description, urgency, in_handbook, photos_input)
values ('Anleitung A','Schritte','info',true,array['data:image/jpeg;base64,/9j/']);
select set_config('test.guide', id::text, true) from public.messages where in_handbook;
insert into public.messages(title, attached_note, note_checks, deadline_at, threat_strike)
values ('Aufgabe A','{}','{false}',now() - interval '1 minute',true);
select set_config('test.task', id::text, true) from public.messages where title = 'Aufgabe A';
insert into public.message_comments(message_id,body) values (current_setting('test.task')::uuid,'Kommentar A');
insert into public.notes(title) values ('Privat A');

select public.save_event(null, 'Termin A', '', '', true, now(), now() + interval '1 hour', '[]', '{}');
set local request.jwt.claim.sub = '11111111-aaaa-4000-8000-000000000002';
select is((public.join_family('TAP-TEAM-B','B','Eins','m','#123456','2000-01-01')).first_name,
  'B', 'Zweiter Code legt ein zweites Team an');
select is(public.get_family_code(), 'TAP-TEAM-B', 'Einladen zeigt den eigenen Code');
select is((select count(*) from public.profiles), 1::bigint, 'Neues Team sieht nur sich selbst');
select is((select count(*) from public.messages), 0::bigint, 'Aufgaben und Anleitungen getrennt');
select is((select count(*) from public.events), 0::bigint, 'Kalender sind getrennt');
select public.save_event(null, 'Termin B', '', '', true, now(), now() + interval '1 hour', '[]',
  '{11111111-aaaa-4000-8000-000000000001}');
select is((select count(*) from public.event_invites), 0::bigint, 'Einladungen erreichen keine fremden Konten');
select throws_ok($$insert into public.message_comments(message_id, body) values
  (current_setting('test.task')::uuid, 'Fremder Kommentar')$$, '42501', null, 'Kommentare erfordern eine sichtbare Karte');
select is((select count(*) from public.card_photos), 0::bigint, 'Kartenbilder getrennt');
select is((select count(*) from public.message_comments), 0::bigint, 'Kommentare getrennt');
select throws_ok($$select public.edit_message_card(current_setting('test.guide')::uuid,0,'{"title":"Fremd"}')$$,
  'P0001','Du kannst diese Karte nicht bearbeiten.', 'Fremde Anleitung auch per ID geschützt');
select throws_ok($$select public.set_task_note_check(current_setting('test.task')::uuid,0,true)$$,
  'P0001','Dieser Listenpunkt kann nicht geändert werden.', 'Fremde Checkliste geschützt');
select throws_ok($$insert into public.messages(title,additional_info_ids) values
  ('Fremder Verweis',array[current_setting('test.guide')::uuid])$$,
  'P0001','Eine verlinkte Info-Karte ist nicht mehr verfügbar.', 'Fremde Anleitung lässt sich nicht einbetten');
select throws_ok($$insert into public.messages(title,assignees) values
  ('Fremde Zuweisung','{11111111-aaaa-4000-8000-000000000001}')$$,
  'P0001','Aufgaben können nur an das eigene Team vergeben werden.', 'Zuweisung ist auf das Team beschränkt');
insert into public.notes(title, shared_with) values ('Notiz B','{11111111-aaaa-4000-8000-000000000001}');
select is((select cardinality(shared_with) from public.notes), 0, 'Notizfreigaben bleiben in der Familie');
select ok((public.propose_rule('Regel B','',1)).approved_at is not null, 'Abstimmungen zählen nur das eigene Team');

set local request.jwt.claim.sub = '11111111-aaaa-4000-8000-000000000003';
select is((public.join_family('tap-team-a','A','Zwei','m','#123456','2000-01-01')).first_name,
  'A', 'Bestehender Code führt zum selben Team');
select is((select count(*) from public.profiles), 2::bigint, 'Beide Mitglieder im ursprünglichen Team');
select is((select count(*) from public.messages), 2::bigint, 'Beigetretene Mitglieder sehen die Karten');
select is((select count(*) from public.card_photos), 1::bigint, 'Beigetretene Mitglieder sehen das Bild');
select is((select array_agg(title) from public.events), array['Termin A'], 'Beitritt öffnet den richtigen Kalender');
select is((select count(*) from public.notes), 0::bigint, 'Private Notizen bleiben privat');
select is((public.edit_message_card(current_setting('test.guide')::uuid,0,'{"title":"Aktualisiert","description":"Schritte"}')).title,
  'Aktualisiert','Eigene Familie kann gemeinsame Anleitung bearbeiten');
select is((select count(*) from public.strike_rules), 0::bigint, 'Regelkataloge getrennt');
reset role;
select public.process_deadlines();
select is((select array_agg(user_id) from public.strikes where message_id = current_setting('test.task')::uuid),
  '{11111111-aaaa-4000-8000-000000000003}'::uuid[], 'Fristablauf betrifft ausschließlich das zuständige Team');
select * from finish();
rollback;
