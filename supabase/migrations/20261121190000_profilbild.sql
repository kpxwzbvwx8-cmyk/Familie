alter table public.profiles
  add column avatar text not null default 'trainer'
  check (avatar in ('trainer', 'pikachu-anime', 'pikachu-ds'));

grant update (avatar) on public.profiles to authenticated;

-- Der bisherige Aufruf bleibt für bereits installierte App-Versionen verfügbar.
create function public.join_family(
  p_code text, p_first_name text, p_last_name text, p_gender text,
  p_color text, p_birthday date, p_avatar text
) returns public.profiles
language plpgsql security invoker set search_path = '' as $$
declare
  member public.profiles;
begin
  member := public.join_family(p_code, p_first_name, p_last_name, p_gender, p_color, p_birthday);
  if p_avatar is distinct from member.avatar then
    update public.profiles set avatar = p_avatar where id = member.id returning * into strict member;
  end if;
  return member;
end;
$$;

revoke all on function public.join_family(text,text,text,text,text,date,text) from public, anon;
grant execute on function public.join_family(text,text,text,text,text,date,text) to authenticated;
