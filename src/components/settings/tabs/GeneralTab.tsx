import type { TabProps } from "../SettingsHelpers";
import StartupVaultSetting from "./StartupVaultSetting";
import UpdatesSetting from "./UpdatesSetting";

export default function GeneralTab({ onNavigate }: TabProps) {
  return (
    <div className="space-y-6">
      <StartupVaultSetting onOpenSecurity={() => onNavigate?.("security")} />
      <UpdatesSetting />
    </div>
  );
}
