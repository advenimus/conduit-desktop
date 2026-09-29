-- Rollback of 20260929161756_cloud_backup_plan_gate: the folder-only storage policies read from
-- production on 2026-09-29. Run the 20260929161900 rollback first if that migration was applied.

drop policy if exists "Users can insert own vault" on storage.objects;
drop policy if exists "Users can update own vault" on storage.objects;
create policy "Users can insert own vault" on storage.objects for insert to authenticated
  with check ((bucket_id = 'vaults') and ((storage.foldername(name))[1] = (auth.uid())::text));
create policy "Users can update own vault" on storage.objects for update to authenticated
  using ((bucket_id = 'vaults') and ((storage.foldername(name))[1] = (auth.uid())::text));
-- SELECT and DELETE policies stay (20260929161756 created them with the same definitions).
drop function if exists public.cloud_backup_name_ok(text);
drop function if exists public.cloud_backup_allowed();
update public.tiers set features = features - 'max_cloud_backup_vaults', updated_at = now()
 where name in ('free', 'pro', 'team');
