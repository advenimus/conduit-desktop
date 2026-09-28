-- Local-stack parity with production for the /verify harness (read from prod on 2026-09-26).
-- Team sync RPC with the parent_entry_id signature the desktop calls.
CREATE OR REPLACE FUNCTION public.upsert_vault_entry_versioned(p_id uuid, p_vault_id uuid, p_name text, p_entry_type text, p_folder_id uuid DEFAULT NULL::uuid, p_sort_order integer DEFAULT 0, p_host text DEFAULT NULL::text, p_port integer DEFAULT NULL::integer, p_username text DEFAULT NULL::text, p_domain text DEFAULT NULL::text, p_icon text DEFAULT NULL::text, p_color text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_password_encrypted text DEFAULT NULL::text, p_private_key_encrypted text DEFAULT NULL::text, p_config_encrypted text DEFAULT NULL::text, p_tags_encrypted text DEFAULT NULL::text, p_is_favorite boolean DEFAULT false, p_expected_version integer DEFAULT 0, p_updated_by uuid DEFAULT NULL::uuid, p_credential_type text DEFAULT NULL::text, p_totp_secret_encrypted text DEFAULT NULL::text, p_parent_entry_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(success boolean, current_version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_current_version INTEGER;
BEGIN
  SELECT version INTO v_current_version
  FROM vault_entries
  WHERE id = p_id AND vault_id = p_vault_id;

  IF NOT FOUND THEN
    INSERT INTO vault_entries (
      id, vault_id, name, entry_type, folder_id, parent_entry_id, sort_order,
      host, port, username, domain, icon, color, notes,
      password_encrypted, private_key_encrypted,
      config_encrypted, tags_encrypted, is_favorite,
      version, updated_by, credential_type, totp_secret_encrypted,
      created_at, updated_at
    ) VALUES (
      p_id, p_vault_id, p_name, p_entry_type, p_folder_id, p_parent_entry_id, p_sort_order,
      p_host, p_port, p_username, p_domain, p_icon, p_color, p_notes,
      p_password_encrypted, p_private_key_encrypted,
      p_config_encrypted, p_tags_encrypted, p_is_favorite,
      1, p_updated_by, p_credential_type, p_totp_secret_encrypted,
      NOW(), NOW()
    );
    RETURN QUERY SELECT TRUE, 1;
  ELSE
    UPDATE vault_entries SET
      name = p_name,
      entry_type = p_entry_type,
      folder_id = p_folder_id,
      parent_entry_id = p_parent_entry_id,
      sort_order = p_sort_order,
      host = p_host,
      port = p_port,
      username = p_username,
      domain = p_domain,
      icon = p_icon,
      color = p_color,
      notes = p_notes,
      password_encrypted = p_password_encrypted,
      private_key_encrypted = p_private_key_encrypted,
      config_encrypted = p_config_encrypted,
      tags_encrypted = p_tags_encrypted,
      is_favorite = p_is_favorite,
      version = v_current_version + 1,
      updated_by = p_updated_by,
      credential_type = p_credential_type,
      totp_secret_encrypted = p_totp_secret_encrypted,
      updated_at = NOW()
    WHERE id = p_id AND vault_id = p_vault_id;
    RETURN QUERY SELECT TRUE, v_current_version + 1;
  END IF;
END;
$function$;
revoke execute on function public.upsert_vault_entry_versioned(uuid,uuid,text,text,uuid,integer,text,integer,text,text,text,text,text,text,text,text,text,boolean,integer,uuid,text,text,uuid) from public, anon;
grant execute on function public.upsert_vault_entry_versioned(uuid,uuid,text,text,uuid,integer,text,integer,text,text,text,text,text,text,text,text,text,boolean,integer,uuid,text,text,uuid) to authenticated;

-- Storage bucket and policies for cloud backup (same as production).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('vaults', 'vaults', false, 10485760, array['application/octet-stream'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists "Users can delete own vault" on storage.objects;
drop policy if exists "Users can insert own vault" on storage.objects;
drop policy if exists "Users can select own vault" on storage.objects;
drop policy if exists "Users can update own vault" on storage.objects;
create policy "Users can delete own vault" on storage.objects for delete to authenticated using ((bucket_id = 'vaults') and ((storage.foldername(name))[1] = (auth.uid())::text));
create policy "Users can insert own vault" on storage.objects for insert to authenticated with check ((bucket_id = 'vaults') and ((storage.foldername(name))[1] = (auth.uid())::text));
create policy "Users can select own vault" on storage.objects for select to authenticated using ((bucket_id = 'vaults') and ((storage.foldername(name))[1] = (auth.uid())::text));
create policy "Users can update own vault" on storage.objects for update to authenticated using ((bucket_id = 'vaults') and ((storage.foldername(name))[1] = (auth.uid())::text));

-- Team members list RPC: production runs 20260527000001, which grants it back to authenticated.
revoke execute on function public.get_team_members_with_email(uuid) from public, anon;
grant execute on function public.get_team_members_with_email(uuid) to authenticated;
