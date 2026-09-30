import type { EntryMeta, EntryType } from "../../../types/entry";

const DEFAULT_PORTS: Readonly<Partial<Record<EntryType, number>>> = { ssh: 22, rdp: 3389, vnc: 5900 };
const CHECKABLE_TYPES: ReadonlySet<EntryType> = new Set(["ssh", "rdp", "vnc", "web"]);

/** Entries the "Is it up?" check applies to: ssh, rdp, vnc and web with a host. */
export function isCheckable(entry: Pick<EntryMeta, "entry_type" | "host">): boolean {
  return CHECKABLE_TYPES.has(entry.entry_type) && !!entry.host?.trim();
}

function webPort(host: string): number {
  const raw = host.trim();
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (url.port) return Number(url.port);
    return url.protocol === "http:" ? 80 : 443;
  } catch {
    return 443;
  }
}

/** The port the main process checks (spec 7.5), for the hint shown before a result names it. */
export function expectedPort(entry: Pick<EntryMeta, "entry_type" | "host" | "port">): number | null {
  if (entry.entry_type === "web") return entry.host ? webPort(entry.host) : null;
  return entry.port ?? DEFAULT_PORTS[entry.entry_type] ?? null;
}
