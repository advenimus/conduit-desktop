import { useEffect, useState } from "react";
import { invoke } from "../../lib/electron";

interface QuotaUsage {
  quota: number;
  count: number;
  remaining: number;
  resetAt: number | null;
}

interface Props {
  variant: "pill" | "block";
}

const POLL_MS = 5000;

function formatReset(resetAt: number | null): string {
  if (resetAt === null) return "";
  const ms = resetAt - Date.now();
  if (ms <= 0) return "any moment";
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function colorClasses(usage: QuotaUsage, variant: "pill" | "block"): string {
  const ratio = usage.quota > 0 ? usage.count / usage.quota : 0;
  if (ratio >= 0.95) {
    return variant === "pill"
      ? "bg-red-500/15 text-red-400 border-red-500/30"
      : "text-red-400";
  }
  if (ratio >= 0.8) {
    return variant === "pill"
      ? "bg-amber-500/15 text-amber-400 border-amber-500/30"
      : "text-amber-400";
  }
  return variant === "pill"
    ? "bg-well text-ink-muted border-stroke"
    : "text-ink";
}

export default function MCPQuotaCounter({ variant }: Props) {
  const [usage, setUsage] = useState<QuotaUsage | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const fetchUsage = async () => {
      try {
        const next = await invoke<QuotaUsage>("mcp_get_quota_usage");
        if (!cancelled) setUsage(next);
      } catch {
        if (!cancelled) setUsage(null);
      }
    };

    fetchUsage();
    timer = setInterval(fetchUsage, POLL_MS);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, []);

  // Re-render every 30s so the "Resets in Xh Ym" text stays current between
  // poll cycles (which only refresh count, not the displayed countdown).
  useEffect(() => {
    if (variant !== "block") return;
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, [variant]);

  if (!usage) return null;
  if (usage.quota === -1) return null;

  if (variant === "pill") {
    return (
      <button
        onClick={() => invoke("auth_open_pricing")}
        title={`MCP tool calls used in the last 24h. ${
          usage.resetAt ? `Oldest call drops off in ${formatReset(usage.resetAt)}.` : ""
        } Click to upgrade for unlimited.`}
        className={`px-2 py-0.5 text-[11px] font-medium tabular-nums border rounded transition-colors hover:opacity-80 ${colorClasses(usage, "pill")}`}
      >
        {usage.count}/{usage.quota} today
      </button>
    );
  }

  return (
    <div>
      <p className={`text-xs ${colorClasses(usage, "block")}`}>
        <span className="tabular-nums font-medium">
          {usage.count} of {usage.quota}
        </span>{" "}
        MCP tool calls used today.
      </p>
      {usage.resetAt !== null && (
        <p className="text-[10px] text-ink-faint mt-0.5">
          Oldest call drops off in {formatReset(usage.resetAt)}.
        </p>
      )}
    </div>
  );
}
