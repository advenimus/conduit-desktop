import { useState, useEffect, useRef, useMemo } from "react";
import type { CredentialMeta } from "../../types/credential";
import { resolveCredentialType, CREDENTIAL_TYPES } from "../../types/credential";
import { SearchIcon } from "../../lib/icons";
import { Badge, ListRow, TextInput } from "../ui";

interface PickerCredentialListProps {
  credentials: CredentialMeta[];
  onSelect: (id: string) => void;
}

const MAX_TAGS = 3;

export default function PickerCredentialList({ credentials, onSelect }: PickerCredentialListProps) {
  const [search, setSearch] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-focus search
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const filtered = useMemo(() => {
    if (!search) return credentials;
    const q = search.toLowerCase();
    return credentials.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.username && c.username.toLowerCase().includes(q)) ||
        (c.domain && c.domain.toLowerCase().includes(q)) ||
        c.tags.some((t) => t.toLowerCase().includes(q))
    );
  }, [credentials, search]);

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [filtered.length, search]);

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && filtered[selectedIndex]) {
      e.preventDefault();
      onSelect(filtered[selectedIndex].id);
    }
  };

  return (
    <div className="flex h-full flex-col" onKeyDown={handleKeyDown}>
      {/* Search bar */}
      <div className="shrink-0 border-b border-divider px-3 py-2">
        <TextInput
          ref={searchRef}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search credentials..."
          leading={<SearchIcon size={16} />}
        />
      </div>

      {/* Credential list */}
      {filtered.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-body text-ink-muted">
          {search ? "No matches" : "No credentials"}
        </div>
      ) : (
        <div ref={listRef} className="flex-1 overflow-y-auto p-1">
          {filtered.map((cred, i) => (
            <CredentialRow
              key={cred.id}
              credential={cred}
              selected={i === selectedIndex}
              onClick={() => onSelect(cred.id)}
              onMouseEnter={() => setSelectedIndex(i)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface CredentialRowProps {
  credential: CredentialMeta;
  selected: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
}

function CredentialRow({ credential, selected, onClick, onMouseEnter }: CredentialRowProps) {
  const type = resolveCredentialType(credential.credential_type);
  const tags = credential.tags.slice(0, MAX_TAGS);
  const hasAccount = Boolean(credential.username || credential.domain);
  const hasDescription = hasAccount || tags.length > 0;

  return (
    <ListRow
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      selected={selected}
      meta={type !== "generic" ? <Badge>{CREDENTIAL_TYPES[type].label}</Badge> : undefined}
      description={hasDescription ? <CredentialDescription credential={credential} tags={tags} hasAccount={hasAccount} /> : undefined}
      // A third line (tags) needs more than the two-line row height.
      className={tags.length > 0 ? "h-auto! py-1" : undefined}
    >
      <span className="text-ink">{credential.name}</span>
    </ListRow>
  );
}

function CredentialDescription({ credential, tags, hasAccount }: { credential: CredentialMeta; tags: string[]; hasAccount: boolean }) {
  return (
    <span className="flex flex-col gap-0.5">
      {hasAccount && (
        <span className="flex min-w-0 items-center gap-1.5">
          {credential.username && <span className="truncate">{credential.username}</span>}
          {credential.username && credential.domain && <span className="text-ink-faint">·</span>}
          {credential.domain && <span className="truncate">{credential.domain}</span>}
        </span>
      )}
      {tags.length > 0 && (
        <span className="flex flex-wrap gap-1">
          {tags.map((tag) => (
            <Badge key={tag} className="rounded-full">
              #{tag}
            </Badge>
          ))}
        </span>
      )}
    </span>
  );
}
