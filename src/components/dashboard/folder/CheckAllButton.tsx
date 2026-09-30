import { useState } from "react";
import { CHECK_ALL_LIMIT } from "../../../types/dashboard";
import { toast } from "../../common/Toast";
import { Button } from "../../ui";
import type { UseReachability } from "../reachability/useReachability";
import { checkAllIds, type FolderListItem } from "./folderList";

interface Progress {
  readonly done: number;
  readonly total: number;
}

/** Checks the listed entries that can be checked, the first 50 in list order, four at a time (docs/DASHBOARD.md 5). */
export default function CheckAllButton({
  items,
  checkMany,
}: {
  items: readonly FolderListItem[];
  checkMany: UseReachability["checkMany"];
}) {
  const [progress, setProgress] = useState<Progress | null>(null);
  const { ids, capped } = checkAllIds(items, CHECK_ALL_LIMIT);

  const onClick = async () => {
    setProgress({ done: 0, total: ids.length });
    try {
      await checkMany(ids, (done, total) => setProgress({ done, total }));
    } finally {
      setProgress(null);
    }
    if (capped) toast.info(`Checked the first ${CHECK_ALL_LIMIT} entries`, "Search or sort the list to check others.");
  };

  return (
    <Button disabled={progress !== null || ids.length === 0} onClick={() => void onClick()}>
      {progress ? `Checking ${progress.done} of ${progress.total}...` : "Check all"}
    </Button>
  );
}
