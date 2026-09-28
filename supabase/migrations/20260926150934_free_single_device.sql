-- Free plan: a personal vault may be open on one device at a time.
-- Setting the value back to -1 turns enforcement off without a client release.
-- See docs/MULTI_DEVICE_SYNC.md section 9.6.

update public.tiers set features = features || '{"vault_max_open_devices": 1}'::jsonb,
  updated_at = now() where name = 'free';
