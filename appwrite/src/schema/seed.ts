// Plan tiers and app settings as they are in prod (2026-10-14). Local and test stacks start from
// these; prod gets its rows from the data import. The tier IDs match the website's TIER_IDS defaults.

export const SEED_TIERS = [
  {
    id: 'be1ecbe0-9638-4267-94ff-405583c2f432',
    name: 'free',
    display_name: 'Free',
    description: 'Basic access with unlimited connections',
    features: {
      mcp_enabled: true, personal_sync: 'on', shared_vaults: false, max_connections: -1, mcp_daily_quota: -1,
      max_cloud_backups: 3, cli_agents_enabled: true, cloud_sync_enabled: false, backup_retention_days: 1,
      beta_features_enabled: false, vault_max_open_devices: 1, chat_cloud_sync_enabled: false,
      max_cloud_backup_vaults: 0, account_max_active_devices: 5,
    },
    sort_order: 0,
    is_active: true,
    price_monthly: 0,
    price_label: 'Free',
    stripe_product_id: null,
    stripe_price_monthly: null,
    stripe_price_annual: null,
    price_annual: 0,
  },
  {
    id: '038a8076-7660-4881-94b6-ae75f1f3b91f',
    name: 'pro',
    display_name: 'Pro',
    description: 'Professional access with expanded features',
    features: {
      mcp_enabled: true, personal_sync: 'on', shared_vaults: false, max_connections: -1, mcp_daily_quota: -1,
      max_cloud_backups: 25, cli_agents_enabled: true, cloud_sync_enabled: true, backup_retention_days: 14,
      beta_features_enabled: false, vault_max_open_devices: -1, chat_cloud_sync_enabled: true,
      max_cloud_backup_vaults: 10, account_max_active_devices: 5,
    },
    sort_order: 1,
    is_active: true,
    price_monthly: 10,
    price_label: '$15/month',
    stripe_product_id: 'prod_U25CG2Mp4p4nFn',
    stripe_price_monthly: 'price_1TNF21AuHA2lanzumXn0Rqp9',
    stripe_price_annual: 'price_1TNF26AuHA2lanzuRmeq8fW8',
    price_annual: 96,
  },
  {
    id: 'b208bc0a-127c-44c6-85d4-b84f608e43a6',
    name: 'team',
    display_name: 'Team',
    description: 'Unlimited access for organizations',
    features: {
      is_per_seat: true, mcp_enabled: true, personal_sync: 'on', shared_vaults: true, max_connections: -1,
      mcp_daily_quota: -1, max_cloud_backups: -1, cli_agents_enabled: true, cloud_sync_enabled: true,
      backup_retention_days: 180, beta_features_enabled: true, vault_max_open_devices: -1,
      chat_cloud_sync_enabled: true, max_cloud_backup_vaults: -1, account_max_active_devices: 5,
    },
    sort_order: 2,
    is_active: true,
    price_monthly: 20,
    price_label: '$25/seat/month',
    stripe_product_id: 'prod_U25CKXlkbzHbGt',
    stripe_price_monthly: 'price_1TNF2BAuHA2lanzufaSQiSLY',
    stripe_price_annual: 'price_1TNF2GAuHA2lanzu8NPY4tju',
    price_annual: 192,
  },
] as const;

export const SEED_CONFIG = [
  { key: 'min_app_version', value: { ios: '0.0.0', desktop: '0.0.0' } },
  { key: 'vault_share_grace_days', value: 14 },
  { key: 'vault_release_cooldown_days', value: 7 },
  { key: 'account_max_active_devices_fallback', value: 5 },
] as const;
