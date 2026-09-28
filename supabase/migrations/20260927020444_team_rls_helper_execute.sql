-- RLS policies on teams, team_members, team_vaults, team_vault_members, team_invitations,
-- vault_key_wraps, vault_audit_log and user_public_keys call these SECURITY DEFINER helpers as the
-- querying user, so that user needs EXECUTE. 20260527000001 revoked it from PUBLIC and granted it
-- back to no one, and every team read by a signed-in user fails with
-- "permission denied for function is_team_member" (42501). Grant to authenticated only; anon
-- keeps no access, and the trigger/cron functions stay revoked.

grant execute on function public.is_team_member(uuid, uuid) to authenticated;
grant execute on function public.is_team_admin(uuid, uuid) to authenticated;
grant execute on function public.is_team_vault_member(uuid, uuid) to authenticated;
grant execute on function public.is_team_vault_admin(uuid, uuid) to authenticated;
grant execute on function public.team_vault_has_members(uuid) to authenticated;
grant execute on function public.shares_team_as_admin(uuid, uuid) to authenticated;
