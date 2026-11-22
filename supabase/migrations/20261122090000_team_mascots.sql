-- Die Familiennummer ist kein Identitätsmerkmal für die persönlichen Maskottchen.
-- Die Zuordnung bleibt im privaten Projekt. Auch bei einer späteren Gründung
-- gilt derselbe Codevergleich wie bei join_family.
insert into public.app_secrets(key, value)
select 'team_mascots', team_extras from public.family
where id = 1 and team_extras->'pokemon' @> '[{"id":"pokemon-speedy"},{"id":"pokemon-idefix"}]';

create or replace function public.get_family_team() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select mascot.value from public.family f
    join public.app_secrets target on target.key = 'team_mascot_code'
      and f.code = upper(btrim(target.value #>> '{}'))
    join public.app_secrets mascot on mascot.key = 'team_mascots'
    where f.id = public.current_family_id()
  ), '{}'::jsonb)
$$;

alter table public.family drop column team_extras;
