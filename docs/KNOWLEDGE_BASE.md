# Knowledge Base and Secret Chips

This is the data contract for the asset knowledge base (KB) and secret chips. Desktop and iOS must
follow it exactly. Every rule marked **[vectors]** has test cases in
`electron/services/knowledge/__vectors__/`. Both apps run those files in their unit tests, so a
change here means a change to the vectors and to both implementations.

Nothing here changes the vault schema. `schema_version` stays 10 and `sync_format` stays 1. Every
record is an ordinary `entries` row, and all new data lives in existing columns or in top-level
`config` keys. Each top-level `config` key is its own synced register, so sync, backup, team sync,
conflicts and key rotation work without changes.

## 1. Records

### 1.1 KB article

An article is an `entries` row with `entry_type = 'document'` and a `config.kb` object.

| Column / key | Meaning |
|---|---|
| `name` | Article title |
| `tags` | Article tags (used for vault-scope matching, section 4) |
| `config.content` | Markdown body |
| `config.kb` | Metadata object (below) |
| `config.kb_history` | Revision array (section 5) |

Placement depends on scope:

| `kb.scope` | `parent_entry_id` | `folder_id` |
|---|---|---|
| `asset` | the asset's id | `null` |
| `folder` | `null` | the folder's id |
| `vault` | `null` | `null` |

`config.kb` fields:

| Field | Type | Notes |
|---|---|---|
| `v` | number | Always `1` |
| `scope` | `'asset' \| 'folder' \| 'vault'` | |
| `kind` | `'overview' \| 'facts' \| 'procedure' \| 'troubleshooting' \| 'contact' \| 'playbook' \| 'changelog'` | |
| `summary` | string | One line, at most 200 characters, shown in lists and sent to agents |
| `pinned` | boolean | Pinned articles sort first. Pinned vault articles apply to every asset |
| `status` | `'active' \| 'needs_review' \| 'archived'` | Archived articles are left out of every list except the archive filter |
| `author` | `{ kind: 'agent' \| 'user', name?: string }` | Who created the article |
| `last_editor` | `{ kind: 'agent' \| 'user', name?: string, device?: 'desktop' \| 'ios', at: string }` | Who saved last |
| `verified_at` | string? | Last time someone confirmed the article is still true |
| `verified_by` | `{ kind, name? }`? | |
| `verify_note` | string? | |
| `reviewed_at` | string? | The newest revision time the user has reviewed (section 5) |

Timestamps are UTC ISO 8601 with milliseconds and a `Z` suffix, as JavaScript's `toISOString()`
writes them (`2026-10-06T14:03:00.000Z`). They compare correctly as strings.

`name` for an agent is its display name, for example `Claude Code` or `Codex`. A user has no name.

The article title (`name`) and `kb.summary` are stored as plain text. Before saving either, replace
every `!!value!!` span in it with `••••` (four U+2022 bullets). A summary derived from the body is
derived from the text before conversion, so it needs the same treatment.

### 1.2 Embedded secret

An embedded secret is an `entries` row with `entry_type = 'credential'` and a `config.embedded`
object. Its value is stored, encrypted, in `password_encrypted`, like every other password.

| Column / key | Meaning |
|---|---|
| `name` | The label shown on the chip |
| `parent_entry_id` | The owner: the entry whose notes or article body holds the chip |
| `folder_id` | `null` |
| `config.embedded.owner_id` | Same as `parent_entry_id`. Kept so a moved row can still be traced |
| `config.embedded.label` | Same as `name` |
| `config.embedded.orphaned_at` | Set when no text in the vault references the secret any more (section 3.3) |
| `config.embedded.pending_for` | Set on a staged rotation value: the id of the secret it will replace |

### 1.3 Hidden entries [vectors: `hidden.json`]

