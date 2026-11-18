-- Striche im Trainerpass vs. auf der Tafel
--  * Trainerpass (profiles.strikes): alle vergebenen Striche – ab der Vergabe, auch nach dem Bezahlen.
--    Nur zurückgezogene Striche zählen nicht.
--  * Tafel: dieselben Striche minus 10 je bezahlter Strafe (berechnet in der App).
--  * Bezahlung: erst möglich, wenn 10 Striche auf der Tafel rechtskräftig sind; jede Bestätigung mit Zeitstempel.

create or replace function public.recalc_strikes(p_user uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.profiles set strikes =
    coalesce((select sum(value) from public.strikes where user_id = p_user and status <> 'withdrawn'), 0)
  where id = p_user;
$$;
revoke all on function public.recalc_strikes(uuid) from public, anon, authenticated;

select public.recalc_strikes(id) from public.profiles;

alter table public.fines add column confirmations jsonb not null default '[]';

create or replace function public.confirm_fine(p_user uuid)
returns public.fines
language plpgsql
security definer
set search_path = public
as $$
declare
  f public.fines;
  v_active numeric;
begin
  if not public.is_member() then raise exception 'Kein Mitglied'; end if;
  if not exists (select 1 from public.profiles where id = p_user) then raise exception 'Unbekannter Trainer'; end if;
  perform 1 from public.profiles where id = p_user for update;
  select coalesce((select sum(value) from public.strikes where user_id = p_user and status = 'active'), 0)
       - 10 * (select count(*) from public.fines where user_id = p_user and settled_at is not null)
    into v_active;
  if v_active < 10 then raise exception 'Erst wenn 10 Striche rechtskräftig sind, kann bezahlt werden'; end if;
  insert into public.fines (user_id) values (p_user) on conflict (user_id) where settled_at is null do nothing;
  update public.fines
     set confirmations = case when auth.uid() = any (confirmed_by) then confirmations
                              else confirmations || jsonb_build_object('by', auth.uid(), 'at', now()) end,
         confirmed_by = array(select distinct unnest(confirmed_by || auth.uid()))
   where user_id = p_user and settled_at is null
   returning * into f;
  if public.all_members_in(f.confirmed_by) then
    update public.fines set settled_at = now() where id = f.id returning * into f;
  end if;
  return f;
end;
$$;
revoke all on function public.confirm_fine(uuid) from public, anon;
grant execute on function public.confirm_fine(uuid) to authenticated;
