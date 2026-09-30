import type { CloudBackupNotice } from "../../../../stores/vaultStore";

/** Status-line text of a refused cloud backup (plan enforcement S16, S17, S24). */
export function cloudBackupNoticeText(notice: CloudBackupNotice): string {
  switch (notice.kind) {
    case "plan":
      return "Cloud backup needs Pro or Team. Your earlier backups are still here.";
    case "full":
      return "Cloud backup is full. Conduit removes the oldest backup before the next one.";
    case "vaults-full": {
      const plan = notice.vaults === null ? "a limited number of" : String(notice.vaults);
      return `Cloud backup is full: your plan backs up ${plan} vaults. Remove an old vault's backups to back up this one.`;
    }
  }
}
