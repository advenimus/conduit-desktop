import { useEffect, useState } from "react";
import { invoke, listenSync } from "../../lib/electron";
import { errorText } from "../../lib/errorText";
import { toast } from "../common/Toast";
import { Button, Callout, Dialog } from "../ui";
import type {
  CertAnswer,
  CertProblem,
  CertPromptInfo as CertPromptRequest,
} from "../../../electron/services/rdp/cert-trust/cert-prompts";

export type { CertAnswer, CertProblem, CertPromptRequest };

export const CERT_PROMPT_EVENT = "rdp:cert_prompt";
export const CERT_PROMPT_RESOLVED_EVENT = "rdp:cert_prompt_resolved";

const LABEL = "text-label text-ink-faint";
const VALUE = "text-body text-ink allow-select break-words";
const MONO = "font-mono text-meta text-ink allow-select break-all";

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function placeOf(req: CertPromptRequest): string {
  const host = req.host.includes(":") ? `[${req.host}]` : req.host;
  return `${host}:${req.port}`;
}

function problemText(problem: CertProblem, req: CertPromptRequest): string {
  switch (problem) {
    case "untrusted":
      return "It is not issued by an authority this computer trusts.";
    case "name":
      return `The name on it does not match ${req.host}.`;
    case "unverified":
      return "Conduit could not fully verify it.";
    case "expired":
      return `It expired on ${formatDate(req.valid_to)}.`;
    case "not-yet-valid":
      return `It is not valid until ${formatDate(req.valid_from)}.`;
  }
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className={LABEL}>{label}</p>
      <p className={mono ? MONO : VALUE}>{value}</p>
    </div>
  );
}

/**
 * Asks whether to trust an RDP host or gateway certificate the helper could not verify, like mstsc.
 * Questions queue; each one times out to Cancel in the main process, which closes it here too.
 */
export default function CertificatePromptDialog() {
  const [queue, setQueue] = useState<CertPromptRequest[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const add = (req: CertPromptRequest) =>
      setQueue((q) => (q.some((r) => r.request_id === req.request_id) ? q : [...q, req]));
    const offRequest = listenSync<CertPromptRequest>(CERT_PROMPT_EVENT, ({ payload }) => add(payload));
    const offResolved = listenSync<{ request_id: string }>(CERT_PROMPT_RESOLVED_EVENT, ({ payload }) =>
      setQueue((q) => q.filter((r) => r.request_id !== payload.request_id)),
    );
    invoke<CertPromptRequest[]>("rdp_cert_prompt_list_pending")
      .then((pending) => pending.forEach(add))
      .catch((err) => console.warn("[rdp-cert] could not list pending questions", err));
    return () => {
      offRequest();
      offResolved();
    };
  }, []);

  const current = queue[0];
  if (!current) return null;

  const respond = async (answer: CertAnswer) => {
    setBusy(true);
    try {
      await invoke("rdp_cert_prompt_respond", { request_id: current.request_id, answer });
    } catch (err) {
      toast.error("Certificate answer not sent", errorText(err, "Could not send your answer"));
    } finally {
      setQueue((q) => q.filter((r) => r.request_id !== current.request_id));
      setBusy(false);
    }
  };

  const changed = current.kind === "changed" && current.previous;
  const what = current.hop === "gateway" ? "the gateway" : "the computer";

  return (
    <Dialog
      open
      title={changed ? "Certificate changed" : "Trust this certificate?"}
      icon={changed ? "alertTriangle" : "lock"}
      tone={changed ? "danger" : "warn"}
      width={520}
      layer="stacked"
      hideClose
      closeOnEscape={false}
      onClose={() => void respond("cancel")}
      harnessLabel="RDP certificate"
      footer={
        <>
          <Button onClick={() => void respond("cancel")} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void respond("once")} disabled={busy}>
            Trust once
          </Button>
          <Button variant={changed ? "danger" : "primary"} onClick={() => void respond("always")} loading={busy}>
            Always trust
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {current.origin === "agent" && <p className="text-body text-ink-muted">An AI agent is opening this connection.</p>}
        {changed ? (
          <Callout tone="danger">
            The certificate of {what} <span className="font-semibold">{placeOf(current)}</span> is not the one you trusted on{" "}
            {formatDate(current.previous!.trusted_at)}. This happens when a certificate is renewed, but it can also mean someone
            is intercepting the connection. Check with the server's admin before you trust it.
          </Callout>
        ) : (
          <p className="text-ink">
            Conduit could not verify the certificate of {what}{" "}
            <span className="font-semibold allow-select">{placeOf(current)}</span>
            {current.connection_name ? <> for {current.connection_name}</> : null}.
          </p>
        )}

        {current.problems.length > 0 && (
          <ul className="list-disc space-y-1 pl-5 text-body text-ink">
            {current.problems.map((p) => (
              <li key={p}>{problemText(p, current)}</li>
            ))}
          </ul>
        )}

        <div className="space-y-2 rounded-md border border-card-border bg-well px-3 py-2">
          <Detail label="Issued to" value={current.subject || "(none)"} />
          <Detail label="Issued by" value={current.issuer || "(none)"} />
          <Detail label="Valid" value={`${formatDate(current.valid_from)} to ${formatDate(current.valid_to)}`} />
          <Detail label={changed ? "New SHA-256 fingerprint" : "SHA-256 fingerprint"} value={current.fingerprint} mono />
          {changed && <Detail label="Trusted SHA-256 fingerprint" value={current.previous!.fingerprint} mono />}
        </div>

        <p className="text-body text-ink-muted">
          Compare the fingerprint with the one the server's admin gives you. Always trust remembers it on this device for{" "}
          {placeOf(current)}. No answer in a minute counts as Cancel.
        </p>
        {queue.length > 1 && <p className="text-label text-ink-faint">{queue.length - 1} more waiting</p>}
      </div>
    </Dialog>
  );
}
