-- Kalender-Abo: persönlicher, geheimer Link pro Person (webcal://…/ics?feed=<token>)
create table public.calendar_feeds (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  token text not null unique,
  created_at timestamptz not null default now()
);
alter table public.calendar_feeds enable row level security;
revoke all on public.calendar_feeds from anon, authenticated;

-- Liefert den eigenen Abo-Schlüssel (legt ihn beim ersten Mal an); p_reset erzeugt einen neuen
create function public.calendar_feed_token(p_reset boolean default false)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_token text;
begin
  if not public.is_member() then raise exception 'Kein Mitglied'; end if;
  if p_reset then delete from public.calendar_feeds where user_id = auth.uid(); end if;
  select token into v_token from public.calendar_feeds where user_id = auth.uid();
  if v_token is null then
    v_token := encode(gen_random_bytes(24), 'hex');
    insert into public.calendar_feeds (user_id, token) values (auth.uid(), v_token);
  end if;
  return v_token;
end;
$$;
revoke all on function public.calendar_feed_token(boolean) from public, anon;
grant execute on function public.calendar_feed_token(boolean) to authenticated;
