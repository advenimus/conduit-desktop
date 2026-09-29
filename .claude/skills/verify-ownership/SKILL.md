---
name: verify-ownership
description: Run only the live vault ownership suite (owner and grace, grace ending and Make my own copy, release and hand-over, release surviving a background re-acquire, owner tag signed out and offline, the account device cap, the minimum app version, the cloud backup plan gate) against the real Conduit app and a local Supabase. Use after changing electron/services/vault-session/ (owner-tag, own-copy tickets, the open gate, the session client), src/components/sync/ ownership dialogs and banners, cloud backup limits, or the plan enforcement migrations, or when asked to verify ownership or plan limits live. Fully isolated; takes about 3 minutes.
---

# /verify-ownership: vault ownership and plan limits suite

Runs `npm run verify:ownership` (`node scripts/verify/run.mjs ownership`). Real Electron devices of
two accounts share one "cloud" folder, sign in as generated test users on a local Supabase, and are
driven like a user. The spec under test is `docs/PLAN_ENFORCEMENT.md` (sections 1, 3, 4 and 7.3);
the harness reference is `scripts/verify/README.md`. Every suite at once is the `verify` skill; the
device-lease basics (take-over, plan changes, owner claims) are the `verify-sync` skill.

## Needs

The plan enforcement migrations on the local stack (`supabase/migrations/20260929150000` to
`20260929150300`); the harness applies every migration of the checkout on every run, so run it from a
checkout that has them. Everything else is as in `verify-sync` (Docker, the pinned Supabase CLI, psql).

## What it proves

Each scenario uses its own devices (`o1a`, `o1b`, ...) and its own `<cloud>/o<n>/Vault.conduit`.
Clocks move by backdating `personal_vault_owners`, `personal_vault_guest_grace` and lease rows.

| Scenario | In plain words |
|---|---|
| `owner-and-grace` | The account that creates a vault owns it (`personal_vault_owners`, owner tag in the file). Another account opens it at once with "This vault belongs to another Conduit account. You can use it until ..." and its four buttons; the owner sees "Another Conduit account is using this vault until ...". |
| `grace-ends` | With the grace clocks moved back 15 days the guest's open vault locks ("... your 14 days of access ended.") with no [Use here instead]; unlocking again shows "This vault belongs to another account"; [Make my own copy] saves next to the original ("Your copy is ready."), the copy opens and is owned by the guest, and the owner still opens the original. |
| `release-hand-over` | The owner (moved past the 7-day cooldown) releases in Settings > Sync ("Vault released."); the owner row is empty with `released_by` set and the file carries `{"a": null}`; the next account to open it owns it; the ex-owner may use it during grace and afterwards sees "You released this vault and another account now owns it." |
| `release-survives-reacquire` | After a release on one of two devices of the owner, the other device's lease is expired by hand; its background re-acquire (p_claim false) leaves the vault unowned. |
| `signed-out-tag` | A signed-out device of another account gets "Sign in to open this vault"; the owner device, signed out, still opens (its cached owner check). |
| `offline-owner` | With Supabase cut, the owner opens its vault; another account's device gets "Connect to the internet so Conduit can check who owns this vault". |
| `device-cap` | With five other devices holding leases, unlocking shows "Too many devices" naming the least recently used one; [Use here instead] opens and displaces it with `device_cap`. |
| `update-required` | With `min_app_version.desktop` at 99.0.0 the open vault locks ("Update Conduit to keep using this vault.") and unlocking shows "Update required" with the version. The setting is put back to `0.0.0` at the end of the scenario and at cleanup. |
| `cloud-backup-free` | A Free account's direct upload to the `vaults` bucket is refused by the server; after a downgrade [Back Up Now] leaves "Cloud backup needs Pro or Team. Your earlier backups are still here." with [Upgrade]. |

## Run it

```bash
npm run verify:ownership
node scripts/verify/run.mjs ownership --only grace-ends            # one scenario
node scripts/verify/run.mjs ownership --only device-cap --keep     # keep /tmp/cv-<id> to inspect
```

Exit code 0 means all passed including cleanup, 1 means a failure, 2 means bad arguments. Test
windows appear on screen: leave them alone. About 164 s of scenarios plus about 10 s of setup; use a 10 minute timeout.

## Read the results

As in `verify-sync`: `.verify/<runId>/results.json`, `shots/`, `logs/<device>.main.log`. Owner rows:
`"$PSQL" postgresql://postgres:postgres@127.0.0.1:54322/postgres -c "select vault_key, owner_id, owner_since, grace_started_at, released_by from personal_vault_owners"`.

## When something fails

1. Read the failing scenario's `steps`, `error`, screenshot and `<device>.main.log`. Decide: app bug,
   harness bug, missing migrations, or environment.
2. Re-run only it with `--only`.
3. Fix the root cause and add a unit test where the code allows. Never weaken an assertion, skip a
   scenario or raise a timeout without a measured reason. If a check disagrees with
   `docs/PLAN_ENFORCEMENT.md`, say so and cite the section.

## Safety rules

- Only the local stack on 127.0.0.1; never production Supabase; never `CONDUIT_ENV=production`.
- `update-required` changes a global setting of the local stack for a minute; do not run it beside
  another run that opens vaults.
- Never run `supabase db reset`; never print the service-role key or tokens.

## Report back

One line with the result and time, then passed / total, then each failure with its root cause and
the fix or open question, and the run folder. Quote the `RESULT:` line as printed; never claim a pass
you did not run.
