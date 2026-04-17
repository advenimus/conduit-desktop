import { useState, useEffect, useRef } from "react";
import { useVaultStore } from "../../stores/vaultStore";
import type { CredentialMeta } from "../../types/credential";
import { resolveCredentialType, CREDENTIAL_TYPES } from "../../types/credential";
import {
  CheckIcon, CloseIcon, GlobeIcon, KeyIcon, SearchIcon, TagIcon, UserIcon
} from "../../lib/icons";

interface CredentialPickerProps {
  selectedId: string | null;
  onSelect: (credentialId: string | null) => void;
  onClose: () => void;
}

export default function CredentialPicker({ selectedId, onSelect, onClose }: CredentialPickerProps) {
  const { credentials } = useVaultStore();
  const [searchQuery, setSearchQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const filteredCredentials = searchQuery
    ? credentials.filter(
        (c) =>
          c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          (c.username && c.username.toLowerCase().includes(searchQuery.toLowerCase())) ||
          (c.domain && c.domain.toLowerCase().includes(searchQuery.toLowerCase())) ||
          c.tags.some((t) => t.toLowerCase().includes(searchQuery.toLowerCase()))
      )
    : credentials;

  const handleSelect = (id: string | null) => {
    onSelect(id);
    onClose();
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/50 z-[60]" onClick={onClose}>
      <div
        className="w-full max-w-md bg-panel rounded-lg shadow-xl max-h-[60vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-stroke">
          <div className="flex items-center gap-2">
            <KeyIcon size={18} className="text-conduit-400" />
            <h3 className="text-sm font-semibold">Select Credential</h3>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-raised rounded">
            <CloseIcon size={16} />
          </button>
        </div>

        {/* Search */}
        <div className="px-4 py-2 border-b border-stroke/50">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-well rounded">
            <SearchIcon size={14} className="text-ink-muted" />
            <input
              ref={searchRef}
              type="text"
              placeholder="Search credentials..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-ink-faint"
            />
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {/* None option */}
          <button
            onClick={() => handleSelect(null)}
            className="w-full px-4 py-2.5 flex items-center justify-between hover:bg-raised/30 text-left"
          >
            <span className="text-sm text-ink-secondary">None (use inline credentials)</span>
            {selectedId === null && (
              <CheckIcon size={16} className="text-conduit-400" />
            )}
          </button>

          <div className="border-t border-stroke/30" />

          {credentials.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-ink-faint">
              <KeyIcon size={32} className="mb-2 opacity-50" />
              <p className="text-sm">No credentials stored</p>
              <p className="text-xs mt-1">Create credentials via the sidebar or Credential Manager</p>
            </div>
          ) : filteredCredentials.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-ink-faint">
              <SearchIcon size={32} className="mb-2 opacity-50" />
              <p className="text-sm">No matching credentials</p>
            </div>
          ) : (
            <div className="divide-y divide-stroke/30">
              {filteredCredentials.map((cred) => (
                <CredentialOption
                  key={cred.id}
                  credential={cred}
                  isSelected={selectedId === cred.id}
                  onSelect={() => handleSelect(cred.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CredentialOption({
  credential,
  isSelected,
  onSelect,
}: {
  credential: CredentialMeta;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`w-full px-4 py-2.5 flex items-start justify-between hover:bg-raised/30 text-left ${
        isSelected ? "bg-conduit-500/10" : ""
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{credential.name}</span>
          {credential.credential_type && resolveCredentialType(credential.credential_type) !== "generic" && (
            <span className="px-1.5 py-0.5 text-[10px] font-medium bg-conduit-500/15 text-conduit-400 rounded">
              {CREDENTIAL_TYPES[resolveCredentialType(credential.credential_type)].label}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 mt-0.5 text-xs text-ink-muted">
          {credential.username && (
            <span className="flex items-center gap-1">
              <UserIcon size={11} />
              {credential.username}
            </span>
          )}
          {credential.domain && (
            <span className="flex items-center gap-1">
              <GlobeIcon size={11} />
              {credential.domain}
            </span>
          )}
        </div>
        {credential.tags.length > 0 && (
          <div className="flex items-center gap-1 mt-1">
            <TagIcon size={11} className="text-ink-faint" />
            {credential.tags.map((tag) => (
              <span
                key={tag}
                className="px-1.5 py-0.5 bg-raised text-ink-secondary text-[10px] rounded"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
      {isSelected && (
        <CheckIcon size={16} className="text-conduit-400 mt-0.5 ml-2 shrink-0" />
      )}
    </button>
  );
}
