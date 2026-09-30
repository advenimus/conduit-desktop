import { useState, useRef } from "react";
import { useVaultStore } from "../../stores/vaultStore";
import type { CredentialMeta } from "../../types/credential";
import { resolveCredentialType, CREDENTIAL_TYPES } from "../../types/credential";
import { CheckIcon, GlobeIcon, SearchIcon, TagIcon, UserIcon } from "../../lib/icons";
import { Badge, Dialog, DialogHeader, EmptyState, TextInput, cx } from "../ui";

interface CredentialPickerProps {
  selectedId: string | null;
  onSelect: (credentialId: string | null) => void;
  onClose: () => void;
}

export default function CredentialPicker({ selectedId, onSelect, onClose }: CredentialPickerProps) {
  const { credentials } = useVaultStore();
  const [searchQuery, setSearchQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

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
    <Dialog
      open
      title="Select Credential"
      icon="key"
      width={448}
      style={{ maxHeight: "60vh" }}
      layer="sync"
      closeOnScrim
      onClose={onClose}
      initialFocusRef={searchRef}
      layout="custom"
    >
      <DialogHeader />

      <div className="border-b border-divider px-4 pb-2">
        <TextInput
          ref={searchRef}
          leading={<SearchIcon size={16} />}
          placeholder="Search credentials..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        <button
          type="button"
          onClick={() => handleSelect(null)}
          {...(selectedId === null ? { "data-selected": "" } : {})}
          className={cx(
            "flex w-full items-center justify-between rounded px-3 py-2 text-left",
            selectedId === null ? "bg-selected text-ink" : "text-ink-secondary hover:bg-hover",
          )}
        >
          <span className="text-body">None (use inline credentials)</span>
          {selectedId === null && <CheckIcon size={16} className="text-link" />}
        </button>

        <div className="my-1 h-px bg-divider" />

        {credentials.length === 0 ? (
          <EmptyState icon="key" title="No credentials stored" description="Create credentials via the sidebar or Credential Manager" />
        ) : filteredCredentials.length === 0 ? (
          <EmptyState icon="search" title="No matching credentials" />
        ) : (
          <div className="space-y-px">
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
    </Dialog>
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
  const type = resolveCredentialType(credential.credential_type);
  return (
    <button
      type="button"
      onClick={onSelect}
      {...(isSelected ? { "data-selected": "" } : {})}
      className={cx(
        "flex w-full items-start justify-between rounded px-3 py-2 text-left",
        isSelected ? "bg-selected text-ink" : "text-ink-secondary hover:bg-hover",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-body font-medium text-ink">{credential.name}</span>
          {credential.credential_type && type !== "generic" && <Badge>{CREDENTIAL_TYPES[type].label}</Badge>}
        </div>
        <div className="mt-0.5 flex items-center gap-3 text-label text-ink-muted">
          {credential.username && (
            <span className="flex items-center gap-1">
              <UserIcon size={12} compact />
              {credential.username}
            </span>
          )}
          {credential.domain && (
            <span className="flex items-center gap-1">
              <GlobeIcon size={12} compact />
              {credential.domain}
            </span>
          )}
        </div>
        {credential.tags.length > 0 && (
          <div className="mt-1 flex items-center gap-1">
            <TagIcon size={12} compact className="text-ink-faint" />
            {credential.tags.map((tag) => (
              <Badge key={tag}>{tag}</Badge>
            ))}
          </div>
        )}
      </div>
      {isSelected && <CheckIcon size={16} className="ml-2 mt-0.5 shrink-0 text-link" />}
    </button>
  );
}
