alter table public.messages
  add column in_handbook boolean not null default false,
  add column linked_info_id uuid references public.messages(id) on delete set null,
  add constraint handbook_info check (not in_handbook or
    (urgency = 'info' and btrim(title) <> '' and btrim(description) <> '' and delete_at is null)),
  add constraint task_info_link check (linked_info_id is null or urgency <> 'info');

grant insert (in_handbook, linked_info_id) on public.messages to authenticated;
create index messages_linked_info_idx on public.messages(linked_info_id) where linked_info_id is not null;

create function public.validate_task_info_link() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.messages where id = new.linked_info_id and urgency = 'info') then
    raise exception 'Die gewählte Info-Karte ist nicht mehr verfügbar.';
  end if;
  return new;
end;
$$;
create trigger validate_task_info_link before insert or update of linked_info_id on public.messages
  for each row when (new.linked_info_id is not null) execute function public.validate_task_info_link();
