-- Cloud backup caps: at most max_cloud_backups snapshots per vault folder and at most
-- max_cloud_backup_vaults vault folders per account. Waits in supabase/pending/ until desktop 0.18
-- ships (0.17 cannot prune by count); rollout step 8 moves it into supabase/migrations/.
-- See docs/PLAN_ENFORCEMENT.md sections 2.9 and 8.

create or replace function public.cloud_backup_slot_free(p_name text) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_cap int; v_vcap int; v_team boolean; v_vault text; v_dir text; v_count int;
begin
  if v_uid is null then return false; end if;
  select case when jsonb_typeof(t.features -> 'max_cloud_backups') = 'number'
              then (t.features ->> 'max_cloud_backups')::int end,
         case when jsonb_typeof(t.features -> 'max_cloud_backup_vaults') = 'number'
              then (t.features ->> 'max_cloud_backup_vaults')::int end,
         coalesce(p.is_team_member, false)
    into v_cap, v_vcap, v_team
    from public.user_profiles p left join public.tiers t on t.id = p.tier_id where p.id = v_uid;
  -- A team member has no caps (the Team tier has none), whatever its tier row says, as in cloud_backup_allowed.
  if v_team then return true; end if;

  -- Per account: at most v_vcap vault folders. A new folder is refused when the account is at the cap.
  v_vault := substring(p_name from '^[^/]+/([0-9a-f-]{36})/');
  if v_vault is not null and v_vcap is not null and v_vcap <> -1
     and not exists (select 1 from storage.objects o where o.bucket_id = 'vaults'
                      and left(o.name, 38 + length(v_uid::text)) = v_uid::text || '/' || v_vault || '/')
     and (select count(distinct split_part(o.name, '/', 2)) from storage.objects o
           where o.bucket_id = 'vaults' and o.name ~ ('^' || v_uid::text || '/[0-9a-f-]{36}/')) >= v_vcap then
    return false;
  end if;

  -- Per vault folder: at most v_cap snapshots, not counting the object itself (an overwrite of an existing
  -- snapshot is free; a move into backups/ counts).
  v_dir := substring(p_name from '^(.*/backups/)[^/]+$');
  if v_dir is null or v_cap is null or v_cap = -1 then return true; end if;
  select count(*) into v_count from storage.objects o
   where o.bucket_id = 'vaults' and left(o.name, length(v_dir)) = v_dir
     and position('/' in substring(o.name from length(v_dir) + 1)) = 0 and o.name <> p_name;
  return v_count < v_cap;
end $$;
revoke execute on function public.cloud_backup_slot_free(text) from public, anon;
grant execute on function public.cloud_backup_slot_free(text) to authenticated;

drop policy if exists "Users can insert own vault" on storage.objects;
create policy "Users can insert own vault" on storage.objects for insert to authenticated
  with check (bucket_id = 'vaults' and (storage.foldername(name))[1] = (select auth.uid())::text
              and public.cloud_backup_allowed() and public.cloud_backup_name_ok(name)
              and public.cloud_backup_slot_free(name));
drop policy if exists "Users can update own vault" on storage.objects;
create policy "Users can update own vault" on storage.objects for update to authenticated
  using (bucket_id = 'vaults' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'vaults' and (storage.foldername(name))[1] = (select auth.uid())::text
              and public.cloud_backup_allowed() and public.cloud_backup_name_ok(name)
              and public.cloud_backup_slot_free(name));
