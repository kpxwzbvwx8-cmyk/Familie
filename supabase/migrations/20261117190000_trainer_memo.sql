-- Trainer-Memo: Wesen, Liebt …, Mag … Essen, Herkunftsregion, freier Status
alter table public.profiles
  add column nature text check (nature in (
    'Robust','Solo','Mutig','Hart','Frech','Kühn','Sanft','Locker','Pfiffig','Lasch',
    'Scheu','Hastig','Ernst','Froh','Naiv','Mäßig','Mild','Ruhig','Zaghaft','Hitzig',
    'Still','Zart','Forsch','Sacht','Kauzig')),
  add column loves text check (char_length(loves) <= 60),
  add column flavor text check (flavor in ('scharf','trocken','süß','bitter','sauer')),
  add column region text check (region in (
    'Kanto','Johto','Hoenn','Sinnoh','Einall','Kalos','Alola','Galar','Hisui','Paldea')),
  add column status_text text check (char_length(status_text) <= 80);

grant update (nature, loves, flavor, region, status_text) on public.profiles to authenticated;
