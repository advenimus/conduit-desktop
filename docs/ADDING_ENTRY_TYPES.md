# Adding New Entry Types & Credential Types

Guide for adding new entry types (connections) or credential sub-types to Conduit.

## Architecture Overview

Conduit has two related but distinct type systems:

| Concept | Stored In | Examples | Purpose |
|---------|-----------|----------|---------|
| **Entry type** (`entry_type`) | `entries.entry_type` column | `ssh`, `rdp`, `vnc`, `web`, `credential` | Defines what kind of entry (connection vs credential) |
| **Credential type** (`credential_type`) | `entries.credential_type` column | `generic`, `ssh_key` | Sub-type for credential entries (how you authenticate) |

Both live in the same `entries` table in the SQLite vault. All entries go through the same EntryDialog UI, which adapts its tabs and fields based on the types.

### Key Data Flow

```
User clicks "+" → EntryDialog (type selector) → EntryDialog (tabbed form)
  → entryStore.createEntry() → IPC "entry_create" → vault.createEntry() → SQLite
```

For credential entries, calling `createEntry` with `entry_type: 'credential'` also refreshes the credential list (sidebar + CredentialManager both read from the same table).

## File Map

These files need changes when adding a new type:

### Type Definitions

| File | What to change |
|------|---------------|
| `src/types/entry.ts` | Add to `EntryType` union if new entry type |
| `src/types/credential.ts` | Add to `CredentialType` union + `CREDENTIAL_TYPES` registry if new credential sub-type |

### Type Selector (the "New Entry" dialog)

| File | What to change |
|------|---------------|
| `src/components/entries/EntryDialog.tsx` | Add entry to `ENTRY_TYPE_CATEGORIES` — either under existing category or a new one |

The type selector is organized into categories (e.g., "Connections", "Credentials"). Each category contains `TypeOption` items:

```typescript
interface TypeOption {
  type: EntryType;          // The entry_type value stored in DB
  label: string;            // Display name in the type selector card
  description: string;      // Short description under the label
  icon: TablerIcon;         // Icon from @tabler/icons-react
  color: string;            // Tailwind border/text/hover classes
  credentialType?: CredentialType;  // Set for credential sub-types
}
```

To add a new **category** (e.g., "Documents", "Tools"), add a new object to `ENTRY_TYPE_CATEGORIES`:

```typescript
{
  label: "Documents",
  items: [
    { type: "document", label: "Markdown", description: "Rich text document", icon: IconFileText, color: "text-teal-400 ..." },
  ],
}
```

### Sidebar & Tab System

| File | What to change |
|------|---------------|
| `src/components/entries/entryDialogTabs.ts` | Add tabs for the new type in `getTabCategories()` |
| `src/components/entries/EntryDialogSidebar.tsx` | Add label in `TYPE_LABELS` record; add special icon/color handling if needed |
| `src/components/entries/entryIcons.ts` | Add icon mapping in `getEntryIcon()` and color in `getEntryColor()` |

### Tab Content

| File | What to change |
|------|---------------|
| `src/components/entries/tabs/GeneralTab.tsx` | Add field visibility rules for the new type |
| `src/components/entries/tabs/CredentialsTab.tsx` | Add field visibility; for credential sub-types, add metadata sections |
| New tab file (if needed) | Create `src/components/entries/tabs/YourNewTab.tsx` matching the existing tab pattern |

Each tab component receives its state via props from EntryDialog. The pattern is:
- Props: `value: string`, `setValue: (v: string) => void` for each field
- Layout: Use `<Field label="...">` wrapper from `../Field`
- Styling: Use `bg-well border-stroke` for inputs, `focus:ring-conduit-500` for focus

### EntryDialog State & Submit

In `EntryDialog.tsx`:
1. Add state variables for any new fields: `const [myField, setMyField] = useState("")`
2. Pass them to tab components as props
3. Add them to `buildConfig()` if they should go in the `config` JSON column
4. Add them to `handleSubmit()` in both the create and update paths
5. Add them to the edit-loading `useEffect` to populate state when editing

### Backend (Electron Main Process)

| File | What to change |
|------|---------------|
| `electron/ipc/entry.ts` | Add new fields to `entry_create` and `entry_update` args types |
| `electron/services/vault/vault.ts` | Add to `EntryType` union, `CreateEntryInput`, `UpdateEntryInput` if adding new columns |
| `electron/services/vault/database.ts` | Add column to `EntryRow`, `insertEntry()`, `updateEntry()` if adding new DB columns |
| `electron/services/vault/migrations.ts` | Add migration if schema change needed (bump `SCHEMA_VERSION` in `schema.ts`) |

### Credential-Specific Files (if adding credential sub-type)

