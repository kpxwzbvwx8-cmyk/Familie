-- Eine eingebettete Notiz gehört zur Aufgabe. Zuständige teilen sich den Fortschritt.
alter table public.messages
  add column attached_note jsonb check (jsonb_typeof(attached_note) = 'object'),
  add column note_checks boolean[] not null default '{}'
    check (array_position(note_checks, null) is null);
grant insert (attached_note, note_checks) on public.messages to authenticated;

create function public.set_task_note_check(p_message uuid, p_index integer, p_checked boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.messages
     set note_checks[p_index + 1] = p_checked
   where id = p_message and public.is_member() and attached_note is not null
     and done_by is null and closed_at is null and p_checked is not null
     and p_index between 0 and cardinality(note_checks) - 1
     and (case when cardinality(assignees) > 0 then auth.uid() = any(assignees)
               else auth.uid() <> author_id end);
  if not found then raise exception 'Dieser Listenpunkt kann nicht geändert werden.'; end if;
end;
$$;
revoke all on function public.set_task_note_check(uuid, integer, boolean) from public, anon;
grant execute on function public.set_task_note_check(uuid, integer, boolean) to authenticated;
