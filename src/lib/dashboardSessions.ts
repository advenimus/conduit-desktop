import type { Session } from "../stores/sessionStore";

/** The pinned Home tab. The id predates the pinned tab; keep it so old code paths still find it. */
export const HOME_SESSION_ID = "__home__";
export const HOME_TITLE = "Home";

/** The vault Knowledge view (docs/KNOWLEDGE_BASE.md). */
export const KNOWLEDGE_SESSION_ID = "knowledge::vault";
export const KNOWLEDGE_TITLE = "Knowledge";

const ENTRY_INFO_PREFIX = "dashboard::";
const FOLDER_VIEW_PREFIX = "folder::";

export const entryInfoSessionId = (entryId: string): string => `${ENTRY_INFO_PREFIX}${entryId}`;
export const folderViewSessionId = (folderId: string): string => `${FOLDER_VIEW_PREFIX}${folderId}`;

export function isHomeSession(sessionId: string | null | undefined): boolean {
  return sessionId === HOME_SESSION_ID;
}

export type DashboardView =
  | { readonly kind: "home" }
  | { readonly kind: "entry"; readonly entryId: string }
  | { readonly kind: "folder"; readonly folderId: string }
  | { readonly kind: "knowledge" };

/** What a "dashboard" session shows: a folder view carries metadata.folderId, an entry info tab its entryId. */
export function dashboardViewOf(session: Pick<Session, "id" | "entryId" | "metadata">): DashboardView {
  if (isHomeSession(session.id)) return { kind: "home" };
  if (session.id === KNOWLEDGE_SESSION_ID) return { kind: "knowledge" };
  const folderId = session.metadata?.folderId;
  if (typeof folderId === "string" && folderId) return { kind: "folder", folderId };
  if (session.entryId) return { kind: "entry", entryId: session.entryId };
  return { kind: "home" };
}
