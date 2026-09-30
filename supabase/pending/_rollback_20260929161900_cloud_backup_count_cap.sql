-- Rollback of 20260929161900_cloud_backup_count_cap: puts the INSERT and UPDATE policies of
-- 20260929161756 back (plan check and name check, no count caps).

drop policy if exists "Users can insert own vault" on storage.objects;
create policy "Users can insert own vault" on storage.objects for insert to authenticated
  with check (bucket_id = 'vaults' and (storage.foldername(name))[1] = (select auth.uid())::text
              and public.cloud_backup_allowed() and public.cloud_backup_name_ok(name));
drop policy if exists "Users can update own vault" on storage.objects;
create policy "Users can update own vault" on storage.objects for update to authenticated
  using (bucket_id = 'vaults' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'vaults' and (storage.foldername(name))[1] = (select auth.uid())::text
              and public.cloud_backup_allowed() and public.cloud_backup_name_ok(name));
drop function if exists public.cloud_backup_slot_free(text);
