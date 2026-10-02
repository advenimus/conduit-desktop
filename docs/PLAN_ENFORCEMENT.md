# Plan enforcement: vault ownership, device cap, seats, cloud backup, minimum version

Status: implementation spec, 2026-09-29. Builds on `docs/MULTI_DEVICE_SYNC.md` (sections 3.5, 6.x, 8, 9). Four builders work from this file in parallel: **DB** (migrations in this repo), **Desktop** (this repo), **iOS**, **Web+BE** (website and backend). Each section says who owns it.

**Path roots used in citations.**
- `DESK` = this repository (conduit-desktop, branch `advenimus/plan-enforcement`)
- `IOS` = `/Volumes/SSD Storage/Github/Repos/conduit-iOS-multi-device-sync` (branch `feat/multi-device-sync`, iOS 1.1.0, unreleased)
- `PKG` = `IOS/Packages/ConduitSync`; `SES` = `PKG/Sources/ConduitSession`; `SYN` = `PKG/Sources/ConduitSync`
- `WEB` = `/Volumes/SSD Storage/Github/Repos/conduit-website-device-sync` (branch `feat/device-sync-pricing`)
- `BE` = `/Volumes/SSD Storage/Github/Repos/conduit-backend-device-sync` (branch `feat/device-sync-tier-keys`)
- Prod = Supabase project `khuyzxadaszwxirwykms` (read with SELECT only)

**Evidence tags.**
- **[V]** verified by reading the code or a prod SELECT (by the scouts or in this pass).
- **[A]** assumed. Every [A] that matters is a test in section 7.

**Rule for every paid rule.** The desktop app is open source. The server decides every limit; the apps only show the answer. The in-file owner tag (section 3) is a backup signal for honest apps offline, never the lock.

---

## 1. What each plan gets and what the user sees

### 1.1 Rules per plan

| Rule | Free | Pro | Team (per person) | Where decided |
|---|---|---|---|---|
| One personal vault open on how many devices at once | 1 (`vault_max_open_devices`, exists) | unlimited | unlimited | `vault_session_acquire` / heartbeat |
| Devices with any personal vault open, per account | 5 | 5 | 5 | New tier key `account_max_active_devices`, same RPCs |
| Personal vault belongs to one account | yes | yes | yes (personal vaults stay personal) | New table `personal_vault_owners` |
| Another account may use your vault | 14 days per vault and per pair of accounts, then no | same | same | `app_config.vault_share_grace_days` |
| Cloud backup upload | no | yes, up to 25 snapshots per vault, up to 10 vaults | yes, unlimited | `storage.objects` policies; tier keys `max_cloud_backups`, NEW `max_cloud_backup_vaults` |
| Team seats | - | - | `teams.max_seats`, enforced by a DB trigger | trigger on `team_members` |
| Minimum app version | per platform, default `0.0.0` (off) | same | same | `app_config.min_app_version` |

- A **device** is a `device_id` (one per app install). A device counts toward the cap while it holds at least one live lease (status `active`, not expired) on any personal vault of the account. iOS releases its lease in the background (MULTI_DEVICE_SYNC 6.10), so a phone in the background does not count.
- Team vaults are not counted by the device cap (section 9).
- The **owner** of a vault (lineage) is the first account that is granted a lease on it by an open the user started (unlock or take-over). Background re-acquires never claim (2.5.2). The owner can release it in Sync settings; the next account to open it becomes the owner. Deleting the account frees the vault.
- **Grace** starts the first time any other account is granted a lease on the vault. For 14 days every other account can use the vault normally. After that other accounts get "not owner" and no access, not even read only. They can make their own copy.
- **Grace is also counted per pair of accounts.** The clock of owner A and guest B starts the first time either one uses a vault owned by the other, and it holds when they swap roles. So forking the vault every 13 days (a copy is a new lineage) does not give the pair a fresh 14 days. Grace ends at the earlier of the vault clock and the pair clock.
- The owner sees when another account is using the vault (S7b), so they can release it or move it to Team before the other person's grace ends.

### 1.2 Exact UI strings

All strings are plain, short, and have no em dashes. `{n}` is the server's `device_cap`. `{v}` is the tier's `max_cloud_backup_vaults`. `{date}` is a short local date (for example "Oct 13"). `{device}` and `{device2}` are device names. `{email}` is the signed-in account's email, shown only on this device.

| Id | Where | Title | Body | Buttons (primary last) |
|---|---|---|---|---|
| S1 | Unlock refused, device cap (take-over dialog variant) | Too many devices | You're using Conduit on {n} devices. Close one to use it here. / Conduit will lock your vaults on {device}, the one you used least recently. | [Cancel] [Use here instead] |
| S1b | Take-over dialog (6.7 Free variant) when the denial carries `also_locks` | (unchanged title) | (unchanged text) / Conduit will also lock your vaults on {device2}, because you're using Conduit on {n} devices. | (unchanged) |
| S2 | Displaced by device cap (soft-lock modal) | Vault locked | You opened Conduit on {device}. Your plan allows {n} devices at once, so your vaults locked here. (`by` null: "on another device") | [OK] [Use here instead] |
| S3 | Reconnect or iOS foreground finds the cap full (6.8 conflict variant) | Too many devices | You're using Conduit on {n} devices. Close one to use it here. / Using it here locks your vaults on {device}. | [Lock here] [Use here instead] |
| S4 | Unlock refused, not owner (online) | This vault belongs to another account | This vault, or the file it was copied from, belongs to another Conduit account. Make your own copy to keep using this data, or ask the owner to share it with you in a Team vault. / You're signed in as {email}. If this is your vault, sign in with the account you use on your other devices. / Made a copy on another device already? [Open a vault...] | [Switch account] [Try Team free] [Cancel] [Make my own copy] (iOS: no [Try Team free], section 5.6) |
| S5 | Unlock refused, not owner (offline, tag check) | This vault belongs to another account | Connect to the internet so Conduit can check who owns this vault, then try again. | [OK] |
| S6 | Unlock refused, signed out, tag names an account | Sign in to open this vault | This vault belongs to a Conduit account. Sign in with that account to open it. | [Cancel] [Sign in] |
| S7 | Grace banner (vault open, not owner) | (banner) | This vault belongs to another Conduit account. You can use it until {date}. The owner can move it into a Team vault and invite you. / Signed in as {email}. [Switch account] | [Try Team free] [Make my own copy] |
| S7b | Owner banner (vault open, owner, another account is using it) | (banner, tone info) | Another Conduit account is using this vault until {date}. | [Try Team free] [Release this vault...] |
| S8 | Displaced, grace ended (soft-lock modal) | Vault locked | This vault belongs to another Conduit account, and your 14 days of access ended. Unlock it again to make your own copy. | [OK] |
| S8b | Displaced or refused, caller released this vault earlier (`released: true`) | Vault locked | You released this vault and another account now owns it. Unlock it again to make your own copy. | [OK] |
| S9 | Unlock refused, update required | Update required | This version of Conduit can't open your vaults anymore. Update to version {min} or later. | [Cancel] [Update Conduit] |
| S10 | Displaced, update required | Vault locked | Update Conduit to keep using this vault. | [OK] [Update Conduit] |
| S11 | Sync settings, owner line | - | Owner: this account. / Owner: another account. You can use it until {date}. / Owner: not set yet. / Owner: sign in to check. | - |
| S12 | Sync settings, release button | Release this vault? | The next Conduit account that opens it becomes its owner. If you open it again first, it stays yours. | [Cancel] [Release] |
| S13 | Release refused, too soon | (toast warning) | You can release this vault on {date}. | - |
| S14 | Release done | (toast success) | Vault released. The next account that opens it becomes its owner. | - |
| S15 | Own copy made | (toast success, existing `offerOpenNewVault`) | Your copy is ready. It opens with the same master password. | [Open it] |
| S16 | Cloud backup refused by plan | (backup status line) | Cloud backup needs Pro or Team. Your earlier backups are still here. | [Upgrade] |
| S17 | Cloud backup full | (backup status line) | Cloud backup is full. Conduit removes the oldest backup before the next one. | - |
| S18 | Team invite accept failed | (toast error) | Could not join the team. / text of the server's `error` field | - |
| S19 | MCP locked, not owner | (MCP error message) | The vault is locked: it belongs to another Conduit account. | - |
| S20 | MCP locked, update required | (MCP error message) | The vault is locked: update Conduit to use it. | - |
| S21 | Soft-lock banner, not owner | (banner) | This vault belongs to another Conduit account. Your open connections keep running. | [Close vault] |
| S22 | Soft-lock banner, update required | (banner) | Update Conduit to use this vault. Your open connections keep running. | [Update Conduit] [Close vault] |
| S23 | Release failed (offline or server error) | (toast error) | Could not release this vault. Check your connection and try again. | - |
| S24 | Cloud backup refused, too many vaults | (backup status line) | Cloud backup is full: your plan backs up {v} vaults. Remove an old vault's backups to back up this one. | - |

---

## 2. Server contract (owner: DB builder)

### 2.1 Migration files and order

All in `DESK/supabase/migrations/`, after `20260928003610_team_invitation_update_guard.sql` [V]. Rollback files use the existing `_rollback_<version>_<name>.sql` convention (`_rollback_20260527000000_advisor_cleanup.sql` [V]); the leading underscore keeps them out of the harness's `<version>_*.sql` pattern [A: from the file names; confirm in `scripts/verify/lib/supabase-stack.mjs:135`].

| # | File | Contents | Section |
|---|---|---|---|
| M1 | `supabase/migrations/20260929161642_team_membership_hardening.sql` | Drop `tm_insert` and `ti_insert`; `tm_update` with check; row guard; seat trigger (also refuses a team without a live subscription); `teams` column guard; invitation admin-edit guard; member-removal cleanup trigger; team-vault helpers require team membership; tighter `team_vault_members_insert` and `_update`, `vault_key_wraps_insert`; `team_vaults_insert` checks `created_by`; guarded `upsert_vault_entry_versioned`; revoke TRUNCATE/REFERENCES/TRIGGER from anon and authenticated | 2.7 |
| M2 | `supabase/migrations/20260929161746_app_config_min_version.sql` | `app_config` table and seed; version helpers | 2.2 |
| M3 | `supabase/migrations/20261001174606_vault_ownership_device_cap.sql` | `personal_vault_owners`, `personal_vault_guest_grace`; owner helpers; `vault_owner_release`; tier key `account_max_active_devices`; widened `displaced_reason`; new peek/acquire (11 args)/heartbeat bodies | 2.3-2.6 |
| M4 | `supabase/migrations/20260929161756_cloud_backup_plan_gate.sql` | `cloud_backup_allowed()` (no arguments); all four `storage.objects` policies for bucket `vaults` created here (INSERT and UPDATE get the plan check and the object-name check); tier key `max_cloud_backup_vaults` | 2.9 |
| M5 | `supabase/migrations/20261002173105_cloud_backup_count_cap.sql` (waited in `supabase/pending/` until rollout step 8) | `cloud_backup_slot_free(text)`; INSERT and UPDATE policies also get the per-vault snapshot cap and the per-account vault-folder cap | 2.9 |

Each file is idempotent (`create or replace`, `drop ... if exists`, `on conflict do nothing`) because the `/verify` harness re-applies every migration on every run [V: `scripts/verify/README.md:104`]. M5 lives in `supabase/pending/` so no in-order apply of `migrations/` (for example `supabase db push`) can ship it before desktop 0.18; the SQL test runner (7.1) applies `supabase/pending/*.sql` after the migrations. At rollout step 8 the owner moves it into `migrations/` (same file name).

### 2.2 `app_config` and version helpers (M2)

```sql
create table if not exists public.app_config (
  key text primary key check (key ~ '^[a-z0-9_]{1,64}$'),
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.app_config enable row level security;       -- no policies: server functions only
revoke all on public.app_config from anon, authenticated;

insert into public.app_config (key, value) values
  ('min_app_version', '{"desktop": "0.0.0", "ios": "0.0.0"}'),
  ('vault_share_grace_days', '14'),
  ('vault_release_cooldown_days', '7'),
  ('account_max_active_devices_fallback', '5')
on conflict (key) do nothing;

-- [major, minor, patch] from "1.2.3", "v0.18", "1.1.0 (107)"; null when there is no leading number.
create or replace function public.version_parts(p text) returns int[]
language sql immutable set search_path = public, pg_temp as $$
  select case when m is null then null
    else array[m[1]::int, coalesce(m[2], '0')::int, coalesce(m[3], '0')::int] end
  from (select regexp_match(coalesce(p, ''), '^\s*v?(\d{1,6})(?:\.(\d{1,6}))?(?:\.(\d{1,6}))?') as m) x
$$;

create or replace function public.app_platform_group(p_platform text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select case when p_platform in ('macos', 'windows', 'linux') then 'desktop'
              when p_platform in ('ios', 'ipados') then 'ios' end
$$;

create or replace function public.app_min_version(p_platform text) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select value ->> public.app_platform_group(p_platform)
                     from public.app_config where key = 'min_app_version'), '0.0.0')
$$;

-- True when any platform has a minimum above 0.0.0.
create or replace function public.app_any_min_set() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select bool_or(public.version_parts(e.value) > array[0, 0, 0])
                     from public.app_config c, jsonb_each_text(c.value) e
                    where c.key = 'min_app_version' and jsonb_typeof(c.value) = 'object'), false)
$$;

-- True when no minimum is set (0.0.0 or unparseable config); otherwise an unparseable app version fails.
-- An unknown or null platform passes only while no platform has a minimum (else it could dodge the lever).
create or replace function public.app_version_ok(p_platform text, p_version text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  with m as (select public.version_parts(public.app_min_version(p_platform)) as min)
  select case when public.app_platform_group(p_platform) is null then not public.app_any_min_set()
              when m.min is null or m.min = array[0, 0, 0] then true
              when public.version_parts(p_version) is null then false
              else public.version_parts(p_version) >= m.min end
  from m
$$;

create or replace function public.app_config_int(p_key text, p_default int) returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select case when jsonb_typeof(value) = 'number' then (value #>> '{}')::int end
                     from public.app_config where key = p_key), p_default)
$$;

revoke execute on function public.version_parts(text), public.app_platform_group(text),
  public.app_min_version(text), public.app_any_min_set(), public.app_version_ok(text, text),
  public.app_config_int(text, int)
  from public, anon, authenticated;
```

- The official apps send `macos`, `windows`, `linux` (DESK `session-client.ts:58`, `host-electron.ts:115` [V: critic]) and `ios`/`ipados` (IOS `VaultSessionHost.swift:48`), so the unknown-platform rule never hits them. Peek skips the version check when `p_platform` is null (a 2-argument caller); acquire always checks.

- Turning a minimum on: `update public.app_config set value = jsonb_set(value, '{desktop}', '"0.19.0"'), updated_at = now() where key = 'min_app_version';`. No client release needed.
- `int[]` comparison is element by element [V: Postgres array ordering], so `{0,18,0} >= {0,17,9}` holds.
- Old apps (desktop 0.17 or older, iOS 1.0.5/1.0.6) never call the lease RPCs, so a minimum never reaches them [V: fact sheet section 6]. Accepted (9).

### 2.3 Vault ownership (M3)

```sql
create table if not exists public.personal_vault_owners (
  vault_key uuid primary key,                       -- sync_state.lineage_id (same key as personal_vault_sessions)
  owner_id uuid references auth.users(id) on delete set null,   -- null: unowned (released or account deleted)
  owner_since timestamptz,                          -- when owner_id got its value; drives the release cooldown
  first_seen_at timestamptz not null default now(),
  grace_started_at timestamptz,                     -- first lease granted to any other account; never reset
  released_at timestamptz,
  released_by uuid,                                 -- last account that released it (no FK: kept after deletion)
  updated_at timestamptz not null default now(),
  check (owner_id is null or owner_since is not null)
);
create index if not exists personal_vault_owners_owner_idx on public.personal_vault_owners (owner_id);

-- The FK's SET NULL runs as an UPDATE of owner_id only; this trigger finishes the "unowned" row so the
-- auth.users delete never fails (a strict "(owner_id is null) = (owner_since is null)" check would).
create or replace function public.personal_vault_owners_normalize() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.owner_id is null and old.owner_id is not null then
    new.owner_since := null;
    new.released_at := coalesce(new.released_at, now());
    new.updated_at := now();
  end if;
  return new;
end $$;
drop trigger if exists trg_personal_vault_owners_normalize on public.personal_vault_owners;
create trigger trg_personal_vault_owners_normalize before update on public.personal_vault_owners
  for each row execute function public.personal_vault_owners_normalize();

alter table public.personal_vault_owners enable row level security;
drop policy if exists "vault owners: read own" on public.personal_vault_owners;
create policy "vault owners: read own" on public.personal_vault_owners
  for select to authenticated using (owner_id = (select auth.uid()));
revoke insert, update, delete, truncate on public.personal_vault_owners from anon, authenticated;
grant select on public.personal_vault_owners to authenticated;

-- Grace per pair of accounts (lo/hi = least/greatest of owner and guest, so swapping roles keeps the clock).
create table if not exists public.personal_vault_guest_grace (
  account_lo uuid not null references auth.users(id) on delete cascade,
  account_hi uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null default now(),
  primary key (account_lo, account_hi),
  check (account_lo < account_hi)
);
alter table public.personal_vault_guest_grace enable row level security;   -- no policies: server functions only
revoke all on public.personal_vault_guest_grace from anon, authenticated;
```

