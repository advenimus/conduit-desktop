-- ti_select and ti_update read the invitee's email from auth.users, which the authenticated role
-- cannot read, so every invitation query by a signed-in user failed with
-- "permission denied for table users" (42501). Take the email from the verified JWT instead.
-- Access is unchanged: team admins, or the user the invitation was sent to.

drop policy if exists ti_select on public.team_invitations;
create policy ti_select on public.team_invitations for select to authenticated
  using (
    public.is_team_admin(team_id, (select auth.uid()))
    or lower(email) = lower((select auth.jwt() ->> 'email'))
  );

drop policy if exists ti_update on public.team_invitations;
create policy ti_update on public.team_invitations for update to authenticated
  using (
    public.is_team_admin(team_id, (select auth.uid()))
    or lower(email) = lower((select auth.jwt() ->> 'email'))
  );
