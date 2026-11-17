-- Region wird zum frei eingebbaren Geburtsort
alter table public.profiles drop constraint if exists profiles_region_check;
alter table public.profiles add constraint profiles_region_check check (char_length(region) <= 40);