- **Separate from the session table.** The 30-day purge cron deletes only `personal_vault_sessions` rows [V: `20260926150829_personal_vault_sessions.sql` cron block], so ownership survives it.
- **Account deletion:** `on delete set null` plus the normalize trigger makes the vault unowned (`owner_id` and `owner_since` null, `released_at` set). A strict check would make the `auth.users` delete fail [V: critics reproduced it on the local stack; FK actions run as UPDATEs and CHECK constraints apply]. There is no account-deletion code in any repo today [V: fact sheet 2]; this FK is the whole mechanism. Pair rows of a deleted account cascade away.
- **The row is kept on release** (owner set to null) so `grace_started_at` is not reset and the release cooldown cannot be dodged by handing the vault back and forth.
- No migration of existing data: prod has 0 session rows and 0 lineages [V: fact sheet 0].

**Resolver.** `p_write = false` is a pure read (acquire step 3 and heartbeat). `p_write = true` runs only right before an acquire is granted (step 7): it claims an unowned vault when `p_claim`, starts the vault grace clock and the pair clock. Caller already holds the account lock and the lineage lock (2.6).

```sql
create or replace function public.vault_owner_resolve(p_uid uuid, p_vault_key uuid, p_write boolean, p_claim boolean)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v public.personal_vault_owners;
  v_days int := public.app_config_int('vault_share_grace_days', 14);
  v_cool int := public.app_config_int('vault_release_cooldown_days', 7);
  v_lo uuid; v_hi uuid; v_pair timestamptz; v_until timestamptz; v_shared timestamptz;
begin
  if p_write and p_claim then
    insert into public.personal_vault_owners (vault_key, owner_id, owner_since)
    values (p_vault_key, p_uid, now()) on conflict (vault_key) do nothing;
  end if;
  select * into v from public.personal_vault_owners where vault_key = p_vault_key for update;
  if not found then return jsonb_build_object('ownership', 'unowned'); end if;

  if v.owner_id is null then
    if not (p_write and p_claim) then return jsonb_build_object('ownership', 'unowned'); end if;
    update public.personal_vault_owners
       set owner_id = p_uid, owner_since = now(), released_at = null, updated_at = now()
     where vault_key = p_vault_key;
    return jsonb_build_object('ownership', 'owner', 'release_after', now() + make_interval(days => v_cool),
                              'shared_until', null);
  end if;

  if v.owner_id = p_uid then
    v_shared := v.grace_started_at + make_interval(days => v_days);
    return jsonb_build_object('ownership', 'owner',
      'release_after', v.owner_since + make_interval(days => v_cool),
      'shared_until', case when v_shared > now() then v_shared end);   -- another account is using it (S7b)
  end if;

  v_lo := least(v.owner_id, p_uid); v_hi := greatest(v.owner_id, p_uid);
  if p_write then
    insert into public.personal_vault_guest_grace (account_lo, account_hi) values (v_lo, v_hi)
      on conflict do nothing;
    if v.grace_started_at is null then
      update public.personal_vault_owners set grace_started_at = now(), updated_at = now()
       where vault_key = p_vault_key;
      v.grace_started_at := now();
    end if;
  end if;
  select started_at into v_pair from public.personal_vault_guest_grace
   where account_lo = v_lo and account_hi = v_hi;
  v_until := least(coalesce(v.grace_started_at, now()), coalesce(v_pair, now())) + make_interval(days => v_days);
  if now() < v_until then
    return jsonb_build_object('ownership', 'grace', 'grace_until', v_until);
  end if;
  return jsonb_build_object('ownership', 'not_owner', 'grace_ended_at', v_until,
                            'released', v.released_by is not distinct from p_uid);
end $$;
revoke execute on function public.vault_owner_resolve(uuid, uuid, boolean, boolean) from public, anon, authenticated;
```

- Nothing is written for an acquire that is refused (not owner, vault limit, device cap). A refused acquire writes no session row, so it would slip past the 200-per-day guard; writing owner rows only on a grant keeps owner rows bounded by granted sessions.
- **Only a user-started open claims** (`p_claim = true` on acquire, 2.5.2). Heartbeats and background re-acquires (desktop "lost" re-acquire, offline retry, sign-in acquire; iOS foreground and sign-in acquire) send `p_claim = false`, so after "Release this vault" the releaser's other unlocked devices keep the vault unowned (they get `ownership: unowned`). Their next user-started unlock claims it again, as S12 says.
- Grace is per vault and per pair: the first foreign grant starts the vault clock for everyone [given] and the pair clock for that owner and guest. Grace ends at the earlier of the two. A copy made with "Make my own copy" is a new lineage, but the pair clock still applies when the other account uses it.
- `released: true` on a `not_owner` answer means the caller is the account that last released this vault (S8b instead of S8).

**Release RPC.**

```sql
create or replace function public.vault_owner_release(p_vault_key uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v public.personal_vault_owners;
  v_cool int := public.app_config_int('vault_release_cooldown_days', 7);
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if p_vault_key is null then raise exception 'missing id' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('vault-owner:' || p_vault_key::text, 0));
  select * into v from public.personal_vault_owners where vault_key = p_vault_key for update;
  if not found or v.owner_id is distinct from v_uid then
    return jsonb_build_object('released', false, 'reason', 'not_owner');
  end if;
  if v.owner_since > now() - make_interval(days => v_cool) then
    return jsonb_build_object('released', false, 'reason', 'too_soon',
      'retry_after', v.owner_since + make_interval(days => v_cool));
  end if;
  update public.personal_vault_owners
     set owner_id = null, owner_since = null, released_at = now(), released_by = v_uid, updated_at = now()
   where vault_key = p_vault_key;
  return jsonb_build_object('released', true);
end $$;
revoke execute on function public.vault_owner_release(uuid) from public, anon;
grant execute on function public.vault_owner_release(uuid) to authenticated;
```

- A directed transfer to an email is **not built**: it needs an email lookup in `auth.users` and an accept step on the other side. Release covers the need (10).

### 2.4 Device cap (M3)

```sql
update public.tiers set features = features || '{"account_max_active_devices": 5}'::jsonb, updated_at = now()
 where name in ('free', 'pro', 'team');

-- -1 means no cap. A missing key uses app_config account_max_active_devices_fallback (5).
create or replace function public.account_device_cap(p_uid uuid) returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select case when jsonb_typeof(t.features -> 'account_max_active_devices') = 'number'
                 then (t.features ->> 'account_max_active_devices')::int end
       from public.user_profiles p left join public.tiers t on t.id = p.tier_id where p.id = p_uid),
    public.app_config_int('account_max_active_devices_fallback', 5))
$$;

-- One entry per OTHER device with a live lease of this account, least valuable first
-- (idle before busy, then least recently active): element 0 is what a take-over displaces.
create or replace function public.vault_session_device_holders(p_uid uuid, p_device_id uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with live as (
    select * from public.personal_vault_sessions
     where user_id = p_uid and status = 'active' and expires_at >= now() and device_id <> p_device_id),
  latest as (
    select distinct on (device_id) device_id, device_name, platform, file_name, file_id, location
      from live order by device_id, last_active_at desc),
  agg as (
    select device_id, count(*) as vaults, max(last_active_at) as last_active_at,
           bool_or(public.vault_session_is_busy(busy)) as is_busy,
           sum(case when jsonb_typeof(busy -> 'sessions') = 'number' then greatest((busy ->> 'sessions')::numeric, 0) else 0 end) as sessions,
           sum(case when jsonb_typeof(busy -> 'jobs') = 'number' then greatest((busy ->> 'jobs')::numeric, 0) else 0 end) as jobs
      from live group by device_id)
  select coalesce(jsonb_agg(jsonb_build_object(
      'device_id', l.device_id, 'device_name', l.device_name, 'platform', l.platform,
      'file_name', l.file_name, 'file_id', l.file_id, 'location', l.location,
      'last_active_at', a.last_active_at, 'busy', jsonb_build_object('sessions', a.sessions, 'jobs', a.jobs),
      'vaults', a.vaults)
      order by a.is_busy asc, a.last_active_at asc, l.device_id), '[]'::jsonb)
  from latest l join agg a using (device_id)
$$;

-- True when this device would be a NEW device over the cap (read only; used by peek and acquire).
create or replace function public.vault_session_over_cap(p_uid uuid, p_vault_key uuid, p_device_id uuid, p_cap int)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select p_cap <> -1
     and not exists (select 1 from public.personal_vault_sessions
                      where user_id = p_uid and device_id = p_device_id and vault_key <> p_vault_key
                        and status = 'active' and expires_at >= now())
     and (select count(distinct device_id) from public.personal_vault_sessions
           where user_id = p_uid and status = 'active' and expires_at >= now()
             and device_id <> p_device_id) >= p_cap
$$;

-- The device the account cap would ALSO lock when a take-over first displaces p_skip on this vault
-- (acquire step 5 victims). Null when the cap would not be exceeded. Read only; feeds `also_locks` (S1b).
create or replace function public.vault_session_cap_victim(
  p_uid uuid, p_vault_key uuid, p_device_id uuid, p_cap int, p_skip uuid[])
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with live as (
    select * from public.personal_vault_sessions
     where user_id = p_uid and status = 'active' and expires_at >= now() and device_id <> p_device_id
       and not (vault_key = p_vault_key and device_id = any(coalesce(p_skip, '{}')))),
  dev as (
    select device_id, bool_or(public.vault_session_is_busy(busy)) as is_busy, max(last_active_at) as la
      from live group by device_id)
  select case
    when p_cap = -1 or (select count(*) from dev) < p_cap then null
    when exists (select 1 from public.personal_vault_sessions
                  where user_id = p_uid and device_id = p_device_id and vault_key <> p_vault_key
                    and status = 'active' and expires_at >= now()) then null
    else (select jsonb_build_object('device_id', d.device_id,
                   'device_name', (select l.device_name from live l where l.device_id = d.device_id
                                    order by l.last_active_at desc limit 1))
            from dev d order by d.is_busy asc, d.la asc, d.device_id limit 1) end
$$;

revoke execute on function public.account_device_cap(uuid), public.vault_session_device_holders(uuid, uuid),
  public.vault_session_over_cap(uuid, uuid, uuid, int),
  public.vault_session_cap_victim(uuid, uuid, uuid, int, uuid[]) from public, anon, authenticated;

alter table public.personal_vault_sessions drop constraint if exists personal_vault_sessions_displaced_reason_check;
alter table public.personal_vault_sessions add constraint personal_vault_sessions_displaced_reason_check
  check (displaced_reason in ('takeover', 'plan_limit', 'device_cap', 'not_owner', 'update_required'));
create index if not exists personal_vault_sessions_user_active_idx
  on public.personal_vault_sessions (user_id, device_id) where status = 'active';
```

- Holder entries keep every field of today's `vault_session_holders` rows, so both clients' `parseHolder` reads them unchanged [V: DESK `session-client-parse.ts:114-135,158-160`]. The extra `vaults` field is ignored by old parsers and optional for new ones.
- The take-over picks the device; there is no device picker (10). The denial names it (`holders[0]`).

### 2.5 Lease RPCs (M3)

#### 2.5.1 Response shapes

Fields marked NEW are added; everything else is unchanged from MULTI_DEVICE_SYNC 9.5.

**`vault_session_peek(p_vault_key uuid, p_device_id uuid, p_platform text default null, p_app_version text default null)`**. The 2-argument function is dropped and replaced (2.5.2); calls that name only the first two arguments still resolve [A: PostgREST named-argument resolution with defaults; test 7.1 P1, an HTTP test].

```jsonc
{ "limit": 1, "holders": [ /* this vault's other holders, as today */ ],
  "device_cap": 5,                                   // NEW
  "reason": "update_required" | "device_cap",        // NEW, only when the open will be refused
  "min_version": "0.19.0",                           // NEW, with update_required
  "devices": [ /* device holders, 2.4; with device_cap */ ] }
```

Peek never reports ownership. A not-owner answer needs the verified password for "Make my own copy", so it comes from acquire (after the password check). Peek never writes.

**`vault_session_acquire(...)`**: today's 10 arguments [V: `20260926150905_personal_vault_session_rpcs.sql:13-16`] plus NEW `p_claim boolean default true` (11th). The 10-argument function is dropped (two overloads would make a 10-argument named call ambiguous). `p_claim = true` only for an open the user started (unlock, take-over from a dialog); `false` for every background re-acquire (2.3).

```jsonc
// Granted
{ "granted": true, "lease_id": "...", "limit": -1, "ttl_seconds": 90, "heartbeat_seconds": 30,
  "sessions": [...], "server_now": "...",
  "device_cap": 5,                                   // NEW
  "ownership": "owner" | "grace" | "unowned",        // NEW ("unowned": p_claim false on an unowned vault)
  "grace_until": "2026-10-13T...Z" | null,           // NEW, set with "grace"
  "release_after": "2026-10-06T...Z" | null,         // NEW, set with "owner" (release cooldown end)
  "shared_until": "2026-10-13T...Z" | null }         // NEW, "owner" only: another account is using it until then (S7b)

// Refused. limit, holders, sessions and server_now are always present.
{ "granted": false, "reason": "vault_limit",  "limit": 1, "device_cap": 5, "holders": [/* non-empty */],
  "also_locks": { "device_id": "...", "device_name": "..." } | null,   // NEW: a take-over would also lock this device (S1b)
  "sessions": [...], "server_now": "..." }
{ "granted": false, "reason": "device_cap",   "limit": -1, "device_cap": 5, "holders": [/* device holders, non-empty, [0] = would be displaced */], "sessions": [...], "server_now": "..." }
{ "granted": false, "reason": "not_owner",    "limit": 1, "grace_ended_at": "...", "released": false, "holders": [], "sessions": [], "server_now": "..." }
{ "granted": false, "reason": "update_required", "limit": 1, "min_version": "0.19.0", "holders": [], "sessions": [], "server_now": "..." }
{ "granted": false, "error": "too_many_sessions" }  // unchanged
```

**`vault_session_heartbeat(...)`**, same 11 arguments.

```jsonc
{ "status": "ok", "limit": -1, "sessions": [...], "server_now": "...",
  "device_cap": 5, "ownership": "owner" | "grace" | "unowned", "grace_until": ... | null,
  "release_after": ... | null, "shared_until": ... | null }   // NEW fields
{ "status": "displaced", "reason": "takeover" | "plan_limit" | "device_cap" | "not_owner" | "update_required", "by": "Chris's MacBook" | null,
  "min_version": "0.19.0",        // NEW, with update_required
  "grace_ended_at": "...",        // NEW, with not_owner
  "released": true | false }      // NEW, with not_owner (S8b when true)
{ "status": "lost", "reason": "unknown" | "superseded" | "released" | "expired" }   // unchanged
```

`by` is null for `not_owner` and `update_required`. For `takeover`, `plan_limit` and `device_cap`, `by` is the displacing device's latest name across ALL of the account's vaults (a device-cap displacer usually holds another vault). `unowned` means the owner released the vault while this device had it open; it is not a refusal.

**`vault_owner_release(p_vault_key uuid)`**: `{"released": true}`, `{"released": false, "reason": "not_owner"}`, `{"released": false, "reason": "too_soon", "retry_after": "..."}`. A transport or server error is the client's `unconfirmed` (4.7).

#### 2.5.2 Function bodies

Peek (drop the 2-argument version first, then grant the new one):

```sql
drop function if exists public.vault_session_peek(uuid, uuid);
create or replace function public.vault_session_peek(
  p_vault_key uuid, p_device_id uuid, p_platform text default null, p_app_version text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_limit int;
  v_cap int;
  v_out jsonb;
begin
  if v_uid is null then return null; end if;                    -- today's SQL returns no row signed out
  v_limit := coalesce(public.vault_device_limit(v_uid), 1);
  v_cap := public.account_device_cap(v_uid);
  v_out := jsonb_build_object('limit', v_limit, 'device_cap', v_cap,
    'holders', public.vault_session_holders(v_uid, p_vault_key, p_device_id));
  if p_platform is not null and not public.app_version_ok(p_platform, p_app_version) then
    return v_out || jsonb_build_object('reason', 'update_required', 'min_version', public.app_min_version(p_platform));
  end if;
  if public.vault_session_over_cap(v_uid, p_vault_key, p_device_id, v_cap) then
    return v_out || jsonb_build_object('reason', 'device_cap',
      'devices', public.vault_session_device_holders(v_uid, p_device_id));
  end if;
  return v_out;
end $$;
revoke execute on function public.vault_session_peek(uuid, uuid, text, text) from public, anon;
grant execute on function public.vault_session_peek(uuid, uuid, text, text) to authenticated;
```