| File | What to change |
|------|---------------|
| `electron/ipc/vault.ts` | Update `credential_create` / `credential_update` handlers if new metadata fields |
| `electron/ipc-server/server.ts` | Update `CredentialList` / `CredentialGet` / `CredentialCreate` handlers |
| `electron/services/vault/team-sync.ts` | Include new fields in upload/download/reconcile paths |
| `mcp/src/tools/credential.ts` | Update tool definitions and handlers |
| `mcp/src/ipc-client.ts` | Update `credentialCreate()` signature |
| `src/stores/vaultStore.ts` | Update `createCredential` / `updateCredential` params |
| `src/components/vault/CredentialManager.tsx` | Add type badge if new credential type |
| `src/components/vault/CredentialPicker.tsx` | Add type badge if new credential type |
| `src/components/vault/CredentialForm.tsx` | Update type selector and add type-specific fields (used by CredentialManager) |

### Supabase (if new DB column)

| File | What to change |
|------|---------------|
| `docs/migrations/NNN_description.sql` | Create Supabase migration (ALTER TABLE + update RPC functions) |

Deploy to preview branch first, verify, then merge to production.

### Documentation

| File | What to change |
|------|---------------|
| `docs/FEATURES.md` | Add the new type/feature (MANDATORY) |

## Checklist: Adding a New Connection Entry Type

Example: adding a "Telnet" connection type.

1. [ ] Add `'telnet'` to `EntryType` union in `src/types/entry.ts`
2. [ ] Add to `ENTRY_TYPE_CATEGORIES` in `EntryDialog.tsx` under "Connections"
3. [ ] Add icon/color in `entryIcons.ts`
4. [ ] Add label in `EntryDialogSidebar.tsx` `TYPE_LABELS`
5. [ ] Configure tabs in `entryDialogTabs.ts` `getTabCategories()`
6. [ ] Add field visibility rules in `GeneralTab.tsx` and `CredentialsTab.tsx`
7. [ ] Create any type-specific tab components if needed
8. [ ] Add to `EntryType` union in `electron/services/vault/vault.ts`
9. [ ] Update `docs/FEATURES.md`
10. [ ] Run `npx tsc --noEmit` — no errors
11. [ ] Test: create, edit, delete the new type

## Checklist: Adding a New Credential Sub-Type

Example: adding an "API Key" credential type.

1. [ ] Add `'api_key'` to `CredentialType` union in `src/types/credential.ts`
2. [ ] Add to `CREDENTIAL_TYPES` registry with label and description
3. [ ] Update `resolveCredentialType()` to recognize the new value
4. [ ] Add to `ENTRY_TYPE_CATEGORIES` in `EntryDialog.tsx` under "Credentials" with icon, color, and `credentialType: 'api_key'`
5. [ ] Update `CredentialsTab.tsx`: add metadata section shown when `credentialType === 'api_key'`
6. [ ] Update `EntryDialogSidebar.tsx`: add special icon/color/label for the new sub-type
7. [ ] Update `EntryDialog.tsx` header text for the new sub-type
8. [ ] Update `CredentialForm.tsx`: type selector auto-includes from registry; add type-specific fields section
9. [ ] Update `CredentialManager.tsx` and `CredentialPicker.tsx`: badge auto-shows for non-generic types (no change needed if using existing pattern)
10. [ ] If new DB columns needed: add migration, update database.ts, vault.ts, IPC handlers, team-sync, MCP tools
11. [ ] If metadata only (stored in `config` JSON): update `buildConfig()` in EntryDialog and relevant IPC handlers
12. [ ] Update `docs/FEATURES.md`
13. [ ] Run `npx tsc --noEmit` — no errors
14. [ ] Test: create via type selector, edit, verify badge shows in list

## Config JSON Column

Non-secret metadata for credential sub-types is stored in the `config` JSON column on the `entries` table. This column is already used for RDP config and web config. For credentials, it stores things like:

```json
{ "public_key": "ssh-ed25519 AAAA...", "fingerprint": "SHA256:..." }
```

The `config` column is encrypted in team vaults (synced via VEK). Use it for any non-secret metadata that should persist with the entry.

## Type Registry Pattern

The `CREDENTIAL_TYPES` registry in `src/types/credential.ts` is the single source of truth for credential type metadata:

```typescript
export const CREDENTIAL_TYPES: Record<CredentialType, { label: string; description: string }> = {
  generic: { label: 'Generic', description: 'Username, password, domain, private key' },
  ssh_key: { label: 'SSH Key', description: 'SSH key pair with public key and fingerprint' },
};
```

UI components (type selectors, badges, form headers) all read from this registry. Adding a new entry automatically makes it appear in type selectors and badge rendering.
