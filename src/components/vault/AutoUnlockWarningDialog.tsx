import { useState } from "react";
import { useVaultStore } from "../../stores/vaultStore";
import { useTeamStore } from "../../stores/teamStore";
import { useAuthStore } from "../../stores/authStore";
import { useStartupVaultStore, type EnableProof, type StartupVault } from "../../stores/startupVaultStore";
import { errorText } from "../../lib/errorText";
import { toast } from "../common/Toast";
import { AUTO_UNLOCK_WARNING, PROOF_EXPIRED_MESSAGE, isMacPlatform, toastAutoUnlockOff, toastAutoUnlockOn, vaultFileName, vaultName } from "../../lib/startup-vault-copy";
import { Button, Callout, Dialog, FormField, PasswordInput, type DialogLayer } from "../ui";

interface AutoUnlockWarningDialogProps {
  /** "after-unlock": the password was just proven in the unlock dialog. "settings": prove it now. */
  mode: "after-unlock" | "settings";
  layer?: DialogLayer;
  onClose: (turnedOn: boolean) => void;
}

interface ReplacementInput {
  readonly startup: StartupVault | null;
  readonly currentPath: string;
  readonly name: string;
  readonly isTeamMember: boolean;
  readonly teamName: (id: string) => string | null;
}

/** docs/AUTO_UNLOCK.md 2.2: what the new startup vault replaces, or null when it is this vault already. */
export function replacementLine({ startup, currentPath, name, isTeamMember, teamName }: ReplacementInput): string | null {
  if (startup === null) return isTeamMember ? `Conduit will open ${name} instead of your last team vault.` : `Conduit will open ${name} instead of the Vault Hub.`;
  if (startup.kind === "hub") return `Conduit will open ${name} instead of the Vault Hub.`;
  if (startup.kind === "team") return `Conduit will open ${name} instead of the team vault ${teamName(startup.teamVaultId) ?? ""}`.trimEnd() + ".";
  if (startup.path === currentPath) return null;
  return `Conduit will open ${name} instead of ${vaultFileName(startup.path)}.`;
}

export default function AutoUnlockWarningDialog({ mode, layer, onClose }: AutoUnlockWarningDialogProps) {
  const { currentVaultPath, biometricAvailable, biometricEnabled, enableBiometric } = useVaultStore();
  const status = useStartupVaultStore((s) => s.status);
  const teamVaults = useTeamStore((s) => s.teamVaults);
  const isTeamMember = useAuthStore((s) => s.isTeamMember);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The unlock proof from the unlock dialog lasts 120 s; after that the password is asked for here.
  const [needsPassword, setNeedsPassword] = useState(mode === "settings");

  const path = currentVaultPath ?? "";
  const name = vaultName(path);
  const platform = status?.platform ?? null;
  const storeName = status?.store.storeName ?? "system keychain";
  const touchIdHere = isMacPlatform(platform) && biometricAvailable;
  const otherSaved = status?.savedPath != null && status.savedPath !== path ? status.savedPath : null;
  const replacement = replacementLine({
    startup: status?.startupVault ?? null,
    currentPath: path,
    name,
    isTeamMember,
    teamName: (id) => teamVaults.find((t) => t.id === id)?.name ?? null,
  });

  const turnOn = async (proof: EnableProof) => {
    setBusy(true);
    setError(null);
    try {
      await useStartupVaultStore.getState().enable(proof);
      if (otherSaved) toastAutoUnlockOff(vaultName(otherSaved));
      toastAutoUnlockOn(name, platform);
      onClose(true);
    } catch (err) {
      const message = errorText(err, "Couldn't turn on automatic unlock.");
      if (proof.kind === "recent-unlock" && message === PROOF_EXPIRED_MESSAGE) setNeedsPassword(true);
      else setError(message);
    } finally {
      setBusy(false);
    }
  };

  const useTouchIdInstead = async () => {
    setBusy(true);
    setError(null);
    try {
      const { forgot } = await useStartupVaultStore.getState().setStartup({ kind: "personal", path });
      if (forgot && otherSaved) toastAutoUnlockOff(vaultName(otherSaved));
      if (!biometricEnabled) await enableBiometric();
      toast.success(`${name} opens at startup`, "Touch ID unlocks it.");
      onClose(false);
    } catch (err) {
      setError(errorText(err, "Couldn't set up Touch ID for this vault."));
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    if (busy) return;
    if (!needsPassword) void turnOn({ kind: "recent-unlock" });
    else if (password.length > 0) void turnOn({ kind: "password", password });
  };

  return (
    <Dialog
      open
      tone="warn"
      icon="alertTriangle"
      title={`Unlock ${name} automatically?`}
      width={420}
      layer={layer}
      hideClose
      closeOnEscape
      closeOnScrim
      onClose={() => onClose(false)}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      data-cv-auto-unlock-warning=""
      footer={
        <>
          <Button onClick={() => onClose(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || (needsPassword && password.length === 0)} loading={busy} loadingLabel="Turning on...">
            Turn On
          </Button>
        </>
      }
    >
      <p className="text-ink-muted">
        Conduit will keep the master password for {vaultFileName(path)} in the {storeName} and open this vault when Conduit starts, without asking.
      </p>
      <Callout tone="warning">{AUTO_UNLOCK_WARNING}</Callout>
      {replacement && <p className="text-ink-muted">{replacement}</p>}
      {otherSaved && <p className="text-ink-muted">{vaultName(otherSaved)} will stop unlocking automatically.</p>}
      {needsPassword && (
        <>
          <p className="text-ink-muted">
            {mode === "settings" ? "Enter your master password to turn this on." : "It's been a while since you unlocked. Enter your master password to turn this on."}
          </p>
          <FormField label="Master Password">
            <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter master password" autoFocus disabled={busy} />
          </FormField>
          {touchIdHere && biometricEnabled && (
            <Button icon="fingerprint" fullWidth onClick={() => void turnOn({ kind: "biometric" })} disabled={busy}>
              Use Touch ID
            </Button>
          )}
        </>
      )}
      {touchIdHere && (
        <p className="text-meta text-ink-muted">
          Safer: open {name} at startup and unlock it with Touch ID.{" "}
          <Button variant="link" size="sm" onClick={() => void useTouchIdInstead()} disabled={busy}>
            Use Touch ID Instead
          </Button>
        </p>
      )}
      {error && <Callout tone="danger">{error}</Callout>}
    </Dialog>
  );
}
