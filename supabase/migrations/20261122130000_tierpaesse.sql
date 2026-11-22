alter table public.pets add column legacy_profile jsonb;
create unique index pets_original_pass on public.pets(family_id,(legacy_profile->>'id'));
grant update(name,birthday,photo) on public.pets to authenticated;
create policy edit_team_pet on public.pets for update to authenticated
  using (family_id = (select public.current_family_id()))
  with check (family_id = (select public.current_family_id()));

create function public.import_team_pets() returns void
language sql security definer set search_path = '' as $$
  insert into public.pets(family_id,name,birthday,legacy_profile)
  select f.id, p->>'firstName', (p->>'birthday')::date, p
  from public.family f join public.app_secrets target
    on target.key = 'team_mascot_code' and f.code = upper(btrim(target.value #>> '{}'))
  join public.app_secrets mascot on mascot.key = 'team_mascots'
  cross join lateral jsonb_array_elements(mascot.value->'pokemon') p
  where p->>'id' in ('pokemon-speedy','pokemon-idefix')
  on conflict do nothing
$$;
revoke all on function public.import_team_pets() from public, anon, authenticated;
create function public.on_pet_team_configured() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.import_team_pets();
  return null;
end;
$$;
revoke all on function public.on_pet_team_configured() from public, anon, authenticated;
create trigger mascot_configuration after insert or update on public.app_secrets for each row
when (new.key in ('team_mascots','team_mascot_code')) execute function public.on_pet_team_configured();
create trigger mascot_family_created after insert on public.family for each row execute function public.on_pet_team_configured();
select public.import_team_pets();

create or replace function public.get_family_team() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce((select mascot.value - 'pokemon' from public.family f
    join public.app_secrets target on target.key = 'team_mascot_code' and f.code = upper(btrim(target.value #>> '{}'))
    join public.app_secrets mascot on mascot.key = 'team_mascots'
    where f.id = public.current_family_id()), '{}'::jsonb)
$$;
