import { useState, useEffect, useRef, useMemo } from "react";
import type { CredentialMeta } from "../../types/credential";
import { resolveCredentialType, CREDENTIAL_TYPES } from "../../types/credential";

interface PickerCredentialListProps {
  credentials: CredentialMeta[];
  onSelect: (id: string) => void;
}

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
    <div className="flex flex-col h-full" onKeyDown={handleKeyDown}>
      {/* Search bar */}
      <div className="px-3 py-2 border-b border-stroke-dim shrink-0">
        <div className="relative">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
          <input
            ref={searchRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search credentials..."
            className="w-full pl-8 pr-3 py-1.5 text-sm bg-well border border-stroke-dim rounded-md text-ink placeholder:text-ink-faint focus:outline-none focus:border-conduit-500 focus:ring-1 focus:ring-conduit-500"
          />
        </div>
      </div>

      {/* Credential list */}
      <div ref={listRef} className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full text-sm text-ink-muted">
            {search ? "No matches" : "No credentials"}
          </div>
        ) : (
          filtered.map((cred, i) => {
            const type = resolveCredentialType(cred.credential_type);
            const typeLabel = CREDENTIAL_TYPES[type].label;
            const isSelected = i === selectedIndex;

            return (
              <button
                key={cred.id}
                onClick={() => onSelect(cred.id)}
                onMouseEnter={() => setSelectedIndex(i)}
                className={`w-full text-left px-3 py-2.5 border-b border-stroke-dim transition-colors ${
                  isSelected ? "bg-conduit-500/10" : "hover:bg-well"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-ink truncate">{cred.name}</span>
                  {type !== "generic" && (
                    <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-well text-ink-muted font-medium uppercase tracking-wide">
                      {typeLabel}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  {cred.username && (
                    <span className="text-xs text-ink-muted truncate">{cred.username}</span>
                  )}
                  {cred.username && cred.domain && (
                    <span className="text-xs text-ink-faint">·</span>
                  )}
                  {cred.domain && (
                    <span className="text-xs text-ink-muted truncate">{cred.domain}</span>
                  )}
                </div>
                {cred.tags.length > 0 && (
                  <div className="flex gap-1 mt-1 flex-wrap">
                    {cred.tags.slice(0, 3).map((tag) => (
                      <span
                        key={tag}
                        className="text-[10px] px-1.5 py-0.5 rounded-full bg-conduit-500/10 text-conduit-500"
                      >
                        #{tag}
                      </span>
                    ))}
                  </div>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
