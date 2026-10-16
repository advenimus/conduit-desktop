import { useEffect, useState } from "react";
import { invoke } from "../../../lib/electron";
import { errorText } from "../../../lib/errorText";
import { updateCheckToast, type UpdateChannelInfo, type UpdateCheckResult } from "../../../lib/updateChannel";
import { toast } from "../../common/Toast";
import BetaPill from "../../common/BetaPill";
import { Button, SectionHeader, SettingsRow, Switch } from "../../ui";

function showCheckResult(result: UpdateCheckResult | null, version: string): void {
  const { title, message } = updateCheckToast(result, version);
  toast.info(title, message);
}

/** Settings > General > Updates (docs/BETA_CHANNEL.md). Acts at once; not part of Save. */
export default function UpdatesSetting() {
  const [info, setInfo] = useState<UpdateChannelInfo | null>(null);
  const [switching, setSwitching] = useState(false);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let alive = true;
    invoke<UpdateChannelInfo>("updater_get_channel")
      .then((next) => {
        if (alive) setInfo(next);
      })
      .catch((err) => console.warn("[updates] Could not read the update channel:", err));
    return () => {
      alive = false;
    };
  }, []);

  const setBetaUpdates = async (enabled: boolean) => {
    if (!info) return;
    setSwitching(true);
    try {
      const result = await invoke<UpdateCheckResult | null>("updater_set_beta_updates", { enabled });
      setInfo({ ...info, betaUpdates: enabled });
      if (!enabled) toast.success("Beta updates are off");
      else if (result) showCheckResult(result, info.version);
      else toast.success("Beta updates are on", "You'll get the next beta when it comes out.");
    } catch (err) {
      toast.error("Couldn't change beta updates", errorText(err, "Try again."));
    } finally {
      setSwitching(false);
    }
  };

  const checkNow = async () => {
    setChecking(true);
    try {
      const result = await invoke<UpdateCheckResult | null>("force_check_for_updates");
      showCheckResult(result, info?.version ?? "");
    } catch (err) {
      toast.error("Couldn't check for updates", errorText(err, "Try again."));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div>
      <SectionHeader title="Updates" />
      <SettingsRow
        title="Version"
        description={
          <span className="flex items-center gap-2">
            <span>{info?.version ?? ""}</span>
            {info && <BetaPill version={info.version} />}
          </span>
        }
      >
        <Button size="sm" onClick={() => void checkNow()} loading={checking} loadingLabel="Checking...">
          Check for updates
        </Button>
      </SettingsRow>
      <SettingsRow
        title="Get beta updates"
        description="Try new features early. Beta builds use your normal account and data."
        toggle={
          <Switch
            checked={info?.betaUpdates ?? false}
            onChange={(next) => void setBetaUpdates(next)}
            disabled={!info || switching}
          />
        }
      >
        {info?.isPrerelease && !info.betaUpdates && (
          <p className="text-label text-ink-muted">You'll move to the next regular release when it comes out.</p>
        )}
      </SettingsRow>
    </div>
  );
}
