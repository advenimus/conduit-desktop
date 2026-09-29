-- Stopgap: the SECURITY DEFINER body has no caller check, so any signed-in user could write
-- any team vault's entries. 20260929150000_team_membership_hardening restores the grant
-- with a guarded body. No team vaults exist in prod when this runs.
revoke execute on function public.upsert_vault_entry_versioned(uuid,uuid,text,text,uuid,integer,text,integer,text,text,text,text,text,text,text,text,text,boolean,integer,uuid,text,text,uuid) from public, anon, authenticated;