Acquire (steps in this exact order):

```sql
drop function if exists public.vault_session_acquire(uuid, uuid, uuid, text, text, text, text, uuid, text, boolean);
create or replace function public.vault_session_acquire(
  p_vault_key uuid, p_device_id uuid, p_session_nonce uuid,
  p_device_name text, p_platform text, p_app_version text,
  p_file_name text, p_file_id uuid, p_location text, p_takeover boolean default false,
  p_claim boolean default true)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_limit int;
  v_cap int;
  v_live int;
  v_devices int;
  v_own jsonb;
  v_victims uuid[];
  v_lease uuid := gen_random_uuid();
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if p_vault_key is null or p_device_id is null or p_session_nonce is null then
    raise exception 'missing id' using errcode = '22023';
  end if;
  v_limit := coalesce(public.vault_device_limit(v_uid), 1);

  -- 1. Minimum version: before any lock or write. Unknown platforms fail once any minimum is set (2.2).
  if not public.app_version_ok(p_platform, p_app_version) then
    return jsonb_build_object('granted', false, 'reason', 'update_required', 'limit', v_limit,
      'min_version', public.app_min_version(p_platform),
      'holders', '[]'::jsonb, 'sessions', '[]'::jsonb, 'server_now', now());
  end if;

  -- 2. One lock per ACCOUNT (was per account and vault): the device cap spans every vault.
  perform pg_advisory_xact_lock(hashtextextended('vault-acct:' || v_uid::text, 0));
  if (select count(*) from public.personal_vault_sessions
       where user_id = v_uid and heartbeat_at > now() - interval '1 day') > 200 then
    return jsonb_build_object('granted', false, 'error', 'too_many_sessions');
  end if;

  -- 3. Ownership, READ ONLY. The lineage lock keeps the answer valid until step 7 (2.6).
  perform pg_advisory_xact_lock(hashtextextended('vault-owner:' || p_vault_key::text, 0));
  v_own := public.vault_owner_resolve(v_uid, p_vault_key, false, false);
  if v_own ->> 'ownership' = 'not_owner' then
    return jsonb_build_object('granted', false, 'reason', 'not_owner', 'limit', v_limit,
      'grace_ended_at', v_own -> 'grace_ended_at', 'released', coalesce((v_own ->> 'released')::boolean, false),
      'holders', '[]'::jsonb, 'sessions', '[]'::jsonb, 'server_now', now());
  end if;

  -- 4. Lapsed leases of the whole account.
  update public.personal_vault_sessions set status = 'expired'
   where user_id = v_uid and status = 'active' and expires_at < now();

  v_cap := public.account_device_cap(v_uid);

  -- 5. Per-vault plan limit: unchanged logic, the denial now carries a reason and also_locks.
  if v_limit <> -1 then
    select count(*) into v_live from public.personal_vault_sessions
     where user_id = v_uid and vault_key = p_vault_key and status = 'active' and device_id <> p_device_id;
    if v_live >= v_limit then
      select array_agg(device_id) into v_victims from (
        select device_id from public.personal_vault_sessions
         where user_id = v_uid and vault_key = p_vault_key and status = 'active' and device_id <> p_device_id
         order by public.vault_session_is_busy(busy) asc, last_active_at asc, device_id
         limit v_live - v_limit + 1) d;
      if not p_takeover then
        return jsonb_build_object('granted', false, 'reason', 'vault_limit', 'limit', v_limit, 'device_cap', v_cap,
          'also_locks', public.vault_session_cap_victim(v_uid, p_vault_key, p_device_id, v_cap, v_victims),
          'holders', public.vault_session_holders(v_uid, p_vault_key, p_device_id),
          'sessions', public.vault_sessions_for(v_uid, p_vault_key, p_device_id), 'server_now', now());
      end if;
      update public.personal_vault_sessions
         set status = 'displaced', displaced_by_device = p_device_id,
             displaced_reason = 'takeover', displaced_at = now()
       where user_id = v_uid and vault_key = p_vault_key and device_id = any(v_victims);
    end if;
  end if;

  -- 6. Account device cap (after step 5, so a device displaced there may no longer count).
  if public.vault_session_over_cap(v_uid, p_vault_key, p_device_id, v_cap) then
    if not p_takeover then
      return jsonb_build_object('granted', false, 'reason', 'device_cap', 'limit', v_limit, 'device_cap', v_cap,
        'holders', public.vault_session_device_holders(v_uid, p_device_id),
        'sessions', public.vault_sessions_for(v_uid, p_vault_key, p_device_id), 'server_now', now());
    end if;
    select count(distinct device_id) into v_devices from public.personal_vault_sessions
     where user_id = v_uid and status = 'active' and expires_at >= now() and device_id <> p_device_id;
    select array_agg(device_id) into v_victims from (
      select device_id from public.personal_vault_sessions
       where user_id = v_uid and status = 'active' and expires_at >= now() and device_id <> p_device_id
       group by device_id
       order by bool_or(public.vault_session_is_busy(busy)) asc, max(last_active_at) asc, device_id
       limit v_devices - v_cap + 1) d;
    update public.personal_vault_sessions
       set status = 'displaced', displaced_by_device = p_device_id,
           displaced_reason = 'device_cap', displaced_at = now()
     where user_id = v_uid and status = 'active' and device_id = any(v_victims);
  end if;

  -- 7. The grant is certain now: commit ownership (claim when p_claim, start the vault and pair grace clocks).
  --    It cannot turn into not_owner here: step 3's lineage lock is still held, and a first pair row
  --    starts at now().
  v_own := public.vault_owner_resolve(v_uid, p_vault_key, true, coalesce(p_claim, true));

  -- 8. Upsert this session: the insert ... on conflict statement of 20260926150905 lines 61-75, unchanged.
  --    (Builder: copy it verbatim.)

  -- 9. Grant.
  return jsonb_build_object('granted', true, 'lease_id', v_lease, 'limit', v_limit, 'device_cap', v_cap,
    'ownership', v_own ->> 'ownership', 'grace_until', v_own -> 'grace_until',
    'release_after', v_own -> 'release_after', 'shared_until', v_own -> 'shared_until',
    'ttl_seconds', 90, 'heartbeat_seconds', 30,
    'sessions', public.vault_sessions_for(v_uid, p_vault_key, p_device_id), 'server_now', now());
end $$;
revoke execute on function public.vault_session_acquire(uuid, uuid, uuid, text, text, text, text, uuid, text, boolean, boolean) from public, anon;
grant execute on function public.vault_session_acquire(uuid, uuid, uuid, text, text, text, text, uuid, text, boolean, boolean) to authenticated;
```

Heartbeat (changes against `20260926150905` lines 82-162 [V]):

1. Lock: `pg_advisory_xact_lock(hashtextextended('vault-acct:' || v_uid::text, 0))` (same key as acquire).
2. Unchanged: `unknown` / `superseded` lookups, the marker update, the never-revive check. **Changed:** every `by` lookup (the `displaced` return at `:118-119` and the plan-limit re-read at `:154-155` [V]) drops the `vault_key` filter:
   ```sql
   select device_name into v_by from public.personal_vault_sessions
    where user_id = v_uid and device_id = v_row.displaced_by_device
    order by heartbeat_at desc limit 1;
   ```
   The `displaced` return adds `'released'` and `'grace_ended_at'` when the stored reason is `not_owner` (read with `vault_owner_resolve(v_uid, p_vault_key, false, false)`), and `'min_version'` when it is `update_required`.
3. NEW, after the never-revive check and before renewing:
   ```sql
   if not public.app_version_ok(v_row.platform, v_row.app_version) then
     update public.personal_vault_sessions set status = 'displaced', displaced_reason = 'update_required',
            displaced_at = now(), displaced_by_device = null
      where user_id = v_uid and vault_key = p_vault_key and device_id = p_device_id;
     return jsonb_build_object('status', 'displaced', 'reason', 'update_required', 'by', null,
       'min_version', public.app_min_version(v_row.platform));
   end if;
   v_own := public.vault_owner_resolve(v_uid, p_vault_key, false, false);   -- never claims, never starts a clock
   if v_own ->> 'ownership' = 'not_owner' then
     update public.personal_vault_sessions set status = 'displaced', displaced_reason = 'not_owner',
            displaced_at = now(), displaced_by_device = null
      where user_id = v_uid and vault_key = p_vault_key and device_id = p_device_id;
     return jsonb_build_object('status', 'displaced', 'reason', 'not_owner', 'by', null,
       'grace_ended_at', v_own -> 'grace_ended_at', 'released', coalesce((v_own ->> 'released')::boolean, false));
   end if;
   ```
4. Renew (unchanged), then the per-vault `plan_limit` sweep (unchanged), then NEW account sweep when `v_cap <> -1`:
   ```sql
   with dev as (
     select device_id, bool_or(public.vault_session_is_busy(busy)) as is_busy, max(last_active_at) as la
       from public.personal_vault_sessions
      where user_id = v_uid and status = 'active' and expires_at >= now() group by device_id),
   ranked as (select device_id, row_number() over (order by is_busy desc, la desc, device_id) as rn from dev),
   keeper as (select device_id from ranked where rn = 1)
   update public.personal_vault_sessions s
      set status = 'displaced', displaced_reason = 'device_cap', displaced_at = now(),
          displaced_by_device = (select device_id from keeper)
     from ranked r
    where s.user_id = v_uid and s.device_id = r.device_id and s.status = 'active' and r.rn > v_cap;
   ```
5. Re-read this row once after both sweeps. If displaced, return `displaced` with its stored reason and `by` (cross-vault lookup of step 2). Otherwise return `ok` with the NEW fields (`device_cap`, `ownership`, `grace_until`, `release_after`, `shared_until`).

Release and abandon are unchanged. Heartbeat grants are unchanged (same signature).

### 2.6 Locking and races

| Race | Outcome |
|---|---|
| Two devices of one account acquire different vaults at the same time, both would be device 5 and 6 | Both take `vault-acct:<uid>` first; the second sees the first's row and gets `device_cap`. The old per-(uid, vault) key could not see this [V: fact sheet 1]. |
| Two accounts are first on one lineage | Both take `vault-owner:<lineage>` at step 3, so they run one after the other: the first claims at step 7, the second reads it as owner and gets grace. |
| Owner releases while another account acquires | Release also takes `vault-owner:<lineage>`. Release first: the acquirer (with `p_claim`) claims. Acquire first: release then succeeds and the acquirer (grace) keeps its lease until its next user-started acquire claims. |
| Lock order | Acquire: own account lock, then one lineage lock, then the owner row. Release: lineage lock, then the owner row. Heartbeat: own account lock, then the owner row (read). No transaction takes two account locks or two lineage locks, and nobody takes an account lock after a lineage lock, so there is no cycle. |
| Heartbeat sweep versus acquire take-over | Same account lock, so they serialize. |
| Grace clock start | Only at step 7, under the lineage lock and the row lock; the pair row uses `on conflict do nothing`. |

Cost: one account lock serializes all lease calls of one account (at most a few devices times their open vaults, every 30 s). Acceptable.

### 2.7 Team hardening (M1)

```sql
-- 1. Only the service role adds team members (webhook, add-self, invite accept). Verified callers: WEB webhooks/route.ts:346-352,
--    add-self/route.ts:54-58, invite/accept/route.ts:90-96 use createServiceClient; the desktop acceptInvitation moves to the
--    website route (2.8); iOS only selects [V: fact sheet 2].
drop policy if exists tm_insert on public.team_members;

-- 2. Admins may change roles in their team; rows never move (the is_team_member sync trigger does not run on UPDATE).
drop policy if exists tm_update on public.team_members;
create policy tm_update on public.team_members for update to authenticated
  using (public.is_team_admin(team_id, (select auth.uid())))
  with check (public.is_team_admin(team_id, (select auth.uid())));

create or replace function public.guard_team_member_update() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.id is distinct from old.id or new.team_id is distinct from old.team_id
     or new.user_id is distinct from old.user_id then
    raise exception 'a team member row cannot move' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_team_member_update on public.team_members;
create trigger trg_guard_team_member_update before update on public.team_members
  for each row execute function public.guard_team_member_update();

-- 3. Seats: no insert may exceed teams.max_seats, whatever the role (service role included), and a team
--    without a live subscription (dissolved) takes no members at all.
create or replace function public.enforce_team_seats() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_max int; v_count int; v_sub text;
begin
  select max_seats, stripe_subscription_id into v_max, v_sub
    from public.teams where id = new.team_id for update;                             -- serializes inserts per team
  if not found then raise exception 'team not found' using errcode = '23503'; end if;
  if v_sub is null then
    raise exception 'team_inactive: this team has no active plan' using errcode = '23514';
  end if;
  select count(*) into v_count from public.team_members where team_id = new.team_id;
  if v_count >= v_max then
    raise exception 'team_full: all % seats are in use', v_max using errcode = '23514';
  end if;
  return new;
end $$;
revoke execute on function public.enforce_team_seats() from public, anon, authenticated;
drop trigger if exists trg_enforce_team_seats on public.team_members;
create trigger trg_enforce_team_seats before insert on public.team_members
  for each row execute function public.enforce_team_seats();

-- 4. teams: a signed-in owner may rename the team, nothing else (max_seats, owner_id and Stripe ids are server-only).
create or replace function public.guard_team_columns() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user in ('authenticated', 'anon') and (
       new.id is distinct from old.id or new.slug is distinct from old.slug
    or new.owner_id is distinct from old.owner_id or new.max_seats is distinct from old.max_seats
    or new.stripe_subscription_id is distinct from old.stripe_subscription_id
    or new.stripe_customer_id is distinct from old.stripe_customer_id
    or new.created_at is distinct from old.created_at) then
    raise exception 'protected column' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_team_columns on public.teams;
create trigger trg_guard_team_columns before update on public.teams
  for each row execute function public.guard_team_columns();

-- 5. Team vault members: the added user must be on the vault's team; the empty-vault branch is only the creator bootstrap.
drop policy if exists team_vault_members_insert on public.team_vault_members;
create policy team_vault_members_insert on public.team_vault_members for insert to authenticated
with check (
  exists (select 1 from public.team_vaults tv
           where tv.id = team_vault_id and public.is_team_member(tv.team_id, team_vault_members.user_id))
  and (
    public.is_team_vault_admin(team_vault_id, (select auth.uid()))
    or (not public.team_vault_has_members(team_vault_id)
        and team_vault_members.user_id = (select auth.uid()) and role = 'admin'
        and exists (select 1 from public.team_vaults tv
                     where tv.id = team_vault_id and tv.created_by = (select auth.uid())
                       and public.is_team_admin(tv.team_id, (select auth.uid()))))));

drop policy if exists team_vault_members_update on public.team_vault_members;
create policy team_vault_members_update on public.team_vault_members for update to authenticated
  using (public.is_team_vault_admin(team_vault_id, (select auth.uid())))
  with check (public.is_team_vault_admin(team_vault_id, (select auth.uid())));

drop policy if exists team_vaults_insert on public.team_vaults;
create policy team_vaults_insert on public.team_vaults for insert to authenticated
  with check (created_by = (select auth.uid()) and exists (
    select 1 from public.team_members tm
     where tm.team_id = team_vaults.team_id and tm.user_id = (select auth.uid()) and tm.role = 'admin'));

-- 6. RLS does not apply to TRUNCATE; these roles never need it.
revoke truncate, references, trigger on public.teams, public.team_members, public.team_vaults,
  public.team_vault_members, public.team_invitations, public.tiers, public.user_profiles from anon, authenticated;

-- 7. Invitations: only the website invite route (service role, which reserves a seat) creates them.
--    Admins may still revoke, but may not extend expires_at or reopen an answered invitation.
drop policy if exists ti_insert on public.team_invitations;
--    In guard_team_invitation_update (20260928003610), replace the early "is_team_admin ... return new" with:
--      if public.is_team_admin(old.team_id, (select auth.uid())) then
--        if new.expires_at > old.expires_at or new.token is distinct from old.token
--           or (old.status <> 'pending' and new.status = 'pending') then
--          raise exception 'an invitation cannot be extended or reopened' using errcode = '42501';
--        end if;
--        return new;
--      end if;
--    (Builder: copy the rest of that function verbatim.)

-- 8. Removing a member (website remove route, team dissolution) also removes every team-vault right of
--    that person in that team, and flags those vaults for key rotation. team_vault_members has no FK to
--    team_members, so without this a removed member keeps reading entries, password history and key wraps.
create or replace function public.cleanup_removed_team_member() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from public.vault_folder_permissions p using public.team_vaults tv
   where tv.team_id = old.team_id and p.vault_id = tv.id and p.user_id = old.user_id;
  delete from public.vault_key_wraps w using public.team_vaults tv
   where tv.team_id = old.team_id and w.team_vault_id = tv.id and w.user_id = old.user_id;
  with gone as (
    delete from public.team_vault_members m using public.team_vaults tv
     where tv.team_id = old.team_id and m.team_vault_id = tv.id and m.user_id = old.user_id
    returning m.team_vault_id)
  update public.team_vaults set rotation_pending = true, updated_at = now()
   where id in (select team_vault_id from gone);
  return old;
end $$;
revoke execute on function public.cleanup_removed_team_member() from public, anon, authenticated;
drop trigger if exists trg_cleanup_removed_team_member on public.team_members;
create trigger trg_cleanup_removed_team_member after delete on public.team_members
  for each row execute function public.cleanup_removed_team_member();

--    Belt and braces for rows written before this migration: vault helpers also require team membership.
create or replace function public.is_team_vault_member(p_vault_id uuid, p_user_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.team_vault_members m join public.team_vaults tv on tv.id = m.team_vault_id
                  where m.team_vault_id = p_vault_id and m.user_id = p_user_id
                    and public.is_team_member(tv.team_id, p_user_id))
$$;
create or replace function public.is_team_vault_admin(p_vault_id uuid, p_user_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.team_vault_members m join public.team_vaults tv on tv.id = m.team_vault_id
                  where m.team_vault_id = p_vault_id and m.user_id = p_user_id and m.role = 'admin'
                    and public.is_team_member(tv.team_id, p_user_id))
$$;
--    (Keep today's grants: both stay executable by authenticated [V: 20260927020444]; the parity check needs it.)

--    A key wrap may only be written for someone on the vault's team. Not "is_team_vault_member":
--    addMember and the admin auto-enroll insert the wrap BEFORE the membership row
--    [V: team-vault-manager.ts:499-521, :357-370].
drop policy if exists vault_key_wraps_insert on public.vault_key_wraps;
create policy vault_key_wraps_insert on public.vault_key_wraps for insert to authenticated
  with check (public.is_team_vault_admin(team_vault_id, (select auth.uid()))
              and exists (select 1 from public.team_vaults tv
                           where tv.id = team_vault_id and public.is_team_member(tv.team_id, vault_key_wraps.user_id)));

-- 9. The team-sync write RPC checks the caller (prod body had no auth check [V]). Same 23-argument
--    signature the desktop calls (team-sync.ts:364 [V]); p_updated_by is ignored and auth.uid() is stored.
create or replace function public.upsert_vault_entry_versioned(
  p_id uuid, p_vault_id uuid, p_name text, p_entry_type text, p_folder_id uuid default null,
  p_sort_order integer default 0, p_host text default null, p_port integer default null,
  p_username text default null, p_domain text default null, p_icon text default null,
  p_color text default null, p_notes text default null, p_password_encrypted text default null,
  p_private_key_encrypted text default null, p_config_encrypted text default null,
  p_tags_encrypted text default null, p_is_favorite boolean default false,
  p_expected_version integer default 0, p_updated_by uuid default null,
  p_credential_type text default null, p_totp_secret_encrypted text default null,
  p_parent_entry_id uuid default null)
returns table(success boolean, current_version integer)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_current_version integer;
  v_old_folder uuid;
  v_exists boolean;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if not exists (select 1 from public.team_vault_members tvm join public.team_vaults tv on tv.id = tvm.team_vault_id
                  where tvm.team_vault_id = p_vault_id and tvm.user_id = v_uid
                    and tvm.role in ('admin', 'editor') and public.is_team_member(tv.team_id, v_uid)) then
    raise exception 'not allowed to edit this vault' using errcode = '42501';
  end if;
  select version, folder_id into v_current_version, v_old_folder
    from public.vault_entries where id = p_id and vault_id = p_vault_id;
  v_exists := found;
  -- Folder restrictions apply to the target folder and, for an update, to the folder it leaves.
  if (p_folder_id is not null and coalesce(public.user_can_access_folder(p_vault_id, p_folder_id, v_uid), 'viewer') not in ('admin', 'editor'))
     or (v_exists and v_old_folder is not null and v_old_folder is distinct from p_folder_id
         and coalesce(public.user_can_access_folder(p_vault_id, v_old_folder, v_uid), 'viewer') not in ('admin', 'editor')) then
    raise exception 'not allowed to edit this folder' using errcode = '42501';
  end if;
  -- Builder: the rest is today's INSERT/UPDATE branches verbatim (scripts/verify/sql/local-parity.sql:3-62 [V]),
  -- branching on `not v_exists` instead of its own SELECT and `IF NOT FOUND`, and with
  -- `updated_by = v_uid` in place of `p_updated_by` in both the INSERT and the UPDATE.
end $$;
revoke execute on function public.upsert_vault_entry_versioned(uuid,uuid,text,text,uuid,integer,text,integer,text,text,text,text,text,text,text,text,text,boolean,integer,uuid,text,text,uuid) from public, anon;
grant execute on function public.upsert_vault_entry_versioned(uuid,uuid,text,text,uuid,integer,text,integer,text,text,text,text,text,text,text,text,text,boolean,integer,uuid,text,text,uuid) to authenticated;
```

