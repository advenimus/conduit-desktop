import { useSyncStore, type SyncView } from "../../stores/syncStore";
import { currentWaiting, visiblePrompts } from "../../stores/sync-reducers";
import type { SyncPrompt } from "../../types/sync";
import { useSyncEvents } from "./useSyncEvents";
import DisplacedDialog, { DisplacingOverlay } from "./DisplacedDialog";
import SessionConflictDialog from "./SessionConflictDialog";
import WaitingForDriveDialog from "./WaitingForDriveDialog";
import EpochPromptDialog, { type EpochPrompt } from "./EpochPromptDialog";
import DifferentCopiesDialog from "./DifferentCopiesDialog";
import ConflictReviewPanel from "./ConflictReviewPanel";
import CandidateMergeDialog from "./CandidateMergeDialog";
import OtherCopiesPanel from "./OtherCopiesPanel";
import RecentlyDeletedPanel from "./RecentlyDeletedPanel";
import MassChangeNotice from "./MassChangeNotice";
import RestorePreviewDialog from "./RestorePreviewDialog";

const EPOCH_KINDS: ReadonlySet<SyncPrompt["kind"]> = new Set(["epoch-newer", "epoch-legacy", "epoch-concurrent"]);

function isEpochPrompt(p: SyncPrompt): p is EpochPrompt {
  return EPOCH_KINDS.has(p.kind);
}

function isDifferentCopies(p: SyncPrompt): p is Extract<SyncPrompt, { kind: "different-copies" }> {
  return p.kind === "different-copies";
}

function ViewPanel({ view }: { view: SyncView }) {
  switch (view.kind) {
    case "review":
      return <ConflictReviewPanel initialRow={view.row} />;
    case "candidate":
      return <CandidateMergeDialog key={view.candidateId} candidateId={view.candidateId} confirmSideFilesAfter={view.confirmSideFilesAfter} />;
    case "other-copies":
      return <OtherCopiesPanel />;
    case "recently-deleted":
      return <RecentlyDeletedPanel />;
    case "mass-change":
      return <MassChangeNotice key={view.noticeId} noticeId={view.noticeId} />;
    case "restore-preview":
      return <RestorePreviewDialog preview={view.preview} apply={view.apply} />;
  }
}

/** Global personal-sync listeners and dialogs. Mount once, in both the hub and the main layout. */
export default function SyncLayer() {
  useSyncEvents();
  const state = useSyncStore((s) => s.state);
  const openWaiting = useSyncStore((s) => s.openWaiting);
  const displaced = useSyncStore((s) => s.displaced);
  const displacing = useSyncStore((s) => s.displacing);
  const sessionConflict = useSyncStore((s) => s.sessionConflict);
  const deferred = useSyncStore((s) => s.deferredPrompts);
  const view = useSyncStore((s) => s.view);

  const waiting = currentWaiting(openWaiting, state);
  const showWaitDialog = waiting !== null && (openWaiting !== null || waiting.blocking);
  const prompts = visiblePrompts(state, deferred);
  const epoch = prompts.find(isEpochPrompt) ?? null;
  const different = prompts.find(isDifferentCopies) ?? null;

  // Later siblings paint on top at the same z-index: the timed and blocking dialogs come after
  // the user's open view, so a countdown is never hidden behind a panel.
  return (
    <>
      {view && <ViewPanel view={view} />}
      {different && !epoch && <DifferentCopiesDialog key={different.id} prompt={different} />}
      {epoch && <EpochPromptDialog key={epoch.id} prompt={epoch} />}
      {showWaitDialog && <WaitingForDriveDialog waiting={waiting} duringUnlock={openWaiting !== null} />}
      {displacing && !displaced && <DisplacingOverlay event={displacing} />}
      {displaced && <DisplacedDialog event={displaced} />}
      {sessionConflict && <SessionConflictDialog event={sessionConflict} />}
    </>
  );
}
