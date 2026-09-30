import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { QUICK_SEARCH_LIMIT } from "../../../types/dashboard";
import { useEntryStore } from "../../../stores/entryStore";
import { useTeamStore } from "../../../stores/teamStore";
import { useVaultStore } from "../../../stores/vaultStore";
import { openFolderView } from "../../../lib/openDashboard";
import { Button, Card, Kbd, ListRow, SearchInput } from "../../ui";
import { EntryIcon, FolderIcon, openHomeEntry, typeLabel } from "./entryDisplay";
import { searchQuick, type QuickResult } from "./quickSearch";

const IS_MAC = navigator.platform.toUpperCase().includes("MAC");
const CREATE_DISABLED_REASON = "View-only access";

function openResult(result: QuickResult): void {
  if (result.kind === "folder") openFolderView(result.id);
  else openHomeEntry(result.entry);
}

export default function QuickBar() {
  const entries = useEntryStore((s) => s.entries);
  const folders = useEntryStore((s) => s.folders);
  const isTeamVault = useVaultStore((s) => s.vaultType === "team");
  const canCreate = useTeamStore((s) => s.canCreate);
  const createDisabled = isTeamVault && !canCreate();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const results = useMemo(() => searchQuick(query, entries, folders, QUICK_SEARCH_LIMIT), [query, entries, folders]);
  const open = query.trim() !== "";
  const optionId = (index: number) => `${listId}-option-${index}`;

  const changeQuery = (value: string) => {
    setQuery(value);
    setActive(0);
  };

  const choose = (result: QuickResult) => {
    openResult(result);
    changeQuery("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (query) changeQuery("");
      else inputRef.current?.blur();
      return;
    }
    if (!open || results.length === 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + step + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const result = results[active];
      if (result) choose(result);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <SearchInput
          ref={inputRef}
          value={query}
          onChange={changeQuery}
          onKeyDown={onKeyDown}
          placeholder="Search entries and folders..."
          aria-label="Search entries and folders"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && results.length > 0 ? optionId(active) : undefined}
          wrapperClassName="flex-1"
        />
        <Button variant="primary" className="gap-2" onClick={() => document.dispatchEvent(new CustomEvent("conduit:quick-connect"))}>
          Quick Connect
          <Kbd onFilled>{IS_MAC ? "⌘N" : "Ctrl+N"}</Kbd>
        </Button>
        <Button
          icon="plus"
          disabled={createDisabled}
          title={createDisabled ? CREATE_DISABLED_REASON : undefined}
          onClick={() => document.dispatchEvent(new CustomEvent("conduit:new-entry"))}
        >
          New Entry
        </Button>
      </div>
      {open && (
        <Card>
          {results.length === 0 ? (
            <p className="text-label text-ink-faint">No entries or folders match</p>
          ) : (
            <div id={listId} role="listbox" aria-label="Search results" className="space-y-px">
              {results.map((result, index) => (
                <ListRow
                  key={`${result.kind}:${result.id}`}
                  id={optionId(index)}
                  role="option"
                  tabIndex={-1}
                  selected={index === active}
                  leading={result.kind === "folder" ? <FolderIcon folder={result.folder} /> : <EntryIcon entry={result.entry} />}
                  meta={result.kind === "folder" ? typeLabel("folder") : typeLabel(result.entry.entry_type)}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(result)}
                >
                  {result.name}
                </ListRow>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