**Local parity:** `scripts/verify/sql/local-parity.sql:1-62` recreates the unguarded `upsert_vault_entry_versioned` on every `/verify` run, after the migrations [V: `supabase-parity.mjs` header]. Delete that block (M1 now creates the function; `parityProblems` still finds the 23-argument version). Keep the `get_team_members_with_email` grant.

Why each piece:
- **tm_insert** today (live, prod [V]): `is_team_admin(team_id, uid) OR NOT EXISTS (members of that team)`. It never checks `user_id` or `role`. Any signed-in user who knows the id of a team with zero members (every dissolved team keeps its row with zero members, WEB `webhooks/route.ts:393-434` [V]) can add any user as admin. That flips `is_team_member`, which gives unlimited devices (`vault_device_limit` returns -1), hard-coded Team features and skipped suspension in BE (`verify.ts:76,82-104` [V]). The admin branch also lets an admin add anyone without an invite and without the seat check. Dropping the policy closes both.
- **Seat trigger** meets "no path can exceed `teams.max_seats`". Normal website flows never trip it: the webhook sets `max_seats = quantity` and `stripe_subscription_id` in the team insert before the first member insert (`webhooks/route.ts:325-352` [V]), and invites already reserve a seat within `max_seats` (`invite/route.ts:94-113` [V]). The trial cap of 3 stays in the accept route (the DB cannot see Stripe trial status; 10).
- **team_inactive:** dissolution deletes the members and sets `stripe_subscription_id = null` but keeps the team row, its `max_seats` and its pending invitations (`webhooks/route.ts:393-434` [V]). The accept route runs its trial check only when `stripe_subscription_id` is set, then inserts the member and sets `tier_id = team` (`invite/accept/route.ts:64-120` [V]). So a pending invitation of a dissolved team gave the Team tier for free, forever. The trigger refuses every insert into a team with no subscription; 6.3 also makes the route check the Stripe status and the webhook expire pending invitations.
- **ti_insert** (prod: `WITH CHECK is_team_admin(...)` only [V]) let a team admin insert invitations with any `expires_at` (for example 2099) and skip the website's seat reservation. Only the website invite route creates invitations, with the service role (`invite/route.ts:118-130` [V]); the desktop and iOS only select and answer them [V: DESK `team-service.ts:206,230,284`, `ipc/team.ts:41,61`; no `team_invitations` in IOS `ConduitiOS/`]. The guard change stops an admin from extending or reopening one.
- **Member-removal cleanup:** prod policies on `vault_entries`, `vault_folders`, `vault_password_history` and `vault_folder_permissions` check only `team_vault_members` (their `team_vaults` join never checks team membership), `vault_key_wraps_select` is `user_id = auth.uid()`, and `is_team_vault_admin` reads only `team_vault_members` [V: prod `pg_policies`, `pg_proc`]. `team_vault_members` has no FK to `team_members` [V]. The website remove route and dissolution delete only `team_members` rows (`members/remove/route.ts:59-60`, `webhooks/route.ts:420-424` [V]). So a removed member kept reading plaintext entry names, hosts and user names, the password history and their own key wrap, and a former vault admin kept deleting members and wraps. The trigger removes those rights at the source; the helper change covers rows left from before.
- **upsert_vault_entry_versioned** (prod: SECURITY DEFINER, executable by `authenticated`, no `auth.uid()` check, stores `p_updated_by` [V]) let any signed-in user who knows a vault and entry id overwrite entries in any team vault, including viewers, removed members and outsiders (for example point an SSH entry at another host). The desktop is the only caller and passes its own user id as `p_updated_by` (`team-sync.ts:386` [V]). A viewer's edit now fails with 42501, as the table policies already intend.
- **teams guard:** `teams_update` has no WITH CHECK (prod [V]), so a team owner could raise `max_seats` directly and dodge the seat trigger. No signed-in client writes `teams` today (only selects in DESK `team-service.ts:128,141` and WEB routes via the service role [V]).
- **team_vault_members_insert:** the live `OR NOT team_vault_has_members(id)` branch let anyone who knows an empty team vault id add any user as admin and then read the plaintext entry names, hosts and user names. Exploitable in the gap between vault creation and the creator's own insert, and for vaults whose members all left. The new bootstrap branch matches the desktop's only use: creator inserts itself as admin right after the `team_vaults` insert (DESK `team-vault-manager.ts:106-131` [V]). Auto-enrolled admins and `addMember` go through the vault-admin branch and are team members [V: `team-vault-manager.ts:151-190,320-370,500-525`].
- Team membership helpers are SECURITY DEFINER and already executable by `authenticated` [V: `20260927020444`].
- **Direct table writes (added in review).** The iOS app upserts `vault_entries` directly and the desktop soft-deletes through a direct update [V: IOS `TeamVaultManager.swift:204,242,265`, DESK `team-sync.ts:339`], so the RPC guard alone left the same hole open over PostgREST. M1 also: `vault_entries_insert` / `_update` check folder rights (USING for the folder the row leaves, WITH CHECK for the new one, through `team_vault_folder_writable(vault, folder)`, which has no uid argument) and `updated_by = auth.uid()`; a `team_vault_members` row can never change `user_id` or `team_vault_id` (trigger, like `team_members`); `vault_password_history` and `vault_folder_permissions` policies use `is_team_vault_member` / `is_team_vault_admin`, so rows left from before the cleanup trigger do not leak. Tests T9b, T12b, T14b.

### 2.8 Team invite accept (desktop, hole 7)

Decision: **the desktop calls the website accept route with a bearer token.** Stripe bookkeeping (quantity, personal-sub cancel) stays in one place. No DB RPC.

- **Web+BE:** `WEB/app/api/team/invite/accept/route.ts` accepts `Authorization: Bearer <supabase access token>`. When the header is present: `const { data: { user } } = await serviceClient.auth.getUser(token)`; otherwise the cookie client as today (`:7-10` [V]). The body stays `{ token }`. Every later step is unchanged except the fixes in 6.3.
- **Desktop:** `acceptInvitation(invitationId)` reads the invitation's `token` (the invitee can select it through `ti_select` [V: `20260927020553`]) and POSTs it (6.4 of this spec, desktop section 4.9).
- The seat trigger backs this path too; a `23514` insert error in the route becomes status 409 with `{ error: 'All seats on this team are in use. Ask your team admin to add a seat.' }` (`team_full`) or `{ error: 'This team no longer has an active plan.' }` (`team_inactive`).

### 2.9 Cloud backup storage (M4, M5)

Today's four `storage.objects` policies check only the folder (prod [V]; mirrored in `scripts/verify/sql/local-parity.sql:65-76` [V]). They are not in any migration. M4 creates all four, so the migrations alone rebuild prod.

Object names the apps write (prod has exactly these shapes [V: prod SELECT]; desktop code [V: `cloud-sync.ts:223,237,538,626,742`, `cloud-backup-name.ts:9-16`]; `{vaultId}` is a lowercase UUIDv4 [V: `vault.ts:1159-1164`]; iOS only downloads [V]):
`{uid}/manifest.json`, `{uid}/vault.enc`, `{uid}/backups/vault_<stamp>.enc`, `{uid}/{vaultId}/vault.enc`, `{uid}/{vaultId}/backups/vault_<stamp>.enc`, where `<stamp>` is `2026-02-17_21-36-10` (old) or `2026-09-26_14-03-07-412_a1b2c3` (current).

```sql
-- M4
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

-- Only the shapes above, in the caller's own folder. Anything else (made-up files, nested backups/) is refused.
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
-- SELECT and DELETE keep today's rule: a downgraded user can still restore and remove old backups.

-- M5 (supabase/pending/ until rollout step 8; replaces the INSERT and UPDATE policies again)
create or replace function public.cloud_backup_slot_free(p_name text) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_cap int; v_vcap int; v_vault text; v_dir text; v_count int;
begin
  if v_uid is null then return false; end if;
  select case when jsonb_typeof(t.features -> 'max_cloud_backups') = 'number'
              then (t.features ->> 'max_cloud_backups')::int end,
         case when jsonb_typeof(t.features -> 'max_cloud_backup_vaults') = 'number'
              then (t.features ->> 'max_cloud_backup_vaults')::int end
    into v_cap, v_vcap
    from public.user_profiles p left join public.tiers t on t.id = p.tier_id where p.id = v_uid;

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
  -- snapshot is free; a move INTO backups/ counts).
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
```

