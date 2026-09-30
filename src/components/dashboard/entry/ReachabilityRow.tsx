import { useEffect, useState } from "react";
import { PlugIcon } from "../../../lib/icons";
import type { EntryMeta } from "../../../types/entry";
import type { ReachabilityResult } from "../../../types/dashboard";
import { Badge, Button, Spinner } from "../../ui";
import { DetailRow } from "../EntryDetailParts";
import { formatRelativeTime } from "../relativeTime";
import { reachabilityHint, reachabilityText } from "../reachability/reachabilityCopy";
import { expectedPort } from "../reachability/reachabilityTarget";
import { useReachability } from "../reachability/useReachability";

const RELATIVE_TICK_MS = 30_000;

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

function ResultLine({ result }: { result: ReachabilityResult }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), RELATIVE_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const text = reachabilityText(result);
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <Badge tone={text.tone} className="shrink-0 self-center">
        {text.badge}
      </Badge>
      <span className="min-w-0">
        {text.detail} {"·"} checked {lowerFirst(formatRelativeTime(result.checkedAt))}
      </span>
    </span>
  );
}

/** The "Is it up?" row of the entry info tab (docs/DASHBOARD.md 6.1). */
export default function ReachabilityRow({ entry }: { entry: EntryMeta }) {
  const { results, checking, check } = useReachability();
  const result = results[entry.id];
  const busy = checking.has(entry.id);
  const port = result?.port ?? expectedPort(entry);

  const value = (
    <div data-cv-reachability="">
      <div className="flex min-h-5 items-center">
        {busy ? (
          <Spinner size={12} text="Checking..." />
        ) : result ? (
          <ResultLine result={result} />
        ) : (
          <span className="text-ink-muted">Not checked yet</span>
        )}
      </div>
      {port !== null && <p className="mt-0.5 text-meta text-ink-muted">{reachabilityHint(port)}</p>}
    </div>
  );

  return (
    <DetailRow
      label="Is it up?"
      icon={<PlugIcon size={16} />}
      value={value}
      actions={
        <Button size="sm" disabled={busy} onClick={() => void check(entry.id)}>
          {result ? "Check again" : "Check"}
        </Button>
      }
    />
  );
}
