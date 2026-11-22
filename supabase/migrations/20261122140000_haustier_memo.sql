-- NULL übernimmt den bisherigen Eintrag eines importierten Tierpasses.
-- Eine leere Zeichenfolge entfernt eine Angabe auch bei importierten Pässen.
alter table public.pets
  add column nature varchar(40),
  add column region varchar(40),
  add column loves varchar(60),
  add column flavor text check (flavor in ('','scharf','trocken','süß','bitter','sauer')),
  add column status_text varchar(120);
grant insert(nature,region,loves,flavor,status_text), update(nature,region,loves,flavor,status_text)
  on public.pets to authenticated;
