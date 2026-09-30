-- vault_sessions_for also returns heartbeat_at: every heartbeat writes the side-file flag, but
-- last_active_at moves only while that device is in use, so clients take heartbeat_at as the time
-- a flag was reported (docs/MULTI_DEVICE_SYNC.md 5.5). Everything else is unchanged from
-- 20260926150829_personal_vault_sessions.sql; clients fall back to last_active_at without it.

create or replace function public.vault_sessions_for(p_uid uuid, p_vault_key uuid, p_device_id uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'device_id', s.device_id, 'device_name', s.device_name, 'platform', s.platform,
      'file_name', s.file_name, 'file_id', s.file_id, 'location', s.location,
      'status', case when s.status = 'active' and s.expires_at < now() then 'expired' else s.status end,
      'last_active_at', s.last_active_at, 'heartbeat_at', s.heartbeat_at, 'busy', s.busy, 'flags', s.flags,
      'written_vv', s.written_vv, 'written_at', s.written_at,
      'pending_changes', s.pending_changes, 'abandoned', s.abandoned_at is not null)
      order by s.last_active_at desc), '[]'::jsonb)
  from public.personal_vault_sessions s
  where s.user_id = p_uid and s.vault_key = p_vault_key and s.device_id <> p_device_id
    and s.heartbeat_at > now() - interval '30 days'
$$;

revoke execute on function public.vault_sessions_for(uuid, uuid, uuid) from public, anon, authenticated;
