import { CheckIcon } from "../../lib/icons";
import { Spinner } from "../ui";

/** The busy state of the export and import dialogs while they cannot be closed. */
export function WorkingState({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-8">
      <Spinner size={24} className="text-info" />
      <p className="text-ink-muted">{text}</p>
    </div>
  );
}

/** The success tick and the two count tiles the export and import dialogs end on. */
export function ResultSummary({ title, counts }: { title: string; counts: ReadonlyArray<{ value: number; label: string }> }) {
  return (
    <>
      <div className="flex flex-col items-center gap-2 py-4">
        <div className="size-10 rounded-full bg-success-bg flex items-center justify-center">
          <CheckIcon size={24} className="text-success" />
        </div>
        <p className="font-semibold text-ink">{title}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 text-center">
        {counts.map((count) => (
          <div key={count.label} className="p-3 rounded-md bg-well">
            <div className="text-title font-semibold text-info">{count.value}</div>
            <div className="text-meta text-ink-muted">{count.label}</div>
          </div>
        ))}
      </div>
    </>
  );
}
