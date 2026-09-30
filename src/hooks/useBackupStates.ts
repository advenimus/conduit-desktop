import { useEffect } from "react";
import { useVaultStore, type CloudSyncState, type LocalBackupState } from "../stores/vaultStore";

/**
 * Keeps vaultStore's cloud and local backup states current for the whole app. Mounted once in
 * App: the dashboard and the sidebar indicator only read the store, so a collapsed sidebar or an
 * unopened Settings > Backup no longer leaves the dashboard showing a backup as "Disabled".
 */
export function useBackupStates(): void {
  useEffect(() => {
    const store = useVaultStore.getState();
    const offCloud = window.electron.on("cloud-sync:state-changed", (state: unknown) => {
      useVaultStore.getState().setCloudSyncState(state as CloudSyncState);
    });
    const offLocal = window.electron.on("local-backup:state-changed", (state: unknown) => {
      useVaultStore.getState().setLocalBackupState(state as LocalBackupState);
    });
    void store.fetchCloudSyncState();
    void store.fetchLocalBackupState();
    return () => {
      offCloud();
      offLocal();
    };
  }, []);
}
