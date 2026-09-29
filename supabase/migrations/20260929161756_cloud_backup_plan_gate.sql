-- Cloud backup uploads need a plan with cloud backup (Pro, Team, or a team member) and one of the
-- object names the apps write. Reads and deletes keep the folder-only rule, so a downgraded user can
-- still restore and remove old backups. The four storage.objects policies of bucket "vaults" were not
-- in any migration before; this one creates all four. See docs/PLAN_ENFORCEMENT.md section 2.9.

update public.tiers set features = features || jsonb_build_object('max_cloud_backup_vaults',
         case name when 'free' then 0 when 'pro' then 10 else -1 end), updated_at = now()
 where name in ('free', 'pro', 'team');

-- No uid argument: a caller can only ask about itself (PostgREST exposes every function it may execute).
create or replace function public.cloud_backup_allowed() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select coalesce(p.is_team_member, false)
                       or (jsonb_typeof(t.features -> 'cloud_sync_enabled') = 'boolean'
                           and (t.features ->> 'cloud_sync_enabled')::boolean)
                     from public.user_profiles p left join public.tiers t on t.id = p.tier_id
                    where p.id = (select auth.uid())), false)
$$;
revoke execute on function public.cloud_backup_allowed() from public, anon;
grant execute on function public.cloud_backup_allowed() to authenticated;   -- the policies run as the caller

-- {uid}/manifest.json, {uid}/vault.enc, {uid}/backups/vault_<stamp>.enc and the same two files under
-- {uid}/{vaultId}/, in the caller's own folder. Anything else is refused.
create or replace function public.cloud_backup_name_ok(p_name text) returns boolean
language sql stable set search_path = public, pg_temp as $$
  select coalesce(p_name ~ ('^' || (select auth.uid())::text
    || '/((([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/)?(vault\.enc|backups/vault_[0-9A-Za-z._-]{1,80}\.enc)|manifest\.json)$'), false)
$$;
revoke execute on function public.cloud_backup_name_ok(text) from public, anon;
grant execute on function public.cloud_backup_name_ok(text) to authenticated;

drop policy if exists "Users can select own vault" on storage.objects;
create policy "Users can select own vault" on storage.objects for select to authenticated
  using (bucket_id = 'vaults' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "Users can delete own vault" on storage.objects;
create policy "Users can delete own vault" on storage.objects for delete to authenticated
  using (bucket_id = 'vaults' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "Users can insert own vault" on storage.objects;
create policy "Users can insert own vault" on storage.objects for insert to authenticated
  with check (bucket_id = 'vaults' and (storage.foldername(name))[1] = (select auth.uid())::text
              and public.cloud_backup_allowed() and public.cloud_backup_name_ok(name));
drop policy if exists "Users can update own vault" on storage.objects;
create policy "Users can update own vault" on storage.objects for update to authenticated
  using (bucket_id = 'vaults' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'vaults' and (storage.foldername(name))[1] = (select auth.uid())::text
              and public.cloud_backup_allowed() and public.cloud_backup_name_ok(name));
