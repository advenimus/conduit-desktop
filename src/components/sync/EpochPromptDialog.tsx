import { useState } from "react";
import { syncApi } from "../../lib/sync-api";
import { errorText } from "../../lib/errorText";
import { useSyncStore } from "../../stores/syncStore";
import { toast } from "../common/Toast";
import type { PasswordFlowResult, SyncPrompt } from "../../types/sync";
import SyncDialogFrame, { DialogButton } from "./SyncDialogFrame";
import { InlineError, PasswordField } from "./PasswordFields";
import { Radio, RadioGroup } from "../ui";
import { passwordChangedText } from "./PasswordChangedElsewhereDialog";

export type EpochPrompt = Extract<SyncPrompt, { kind: "epoch-newer" | "epoch-legacy" | "epoch-concurrent" }>;

type Keep = "this-device" | "other";

const FLOW_ERRORS: Readonly<Record<Exclude<PasswordFlowResult, { ok: true }>["reason"], string>> = {
  "wrong-password": "That password didn't work.",
  superseded: "That is an older password. Enter the newest one.",
  "needs-previous-password": "Enter your previous password too.",
};

function introFor(prompt: EpochPrompt): string {
  if (prompt.kind === "epoch-newer") return passwordChangedText(prompt.changedByDeviceName, prompt.changedMs);
  if (prompt.kind === "epoch-legacy") return "The master password was changed by an older Conduit app.";
  return "The master password was changed on two devices at the same time.";
}

/**
 * epochIds is [this device's epoch, the other epoch] (key-epoch-align order). Keeping this
 * device's password means its epoch wins.
 */
export function winnerEpochFor(prompt: Extract<SyncPrompt, { kind: "epoch-concurrent" }>, keep: Keep): string {
  const [own, other] = prompt.epochIds;
  return (keep === "this-device" ? own : other) ?? own ?? "";
}

async function runFlow(prompt: EpochPrompt, password: string, previous: string | null, keep: Keep): Promise<PasswordFlowResult> {
  if (prompt.kind === "epoch-newer") return syncApi.enterNewPassword(password);
  if (prompt.kind === "epoch-legacy") return syncApi.adoptLegacyPassword(password, previous);
  return syncApi.resolveConcurrentEpoch(password, winnerEpochFor(prompt, keep));
}

/** Running 4.8 prompts: syncing pauses until the user enters the password that opens the vault now. */
export default function EpochPromptDialog({ prompt }: { prompt: EpochPrompt }) {
  const [password, setPassword] = useState("");
  const [previous, setPrevious] = useState("");
  const [askPrevious, setAskPrevious] = useState(false);
  const [keep, setKeep] = useState<Keep>("this-device");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const concurrent = prompt.kind === "epoch-concurrent";

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await runFlow(prompt, password, askPrevious ? previous : null, keep);
      if (result.ok) {
        toast.success("Password updated. Syncing again.");
        await useSyncStore.getState().refresh();
        return;
      }
      if (result.reason === "needs-previous-password") setAskPrevious(true);
      setError(FLOW_ERRORS[result.reason]);
    } catch (err) {
      setError(errorText(err, "Could not update the password."));
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = password.length > 0 && (!askPrevious || previous.length > 0) && !busy;
  return (
    <SyncDialogFrame
      icon="key"
      tone="warn"
      title="Syncing paused"
      onSubmit={() => {
        if (canSubmit) void submit();
      }}
      footer={
        <>
          <DialogButton onClick={() => useSyncStore.getState().deferPrompt(prompt.id)} disabled={busy}>Later</DialogButton>
          <DialogButton type="submit" variant="primary" disabled={!canSubmit} loading={busy} loadingLabel="Checking...">
            Continue
          </DialogButton>
        </>
      }
    >
      <p className="text-ink">{introFor(prompt)}</p>
      <p>Your changes are saved on this device. {concurrent ? "Enter the password set on the other device." : "Enter the new password to keep syncing."}</p>
      <PasswordField label={concurrent ? "Other device's password" : "New master password"} value={password} onChange={setPassword} autoFocus />
      {askPrevious && <PasswordField label="Previous master password" value={previous} onChange={setPrevious} />}
      {concurrent && (
        <fieldset>
          <legend className="mb-1.5 text-body font-semibold text-ink">Which password do you want to keep?</legend>
          <RadioGroup value={keep} onChange={setKeep} name="keep" className="gap-1.5">
            <Radio value="this-device">The one I use on this device</Radio>
            <Radio value="other">The other device's password</Radio>
          </RadioGroup>
        </fieldset>
      )}
      <InlineError message={error} />
    </SyncDialogFrame>
  );
}
