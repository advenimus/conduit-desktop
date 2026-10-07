import { useEffect, useState } from "react";
import { invoke, listenSync } from "../../lib/electron";
import { errorText } from "../../lib/errorText";
import { Button, Callout, Dialog } from "../ui";

export interface RevealRequest {
  request_id: string;
  agent_name: string | null;
  kind: "credential" | "secret";
  target_id: string;
  target_name: string;
  owner_name: string | null;
  purpose: string;
}

export const REVEAL_REQUEST_EVENT = "mcp:approval_request";
export const REVEAL_RESOLVED_EVENT = "mcp:approval_resolved";

/**
 * Asks the user before an agent sees a secret's plain value. Requests queue; each one times out
 * to Deny in the main process, which closes it here too.
 */
export default function RevealApprovalDialog() {
  const [queue, setQueue] = useState<RevealRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const add = (req: RevealRequest) =>
      setQueue((q) => (q.some((r) => r.request_id === req.request_id) ? q : [...q, req]));
    const offRequest = listenSync<RevealRequest>(REVEAL_REQUEST_EVENT, ({ payload }) => add(payload));
    const offResolved = listenSync<{ request_id: string }>(REVEAL_RESOLVED_EVENT, ({ payload }) =>
      setQueue((q) => q.filter((r) => r.request_id !== payload.request_id)),
    );
    invoke<RevealRequest[]>("approval_list_pending")
      .then((pending) => pending.forEach(add))
      .catch((err) => console.warn("[reveal] could not list pending requests", err));
    return () => {
      offRequest();
      offResolved();
    };
  }, []);

  const current = queue[0];
  if (!current) return null;

  const respond = async (approved: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await invoke("approval_respond", { request_id: current.request_id, approved });
    } catch (err) {
      setError(errorText(err, "Could not send your answer"));
    } finally {
      setQueue((q) => q.filter((r) => r.request_id !== current.request_id));
      setBusy(false);
    }
  };

  const agent = current.agent_name ?? "An AI agent";
  const what = current.owner_name ? `${current.target_name} on ${current.owner_name}` : current.target_name;

  return (
    <Dialog
      open
      title="Show a secret to an agent?"
      icon="lock"
      tone="warn"
      width={448}
      layer="stacked"
      hideClose
      closeOnEscape={false}
      onClose={() => void respond(false)}
      harnessLabel="Reveal secret"
      footer={
        <>
          <Button onClick={() => void respond(false)} disabled={busy}>
            Deny
          </Button>
          <Button variant="primary" onClick={() => void respond(true)} loading={busy}>
            Allow once
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-ink">
          <span className="font-semibold">{agent}</span> wants to see the plain value of{" "}
          <span className="font-semibold">{what}</span>.
        </p>
        <div className="rounded-md border border-card-border bg-well px-3 py-2">
          <p className="text-label text-ink-faint">Reason it gave</p>
          <p className="text-body text-ink allow-select">{current.purpose}</p>
        </div>
        <p className="text-body text-ink-muted">
          Agents can type this secret without seeing it. Allow only if the value itself must be shown. No answer in a
          minute counts as Deny.
        </p>
        {queue.length > 1 && <p className="text-label text-ink-faint">{queue.length - 1} more waiting</p>}
        {error && <Callout tone="danger">{error}</Callout>}
      </div>
    </Dialog>
  );
}
