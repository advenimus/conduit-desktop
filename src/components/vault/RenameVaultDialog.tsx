import { useState } from "react";
import { invoke } from "../../lib/electron";
import { useVaultStore } from "../../stores/vaultStore";
import { useTeamStore } from "../../stores/teamStore";
import { toast } from "../common/Toast";
import { Button, Callout, Dialog, FormField, TextInput } from "../ui";
import { errorText } from "../../lib/errorText";

interface RenameVaultDialogProps {
  onClose: () => void;
}

export default function RenameVaultDialog({ onClose }: RenameVaultDialogProps) {
  const { currentVaultPath, vaultType, teamVaultId } = useVaultStore();
  const { teamVaults } = useTeamStore();

  const isTeamVault = vaultType === "team";

  const currentName = isTeamVault
    ? teamVaults.find((v) => v.id === teamVaultId)?.name ?? ""
    : currentVaultPath
        ?.split(/[/\\]/)
        .pop()
        ?.replace(/\.conduit$/i, "") ?? "";

  const [newName, setNewName] = useState(currentName);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isValid = newName.trim().length > 0 && newName.trim() !== currentName;

  const handleRename = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;

    setLoading(true);
    setError(null);

    try {
      if (isTeamVault && teamVaultId) {
        await invoke("team_vault_rename", {
          teamVaultId,
          newName: newName.trim(),
        });
        await useTeamStore.getState().loadTeamVaults();
      } else {
        const newPath = await invoke<string>("vault_rename", {
          newName: newName.trim(),
        });
        const settings = await invoke<{ recent_vaults?: string[] }>(
          "settings_get",
        );
        useVaultStore.setState({
          currentVaultPath: newPath,
          recentVaults: settings.recent_vaults ?? [],
        });
      }

      toast.success(`Vault renamed to "${newName.trim()}"`);
      onClose();
    } catch (err) {
      setError(errorText(err, "Failed to rename vault"));
      setLoading(false);
    }
  };

  return (
    <Dialog
      open
      title="Rename Vault"
      description="Change the display name of this vault"
      icon="pencil"
      width={400}
      hideClose
      closeOnEscape={false}
      onClose={onClose}
      onSubmit={(e) => void handleRename(e)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!isValid} loading={loading}>
            Rename
          </Button>
        </>
      }
    >
      <FormField
        label="Vault Name"
        description={isTeamVault ? undefined : <>File will be renamed to &ldquo;{newName.trim() || "..."}.conduit&rdquo;</>}
      >
        <TextInput
          value={newName}
          onChange={(e) => {
            setNewName(e.target.value);
            setError(null);
          }}
          placeholder="Enter new vault name"
          autoFocus
        />
      </FormField>

      {error && <Callout tone="danger">{error}</Callout>}
    </Dialog>
  );
}
