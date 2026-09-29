-- Local-stack parity with production for the /verify harness (read from prod on 2026-09-26).
-- The migrations create upsert_vault_entry_versioned (20260929150000) and the four storage.objects
-- policies of bucket "vaults" (20260929150300); this file adds what no migration creates.

-- Storage bucket for cloud backup (same as production).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('vaults', 'vaults', false, 10485760, array['application/octet-stream'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Team members list RPC: production runs 20260527000001, which grants it back to authenticated.
revoke execute on function public.get_team_members_with_email(uuid) from public, anon;
grant execute on function public.get_team_members_with_email(uuid) to authenticated;
