import { useEffect, useState } from "react";
import { invoke } from "../../lib/electron";
import { isPrereleaseVersion } from "../../lib/updateChannel";
import { cx } from "../ui";

/** App.tsx opens the feedback dialog on this event. */
export const OPEN_FEEDBACK_EVENT = "conduit:open-feedback";

interface BetaPillProps {
  /** The running version; read from the main process when left out. */
  version?: string;
  className?: string;
}

/** A small Beta label shown only on prerelease builds. */
export default function BetaPill({ version, className }: BetaPillProps) {
  const [fetched, setFetched] = useState<string | null>(null);

  useEffect(() => {
    if (version !== undefined) return;
    let alive = true;
    invoke<string>("app_get_version")
      .then((v) => {
        if (alive) setFetched(v);
      })
      .catch((err) => console.warn("[beta-pill] Could not read the app version:", err));
    return () => {
      alive = false;
    };
  }, [version]);

  const current = version ?? fetched;
  if (!current || !isPrereleaseVersion(current)) return null;

  return (
    <button
      type="button"
      title="You're using a beta build. Click to send feedback."
      onClick={() => document.dispatchEvent(new CustomEvent(OPEN_FEEDBACK_EVENT))}
      className={cx(
        "inline-flex h-4 shrink-0 items-center rounded bg-warning-bg px-1.5 text-badge font-semibold text-warning hover:opacity-80",
        className,
      )}
    >
      Beta
    </button>
  );
}
