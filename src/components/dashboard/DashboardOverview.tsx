import { useEntryStore } from "../../stores/entryStore";
import { useVaultStore } from "../../stores/vaultStore";
import { useTierStore } from "../../stores/tierStore";
import { useAuthStore } from "../../stores/authStore";
import { HOME_SECTION_IDS, type HomeSectionId } from "../../types/dashboard";
import VaultStatusCard from "./VaultStatusCard";
import AiActivityCard from "./home/AiActivityCard";
import AgentLearningsCard from "./home/AgentLearningsCard";
import AttentionCard from "./home/AttentionCard";
import CustomizeMenu from "./home/CustomizeMenu";
import FavoritesCard from "./home/FavoritesCard";
import OpenNowCard from "./home/OpenNowCard";
import OverviewCard from "./home/OverviewCard";
import QuickBar from "./home/QuickBar";
import RecentConnectionsCard from "./home/RecentConnectionsCard";
import WelcomeBlock from "./home/WelcomeBlock";
import { countConnections } from "./home/entryDisplay";
import { bumpHistoryVersion } from "./home/homeFeeds";
import { useHomeSettings } from "./home/useHomeSettings";
import { selectCredentialCount, selectEntries, selectFolders } from "./home/storeSelectors";

/**
 * Home (docs/DASHBOARD.md 4): header, quick bar, then the cards; a hidden or empty card takes no
 * cell. The grid follows the pane width, since Home also fills split panes. `active` is false while
 * the Home tab is mounted behind another tab; the cards then stop loading.
 */
export default function DashboardOverview({ active = true }: { active?: boolean }) {
  const entries = useEntryStore(selectEntries);
  const folders = useEntryStore(selectFolders);
  const credentialCount = useVaultStore(selectCredentialCount);
  const { settings, loaded } = useHomeSettings();

  if (entries.length === 0 && folders.length === 0) return <WelcomeBlock />;

  const shown = (id: HomeSectionId) => loaded && !settings.hidden.includes(id);
  const allHidden = HOME_SECTION_IDS.every((id) => settings.hidden.includes(id));

  return (
    <div className="@container flex-1 flex flex-col bg-editor overflow-y-auto h-full">
      <div className="max-w-4xl w-full mx-auto p-6 space-y-6">
        <HomeHeader
          entryCount={entries.length}
          credentialCount={credentialCount}
          folderCount={folders.length}
          onHistoryCleared={bumpHistoryVersion}
        />
        {loaded && allHidden && <p className="text-label text-ink-faint">All sections are hidden. Use Customize to show them.</p>}
        {shown("quick") && <QuickBar />}
        <div className="grid grid-cols-1 items-start gap-4 @2xl:grid-cols-2">
          {shown("recent") && <RecentConnectionsCard active={active} />}
          {shown("open-now") && <OpenNowCard />}
          {shown("favorites") && <FavoritesCard />}
          {shown("attention") && <AttentionCard settings={settings} />}
          {shown("ai-activity") && <AiActivityCard className="@2xl:col-span-2" active={active} />}
          {shown("agent-learnings") && <AgentLearningsCard className="@2xl:col-span-2" />}
          {shown("vault-status") && <VaultStatusCells />}
        </div>
      </div>
    </div>
  );
}

function HomeHeader({
  entryCount,
  credentialCount,
  folderCount,
  onHistoryCleared,
}: {
  entryCount: number;
  credentialCount: number;
  folderCount: number;
  onHistoryCleared: () => void;
}) {
  const profile = useAuthStore((s) => s.profile);
  const displayName = profile?.display_name?.split(/\s+/)[0] || null;
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-title font-semibold text-ink">Welcome back{displayName ? `, ${displayName}` : ""}</h1>
        <p className="text-body text-ink-muted mt-1">
          {entryCount} {entryCount === 1 ? "entry" : "entries"} &middot;{" "}
          {credentialCount} {credentialCount === 1 ? "credential" : "credentials"} &middot;{" "}
          {folderCount} {folderCount === 1 ? "folder" : "folders"}
        </p>
      </div>
      <CustomizeMenu onHistoryCleared={onHistoryCleared} />
    </div>
  );
}

/** Vault status and Overview: two grid cells behind one switch. */
function VaultStatusCells() {
  const entries = useEntryStore(selectEntries);
  const cloudSyncState = useVaultStore((s) => s.cloudSyncState);
  const localBackupState = useVaultStore((s) => s.localBackupState);
  const teamSyncState = useVaultStore((s) => s.teamSyncState);
  const maxConnections = useTierStore((s) => s.maxConnections);
  const isTrialing = useTierStore((s) => s.isTrialing);
  const trialDaysRemaining = useTierStore((s) => s.trialDaysRemaining);
  const authMode = useAuthStore((s) => s.authMode);
  return (
    <>
      <VaultStatusCard
        cloudSyncState={cloudSyncState}
        localBackupState={localBackupState}
        teamSyncState={teamSyncState}
        authMode={authMode}
        maxConnections={maxConnections}
        connectionCount={countConnections(entries)}
        isTrialing={isTrialing}
        trialDaysRemaining={trialDaysRemaining}
      />
      <OverviewCard entries={entries} />
    </>
  );
}