An entry is **hidden** when its `config` is a JSON object whose `kb` key or `embedded` key holds a
JSON object. Hidden entries are left out of the sidebar tree, folder lists, counts, favorites,
recents, quick search, credential pickers and credential lists, and the MCP `entry_list` and
`entry_search` tools. They never act as an inherited credential for a connection nested under the
same parent. Lookups by id still find them, because chips and article links resolve by id.

### 1.4 Delete cascade

Deleting an entry also deletes every hidden entry nested under it (by `parent_entry_id`), and
does so recursively (an article's own secrets go too). Normal, non-hidden children are promoted
to the deleted entry's container as before. Deleting a folder already deletes everything inside it.

## 2. References

### 2.1 Grammar [vectors: `refs.json`]

```
secret ref:  {{secret:<uuid>[.pending][|<label>]}}
cred ref:    {{cred:<uuid>[.username|.password|.totp]}}
```

- `<uuid>` is `8-4-4-4-12` hex digits, case-insensitive. Anything else is not a ref.
- `<label>` is up to 80 UTF-16 code units (an emoji counts as 2) and contains no `}`, `|` or line
  break. It is display-only: the id decides what the ref points to. An empty label counts as no label.
  When writing a label, cut it to 80 code units without splitting a surrogate pair.
- `.pending` points to the staged value of a rotation (section 3.4).
- A `cred` ref with no field means `.password`. `.totp` means the current one-time code.

Regular expressions (JavaScript flavour):

```
/\{\{secret:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(\.pending)?(?:\|([^}|\n]{0,80}))?\}\}/g
/\{\{cred:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:\.(username|password|totp))?\}\}/g
```

Ids are compared in lower case.

All regular expressions in this document are JavaScript (no `u` flag): `.` and character classes
work on UTF-16 code units, `\s` is the JavaScript whitespace set, `^` with the `m` flag matches after
`\n`, and strings compare by code unit. Ports to other regex engines must spell these out.

### 2.2 Where refs are resolved

- **Apps:** a secret ref renders as a chip showing the label (or the secret's current name, which
  wins when they differ). The chip can reveal, copy and, on desktop, auto-type the value.
- **Agents (desktop only):** typing tools swap refs for values inside the main process. Agents
  never receive the value. See `docs/FEATURES.md` for the tool list.
- Refs are never resolved inside notes or article bodies. Text keeps the ref.

## 3. Converting `!!value!!`

### 3.1 Conversion [vectors: `convert.json`]

`!!value!!` is still how people type a secret. Every save of notes or an article body (and
documents) converts each `!!value!!` span into a new embedded secret and replaces the span with a
secret ref. Plaintext `!!…!!` is never stored by a current app.

- Spans match `/!!(.+?)!!/g`, the same pattern as before. The value is the text between the
  markers, unchanged.
- Spans are converted everywhere in the text, including code blocks, to match how they were
  masked before.
- Identical values in one text map to one secret. The label comes from the first occurrence.
- New secrets get fresh UUIDs. The vectors pass the ids in, in order of first appearance.
- The replacement is `{{secret:<id>|<label>}}`. On a table row (a line whose first non-space character
  is `|`) it is `{{secret:<id>}}` with no label, because a `|` would split the table cell. The secret
  still gets the derived label as its name.

### 3.2 Labels [vectors: `convert.json`]

The label comes from the text before the span, on the same line:

1. Take the line text before the span. If an earlier ref or span sits on the same line, start
   after the last one.
2. If the text contains `|`, split it at `|` and keep the last piece that is not blank after
   trimming (table cells: `| DB | !!x!! |` gives `DB`).
3. Remove a leading list marker (`- `, `* `, `+ `, `1. `, `1) `) and a leading heading marker
   (`#` to `######` plus a space). Leading spaces before them are removed too.
4. Remove the characters `*`, `` ` ``, `{` and `}`.
5. Trim, then strip trailing `:`, `=`, `-`, `–`, `—` and whitespace.
6. Keep the first 40 Unicode code points, then trim again.
7. If the result is empty, use `Secret <n>`, where `n` counts the new secrets created by this
   conversion, starting at 1.

### 3.3 Orphans

A secret is **referenced** when any entry's `notes`, `config.content` or the `content` of any
revision in its `config.kb_history` contains a secret ref with its id. (A revision can be restored,
so a secret it links to is still in use.) A secret an editor creates for text that is not saved yet
may start with `orphaned_at` set; the save clears it. After each save, the app checks the owner's embedded secrets:

- referenced and `orphaned_at` set → clear `orphaned_at`;
- not referenced and `orphaned_at` not set → set `orphaned_at` to now.

A staged rotation row (`pending_for` set) is never flagged: its original's ref covers it.

Apps never delete orphans on their own. The asset page offers "Clean up N unused secrets", and
orphans go when their owner is deleted. Restoring an old revision brings a ref back, which clears
the flag on the next save.

### 3.4 Rotation

Rotating a secret creates a second embedded secret with `config.embedded.pending_for` set to the
original's id, nested under the same owner. `{{secret:<original>.pending}}` resolves to it.
Committing writes the pending value into the original (the old value goes to password history)
and deletes the pending row. Discarding deletes the pending row.

## 4. Inheritance [vectors: `inherit.json`]

The knowledge for an asset is three groups, in this order:

1. **Asset:** active and needs-review articles with `parent_entry_id` = the asset.
2. **Folder:** folder-scope articles in the asset's folder, then its parent folder, and so on up
   to the root. Nearest folder first. A nested asset (no `folder_id`) uses the folder of the
   nearest ancestor entry that has one.
3. **Vault:** vault-scope articles that are pinned, or that share at least one tag with the asset
   (tags compare case-insensitively).

The knowledge for a folder is the folder group starting at that folder, then pinned vault articles.

Inside each group (and inside each folder level), articles sort by:

1. pinned first (a missing `pinned` counts as `false`);
2. kind, in this order: `overview`, `facts`, `procedure`, `troubleshooting`, `contact`,
   `playbook`, `changelog`;
3. name, lower-cased, by code unit.

Archived articles are never included.

## 5. Revisions [vectors: `revisions.json`]

`config.kb_history` is an array, oldest first, of:

```
{ at, author: { kind, name?, device? }, reason?, content }
```

Every save appends the saved content. The array keeps the newest 20 revisions, plus the
**baseline** revision when it would otherwise fall off (so it can hold 21).

- **Unseen agent edit:** `last_editor.kind = 'agent'` and (`reviewed_at` is missing or
  `reviewed_at < last_editor.at`). A `last_editor` without `at` counts as unseen only while
  `reviewed_at` is missing.
- **Baseline:** if `reviewed_at` is set, the newest revision with `at <= reviewed_at`. Otherwise
  the newest revision by a user. There may be none.
- **Keep** sets `reviewed_at` to the newest revision's `at` (with no history, `last_editor.at`, or now).
- **Undo** restores the baseline's content as a new user revision with reason
  `Undo agent edits`, then sets `reviewed_at` to that new revision's `at`. With no baseline, the
  article was created by an agent and never reviewed, so the app offers **Archive** instead.
- **Restore** (from History) saves the chosen revision's content as a new user revision.

### 5.1 Sync conflicts on metadata and history [vectors: `autoresolve.json`]

When an article is edited on two devices at once, `config.content` conflicts like any document and
the user picks a version. `config.kb` and `config.kb_history` conflict too, but apps resolve those
themselves, right after a merge, by writing one value over every conflicting version (an ordinary
conflict resolution). The value depends only on the versions, so two devices that resolve at the
same time write the same value:

- **`config.kb`:** the version whose `last_editor.at` is greatest (string order); on a tie, the one
  whose `JSON.stringify` text is greater. Its `reviewed_at` becomes the greatest `reviewed_at` of all
  versions (missing ones ignored).
- **`config.kb_history`:** every revision of every version, without duplicates (same `at` and same
  `content`), sorted by `at` and then `content` (string order), then built up with the append rule of
  section 5 one revision at a time, using the merged `reviewed_at`.

Versions that are not valid JSON of the right shape are left for the user.

## 6. Stale articles [vectors: `stale.json`]

An article is **stale** when `verified_at` (or the entry's `updated_at` if it was never verified)
is more than 90 days before now. Changelog articles are never stale.

## 7. Notes migration

### 7.1 When to suggest it [vectors: `migration.json`]

Suggest moving an asset's notes into the KB when all of these hold:

- the asset has no asset-scope articles that are not archived;
- `config.kb_migration_dismissed` is not `true`;
- the trimmed notes are at least 400 characters long (reason `long`), or contain a Markdown
  heading line (`^#{1,6}\s`, reason `headings`), or contain at least 3 numbered list lines
  (`^\s*\d+[.)]\s`, reason `steps`). Reasons are checked in that order and the first match wins.

### 7.2 Split by headings [vectors: `split.json`]

The app can split notes into articles with no AI:

0. Line endings `\r\n` become `\n`.
1. Split at level-2 headings (`## `). If there are none, split at level-1 headings (`# `). Heading
   lines inside fenced code blocks (between lines starting with ` ``` ` or `~~~`) do not count.
2. Text before the first heading becomes an article titled `Overview`, if it is not blank.
3. Each section becomes an article titled with the heading text (trimmed). The body is the lines
   after the heading, with leading and trailing blank lines removed. If the heading holds secrets
   (`!!value!!` spans or `{{secret:…}}` / `{{cred:…}}` refs), each becomes `••••` in the title, and
   the secrets, joined by single spaces, become the first line of the body so nothing is lost.
   Sections whose body is then blank are dropped.
4. If there are no headings at all, the whole text becomes one `Overview` article.
5. Kind comes from the title. Lower-case it and split it into words at every run of characters
   other than `a-z` and `0-9`. Check these lists in order; the first list with a matching word wins:
   - `overview`, `summary`, `about` → `overview`
   - `contact`, `contacts`, `vendor`, `support`, `phone`, `email` → `contact`
   - `issue`, `issues`, `error`, `errors`, `troubleshoot`, `troubleshooting`, `problem`,
     `problems`, `fix`, `known` → `troubleshooting`
   - `steps`, `procedure`, `procedures`, `how`, `reboot`, `restart`, `install`, `update`,
     `upgrade`, `backup`, `restore` → `procedure`
   - anything else → `facts`
6. The first article with kind `overview` (if any) is pinned.

Notes are left unchanged unless the user chooses to replace them with
`Moved to Knowledge. See the Knowledge tab.`

## 8. Change log [vectors: `changelog.json`]

`kb_log` and the apps write to the asset's change-log article (kind `changelog`, title
`Change log`), creating it if needed. Each entry is one line, newest first:

```
- 2026-10-06 14:03 UTC · Claude Code: Rotated the local admin password.
```

The time is the minute, in UTC. The name is the agent name, or `You`. The text is trimmed and
each line break (`\n` or `\r\n`) becomes a space.

Inserting a line into the article body:

- An empty body becomes just the line.
- If the first line is a heading (`^#{1,6}\s`), the new line goes after it, and after the blank
  line that follows it if there is one. A body that is only the heading (with or without a
  trailing blank line) becomes `<heading>\n\n<line>`.
- Otherwise the new line goes at the top.

## 9. Export and import

Exports carry `parent_entry_id`. Imported entries get new ids, so import restores nesting and rewrites
every `{{secret:<id>` and `{{cred:<id>` in notes and `config.content`, and `config.embedded.owner_id` /
`pending_for`, to the new ids. Ids not in the export are left as they are.

## 10. Older apps

Desktop 0.18 and iOS 1.1.0 do not know these keys. They keep working: articles look like plain
documents, embedded secrets look like credentials, and refs show as raw text. They may write
`!!value!!` as plaintext. A current app converts it the next time it saves that entry, and the
"Encrypt secrets now" banner and the vault-wide action catch the rest.
