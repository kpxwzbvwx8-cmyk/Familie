-- has_photos wird beim Speichern der Kartenbilder vor der Constraint-Prüfung gesetzt.
alter table public.messages
  drop constraint handbook_info,
  add constraint handbook_info check (not in_handbook or
    (urgency = 'info' and btrim(title) <> '' and delete_at is null
     and (description ~ '[^[:space:]]' or has_photos)));
