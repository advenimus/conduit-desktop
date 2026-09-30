import { useCallback, useState } from "react";
import { dashboardApi } from "../../../lib/dashboardApi";
import { DASHBOARD_CHANNELS, HISTORY_RECENT_MAX } from "../../../types/dashboard";
import { useSessionReload } from "../entry/useSessionReload";

const EMPTY: ReadonlyMap<string, string> = new Map();

/** Entry id to the start time of its last connection, from the newest 50 entries of this vault's history. */
export function useLastConnected(folderId: string): ReadonlyMap<string, string> {
  const [lastConnected, setLastConnected] = useState<ReadonlyMap<string, string>>(EMPTY);

  const load = useCallback(() => {
    dashboardApi
      .historyRecent({ limit: HISTORY_RECENT_MAX })
      .then((rows) => setLastConnected(new Map(rows.map((row) => [row.entryId, row.lastStartedAt]))))
      .catch((err: unknown) => console.warn(`${DASHBOARD_CHANNELS.historyRecent} failed`, err));
  }, []);

  useSessionReload(load, folderId);
  return lastConnected;
}