- **Cap units:** snapshots per vault folder (`max_cloud_backups`: Free 3, Pro 25, Team -1 [V: prod `tiers`]) and vault folders per account (NEW `max_cloud_backup_vaults`: Free 0, Pro 10, Team -1; owner to confirm 10, section 10). The legacy `{uid}/backups/*` is its own snapshot folder and is not a vault folder. Prod today: at most 2 vault folders per account and one vault with 29 snapshots [V: prod SELECT].
- The name check closes the side doors a count cap alone leaves open: other names (`{uid}/{vault}/x.bin`, nested `backups/a/b.enc`), and made-up vault folders are now limited by the folder cap. The UPDATE check stops a Storage move into `backups/` past the cap [A: Storage `move` updates the row's `name` under the UPDATE policy; test 7.1 C7].
- Team members may back up (BE already treats them as `cloud_sync_enabled` [V: `verify.ts:101`]).
- The policy names stay the same so `scripts/verify/lib/supabase-parity.mjs:15` keeps finding all four [V]. **Delete the storage policy block in `local-parity.sql:69-76`** (keep the bucket insert at `:66-68`): M4 now creates all four policies, and parity runs after the migrations [V: `supabase-stack.mjs:238-239`], so the old block would put the open policies back locally.
- `postgres` (the owner of SECURITY DEFINER functions) can read `storage.objects` [A: test 7.1 C3].
- Two parallel snapshot uploads can both pass at count 24. Accepted (9).
- **Server-side retention cleanup is out of scope.** `storage.protect_delete` blocks SQL deletes of `storage.objects` [V: fact sheet 5], so it would need an edge function or a backend job using the Storage API. Honest clients already prune by age and, after this change, by count (4.10).
- Existing objects stay. Prod: 9 Free users (47 objects) and 1 Pro user over the snapshot cap (29 snapshots in one vault) [V: fact sheet 0].

### 2.10 Backward compatibility

| Client | Calls lease RPCs? | Effect of M1-M5 |
|---|---|---|
| Desktop 0.17 and older (released) | No [V: fact sheet 6] | M1: its team accept already fails under RLS today, so no regression; a viewer's team-vault edit now fails (intended); a removed member loses team-vault access at once. M4: uploads fail for Free users (intended); the name check accepts every shape a released app wrote (prod holds only those shapes [V]). M3: 0.17 never calls the lease RPCs, so the 11-argument acquire does not affect it. M5: an over-cap Pro user stops getting new snapshots, and 0.17 skips its prune when the snapshot fails (`v0.17.0:electron/services/vault/cloud-sync.ts:704-709` chains snapshot then prune [V]), so M5 waits for 0.18 (8). |
| iOS 1.0.5 / 1.0.6 (released) | No [V] | Only reads `team_members` and downloads backups [V]. None of M1-M5 changes that. |
| Desktop 0.18 / iOS 1.1 (unreleased, this work) | Yes | Must ship the parser changes in 4.2 and 5.2. Today's parsers treat every new denial as malformed, which means "unconfirmed" and the vault OPENS [V: DESK `session-client-parse.ts:208-211`, IOS `SessionClientParse.swift:208-211`]. |

Parser rules for both clients (these are the contract):
- A denial without `reason` is `vault_limit` (older server).
- `vault_limit` and `device_cap` need a non-empty `holders` list; `not_owner` and `update_required` allow an empty one.
- `update_required` needs `min_version` (string, 1-40 chars). `device_cap` needs `device_cap` (integer >= 1).
- An unknown `reason`, `ownership` or displaced reason is malformed, which is "unconfirmed" (the existing rule "a server problem is never a denial"). The minimum version (2.2) is the lever for future reasons.
- `ownership`, `grace_until`, `release_after`, `shared_until` and `device_cap` are optional on grants and heartbeat `ok`; absent means unknown (no tag write, no banner). `ownership: "unowned"` is valid on both (a grant with `p_claim = false`).
- `also_locks` (on `vault_limit`) is optional: null or `{device_id, device_name}`. `released` (on `not_owner`, both acquire and heartbeat) is an optional boolean, absent means false.
- Clients send `p_claim` on every acquire: `true` from a user-started open or take-over, `false` from background re-acquires (4.3, 5.3).

---

## 3. In-file owner tag (owners: Desktop and iOS, same release)

### 3.1 Register

| Item | Value |
|---|---|
| Key | `_sync/owner/account` (tbl 9, row `owner`, reg `account`) |
| Kind, class | `json`, `auto` (provisional = highest rank, like `_sync/owner/owner`) |
| Value | JCS of `{"a": "<account_hint>"}` or `{"a": null}` (released) |
| `account_hint` | `hex(trunc16(SHA-256("conduit-acct-v1" ‖ lineage_id ‖ user_id)))`, 32 lowercase hex chars [V: DESK `hashing.ts:301-304`, IOS `HashingIds.swift:65-68`]. Both platforms hash the lowercase user id. Never the email. |
| Label | "Vault owner" |
| Bookkeeping | Yes, automatically: `digest.ts:215-217` treats every register of the `_sync/owner` row as bookkeeping [V], so "nothing new" copy checks ignore it. |

It is a **new register**, not the `a` field of the Free owner claim. The Free claim is rewritten by every take-over and is written only when the effective limit is 1 [V: `open-start.ts:159`, `session-runtime-claims.ts:87-101`]; the owner tag must be written on every plan and only by the owner. Both catalogs change in the same release; no `sync_format` bump is needed because desktop 0.18 and iOS 1.1 are both unreleased and `_sync` registers are not content columns [V: MULTI_DEVICE_SYNC.md:337].

### 3.2 Who writes it and when

- **Only a confirmed owner writes `{"a": own_hint}`**: a device whose last acquire or heartbeat (confirmed, section 6.8 of the sync spec) said `ownership: "owner"`, for a shared vault (one with W). It writes only when the provisional tag differs from its own hint. Write points:
  - desktop `open-start.ts` `writePresenceAndClaim` (`:143-161` [V]), in the same `applyWrites` batch as presence;
  - desktop `session-runtime-claims.ts` (heartbeat `ok` with `ownership: "owner"`);
  - iOS `SES/VaultOpenStart.swift:117,127` and `SES/SessionRuntimeClaims.swift:82-85` (same places as the Free claim writers [V: scout]).
- **`{"a": null}`** is written by the device that got `{"released": true}` from `vault_owner_release`, right after the answer, and only then (never on `too_soon`, `not_owner` or an unconfirmed call).
- Never written by: a non-owner (grace), a signed-out device, an unconfirmed lease, a private vault (no W, no engine).
- Forks (`forkAsSeparateVault`) drop every `sync_*` table [V: `file-binding-fork.ts:146-150`], so a copy starts without a tag and is unowned until its first online lease. That is right for "Make my own copy".

### 3.3 Per-device cache of a confirmed check

New optional key in `local.json` (per lineage per machine), added to `LOCAL_JSON_OPTIONAL_KEYS` (`local-state-validate.ts:249` [V]) and the iOS codec (ignores unknown keys [V: scout]):

```jsonc
"ownerCheck": { "hint": "<32 hex>", "kind": "owner" | "grace", "untilMs": 1760000000000 | null, "atMs": 1759000000000 } | null
```

- Written on each confirmed grant or heartbeat `ok` when it changes (pattern of `recordLastLimit`, `session-runtime-parts.ts:93-100` [V]). `hint` is this device's own hint for the signed-in account. `untilMs` is `grace_until` for `grace`, null for `owner`.
- Cleared (set to null) on a confirmed `not_owner` answer and on a confirmed successful release (`released: true`). **Never cleared on sign-out**: a signed-out owner device relies on it (3.4). When a different account signs in, its hint no longer matches, so the old record is ignored; no extra step.
- A value with `atMs` more than 5 minutes in the future is ignored (same sanity rule as the tier cache, sync spec 6.8).
- Private vaults have no `local.json` and get no cache and no tag. They are protected by the server only (9).

### 3.4 How unlock evaluates the tag

A pure function on both platforms, `evaluateOwnerTag(input) -> 'allow' | 'sign-in' | 'not-owner-offline'`:

| Input state | Tag absent or `a` null | `a` = own hint | `a` = other |
|---|---|---|---|
| Signed in, server answered (peek ok) | tag not used; the server decides at acquire | same | same |
| Signed in, peek unconfirmed (offline, blocked, server error) | allow | allow | allow if `ownerCheck.hint` = own hint and either (`kind = 'owner'` and `atMs` > the tag sibling's HLC ms) or (`kind = 'grace'` and `untilMs > now`); else **not-owner-offline** (S5) |
| Signed out | allow | n/a | allow if `ownerCheck.kind = 'owner'` and (`ownerCheck.hint` = tag `a`, or `atMs` > the tag sibling's HLC ms); else **sign-in** (S6) |

- It runs in the early check before password work: desktop `open-gate.ts` `earlyInUseCheck`, in the non-`ok` branch before `checkClaimsAtUnlock` (`:58-59` [V]); iOS `SES/VaultAccessCoordinator.swift:116-131`. It reads the same state as the Free claims (peeked S, else W) [V: `open-personal-vault.ts:137,143-145`].
- It runs only for shared vaults (claim state not null). Sync-off opens and private vaults go through `openPrivateVault` with `claimState: null` [V: `open-private.ts:50`, `app-sync-open.ts:15-24`], so only the server protects them.
- Order: owner tag first, then Free claims (a non-owner must not take over).
- "Nobody is locked out of their own vault offline": the owner's devices compute a matching hint; a signed-out device of the owner matches through its `ownerCheck`. A stale tag (this copy of the file has not yet received the new owner's tag write, or still carries the tag from before a hand-over back to this account) does not lock out a device whose cached owner record is newer than the tag: `readOwnerTag` returns the provisional sibling's HLC ms with the value (like `readOwnerClaim`, `claims.ts:47-54` [V]).
- The tag is a backup signal. A modified app can ignore it (9).

### 3.5 Vectors

- `DESK/electron/services/sync/__tests__/golden-inputs.ts` (owner JSON case at `:94` [V]): add canonical cases for `{"a":"<hex>"}` and `{"a":null}` on `_sync/owner/account`; regenerate `__vectors__/canon.json` with `SYNC_UPDATE_VECTORS=1` [V: `golden-inputs.ts:3-5`].
- New `__vectors__/owner-tag.json`: the decision table of 3.4 as rows `{signedIn, peekConfirmed, userId, lineageId, tag, tagMs, ownerCheck, nowMs, expect}`, at least 18 rows (every cell, plus future-dated `atMs`, expired grace, mixed-case user id, and 'stale tag, newer owner cache' / 'newer tag, older owner cache' for both the signed-in and signed-out rows). Desktop runs it from a new `owner-tag.test.ts`; iOS copies it with `IOS/scripts/sync-vectors.sh:12-31` [V: scout] and runs it from a new `OwnerTagTests.swift`.
- `catalog.test.ts` (`:102` [V]) and iOS `CatalogTests.swift:85`: `_sync/owner/account` is known; `_sync/owner/other` is still unknown.
- `hashing.json` needs no change (account_hint vectors exist [V: `hashing.json:1358-1375`]).

---

## 4. Desktop changes (owner: Desktop builder)

Paths are under `DESK/`. Line anchors are from the scouts' reads [V] unless marked.

### 4.1 Sync catalog and tag

| File | Change |
|---|---|
| `electron/services/sync/catalog-defs.ts` | `ACCOUNT_REG = 'account'`; `ACCOUNT_DEF = def(TBL.sync, ACCOUNT_REG, 'json', 'auto', { columns: [], label: 'Vault owner' })`; `syncRegisterDef` owner branch returns `OWNER_DEF` or `ACCOUNT_DEF` (`:186-194`); `ownerTagRegKey()` next to `ownerRegKey` (`:227`) |
| `electron/services/sync/capture-local-explicit.ts` | `ownerTagWrite(value: OwnerTagValue, ctx)` next to `ownerClaimWrite` (`:86-89`), `replace-all` |
| `electron/services/sync/types*.ts` | `OwnerTagValue = { readonly a: string | null }`; `LocalJson.ownerCheck` (3.3) in `types-ui.ts:255-290`, default null in `local-state.ts:24-47`, validator and optional key in `local-state-validate.ts:249-279` |
| NEW `electron/services/vault-session/owner-tag.ts` | `readOwnerTag(state) -> { a: string | null; ms: number } | null` (parse like `claims.ts:32-54`, returning the provisional sibling's `ms`; a value other than null or 32 lowercase hex is ignored), `evaluateOwnerTag(input)` (3.4), `ownerTagWritesFor(ownership, hint, state, rctx)` |
| `docs/MULTI_DEVICE_SYNC.md` 3.5 table | Builders add the `_sync/owner/account` row when implementing (this spec only adds a pointer now) |

### 4.2 Session client and parsers

| File | Change |
|---|---|
| `vault-session/session-client.ts:98-119` | Types below |
| `vault-session/session-client-parse.ts:185-241` | Rules of 2.10. `DISPLACED_REASONS` (`:20`) adds `device_cap`, `not_owner`, `update_required`. Parse `reason` before the `limit` / holders checks of a denial (`:198-211`). Parse the NEW grant and heartbeat fields. Peek parses `reason`, `devices`, `min_version`, `device_cap`. |
| `vault-session/host.ts:128` | `DisplacementReason` adds `'device_cap' | 'not_owner' | 'update_required'`; `LockedReason` (`:109`) becomes `'open_elsewhere' | 'not_owner' | 'update_required'` (device_cap soft-locks as `open_elsewhere`) |
| `vault-session/realtime.ts:19,47` | Accept the three new reasons |
| `vault-session/session-client.ts` `peek` | Sends `p_platform` and `p_app_version` from `host.device.current()` |
| `vault-session/session-client.ts` `acquire` | `AcquireArgs` gains `claim: boolean`, sent as `p_claim` (2.5.1) |

```ts
export type Ownership =
  | { readonly kind: 'owner'; readonly releaseAfterMs: number | null; readonly sharedUntilMs: number | null }
  | { readonly kind: 'grace'; readonly untilMs: number }
  | { readonly kind: 'unowned' };

export type AcquireResult =
  | { kind: 'granted'; leaseId; limit; deviceCap: number | null; ownership: Ownership | null; sessions; serverNowMs }
  | { kind: 'denied'; cause: 'vault_limit' | 'device_cap'; limit; deviceCap: number | null; holders;
      alsoLocks: { deviceId: string; deviceName: string | null } | null; sessions; serverNowMs }
  | { kind: 'not-owner'; graceEndedMs: number | null; released: boolean; serverNowMs }
  | { kind: 'update-required'; minVersion: string; serverNowMs }
  | Unconfirmed;

export type HeartbeatResult =
  | { kind: 'ok'; limit; deviceCap: number | null; ownership: Ownership | null; sessions; serverNowMs }
  | { kind: 'displaced'; reason: 'takeover' | 'plan_limit' | 'device_cap' | 'not_owner' | 'update_required'; byDeviceName: string | null;
      minVersion: string | null; released: boolean }
  | { kind: 'lost'; reason: ... }                        // unchanged
  | Unconfirmed;

export type PeekResult =
  | { kind: 'ok'; limit; deviceCap: number | null; holders;
      refusal: null | { kind: 'update-required'; minVersion: string } | { kind: 'device-cap'; deviceCap: number; devices: readonly Holder[] } }
  | Unconfirmed;
```

`Holder` gains optional `vaults: number | null`.

### 4.3 Open gate and errors

| File | Change |
|---|---|
| `vault-session/open-errors.ts:11-50` | `VAULT_OPEN_ELSEWHERE` gains `cause: 'vault_limit' | 'device_cap'`, `deviceCap: number | null`, `displaceDeviceName: string | null`, `alsoLockDeviceName: string | null` (S1b). New codes: `VAULT_NOT_OWNER { fileName, offline: boolean, graceEndedMs: number | null, released: boolean, copyTicket: string | null, copyDir: string | null }` (`copyDir`: the original's folder, the Save dialog's default), `VAULT_SIGN_IN_REQUIRED { fileName }`, `VAULT_UPDATE_REQUIRED { fileName, minVersion }`. Mirror in `electron/services/sync/app-sync-dto.ts:215-250` and `src/types/sync.ts:214-250`, and add to `OPEN_ERROR_CODES` (`src/types/sync.ts:553-558`); `app-sync-dto-mirror.test.ts` enforces the mirror [V]. |
| `vault-session/open-gate.ts:47-60` `earlyInUseCheck` | Peek `ok` with `refusal` update-required throws `VAULT_UPDATE_REQUIRED`; device-cap throws `VAULT_OPEN_ELSEWHERE {cause:'device_cap', holders: devices, displaceDeviceName: devices[0].deviceName}`. Non-`ok` branch: `evaluateOwnerTag` first (`sign-in` throws `VAULT_SIGN_IN_REQUIRED`; `not-owner-offline` throws `VAULT_NOT_OWNER {offline: true, copyTicket: null}`), then claims as today. Skipped on take-over as today (`:48`). |
| `vault-session/open-gate.ts:90-119` `acquireLease` | New parameters `copyKey: Buffer` and `claim: boolean` (sent as `p_claim`; `true` from every open, including the take-over re-open, since the user started it). `denied` throws `VAULT_OPEN_ELSEWHERE` with `cause` and `alsoLockDeviceName`. `not-owner` registers a copy ticket (4.5) with `{source: peek.hasW ? {kind: 'working', lineageId} : {kind: 'shared', path: ctx.sharedPath}, key: copyKey, expiresAtMs: now + 10 min}` and throws `VAULT_NOT_OWNER {offline: false, released, copyTicket, copyDir: dirname(ctx.sharedPath)}`. `update-required` throws `VAULT_UPDATE_REQUIRED`. The open rolls back as today (`open-shared.ts:77-80`). |
| callers | `open-shared.ts:51` passes `unlock.key`; `open-private.ts:54,75` pass `ctx.kdf(password, meta.salt)` [A: the key `forkAsSeparateVault` expects for a private file; test 7.2 D9]; `createShared` `:92` passes its new `key` (a new vault is always granted). |
| `vault-session/open-start.ts:143-161` | Append `ownerTagWritesFor(...)` to the writes when the grant says owner. Record `ownerCheck`. |
| `vault-session/session-runtime-parts.ts:93-100` | `recordOwnerCheck(replica, host, ownership, hint)` next to `recordLastLimit` |
| `vault-session/session-runtime-claims.ts:87-101` | On heartbeat `ok` with `ownership.kind === 'owner'`, write the tag when it differs. Push ownership to the state (4.7). |
| `vault-session/heartbeat.ts:227-254` | Re-acquire (after `lost`, and the offline retry) sends `claim: false` (2.3). `not-owner` and `update-required` go to displacement with that reason (not `reportConflict`); `denied` with `cause: 'device_cap'` goes to `reportConflict` with the cause (S3). |
| sign-in acquire (`session-runtime.ts`, the acquire run when the user signs in with a vault open) | Sends `claim: false` [A: the builder finds this call next to `answerConflict`; every acquire that is not `acquireLease` from an open passes false]. |
| `vault-session/session-runtime.ts:159-181` `answerConflict` | Handle the new kinds the same way. [Use here instead] is a user choice, so its take-over acquire sends `claim: true`. |
| `vault-session/lease.ts:84-92` | New acquire kinds leave an existing lease alone, like `denied` |
| `electron/ipc-server/vault-guard.ts:7-15` | New reasons `not_owner`, `update_required` with S19 and S20; `isOpenElsewhere` stays for `open_elsewhere` |

### 4.4 Displacement and soft lock

- `electron/services/sync/app-sync-dto.ts:167` and `src/types/sync.ts:166` mirror the new `DisplacementReason`s. `DisplacedEvent` gains `minVersion: string | null` and `released: boolean` (S8b).
- The soft lock for `not_owner` and `update_required` uses the matching `LockedReason`; the vault store (`src/stores/vaultStore.ts:81,314`) and `SyncBanners.tsx:90` show S21 or S22 instead of the "open on another device" banner.

### 4.5 "Make my own copy"

- NEW `electron/services/vault-session/own-copy-tickets.ts`: an in-memory map `ticket (random uuid) -> { source: {kind: 'working', lineageId} | {kind: 'shared', path}, key: Buffer, lineageId, expiresAtMs }`. One live ticket per source path (a new one replaces and zeroes the old). Zero and drop when the copy is made, on expiry (a timer set for the earliest expiry), app lock, sign-out and quit; a failed copy keeps the ticket so the user can try again. The ticket holds the accepted key and, when the unlock had one, W's previous-epoch key; a `working` source also names S. When no ticket key opens W (W is one key epoch behind S because the password changed on another device) or W cannot be read, S is forked with the key that opens it (same as iOS). Never written to disk or sent to the renderer (only the ticket id is).
- NEW IPC `sync_make_own_copy { ticket: string, targetPath: string }` in `electron/ipc/sync.ts:109-137` (`requireVaultTarget` for the path, like `sync_make_separate_vault`). Source: **this device's working copy W when it exists** (`peek.hasW` [V: `open-peek.ts:33,90`]). W holds every change made on this device, including edits whose final save to S failed at displacement (`displacement.ts:131-136` [V]) and edits made while unconfirmed; the acquire runs before W is opened (`open-shared.ts:47-51` [V]), so W is closed and intact. Snapshot it with `vacuumInto` (`sync/shared-file.ts`, as `app-sync-flows.ts:25-27` [V]) into `<syncRoot>/tmp`, then fork that snapshot. Only without W, fork S. Then `forkAsSeparateVault({ sourcePath, key, targetPath, workDir: <syncRoot>/tmp }, host)` [V: `file-binding-fork.ts:153-175` copies the source first and never changes it]. An unreadable source (offline network share) fails with "Could not read the vault file. Check the folder and try again." Unknown or expired ticket: error "Unlock the vault again to make your copy."
- The Save dialog opens in `copyDir` (the original's folder), so the copy lands next to the original and syncs to the user's other devices like the original did. `syncApi.pickVaultFile("save", { defaultDir })` gains the option.
- `src/lib/sync-api.ts`: `makeOwnCopy(ticket, targetPath)`.
- During grace the vault is open, so [Make my own copy] in the banner uses the existing `sync_make_separate_vault` (forks W [V: `sync-engine-actions.ts:128-144`]).
- After either: `offerOpenNewVault(path, "Your copy is ready.")` (`src/components/sync/prompt-actions.ts:29` [V]). The copy is a new lineage, so its first online lease makes this account the owner.

### 4.6 Renderer dialogs

All dialogs use `SyncDialogFrame` and `DialogButton` (`src/components/sync/SyncDialogFrame.tsx:25-79` [V]; its `harnessLabel` is the title, which `/verify` reads) and the `src/components/ui` primitives. Status messages use `toast` (`src/components/common/Toast.tsx`), never `window.alert`.

| File | Change |
|---|---|
| `src/components/sync/TakeoverDialog.tsx:35-68` | `payload.cause === 'device_cap'`: title and text S1, one `HolderLine` per device with "{device}: {vaults} vaults open, active {time}", no [Upgrade to Pro]. `alsoLockDeviceName` set: add the S1b line. Otherwise unchanged. |
| NEW `src/components/sync/NotOwnerDialog.tsx` | S4 (online, `copyTicket` set): shows the signed-in email; [Switch account] signs out and opens the sign-in flow [A: same entry as S6]; [Try Team free] opens the trial link (4.8); [Open a vault...] runs the existing open-vault picker; [Make my own copy] asks `syncApi.pickVaultFile("save", { defaultDir: copyDir })`, then `makeOwnCopy`, then S15. `released: true` uses the S8b body. S5 when `offline`. |
| NEW `src/components/sync/SignInRequiredDialog.tsx` | S6; [Sign in] opens the existing sign-in flow [A: the entry the account menu uses]. |
| NEW `src/components/sync/UpdateRequiredDialog.tsx` | S9; [Update Conduit] calls `force_check_for_updates` (`electron/ipc/updater.ts:99-137` [V]); if no update is found, `auth_open_download` (`electron/ipc/auth.ts:83` [V]). |
| `src/components/vault/UnlockErrorView.tsx:35-71` | Route the three new codes to these dialogs. The typed password is kept as today (`:34`). |
| `src/components/sync/DisplacedDialog.tsx:15-31` | `displacedCopy` gains `device_cap` (S2; "on another device" when `by` is null), `not_owner` (S8, or S8b when `released`), `update_required` (S10) and a `useHere: boolean` field; [Use here instead] only when `useHere` (false for not_owner and update_required). TS exhaustiveness forces the cases [V]. |
| `src/components/sync/SyncBanners.tsx:20-31,90` | Soft-lock banner per `LockedReason` (S21, S22). NEW `GraceBanner` (S7, tone `warn`, with the signed-in email and [Switch account]) when `state.ownership?.kind === 'grace'`. NEW `SharedBanner` (S7b, tone `info`) when `state.ownership?.kind === 'owner'` and `sharedUntilMs > now`; [Release this vault...] opens S12 (disabled with S13 text before `releaseAfterMs`). Dismissible per vault per day [A: a local UI flag]. |
| `src/stores/vault-unlock-errors.ts:41-59` | Classify the new codes; no retry loops. |
| `src/components/sync/sync-copy.ts` | `deviceCapText(n)`, owner line S11, date helper |

### 4.7 Sync settings and state

- `SyncStateResponse` (`src/types/sync.ts:285-301` / `app-sync-dto.ts:287`, mirrored) gains `ownership: { kind: 'owner'; releaseAfterMs: number | null; sharedUntilMs: number | null } | { kind: 'grace'; untilMs: number } | { kind: 'unowned' } | { kind: 'unknown' } | null` and `deviceCap: number | null`. Built in `app-sync-manager.ts:299+` from the runtime's last confirmed answer; `unknown` when signed out or unconfirmed; null with no personal vault open. The renderer shows "Owner: sign in to check." for `unknown` only when signed out; signed in and unconfirmed, it shows no owner line (same as iOS).
- `src/components/settings/tabs/SyncTab.tsx:71-106`: in "This vault", the owner line S11. For the owner (signed in): [Release this vault...] opens S12; confirm calls NEW IPC `sync_release_ownership` which runs `vault_owner_release` and returns `{released: true} | {released: false, reason: 'too_soon', retryAfterMs} | {released: false, reason: 'not_owner'} | {released: false, reason: 'unconfirmed'}` (`unconfirmed`: transport error, timeout, malformed answer). Only after `released: true` does it write `{"a": null}` (3.2) and clear `ownerCheck`. The button is disabled with "You can release this vault on {date}." when `releaseAfterMs > now`. Toasts S13 (`too_soon`), S14 (released), S23 (`unconfirmed`); `not_owner` refreshes the owner line.
- The plan line (`:88-91`) adds "Up to {n} devices at once across your vaults." when `deviceCap` is not -1.
- `electron/services/vault-session/host.ts:14-19` `SessionRpcName` adds `vault_owner_release`; the fake server (`__tests__/fake-session-server.ts:124-140`) dispatches it.
- `src/stores/tierStore.ts:10-17` and `electron/ipc/tier-capabilities.ts:9-20,53-67`: read `account_max_active_devices` for display only.

### 4.8 Links

- NEW IPC `auth_open_team_trial` in `electron/ipc/auth.ts` (next to `auth_open_pricing`, `:78-81` [V]): opens `${websiteUrl}/account/team/setup?plan=monthly&trial=true`, the same link the pricing page's "Try Team Free for 30 Days" uses [V: `WEB/app/pricing/PricingClient.tsx:203`].

### 4.9 Team invite accept

- `electron/services/team/team-service.ts:224-277` `acceptInvitation(invitationId)`: select `token, status, email` of the invitation (RLS `ti_select` [V]); keep the pending and email checks; POST `${getEnvConfig().websiteUrl}/api/team/invite/accept` with `Authorization: Bearer <current access token>`, `Content-Type: application/json`, body `{ token }`, 15 s timeout. Non-2xx: throw `new Error(json.error ?? 'Could not join the team.')`. Remove the direct `team_members` insert, the invitation update and the `primary_team_id` update (the route does all three).
- After success, refresh the profile and tier (the route changes `tier_id`) through the existing auth refresh [A: the call the tier refresh uses today].
- `src/stores/teamStore.ts:216-233`: on error show `toast.error("Could not join the team", err.message)` (S18) instead of only setting `error`.
- `electron/ipc/team.ts:35-54` keeps `logAudit('invitation_accepted')` after success.
- Unit test with a mocked `fetch` (7.2 D12). There are no tests for `team-service.ts` today [V].

### 4.10 Cloud backup

- `electron/services/vault/cloud-sync.ts`:
  - Read `max_cloud_backups` from the tier (like `getBackupRetentionDays`, `:469-489`).
  - Before `uploadVersionedSnapshot` (`:624-640`), prune the vault's `backups/` folder by count so at most `cap - 1` remain (newest kept), through `storage.remove()` like `pruneOldBackups` (`:645-669`). Run the age prune even when the snapshot upload fails (0.17's chain skipped it).
  - Map refusals: an RLS refusal (HTTP 403, "row-level security") on `vault.enc` or `manifest.json` calls `planStillAllowsBackup`; if the plan says no, `stopForPlan` with S16; if it still says yes, status error S16 as well (the server is the truth; the tier cache may be stale). A refused snapshot sets the status line S17 and logs a warning; `vault.enc` stays uploaded. A refused `vault.enc` for a vault folder that does not exist yet while the plan allows backup means the vault-folder cap (`max_cloud_backup_vaults`, read like `max_cloud_backups`): status line S24.
- `electron/services/vault/backup-tier.ts:9-26`: also allow when `profile.is_team_member` is true (matches the server rule).

### 4.11 Docs

- `docs/FEATURES.md`: entries for vault ownership, the device cap, "Make my own copy", "Release this vault" and the update-required notice (repo convention).
- `docs/SUPABASE.md:74-99`: add `account_max_active_devices` to the tier table and an `app_config` section.
- `docs/MULTI_DEVICE_SYNC.md`: 3.5 table row, 6.13 known limit rewritten to point here (the pointer is added now; the row when built).

---

## 5. iOS changes (owner: iOS builder)

Paths are under `IOS/`, `PKG/`, `SES/`, `SYN/`. Anchors are from the iOS scout [V].

### 5.1 Catalog and tag

| File | Change |
|---|---|
| `SYN/Core/CatalogDefs.swift:22-31,131,167-174` | `account` register in the `owner` row, json, auto, label "Vault owner" |
| `SYN/Core/CatalogValues.swift:18` | `ownerTagRegKey` |
| `SYN/Core/CaptureLocalExplicit.swift:45-46` | `ownerTagWrite(_:)` (JCS, replaceAll) |
| `SYN/Core/TypesLocal.swift:137-162,233` | `OwnerTagValue`; `LocalJson.ownerCheck` (3.3); codec `SYN/Engine/LocalStateCodec.swift:21` |
| NEW `SES/OwnerTag.swift` | `readOwnerTag`, `evaluateOwnerTag` (3.4), `ownerTagWrites` |

### 5.2 Session client

| File | Change |
|---|---|
| `SES/SessionClientParse.swift:185-241` | Rules of 2.10; parse `reason` before the holders check (`:208-211`) |
| `SES/SessionClientTypes.swift:125-179` | `AcquireArgs` gains `claim: Bool` (sent as `p_claim`); `AcquireGrant` gains `deviceCap`, `ownership` (with `sharedUntilMs`); `AcquireDenial` gains `cause` (`.vaultLimit`, `.deviceCap`), `deviceCap` and `alsoLocks`; `AcquireResult` gains `.notOwner(graceEndedMs:released:)` and `.updateRequired(minVersion:)`; `ServerDisplacedReason` gains `deviceCap`, `notOwner`, `updateRequired`; `PeekResult.ok` gains `deviceCap` and `refusal` |
| `SES/SessionTypes.swift:37-45` | `DisplacementReason` adds `.deviceCap`, `.notOwner`, `.updateRequired` |
| `SES/SessionRealtime.swift:31-33` | Accept the new reasons |
| `SES/SessionHost.swift:35-41` | RPC name `vault_owner_release`; peek sends `p_platform` ("ios" or "ipados") and `p_app_version` (`VaultSessionHost.swift:47-48`) |
| `ConduitiOS/Core/Networking/VaultSessionService.swift:9-58` | Transport for the new RPC |

### 5.3 Open flow

| File | Change |
|---|---|
| `SES/VaultOpenErrors.swift:20-54` | Cases `notOwner(offline:graceEndedMs:copyTicket:)`, `signInRequired`, `updateRequired(minVersion:)`; `openElsewhere` gains `cause` and `displaceDeviceName` |
| `SES/VaultAccessCoordinator.swift:116-131` | Peek refusals (update required, device cap) before the password; owner tag (3.4) in the unconfirmed and signed-out branch, before claims (`:134-149`) |
| `SES/VaultAccessCoordinator.swift:154-175` | Acquire with `claim: true` (user-started unlock). Branch on the new acquire kinds; not-owner keeps the verified key in an in-memory ticket (10 min, zeroed on use, lock, background, sign-out) |
| `SES/HeartbeatLoop.swift:242-279` | Re-acquire with `claim: false`: not-owner and update-required displace with that reason; device cap goes to the conflict sheet with S3 |
| `SES/LeaseTracker.swift:92-105` | New heartbeat outcomes |
| `SES/SessionRuntimeLifecycle.swift:40-70` | Foreground re-acquire sends `claim: false` (it runs on every foreground [V: `:35-50`], so it must never undo a release). A `.deviceCap` denial opens the 6.8 conflict sheet with S3 ([Lock here] [Use here instead], naming `holders[0]` as the device that would lock), not the S2 soft lock: `holders[0]` is the device a take-over would lock, not one the user just opened [V: `:64-66` passes `holders.first` today]. `.vaultLimit` keeps today's S2-style soft lock. Not-owner and update-required displace with their own reasons |
| `SES/SessionRuntimeLifecycle.swift:100-173` | Sign-in acquire sends `claim: false` [V: `:96-110`]; `answerConflict` [Use here instead] sends `claim: true`; both branch on the new kinds |
| `SES/SessionRuntime.swift:250-264` | Record `ownerCheck` next to `lastLimit`; write the owner tag when confirmed owner (3.2) |
| `SES/VaultOpenStart.swift:117,127`, `SES/SessionRuntimeClaims.swift:82-85` | Tag write points |

### 5.4 Make my own copy

- New `VaultManager.makeOwnCopy(ticket:)`: `forkAsSeparateVault` (`SYN/Engine/Fork.swift:100-121` [V]) from this device's working copy when one exists (same reason as desktop 4.5: it holds edits that never reached the shared file), else from the peek copy of the source file, with the ticket's key, named "{name} (my copy).conduit" (add " 2", " 3" when taken).
- **Where the copy goes:** a `fileExporter` / folder picker opens so the user can save it next to the original (iCloud Drive, Dropbox and similar), where it syncs to their other devices like the original. Documents is the fallback only when the user cancels the picker and confirms "Keep it on this iPhone only". [A: iOS cannot write next to the original without folder access, since the security scope covers the picked file only; the picker gives that access.] A Documents copy is a private vault (no working copy or engine [V: `ConduitiOS/Core/Sync/OpenStepsPrivate.swift:7-9`]) and does not sync.
- During grace (vault open), use `SyncEngine.makeSeparateVault` (`SYN/Engine/SyncEngine.swift:133-135`) with the same picker.

### 5.5 UI

| File | Change |
|---|---|
| `ConduitiOS/Features/Vault/VaultUnlockProblem.swift:12-44`, `VaultUnlockView.swift:236-298` | Problem sheets for S4 (without [Try Team free]; with the signed-in email, [Switch Account] and [Open a Vault...]; S8b body when `released`), S5, S6, S9 |
| `ConduitiOS/Features/Vault/Sync/TakeoverSheet.swift:6-61` | Device-cap variant S1 (plan line at `:44-48` replaced); S1b line when `alsoLocks` is set |
| `ConduitiOS/Features/Vault/Sync/DisplacedView.swift:25-33`, `SES/DisplacementText.swift:36-63` | S2, S8, S8b, S10; "Use Here Instead" hidden for not-owner and update-required |
| `ConduitiOS/Features/Vault/Sync/VaultSyncSheets.swift:109-163` | Grace banner S7 with [Make my own copy] and [Switch Account] only; owner banner S7b with [Release This Vault...] only |
| `ConduitiOS/Features/Vault/Sync/VaultSyncSheets.swift:57-89` (`VaultSyncMenuItems`) | Owner line S11 and "Release This Vault" (S12-S14, S23; same four outcomes and write order as desktop 4.7) |
| `ConduitiOS/Core/Networking/TierGating.swift:51-65` | `accountMaxActiveDevices` reader and sentence |
| `ConduitiOS/Core/Vault/VaultManager.swift:10-35` | Error mapping |
| Update button (S9, S10) | Opens the App Store page of Conduit [A: the app has no update link today; use its App Store URL] |

### 5.6 Links on iOS

iOS shows **no** [Try Team free] button and no pricing link: the app has none today [V: scout], and App Store rules on links to outside purchases vary by region [A]. S4 and S7 say "ask the owner to share it with you in a Team vault" instead. "Share it with Team" is not possible on iOS (it cannot create team vaults [V]).

---

## 6. Website and backend (owner: Web+BE builder)

### 6.1 Tier display

| File | Change |
|---|---|
| `WEB/lib/tiers/fallback.ts:12-72` | `account_max_active_devices: 5` in free, pro and team features (the public site always renders the fallback because anon cannot read `tiers` [V: fact sheet 8]) |
| `WEB/lib/tiers/resolve.ts` | Helper `activeDeviceCap(features)` (`-1` means "Unlimited"); comparison row "Devices at once" after "Devices per vault at once" (`:163`); `STATIC_COPY.pro.description` (`:22-26`): "Use your vault on up to 5 devices at once, with merge, conflict review, and encrypted cloud backup." |
| `WEB/app/pricing/page.tsx:93` | FAQ: "open it on all your devices at once" becomes "open it on up to 5 devices at once" |
| `WEB/app/docs/tiers/page.tsx:88-100,182-196` | "Devices and Sync": the 5-device cap per account; "Each personal vault belongs to one Conduit account. Someone else can use it for 14 days. After that they need their own copy or a seat on your team." |

### 6.2 Backend

- `BE/src/lib/types.ts:56-76`: `account_max_active_devices?: number`.
- `BE/src/lib/auth/verify.ts`: `DEFAULT_TIER_FEATURES` gets `account_max_active_devices: 5`; the team override (`:82-104`) gets `account_max_active_devices: 5`. Display only; the desktop calls only `/api/fingerprint` [V].

### 6.3 Team routes

| File | Change |
|---|---|
| `WEB/app/api/team/invite/accept/route.ts` | (a) Bearer auth (2.8). (b) Read the personal subscription **before** step 3 clears it: today step 5 reads `stripe_subscription_id` after step 3 set it to null (`:110-120` then `:139-146` [V]), so the personal subscription is never cancelled. (c) Quantity: set it to `max(item.quantity, members after insert)` instead of `+1` (`:158-168`). (d) Map a `23514` insert error to 409 (2.8). (e) Before the insert, refuse with 409 "This team no longer has an active plan." unless `team.stripe_subscription_id` is set and the Stripe status is `active`, `trialing` or `past_due`; a Stripe error is 503 "Could not check the team's plan. Try again." (today the trial check sits inside `if (team.stripe_subscription_id)` and a Stripe error is ignored, `:68-87` [V]). |
| `WEB/app/api/stripe/webhooks/route.ts` `handleTeamDissolution` (`:393-434`) | Also `update team_invitations set status = 'expired' where team_id = teamId and status = 'pending'` [V: today it never touches invitations]. |
| `WEB/app/api/team/add-self/route.ts` | Pick the caller's team with a live subscription (`.eq('owner_id', user.id).not('stripe_subscription_id', 'is', null)`, `maybeSingle`); none: 403 "Your team plan has ended." Closes the free re-join of a dissolved team (`:17-26,54-69` [V]). |
| `WEB/app/api/team/invite/route.ts:84-88` | The "already on another team" check queries `user_profiles.email`, which does not exist [V: fact sheet 2], so it always passes. Look the user up with `serviceClient.auth.admin.listUsers` filtered by email, or drop the check (accept re-checks membership at `:53-61`). |

Quantity fix (c) reasoning: the invite route already reserves a seat within `max_seats` (`invite/route.ts:107-108` [V]), so accept's `+1` bills 9 seats for 5 people when someone buys 5 and invites 4. With (c) the quantity grows only when members exceed the paid seats. **The owner must confirm this billing change before it ships** (10).

### 6.4 Coordination

- The bearer path of the accept route must be deployed before desktop 0.18 ships.
- No website code calls the lease RPCs.

---

## 7. Test plan

### 7.1 SQL tests against local Supabase (owner: DB builder)

New `DESK/supabase/tests/plan_enforcement.sql`, run by NEW `DESK/scripts/verify/run-sql-tests.mjs` (reuses `ensureLocalSupabase` from `lib/supabase-stack.mjs:229` [V], applies `supabase/pending/*.sql` after the migrations, then `psql -v ON_ERROR_STOP=1 -f`), exposed as `npm run test:sql`. The same runner also runs the HTTP cases (H1-H2) against the local PostgREST at `http://127.0.0.1:54321/rest/v1/rpc/...` with a test user's JWT, because `psql` cannot test PostgREST function resolution. Each case runs in `begin; ... rollback;`, creates users in `auth.users`, and acts as a user with `set local role authenticated; select set_config('request.jwt.claims', '{"sub":"<uuid>","role":"authenticated","email":"<email>"}', true);` [A: `auth.uid()` reads `request.jwt.claims` on the local stack]. Failures use `assert`.

| Id | Case | Expect |
|---|---|---|
| T1 | Any user inserts itself as admin into a team with 0 members | 42501 (no insert policy) |

Team fixtures set `stripe_subscription_id` to a dummy value (the seat trigger refuses teams without one), except T10.

| Id | Case | Expect |
|---|---|---|
| T2 | Team admin inserts another user into `team_members` | 42501 |
| T3 | Service role inserts members up to `max_seats`, then one more | last one 23514 `team_full` |
| T4 | Two sessions insert the last seat concurrently (dblink or two psql runs) | one succeeds [A: run as a script with two connections] |
| T5 | Admin updates a member row's `team_id` or `user_id` | 42501 |
| T6 | Owner updates `teams.max_seats` / `stripe_subscription_id` as authenticated | 42501; `name` change succeeds |
| T7 | Non-member inserts itself as admin into an empty team vault | refused |
| T8 | Team admin creates a vault (`created_by` = self) and inserts itself as admin | ok; `created_by` = someone else refused |
| T9 | Vault admin adds a user who is not on the team | refused |
| T10 | Service role inserts a member into a team with `stripe_subscription_id` null (dissolved) | 23514 `team_inactive` |
| T11 | `upsert_vault_entry_versioned` called by a vault viewer, by a removed team member, and by an outsider | 42501 each; an editor succeeds and `updated_by` = the caller even when `p_updated_by` names someone else |
| T12 | Editor with a viewer-only folder permission upserts into that folder, and moves an entry out of it | 42501 both |
| T12b | Same editor writes `vault_entries` directly: updates an entry in the viewer-only folder, moves one into it, inserts into it, sets `updated_by` to someone else | 0 rows or 42501 each; an open-folder edit with `updated_by` = self succeeds |
| T9b | Vault admin changes a `team_vault_members` row's `user_id` or `team_vault_id` | 42501; a role change succeeds |
| T14b | Former member (row left from before M1) selects `vault_password_history` and `vault_folder_permissions`, inserts history | 0 rows; 42501 |
| T13 | Remove a member from `team_members`; as that user select `vault_entries`, `vault_password_history`, `vault_key_wraps`, `vault_folder_permissions` of the team's vaults | 0 rows each; `team_vault_members` rows gone; `team_vaults.rotation_pending` true |
| T14 | Former vault admin (removed from the team, row left from before M1 by inserting it with the trigger disabled) deletes a member or a key wrap | 0 rows affected (helpers require team membership) |
| T15 | Vault admin inserts a key wrap for a user not on the team; for a team member not yet in the vault | refused; ok (addMember order) |
| T16 | Team admin inserts into `team_invitations` | 42501 (no insert policy) |
| T17 | Team admin updates an invitation's `expires_at` later, or `status` from `declined` to `pending` | 42501; setting `status = 'expired'` succeeds |
| O1 | A acquires lineage L | granted, `ownership: owner`, row in `personal_vault_owners` |
| O2 | B acquires L | granted, `ownership: grace`, `grace_until` = now + 14 d; `grace_started_at` set; pair row (A, B) exists; A's next heartbeat `ok` has `shared_until` = that date |
| O3 | Backdate `grace_started_at` 15 days; B acquires | `reason: not_owner`, no session row for B |
| O4 | B heartbeats after the backdate | `displaced`/`not_owner`, B's row displaced |
| O5 | A releases before the cooldown | `too_soon` with `retry_after` |
| O6 | Backdate `owner_since` 8 days; A releases; B acquires | released; `released_by` = A; B becomes owner |
| O7 | A's other device heartbeats after the release, then re-acquires with `p_claim = false` | `ok`/granted, `ownership: unowned`, still no owner |
| O8 | Delete user A (owner of L) from `auth.users` | the delete succeeds; owner row has `owner_id` null, `owner_since` null, `released_at` set; A's pair rows gone |
| O9 | Two accounts acquire a new lineage concurrently | exactly one owner |
| O10 | A owns L1; B's grace on L1 ends (backdate); B makes a fork L2 and acquires it (owner); A acquires L2 | `not_owner` (pair clock), no session row for A |
| O11 | A acquires unowned L with `p_claim = false` | granted, `ownership: unowned`, no owner row written |
| O12 | B acquires L and is refused (`device_cap`, then `vault_limit`); B acquires a random lineage and is refused | no `personal_vault_owners` row created or changed, no pair row, `grace_started_at` still null |
| O13 | After O6, A (ex-owner) acquires L with grace over; A's open device heartbeats | `not_owner` with `released: true` on both |
| D1 | Pro user with 5 devices on 5 vaults; 6th device acquires | `reason: device_cap`, 5 holders, `holders[0]` least recent idle |
| D2 | Same with takeover | granted; every row of `holders[0]`'s device displaced with `device_cap` |
| D3 | A device that already holds vault V1 acquires V2 with 5 devices live | granted (not a new device) |
| D4 | Lower `account_max_active_devices` to 2; heartbeat | extra devices displaced `device_cap`, busy kept first |
| D5 | Peek on a 6th device | `reason: device_cap`, `devices` non-empty |
| D6 | Free user: vault limit and cap both exceeded, the vault's holder holds only this vault | `vault_limit`, `also_locks` null; takeover resolves both by displacing only the holder |
| D7 | Free user: vault limit and cap both exceeded, the vault's holder also holds another vault | `vault_limit` with `also_locks` = the least-used other device; takeover displaces both |
| D8 | After D2, the displaced device heartbeats on its own vault (not the new device's vault) | `displaced`/`device_cap`, `by` = the new device's name (cross-vault lookup) |
| V1 | `min_app_version.desktop = 0.19.0`; acquire with 0.18.2 | `update_required`, `min_version` |
| V2 | Heartbeat of a lease acquired with 0.18.2 after the change | `displaced`/`update_required` |
| V3 | Unparseable version with a minimum set; `0.0.0` minimum with any version | refused; allowed |
| V4 | `version_parts` table: "1.1.0 (107)", "v0.18", "", "abc" | [1,1,0], [0,18,0], null, null |
| V5 | `min_app_version.ios = 1.2.0` only; acquire with `p_platform` 'x', and with null | `update_required` both; with all minimums 0.0.0, 'x' is granted |
| C1 | Free user uploads `uid/v/vault.enc` (insert and upsert) | refused |
| C2 | Team member on a tier without `cloud_sync_enabled` | allowed |
| C3 | Pro user with 25 snapshots in one vault inserts a 26th; another vault's snapshot | refused; allowed |
| C4 | Free user reads and deletes own old objects | allowed |
| C5 | Pro user inserts `uid/<vault>/x.bin`, `uid/<vault>/backups/a/b.enc`, `uid/other.enc`; inserts `uid/<vault>/backups/vault_2026-09-26_14-03-07-412_a1b2c3.enc` and `uid/backups/vault_2026-02-17_21-36-10.enc` | refused x3; allowed x2 |
| C6 | Pro user with 10 vault folders inserts into an 11th; into an existing one | refused; allowed |
| C7 | Pro user with 25 snapshots updates (overwrites) one of them; renames `uid/<vault>/vault.enc` into `backups/` (UPDATE of `name`) | allowed; refused |
| C8 | `cloud_backup_allowed` and `cloud_backup_slot_free` have no uid parameter | `pg_get_function_identity_arguments` is '' and 'p_name text' |

HTTP cases (same runner, PostgREST):

| Id | Case | Expect |
|---|---|---|
| H1 (was P1) | POST `{p_vault_key, p_device_id}` to `/rest/v1/rpc/vault_session_peek` with a test user's JWT | 200 and a body with `device_cap` (proves it hit the 4-argument function) |
| H2 | POST the 10 pre-M3 named arguments (no `p_claim`) to `/rest/v1/rpc/vault_session_acquire` | 200, `granted: true`, `ownership: owner` (default `p_claim = true`) |

### 7.2 Desktop unit tests (vitest; owner: Desktop builder)

| Id | File | Covers |
|---|---|---|
| D1 | `vault-session/__tests__/session-client-parse.test.ts` | Every shape of 2.5.1; the 2.10 rules; unknown reason is malformed |
| D2 | `__tests__/fake-session-server.ts` | Emulates owners, vault and pair grace, `p_claim`, release (`released_by`), device cap with `also_locks` and cross-vault `by`, min version (header says it mirrors the SQL [V: `:1-7`]); multi-account through `clientFor(userId)` [V: `:74-76`] |
| D3 | `open-personal-vault-lease.test.ts` | not_owner, update_required, device_cap at open; nothing written, lease released |
| D4 | NEW `owner-tag.test.ts` | `owner-tag.json` vectors; tag write only when confirmed owner and different |
| D5 | `open-personal-vault-claims.test.ts` | Tag before claims; signed-out sign-in; offline grace |
| D6 | `heartbeat.test.ts`, `displacement.test.ts`, `realtime.test.ts` | New displaced reasons (S8b via `released`); re-acquire routing; every background re-acquire sends `claim: false`, open and [Use here instead] send `claim: true` |
| D7 | `session-runtime-*.test.ts` | ownerCheck recording; never cleared on sign-out; release writes `{"a":null}` and clears `ownerCheck` only on `released: true`; `unconfirmed`, `too_soon`, `not_owner` leave both alone |
| D8 | `sync/__tests__/catalog.test.ts`, `canonical.test.ts`, `golden-vectors`, `app-sync-dto-mirror.test.ts` | Register and mirrors |
| D9 | NEW `own-copy-tickets.test.ts` | Expiry, zeroing, fork of a private and a shared file |
| D9b | `own-copy-tickets.test.ts` | With W present and an edit in W that never reached S, the copy contains the edit; without W the copy is made from S |
| D10 | `src/components/sync/__tests__/` | `displacedCopy` cases, GraceBanner (email, Switch account), SharedBanner (S7b), TakeoverDialog device-cap and S1b text, NotOwnerDialog (all buttons, S8b body, Save dialog `defaultDir`) |
| D11 | `src/stores/__tests__/vault-unlock-errors.test.ts` | New codes |
| D12 | NEW `electron/services/team/__tests__/team-service.test.ts` | Accept posts the token with the bearer header; error text |
| D13 | `electron/services/vault/__tests__/cloud-sync*.test.ts` | Count prune before snapshot; refusal mapping (S16, S17, S24) |
| D14 | `session-client-parse.test.ts` | `also_locks`, `shared_until`, `released`, `ownership: unowned` on a grant; `p_claim` is sent |

`npx tsc --noEmit`, `npx vitest run` and `npm run build:electron` must pass (CLAUDE.md).

### 7.3 Live `/verify` (owner: Desktop builder)

New suite `scripts/verify/suites/ownership.mjs` (two accounts via `ctx.createUser` twice [V: `lib/supabase.mjs:41-66`]; backdating through `ctx.sql`):

| Id | Scenario |
|---|---|
| L1 | owner-and-grace: A creates a shared vault; B (other account) opens it, sees the grace banner (S7) |
| L2 | grace-ends: backdate grace; B's open shows S4; B makes its own copy and opens it; A still opens the original |
| L3 | release-hand-over: backdate `owner_since`; A releases in Sync settings; B opens and becomes owner; A gets S4 with the S8b body |
| L3b | release-survives-reacquire: A has the vault open on two app instances; A releases on one; the other loses its lease (force `lost` by expiring its row with `ctx.sql`) and re-acquires; the vault stays unowned (`personal_vault_owners.owner_id` null) |
| L4 | signed-out-tag: B signed out opens A's vault: S6; A signed out on its own device opens (ownerCheck) |
| L5 | offline-owner: A with the Supabase host blocked opens its own vault; B offline gets S5 |
| L6 | device-cap: insert 5 live session rows for fake devices of account A with `ctx.sql`; A's real device opens: S1; [Use here instead] opens and displaces the least recent fake device |
| L7 | update-required: set `min_app_version.desktop` above the app version; unlock shows S9; an open vault soft-locks with S10 on the next heartbeat |
| L8 | cloud-backup-free: a Free account's backup upload is refused and shows S16 |

Extend `lib/supabase-stack.mjs:24` `EXPECTED_TIERS` to also check `account_max_active_devices = 5` and `max_cloud_backup_vaults` (0, 10, -1). In `sql/local-parity.sql` delete the `upsert_vault_entry_versioned` block (`:1-62`, 2.7) and the storage policy lines (`:69-76`, 2.9); keep the bucket insert and the `get_team_members_with_email` grant; update the header comment of `lib/supabase-parity.mjs` to say the migrations now create the RPC and the four policies (the checks stay). New dialog titles need fixtures in `scripts/__tests__/verify-selectors.test.ts` [V: README :501-503]. Add a `/verify-ownership` skill next to `/verify-sync`.

### 7.4 iOS XCTests (owner: iOS builder)

- `PKG/Tests/ConduitSessionTests/SessionClientTests.swift:130-239`: new shapes; `testAcquireMalformedAnswers` (`:148`) changes: a `not_owner` denial with empty holders is valid; a reason-less denial with empty holders stays malformed.
- `VaultAccessCoordinatorTests.swift:45-246`: peek refusals, tag rules, not-owner ticket.
- NEW `OwnerTagTests.swift` from `owner-tag.json`; `CatalogTests.swift:85`; golden canon cases.
- `DisplacementTests`, `RealtimeTests`, `LeaseTrackerTests`, `HeartbeatTests`, `SessionRuntimeLifecycleTests` (foreground device cap).
- `IOS/ConduitiOSTests/SyncTestSupport.swift:11-27`: `NotOwnerServerRpc`, `DeviceCapServerRpc`, `UpdateRequiredServerRpc` next to `ProServerRpc`.
- Run signed on the iOS 27 simulator (`xcodebuild test -project ConduitiOS.xcodeproj -scheme ConduitiOS -destination 'platform=iOS Simulator,id=<udid>' ARCHS=arm64`, without `CODE_SIGNING_ALLOWED=NO`) and `xcodebuild test -scheme ConduitSync-Package` from `PKG`.


### 7.5 Website route tests (owner: Web+BE builder)

`WEB` has no test runner today (`package.json` scripts: dev, build, start, lint; no `*.test.ts` [V]). Add `vitest` (devDependency) and `"test": "vitest run"`. Route tests call the exported `POST` handlers with a `Request`, a mocked Stripe client (`@/lib/stripe/client`) and mocked Supabase clients (`@/lib/supabase/server`).

| Id | Route | Case | Expect |
|---|---|---|---|
| W1 | invite/accept | Bearer header vs cookie session | both resolve the user; a bad token is 401 |
| W2 | invite/accept | Invitee has a personal Pro subscription | its id is read before the profile update clears it, and `subscriptions.cancel` is called with it |
| W3 | invite/accept | Seat already reserved (buy 5, 4 invited, 4 accept) | quantity stays 5; a 6th member (quantity 5, members 6) sets 6 |
| W4 | invite/accept | Insert fails with 23514 `team_full` / `team_inactive` | 409 with the 2.8 texts |
| W5 | invite/accept | Team with `stripe_subscription_id` null; Stripe status `canceled`; Stripe error | 409; 409; 503. No member insert in any |
| W6 | add-self | Caller's team has `stripe_subscription_id` null | 403 "Your team plan has ended." |
| W7 | webhooks | `customer.subscription.deleted` for a team | pending invitations of that team become `expired` |

Stripe test-mode checklist before rollout step 6: buy 5 seats, invite 4, accept 4, expect Stripe quantity 5 and `teams.max_seats` 5; invite and accept a 6th after raising seats to 6, expect 6.

---

## 8. Rollout

| Step | What | When | Why safe |
|---|---|---|---|
| 0 | `20260929141921_upsert_vault_entry_stopgap.sql`: revoke `upsert_vault_entry_versioned` from `authenticated` | Applied to prod 2026-09-29 | 0 team vaults in prod; M1 grants it back with the guarded body, so M1 must sort after it |
| 1 | Website: add-self fix, invite email check, accept route bearer path, live-plan check (6.3 e), the personal-sub read fix, and invitation expiry on dissolution | Any time, before M1 | Service-role routes; cookie path unchanged |
| 2 | M1 team hardening | Applied to prod 2026-09-29 (version 20260929161642) | Prod has 0 teams, 0 members, 0 invitations, 0 team vaults and 0 entries [V: prod SELECT 2026-09-29]; website uses the service role; the desktop's own insert already fails under RLS today; the guarded upsert keeps the desktop's signature |
| 3 | M2 app_config | Applied to prod 2026-09-29 (version 20260929161746) | Seeds are permissive; nothing reads it until M3 |
| 4 | M3 ownership and device cap | Applied to prod 2026-10-01 (version 20261001174606), before desktop 0.18 and iOS 1.1 (a 0.18 build without this work would get answers it does not know) | No released client calls the lease RPCs; 0 session rows [V]. Unreleased 0.18/1.1 dev builds must move to the 11-argument acquire at the same time (a 10-argument named call still resolves through the default) |
| 5 | M4 cloud backup plan gate and name check | Applied to prod 2026-09-29 (version 20260929161756) | Free users cannot enable backup in 0.17 (`v0.17.0:electron/ipc/cloud-sync.ts:38-39` [V]); any Free upload that still happens is refused by design; the name check accepts every shape in prod [V] |
| 6 | Accept route quantity fix (6.3 c) | After the owner confirms (10) | Changes billing |
| 7 | Desktop 0.18 and iOS 1.1 | Together | Both catalogs carry `_sync/owner/account`; both parse the new answers |
| 8 | M5 backup count cap: move it into `supabase/migrations/`, then apply it | Applied to prod 2026-10-02 (version 20261002173105), right after desktop 0.18 was published | 0.17 cannot prune by count and skips its prune when a snapshot fails; one prod Pro user (29 snapshots in one vault) would stop getting snapshots until updating. Find them before applying: `select split_part(name,'/',1), count(*) from storage.objects where bucket_id = 'vaults' and name like '%/backups/%' group by 1, split_part(name,'/',2) having count(*) >= 25;` (the user id stays out of this public repo) |
| 9 | Raise `min_app_version` | When needed | Config only |

Prod stays read-only for this work. Applying migrations to prod is the owner's step: apply M1 to M4 one at a time (Supabase MCP `apply_migration` or the SQL editor), in order, never `supabase db push` of the whole folder while M5 is pending.

### 8.1 Rollback SQL

Each goes in `supabase/migrations/_rollback_<version>_<name>.sql` (the M5 one in `supabase/pending/` until M5 moves). **Rule:** a rollback never removes an RPC signature that desktop 0.18 or iOS 1.1 calls; it restores the old behavior behind the new signature, so shipped apps keep getting well-formed answers.

```sql
-- _rollback_20261002173105_cloud_backup_count_cap.sql: put M4's INSERT and UPDATE policies back
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

-- _rollback_20260929161756_cloud_backup_plan_gate.sql: the folder-only policies of today
drop policy if exists "Users can insert own vault" on storage.objects;
drop policy if exists "Users can update own vault" on storage.objects;
create policy "Users can insert own vault" on storage.objects for insert to authenticated
  with check ((bucket_id = 'vaults') and ((storage.foldername(name))[1] = (auth.uid())::text));
create policy "Users can update own vault" on storage.objects for update to authenticated
  using ((bucket_id = 'vaults') and ((storage.foldername(name))[1] = (auth.uid())::text));
-- SELECT and DELETE policies stay (M4 created them with today's definitions).
drop function if exists public.cloud_backup_name_ok(text);
drop function if exists public.cloud_backup_allowed();
update public.tiers set features = features - 'max_cloud_backup_vaults', updated_at = now()
 where name in ('free', 'pro', 'team');

-- _rollback_20261001174606_vault_ownership_device_cap.sql
-- 1. Acquire keeps the 11-argument signature (0.18 and 1.1 send p_claim) with the body of
--    20260926150905 (copy verbatim; p_claim is ignored). Heartbeat: the 20260926150905 body (same signature).
-- 2. Peek keeps the 4-argument signature (0.18 and 1.1 send p_platform and p_app_version; a 2-argument-only
--    function would make PostgREST answer PGRST202, every peek would look unconfirmed, and online users
--    would fall into the offline owner-tag branch). Body: the 2-argument body of 20260926150905, ignoring
--    the two new arguments. Keep its revoke and grant.
-- 3. Release stays callable and answers as if nothing is owned:
create or replace function public.vault_owner_release(p_vault_key uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('released', false, 'reason', 'not_owner')
$$;
update public.personal_vault_sessions set displaced_reason = 'plan_limit'
 where displaced_reason in ('device_cap', 'not_owner', 'update_required');
alter table public.personal_vault_sessions drop constraint if exists personal_vault_sessions_displaced_reason_check;
alter table public.personal_vault_sessions add constraint personal_vault_sessions_displaced_reason_check
  check (displaced_reason in ('takeover', 'plan_limit'));
drop index if exists public.personal_vault_sessions_user_active_idx;
drop function if exists public.vault_owner_resolve(uuid, uuid, boolean, boolean);
drop function if exists public.vault_session_cap_victim(uuid, uuid, uuid, int, uuid[]);
drop function if exists public.vault_session_over_cap(uuid, uuid, uuid, int);
drop function if exists public.vault_session_device_holders(uuid, uuid);
drop function if exists public.account_device_cap(uuid);
-- The two ownership tables are KEPT (data for a fix-forward); nothing reads them after the rollback.
update public.tiers set features = features - 'account_max_active_devices', updated_at = now()
 where name in ('free', 'pro', 'team');

-- _rollback_20260929161746_app_config_min_version.sql (after the M3 rollback)
drop function if exists public.app_config_int(text, int);
drop function if exists public.app_version_ok(text, text);
drop function if exists public.app_any_min_set();
drop function if exists public.app_min_version(text);
drop function if exists public.app_platform_group(text);
drop function if exists public.version_parts(text);
drop table if exists public.app_config;

-- _rollback_20260929161642_team_membership_hardening.sql (restores the live definitions read on 2026-09-29)
drop trigger if exists trg_enforce_team_seats on public.team_members;
drop function if exists public.enforce_team_seats();
drop trigger if exists trg_guard_team_member_update on public.team_members;
drop function if exists public.guard_team_member_update();
drop trigger if exists trg_guard_team_columns on public.teams;
drop function if exists public.guard_team_columns();
drop trigger if exists trg_cleanup_removed_team_member on public.team_members;
drop function if exists public.cleanup_removed_team_member();
drop policy if exists tm_update on public.team_members;
create policy tm_update on public.team_members for update using (is_team_admin(team_id, (select auth.uid())));
create policy tm_insert on public.team_members for insert with check (
  is_team_admin(team_id, (select auth.uid()))
  or not exists (select 1 from public.team_members existing where existing.team_id = team_members.team_id));
create policy ti_insert on public.team_invitations for insert with check (is_team_admin(team_id, (select auth.uid())));
-- guard_team_invitation_update: re-run its body from 20260928003610 (copy verbatim).
-- is_team_vault_member / is_team_vault_admin: the prod bodies (select exists from team_vault_members ...,
--   admin adds role = 'admin'), same signatures and grants.
drop policy if exists vault_key_wraps_insert on public.vault_key_wraps;
create policy vault_key_wraps_insert on public.vault_key_wraps for insert
  with check (is_team_vault_admin(team_vault_id, (select auth.uid())));
-- upsert_vault_entry_versioned: NOT rolled back (the unguarded body is the critical hole in 2.7).
drop policy if exists team_vault_members_insert on public.team_vault_members;
create policy team_vault_members_insert on public.team_vault_members for insert with check (
  is_team_vault_admin(team_vault_id, (select auth.uid())) or not team_vault_has_members(team_vault_id));
drop policy if exists team_vault_members_update on public.team_vault_members;
create policy team_vault_members_update on public.team_vault_members for update
  using (is_team_vault_admin(team_vault_id, (select auth.uid())));
drop policy if exists team_vaults_insert on public.team_vaults;
create policy team_vaults_insert on public.team_vaults for insert with check (exists (
  select 1 from public.team_members tm
   where tm.team_id = team_vaults.team_id and tm.user_id = (select auth.uid()) and tm.role = 'admin'));
-- The TRUNCATE/REFERENCES/TRIGGER revoke is not rolled back (no client uses them).
```

The M1 rollback reopens the security holes in 2.7 (except the RPC guard); use it only to unblock a broken website flow, and fix forward.

---

## 9. Known limits (accepted)

- **Modified clients.** The server holds every limit, but a modified app can skip the in-file tag and the Free claims offline. It still cannot get a lease, a cloud backup upload or a team seat it is not allowed.
- **Old apps are not enforced.** Desktop 0.17 or older and iOS 1.0.5/1.0.6 never call the lease, so ownership, the device cap and the minimum version do not reach them.
- **Offline and signed out.** A vault that was never opened online by any account has no owner and no tag. A signed-out device can open any vault whose tag is absent or null.
- **Private vaults** (desktop app data folder, iOS Documents) have no tag and no `ownerCheck`; only the server protects them, so signed-out and offline opens are allowed. A second account can reach them only on the same OS profile.
- **Team vaults are not counted** by the device cap. A person using only team vaults can use any number of devices.
- **The device cap counts leases, not people.** Five people sharing one account on five devices fit. Geo detection is not built (out of scope).
- **The take-over picks the least recently used idle device;** the user cannot choose which one.
- **Cloud backup count cap** can be passed by one or two when uploads race; server-side retention cleanup is not built.
- **Grace starts on the first foreign lease that is granted** and never resets, even after a release. The pair clock also never resets, so two accounts get 14 days of sharing in total, across every vault and copy they pass between them. Three or more accounts rotating vaults can still get 14 days per pair.
- **A lineage id is enough to claim an unowned lineage.** Anyone who has seen a vault's lineage id (for example a former grace guest) can acquire it and become owner if it is unowned (never opened online, or released). The id lives only in the file, and release already hands the vault to "the next account".
- **Legacy (pre-sync) copies share a lineage.** The lineage of a legacy file comes from its salt (`hashing.ts:287-289` [V]), so separate copies of one legacy file made before 0.18 share it. If two people kept their own copy with the same password, the first to open one on 0.18 owns both, and the other is locked out after grace with S4 ("This vault, or the file it was copied from, belongs to another Conduit account"). "Make my own copy" recovers their data into a new lineage.
- **"Make my own copy" on several devices makes several vaults.** Each device forks its own copy with a new random lineage. The Save dialog defaults to the original's folder and S4 points to [Open a vault...], so a user can open the first copy instead. The server does not record forks.
- **Release is the only hand-over.** No directed transfer to an email. After a hand-over the ex-owner sees S8b, not S8.
- **Trial seat cap (3)** is enforced only by the website accept route, which reads Stripe.
- Out of scope, noted only: repeat trials on the same card; the `price_label` mismatch in `public.tiers` (Pro `$15/month` versus 10.00 [V]); geo detection; making the server part of vault encryption.

---

## 10. Decisions made in this spec and items for the owner

Decisions (beyond the approved product decisions):
1. Owner tag is a new register `_sync/owner/account`, not the Free claim's `a` field.
2. Not-owner is answered only at acquire (after the password check), so "Make my own copy" has a verified key; peek refuses early only for update required and the device cap.
3. The copy uses an in-memory ticket (key held 10 minutes in the main process), so biometric and automatic (`auto_unlock`, docs/AUTO_UNLOCK.md) unlocks can make a copy too.
4. Grace length, release cooldown, version minimums and the cap fallback live in a new `app_config` table; the cap itself is a tier key.
5. Release keeps the owner row and adds a 7-day cooldown after becoming owner, so hand-back loops are slow.
6. The lease lock moves from per (account, vault) to per account.
7. Refusal reasons reuse the `displaced` status on heartbeat (`device_cap`, `not_owner`, `update_required`), so the existing soft-lock and Realtime path carry them.
8. Desktop invite accept goes through the website route with a bearer token; `tm_insert` is dropped entirely; `teams` columns other than `name` are server-only.
9. `max_cloud_backups` counts snapshots per vault folder; M5 ships with 0.18.
10. iOS shows no Team trial link.
11. Ownership is claimed and grace clocks start only when an acquire is granted, and only a user-started open claims (`p_claim`).
12. Grace is counted per vault AND per pair of accounts (`personal_vault_guest_grace`), so forking every 13 days does not extend sharing.
13. Removing someone from a team removes all their team-vault rows and key wraps in that team (trigger), and flags the vaults for key rotation.
14. `upsert_vault_entry_versioned` checks the caller's vault role and folder rights and stores `auth.uid()` as `updated_by`. It is not rolled back with M1.
15. Only the website creates team invitations; a team without a live subscription takes no members.
16. Cloud backup accepts only the known object names, and adds a per-account vault-folder cap (`max_cloud_backup_vaults`).
17. "Make my own copy" copies this device's working copy when it has one, and saves next to the original by default.
18. M5 waits in `supabase/pending/` until desktop 0.18 ships.

For the owner to confirm:
- The accept route quantity fix (6.3 c): today buying 5 seats and inviting 4 bills 9 seats.
- The 7-day release cooldown (set `vault_release_cooldown_days` to 0 to turn it off).
- `max_cloud_backup_vaults`: Pro 10, Free 0, Team unlimited (prod max today is 2 per account [V]).
- The pair limit on grace (12): two accounts get 14 days of sharing in total, not 14 days per vault.
