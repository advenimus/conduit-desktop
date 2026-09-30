import { useMemo } from "react";
import { CircleFilledIcon } from "../../../lib/icons";
import { isHomeSession } from "../../../lib/dashboardSessions";
import { focusSession } from "../../../lib/focusSession";
import { useEntryStore } from "../../../stores/entryStore";
import { useSessionStore, type Session, type SessionType } from "../../../stores/sessionStore";
import { Card, cx, ListRow, SectionHeader, type IconSource } from "../../ui";
import { EntryIcon } from "./entryDisplay";
import { selectEntries, selectSessions } from "./storeSelectors";

const OPEN_NOW_LIMIT = 8;

const TYPE_ICONS: Partial<Readonly<Record<SessionType, IconSource>>> = {
  ssh: "terminal",
  local_shell: "terminal",
  rdp: "desktop",
  vnc: "desktop",
  web: "globe",
  command: "playerPlay",
};

// Same colors as the tab StatusDot in PaneTabBar.
const DOT_TONE: Readonly<Record<Session["status"], string>> = {
  connected: "text-(--c-state-connected)",
  connecting: "text-(--c-state-connecting) animate-pulse motion-reduce:animate-none",
  disconnected: "text-(--c-state-error)",
};

export function sessionStatusText(session: Session): string {
  if (session.status === "connected") return "Connected";
  if (session.status === "disconnected") return "Disconnected";
  return session.metadata?.reconnecting ? "Reconnecting..." : "Connecting...";
}

export function isOpenNowSession(session: Session): boolean {
  return !isHomeSession(session.id) && session.type !== "dashboard" && session.type !== "document";
}

function StatusMeta({ session }: { session: Session }) {
  return (
    <>
      <span className={cx("flex", DOT_TONE[session.status])}>
        <CircleFilledIcon size={12} />
      </span>
      {sessionStatusText(session)}
    </>
  );
}

/** Open now (docs/DASHBOARD.md 4.4). */
export default function OpenNowCard() {
  const sessions = useSessionStore(selectSessions);
  const entries = useEntryStore(selectEntries);
  const open = useMemo(() => sessions.filter(isOpenNowSession), [sessions]);
  const byId = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);

  if (open.length === 0) return null;
  const more = open.length - OPEN_NOW_LIMIT;
  return (
    <Card>
      <SectionHeader title="Open now" />
      <div className="space-y-px">
        {open.slice(0, OPEN_NOW_LIMIT).map((session) => {
          const entry = session.entryId ? byId.get(session.entryId) : undefined;
          return (
            <ListRow
              key={session.id}
              leading={entry ? <EntryIcon entry={entry} /> : (TYPE_ICONS[session.type] ?? "terminal")}
              meta={<StatusMeta session={session} />}
              onClick={() => focusSession(session.id)}
            >
              {session.title}
            </ListRow>
          );
        })}
      </div>
      {more > 0 && <p className="mt-1 px-2 text-meta text-ink-faint">+{more} more</p>}
    </Card>
  );
}
