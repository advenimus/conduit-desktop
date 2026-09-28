import { useSyncStore } from "../../stores/syncStore";
import type { SyncPrompt } from "../../types/sync";
import SyncBanner, { type BannerAction } from "./SyncBanner";
import SideFilesPausedBanner from "./SideFilesPausedBanner";
import {
  applyHeld,
  copyAction,
  locateVaultFile,
  openOtherVault,
  reviewCandidate,
  saveNewCopyHere,
} from "./prompt-actions";
import { plural } from "./sync-copy";

/** Prompts shown as a modal elsewhere (epoch dialog, different-copies dialog). */
export const MODAL_PROMPT_KINDS: ReadonlySet<SyncPrompt["kind"]> = new Set([
  "epoch-newer",
  "epoch-legacy",
  "epoch-concurrent",
  "different-copies",
]);

interface BannerSpec {
  readonly text: string;
  readonly actions: readonly BannerAction[];
}

/** "deleted 2 items and changed 1 back", naming only the parts that happened. */
export function heldChangesText(deletes: number, reverts: number): string {
  const parts = [deletes > 0 ? `deleted ${plural(deletes, "item")}` : null, reverts > 0 ? `changed ${plural(reverts, "item")} back` : null];
  const said = parts.filter((p): p is string => p !== null);
  return said.length > 0 ? said.join(" and ") : "changed some items";
}

/** "with 17 changes that aren't in your vault, including 15 deletions"; a copy this device can't count (another password) may still hold some. */
export function copyText(changes: number, deletions: number): string {
  if (changes === 0) return "that may hold changes that aren't in your vault";
  const del = deletions > 0 ? `, including ${plural(deletions, "deletion")}` : "";
  return `with ${plural(changes, "change")} that ${changes === 1 ? "isn't" : "aren't"} in your vault${del}`;
}

/**
 * The engine raises these again on every cycle while the cause lasts, so putting them off is
 * remembered here until the next unlock.
 */
function putOff(promptId: string): void {
  useSyncStore.getState().deferPrompt(promptId);
}

function bannerSpec(prompt: SyncPrompt, fileName: string): BannerSpec | null {
  const keepWorking = { label: "Keep working on this device", onClick: () => putOff(prompt.id) };
  switch (prompt.kind) {
    case "file-missing":
      return {
        text: `Vault file not found at ${prompt.path}. It may have been moved or renamed.`,
        actions: [{ label: "Locate...", primary: true, onClick: () => void locateVaultFile() }, keepWorking, { label: "Save a new copy here", onClick: () => void saveNewCopyHere() }],
      };
    case "foreign-other-vault":
      return {
        text: `The file at ${prompt.path} is now a different vault.`,
        actions: [
          { label: "Locate this vault's file...", primary: true, onClick: () => void locateVaultFile() },
          { label: "Open the other vault instead", onClick: () => void openOtherVault(prompt.path) },
          keepWorking,
        ],
      };
    case "foreign-newer-format":
      return {
        text: "This vault was updated by a newer version of Conduit. Update Conduit to keep syncing. Your changes are saved on this device.",
        actions: [{ label: "OK", onClick: () => putOff(prompt.id) }],
      };
    case "held-legacy":
      return {
        text: `While an older Conduit had this vault open, it ${heldChangesText(prompt.deletes, prompt.reverts)}.`,
        actions: [{ label: "Apply these changes", onClick: () => void applyHeld("apply") }, { label: "Keep my versions", primary: true, onClick: () => void applyHeld("keep-mine") }],
      };
    case "copy-review":
      return {
        text: `'${prompt.copy.name}' is a copy of this vault ${copyText(prompt.copy.changes, prompt.copy.deletions)}.`,
        actions: [{ label: "Review...", primary: true, onClick: () => void copyAction(prompt.copy, "review") }, { label: "Ignore this copy", onClick: () => void copyAction(prompt.copy, "ignore") }],
      };
    case "same-device-copy":
      return {
        text: `'${prompt.copy.name}' is a copy of '${fileName}'.`,
        actions: [
          { label: "Use as a separate vault", onClick: () => void copyAction(prompt.copy, "separate") },
          { label: "It's the same vault, merge", primary: true, onClick: () => void copyAction(prompt.copy, "merge") },
          { label: "Ignore", onClick: () => void copyAction(prompt.copy, "ignore") },
        ],
      };
    case "candidate":
      return {
        text: `Changes from ${prompt.label} are ready to review.`,
        actions: [{ label: "Review", primary: true, onClick: () => reviewCandidate(prompt.candidateId) }, { label: "Later", onClick: () => useSyncStore.getState().deferPrompt(prompt.id) }],
      };
    default:
      return null;
  }
}

/** One running-engine prompt as a banner (spec 5.2, 5.5, 5.8, 5.9, 4.3). */
export default function PromptBanner({ prompt, fileName }: { prompt: SyncPrompt; fileName: string }) {
  if (prompt.kind === "side-files") return <SideFilesPausedBanner prompt={prompt} />;
  const spec = bannerSpec(prompt, fileName);
  if (spec === null) return null;
  return <SyncBanner tone="warn" text={spec.text} actions={spec.actions} />;
}
