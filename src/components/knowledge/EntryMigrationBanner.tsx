import type { EntryMeta } from "../../types/entry";
import MigrationBanner from "./MigrationBanner";
import { useKnowledge } from "./useKnowledge";

export default function EntryMigrationBanner({ entry }: { entry: EntryMeta }) {
  const own = useKnowledge({ entry_id: entry.id }).filter((k) => k.group === "asset").length;
  return <MigrationBanner entry={entry} ownArticles={own} />;
}
