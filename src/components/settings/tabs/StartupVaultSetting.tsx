import { useEffect, useState } from "react";
import { useStartupVaultStore, type StartupVault } from "../../../stores/startupVaultStore";
import { useVaultStore } from "../../../stores/vaultStore";
import { useTeamStore } from "../../../stores/teamStore";
import { useAuthStore } from "../../../stores/authStore";
import { choiceFor } from "../../../lib/startup-vault";
import { isMacPlatform, toastAutoUnlockOff, toastStartupCleared, toastStartupSet, vaultName } from "../../../lib/startup-vault-copy";
import { errorText } from "../../../lib/errorText";
import { toast } from "../../common/Toast";
import ConfirmDialog from "../../common/ConfirmDialog";
import { Button, IconSlot, Kbd, SectionHeader, Select, SettingsRow } from "../../ui";

interface StartupVaultSettingProps {
  onOpenSecurity?: () => void;
}

/** The select's value: "automatic", "hub", "p:<path>" or "t:<team vault id>". */
export function startupValue(sv: StartupVault | null, teamMember: boolean): string {
  if (sv === null) return teamMember ? "automatic" : "hub";
  if (sv.kind === "hub") return "hub";
  return sv.kind === "team" ? `t:${sv.teamVaultId}` : `p:${sv.path}`;
}

function parentFolder(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts.length > 1 ? (parts[parts.length - 2] ?? "") : "";
}

/** Recent vaults as "{name}", or "{name} ({parent folder})" when two share a name (spec 2.4). */
export function personalLabels(paths: readonly string[]): ReadonlyMap<string, string> {
  const counts = new Map<string, number>();
  for (const p of paths) counts.set(vaultName(p), (counts.get(vaultName(p)) ?? 0) + 1);
  return new Map(paths.map((p) => [p, (counts.get(vaultName(p)) ?? 0) > 1 ? `${vaultName(p)} (${parentFolder(p)})` : vaultName(p)]));
}

/** Settings > General > Startup (docs/AUTO_UNLOCK.md 2.4). Acts at once; not part of Save. */
export default function StartupVaultSetting({ onOpenSecurity }: StartupVaultSettingProps) {
  const status = useStartupVaultStore((s) => s.status);
  const recentVaults = useVaultStore((s) => s.recentVaults);
  const teamVaults = useTeamStore((s) => s.teamVaults);
  const { isTeamMember, authMode } = useAuthStore();
  const [confirm, setConfirm] = useState<{ value: string; oldName: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void useStartupVaultStore.getState().refresh();
  }, []);

  const teamMember = isTeamMember && (authMode === "authenticated" || authMode === "cached");
  const sv = status?.startupVault ?? null;
  const value = startupValue(sv, teamMember);
  const personalPaths = sv?.kind === "personal" && !recentVaults.includes(sv.path) ? [...recentVaults, sv.path] : recentVaults;
  const labels = personalLabels(personalPaths);
  const teamName = (id: string) => teamVaults.find((t) => t.id === id)?.name ?? "Team vault";
  const nameOf = (v: string) => (v.startsWith("p:") ? vaultName(v.slice(2)) : v.startsWith("t:") ? teamName(v.slice(2)) : null);

  const apply = async (next: string) => {
    setBusy(true);
    try {
      const prevName = nameOf(value);
      const { forgot } = await useStartupVaultStore.getState().setStartup(choiceFor(next));
      if (forgot && prevName) toastAutoUnlockOff(prevName);
      const nextName = nameOf(next);
      if (nextName) toastStartupSet(nextName);
      else if (prevName) toastStartupCleared(prevName, false);
    } catch (err) {
      toast.error("Couldn't change the startup vault", errorText(err, "Try again."));
    } finally {
      setBusy(false);
    }
  };

  const onChange = (next: string) => {
    if (next === value) return;
    if (status?.savedPath && `p:${status.savedPath}` !== next) {
      setConfirm({ value: next, oldName: vaultName(status.savedPath) });
      return;
    }
    void apply(next);
  };

  const keys = isMacPlatform(status?.platform) ? (
    <>
      <Kbd>Shift</Kbd> or <Kbd>Option</Kbd>
    </>
  ) : (
    <Kbd>Shift</Kbd>
  );

  return (
    <div>
      <SectionHeader title="Startup" />
      <SettingsRow
        title="Open at startup"
        description={
          <>
            What Conduit shows when it starts. Hold {keys} while it starts to go to the Vault Hub once.
          </>
        }
      >
        <Select value={value} onChange={(e) => onChange(e.target.value)} disabled={busy} aria-label="Open at startup">
          {teamMember && <option value="automatic">Last team vault used</option>}
          <option value="hub">Vault Hub</option>
          {personalPaths.length > 0 && (
            <optgroup label="Personal vaults">
              {personalPaths.map((p) => (
                <option key={p} value={`p:${p}`}>
                  {labels.get(p)}
                </option>
              ))}
            </optgroup>
          )}
          {teamMember && teamVaults.length > 0 && (
            <optgroup label="Team vaults">
              {teamVaults.map((t) => (
                <option key={t.id} value={`t:${t.id}`}>
                  {t.name}
                </option>
              ))}
            </optgroup>
          )}
        </Select>
        {value === "automatic" && (
          <p className="mt-1 text-label text-ink-muted">
            Conduit reconnects to the team vault you used last, like today. Otherwise it shows the Vault Hub.
          </p>
        )}
        {sv?.kind === "team" && <p className="mt-1 text-label text-ink-muted">Team vaults open without a password on this computer.</p>}
        {sv?.kind === "personal" && status?.savedPath === sv.path && (
          <p className="mt-1 flex items-center gap-1 text-label text-ink-muted">
            <IconSlot icon="lockOpen" size={12} />
            Unlocks automatically on this computer. Change in{" "}
            <Button variant="link" size="sm" onClick={onOpenSecurity}>
              Security
            </Button>
          </p>
        )}
      </SettingsRow>
      {confirm && (
        <ConfirmDialog
          title="Turn off automatic unlock?"
          message={`${confirm.oldName} unlocks automatically at startup. Choosing another startup vault turns that off and forgets the saved password.`}
          confirmLabel="Continue"
          layer="stacked"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const next = confirm.value;
            setConfirm(null);
            void apply(next);
          }}
        />
      )}
    </div>
  );
}
