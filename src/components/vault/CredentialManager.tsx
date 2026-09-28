import { useState, useEffect } from "react";
import { useVaultStore } from "../../stores/vaultStore";
import { useTeamStore } from "../../stores/teamStore";
import UnlockDialog from "./UnlockDialog";
import CredentialForm from "./CredentialForm";
import type { CredentialMeta } from "../../types/credential";
import { resolveCredentialType, CREDENTIAL_TYPES } from "../../types/credential";
import { GlobeIcon, LockIcon, SearchIcon, TagIcon, UserIcon } from "../../lib/icons";
import { Badge, Button, Dialog, DialogHeader, EmptyState, IconButton, TextInput } from "../ui";

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
      <Dialog
        open
        title="Credentials"
        icon="key"
        width={672}
        style={{ maxHeight: "80vh" }}
        closeOnEscape={!showForm && !showUnlock && !deletingId}
        onClose={onClose}
        layout="custom"
      >
        <DialogHeader
          subtitle={
            <>
              {vaultType === "team" && activeTeamVault && <Badge tone="accent">{activeTeamVault.name}</Badge>}
              <span>{credentials.length} stored</span>
            </>
          }
        >
          {isUnlocked && <IconButton icon="lockOpen" label="Lock vault" onClick={() => lockVault()} />}
        </DialogHeader>

        <div className="flex items-center gap-2 border-b border-divider px-4 pb-2">
          <TextInput
            leading={<SearchIcon size={16} />}
            placeholder="Search credentials..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <Button
            variant="primary"
            icon="plus"
            onClick={() => {
              setEditingId(undefined);
              setShowForm(true);
            }}
          >
            Add
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {filteredCredentials.length === 0 ? (
            credentials.length === 0 ? (
              <div className="py-4">
                <EmptyState icon="key" title="No credentials stored" description='Click "Add" to create your first credential' />
              </div>
            ) : (
              <div className="py-4">
                <EmptyState icon="search" title="No matching credentials" />
              </div>
            )
          ) : (
            <div className="divide-y divide-divider">
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

        <div className="flex items-center gap-1.5 border-t border-divider px-4 py-2 text-label text-ink-faint">
          <LockIcon size={12} compact />
          <span>
            {vaultType === "team"
              ? "End-to-end encrypted with zero-knowledge team key"
              : "Credentials are encrypted with AES-256-GCM"}
          </span>
        </div>
      </Dialog>

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
  const type = resolveCredentialType(credential.credential_type);
  return (
    <div className="group px-4 py-3 hover:bg-hover">
      {isDeleting ? (
        <div className="flex items-center justify-between">
          <p className="text-body text-danger">Delete "{credential.name}"?</p>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={onDeleteCancel}>
              Cancel
            </Button>
            <Button size="sm" variant="danger" onClick={onDeleteConfirm}>
              Delete
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-start justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-body font-medium text-ink">{credential.name}</span>
              {credential.credential_type && type !== "generic" && <Badge>{CREDENTIAL_TYPES[type].label}</Badge>}
            </div>
            <div className="mt-1 flex items-center gap-4 text-label text-ink-muted">
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
              <div className="mt-1.5 flex items-center gap-1.5">
                <TagIcon size={12} compact className="text-ink-faint" />
                {credential.tags.map((tag) => (
                  <Badge key={tag}>{tag}</Badge>
                ))}
              </div>
            )}
          </div>
          <div className="ml-2 flex items-center gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
            <IconButton icon="pencil" label="Edit credential" onClick={onEdit} />
            <IconButton icon="trash" tone="danger" label="Delete credential" onClick={onDeleteStart} />
          </div>
        </div>
      )}
    </div>
  );
}
