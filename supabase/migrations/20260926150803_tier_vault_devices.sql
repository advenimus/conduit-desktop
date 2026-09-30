-- Plan keys for personal vault sync. Every plan starts unlimited (presence only);
-- 20260926150934 turns on the Free single-device limit. mcp_daily_quota stays -1
-- because MCP builds before the quota removal cap at 50/day when the key is missing.
-- See docs/MULTI_DEVICE_SYNC.md section 9.3.

update public.tiers set features = features || jsonb_build_object(
    'vault_max_open_devices', -1,
    'mcp_daily_quota', -1,
    'cloud_sync_enabled', name <> 'free',
    'personal_sync', 'on'),
  updated_at = now()
where name in ('free', 'pro', 'team');
