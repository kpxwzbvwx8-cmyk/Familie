-- Status darf länger sein (Memo hat jetzt mehr Platz)
alter table public.profiles drop constraint if exists profiles_status_text_check;
alter table public.profiles add constraint profiles_status_text_check check (char_length(status_text) <= 120);
