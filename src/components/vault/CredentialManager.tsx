import { useState, useEffect } from "react";
import { useVaultStore } from "../../stores/vaultStore";
import { useTeamStore } from "../../stores/teamStore";
import UnlockDialog from "./UnlockDialog";
import CredentialForm from "./CredentialForm";
import type { CredentialMeta } from "../../types/credential";
import { resolveCredentialType, CREDENTIAL_TYPES } from "../../types/credential";
import {
  CloseIcon, GlobeIcon, KeyIcon, LockIcon, LockOpenIcon, PencilIcon, PlusIcon, SearchIcon, TagIcon, TrashIcon, UserIcon
} from "../../lib/icons";

interface CredentialManagerProps {
  onClose: () => void;
}

export default function CredentialManager({ onClose }: CredentialManagerProps) {
  const {
    isUnlocked,
    credentials,
    checkVaultStatus,
    lockVault,
    deleteCredential,
    vaultType,
    teamVaultId,
  } = useVaultStore();
  const activeTeamVault = useTeamStore((s) =>
    s.teamVaults.find((v) => v.id === teamVaultId)
  );

  const [searchQuery, setSearchQuery] = useState("");
  const [showUnlock, setShowUnlock] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | undefined>();
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    checkVaultStatus();
  }, [checkVaultStatus]);

  // If vault is not unlocked, prompt for unlock
  useEffect(() => {
    if (!isUnlocked) {
      setShowUnlock(true);
    }
  }, [isUnlocked]);

  const filteredCredentials = searchQuery
    ? credentials.filter(
        (c) =>
          c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          (c.username &&
            c.username.toLowerCase().includes(searchQuery.toLowerCase())) ||
          (c.domain &&
            c.domain.toLowerCase().includes(searchQuery.toLowerCase())) ||
          c.tags.some((t) =>
            t.toLowerCase().includes(searchQuery.toLowerCase())
          )
      )
    : credentials;

  const handleEdit = (id: string) => {
    setEditingId(id);
    setShowForm(true);
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteCredential(id);
      setDeletingId(null);
    } catch {
      // Error handled in store
    }
  };

  const handleFormClose = () => {
    setShowForm(false);
    setEditingId(undefined);
  };

  const handleFormSaved = () => {
    setShowForm(false);
    setEditingId(undefined);
  };

  const handleUnlockSuccess = () => {
    setShowUnlock(false);
  };

  const handleUnlockCancel = () => {
    setShowUnlock(false);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && !showForm && !showUnlock && !deletingId) {
      onClose();
    }
  };

  // Show unlock dialog if vault is locked
  if (showUnlock && !isUnlocked) {
    return (
      <UnlockDialog
        onSuccess={handleUnlockSuccess}
        onCancel={handleUnlockCancel}
      />
    );
  }

  return (
    <>
      <div
        className="fixed inset-0 flex items-center justify-center bg-black/50 z-50"
        onKeyDown={handleKeyDown}
      >
        <div className="w-full max-w-2xl bg-panel rounded-lg shadow-xl max-h-[80vh] flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-stroke">
            <div className="flex items-center gap-2">
              <KeyIcon size={20} className="text-conduit-400" />
              <h2 className="text-lg font-semibold">Credentials</h2>
              {vaultType === 'team' && activeTeamVault && (
                <span className="px-2 py-0.5 text-xs font-medium bg-conduit-500/10 text-conduit-400 rounded-full">
                  {activeTeamVault.name}
                </span>
              )}
              <span className="text-xs text-ink-faint ml-1">
                {credentials.length} stored
              </span>
            </div>
            <div className="flex items-center gap-1">
              {isUnlocked && (
                <button
                  onClick={() => lockVault()}
                  className="p-1.5 hover:bg-raised rounded text-ink-muted hover:text-amber-400"
                  title="Lock vault"
                >
                  <LockOpenIcon size={16} />
                </button>
              )}
              <button
                onClick={onClose}
                className="p-1 hover:bg-raised rounded"
              >
                <CloseIcon size={20} />
              </button>
            </div>
          </div>

          {/* Search + Add bar */}
          <div className="flex items-center gap-2 px-4 py-2 border-b border-stroke/50">
            <div className="flex-1 flex items-center gap-2 px-3 py-1.5 bg-well rounded">
              <SearchIcon size={16} className="text-ink-muted" />
              <input
                type="text"
                placeholder="Search credentials..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-ink-faint"
              />
            </div>
            <button
              onClick={() => {
                setEditingId(undefined);
                setShowForm(true);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-conduit-600 hover:bg-conduit-700 text-white rounded text-sm"
            >
              <PlusIcon size={16} />
              <span>Add</span>
            </button>
          </div>

          {/* Credential list */}
          <div className="flex-1 overflow-y-auto">
            {filteredCredentials.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-ink-faint">
                {credentials.length === 0 ? (
                  <>
                    <KeyIcon size={40} className="mb-3 opacity-50" />
                    <p className="text-sm">No credentials stored</p>
                    <p className="text-xs mt-1">
                      Click "Add" to create your first credential
                    </p>
                  </>
                ) : (
                  <>
                    <SearchIcon size={40} className="mb-3 opacity-50" />
                    <p className="text-sm">No matching credentials</p>
                  </>
                )}
              </div>
            ) : (
              <div className="divide-y divide-stroke/50">
                {filteredCredentials.map((cred) => (
                  <CredentialRow
                    key={cred.id}
                    credential={cred}
                    isDeleting={deletingId === cred.id}
                    onEdit={() => handleEdit(cred.id)}
                    onDeleteStart={() => setDeletingId(cred.id)}
                    onDeleteConfirm={() => handleDelete(cred.id)}
                    onDeleteCancel={() => setDeletingId(null)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Footer info */}
          <div className="px-4 py-2 border-t border-stroke text-xs text-ink-faint flex items-center gap-1.5">
            <LockIcon size={12} />
            <span>
              {vaultType === 'team'
                ? 'End-to-end encrypted with zero-knowledge team key'
                : 'Credentials are encrypted with AES-256-GCM'}
            </span>
          </div>
        </div>
      </div>

      {/* Credential form modal */}
      {showForm && (
        <CredentialForm
          editId={editingId}
          onClose={handleFormClose}
          onSaved={handleFormSaved}
        />
      )}
    </>
  );
}

function CredentialRow({
  credential,
  isDeleting,
  onEdit,
  onDeleteStart,
  onDeleteConfirm,
  onDeleteCancel,
}: {
  credential: CredentialMeta;
  isDeleting: boolean;
  onEdit: () => void;
  onDeleteStart: () => void;
  onDeleteConfirm: () => void;
  onDeleteCancel: () => void;
}) {
  return (
    <div className="px-4 py-3 hover:bg-raised/30 group">
      {isDeleting ? (
        <div className="flex items-center justify-between">
          <p className="text-sm text-red-400">
            Delete "{credential.name}"?
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={onDeleteCancel}
              className="px-3 py-1 text-xs hover:bg-raised rounded"
            >
              Cancel
            </button>
            <button
              onClick={onDeleteConfirm}
              className="px-3 py-1 text-xs bg-red-600 hover:bg-red-700 rounded"
            >
              Delete
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm">{credential.name}</span>
              {credential.credential_type && resolveCredentialType(credential.credential_type) !== "generic" && (
                <span className="px-1.5 py-0.5 text-[10px] font-medium bg-conduit-500/15 text-conduit-400 rounded">
                  {CREDENTIAL_TYPES[resolveCredentialType(credential.credential_type)].label}
                </span>
              )}
            </div>
            <div className="flex items-center gap-4 mt-1 text-xs text-ink-muted">
              {credential.username && (
                <span className="flex items-center gap-1">
                  <UserIcon size={12} />
                  {credential.username}
                </span>
              )}
              {credential.domain && (
                <span className="flex items-center gap-1">
                  <GlobeIcon size={12} />
                  {credential.domain}
                </span>
              )}
            </div>
            {credential.tags.length > 0 && (
              <div className="flex items-center gap-1.5 mt-1.5">
                <TagIcon size={12} className="text-ink-faint" />
                {credential.tags.map((tag) => (
                  <span
                    key={tag}
                    className="px-1.5 py-0.5 bg-raised text-ink-secondary text-xs rounded"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity ml-2">
            <button
              onClick={onEdit}
              className="p-1.5 hover:bg-raised rounded text-ink-muted hover:text-ink"
              title="Edit credential"
            >
              <PencilIcon size={16} />
            </button>
            <button
              onClick={onDeleteStart}
              className="p-1.5 hover:bg-raised rounded text-ink-muted hover:text-red-400"
              title="Delete credential"
            >
              <TrashIcon size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
