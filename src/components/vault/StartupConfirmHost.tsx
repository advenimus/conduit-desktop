import { useStartupVaultStore } from "../../stores/startupVaultStore";
import ConfirmDialog from "../common/ConfirmDialog";

/** Shows the confirm the Hub and vault menus ask for (recentVaultMenu.ts). */
export default function StartupConfirmHost() {
  const confirm = useStartupVaultStore((s) => s.confirm);
  if (confirm === null) return null;
  const close = () => useStartupVaultStore.getState().askConfirm(null);
  return (
    <ConfirmDialog
      title={confirm.title}
      message={confirm.message}
      confirmLabel={confirm.confirmLabel}
      layer="stacked"
      closeOnEscape
      onCancel={close}
      onConfirm={() => {
        close();
        void confirm.run();
      }}
    />
  );
}
