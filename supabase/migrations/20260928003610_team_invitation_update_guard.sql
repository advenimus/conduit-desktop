-- ti_update lets the invitee update their own invitation with no column limits, and the website's
-- accept route adds the member with the invitation's role. An invitee could set role = 'admin'
-- (or reopen a declined invitation, or move it to another team) and then accept it.
-- The invitee may now only answer a pending invitation; team admins keep full edits within their
-- team. Server code using the service role is unaffected.

drop policy if exists ti_update on public.team_invitations;
create policy ti_update on public.team_invitations for update to authenticated
  using (
    public.is_team_admin(team_id, (select auth.uid()))
    or lower(email) = lower((select auth.jwt() ->> 'email'))
  )
  with check (
    public.is_team_admin(team_id, (select auth.uid()))
    or lower(email) = lower((select auth.jwt() ->> 'email'))
  );

create or replace function public.guard_team_invitation_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'authenticated' then
    return new;
  end if;

  if new.team_id is distinct from old.team_id or new.id is distinct from old.id then
    raise exception 'an invitation cannot move to another team' using errcode = '42501';
  end if;

  if public.is_team_admin(old.team_id, (select auth.uid())) then
    return new;
  end if;

  if new.email is distinct from old.email
    or new.invited_by is distinct from old.invited_by
    or new.role is distinct from old.role
    or new.token is distinct from old.token
    or new.expires_at is distinct from old.expires_at
    or new.created_at is distinct from old.created_at then
    raise exception 'only the invitation status can be changed' using errcode = '42501';
  end if;

  if old.status <> 'pending' or new.status not in ('accepted', 'declined') then
    raise exception 'only a pending invitation can be accepted or declined' using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke execute on function public.guard_team_invitation_update() from public, anon, authenticated;

drop trigger if exists guard_team_invitation_update on public.team_invitations;
create trigger guard_team_invitation_update
  before update on public.team_invitations
  for each row execute function public.guard_team_invitation_update();
