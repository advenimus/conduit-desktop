import { lineDiff } from "./lineDiff";

const STYLE = {
  same: "text-ink-muted",
  added: "bg-success-bg text-ink",
  removed: "bg-danger-bg text-ink line-through decoration-danger",
} as const;

const MARK = { same: " ", added: "+", removed: "−" } as const;

export default function DiffView({ before, after }: { before: string; after: string }) {
  const lines = lineDiff(before, after);
  if (lines.every((l) => l.kind === "same")) return <p className="text-body text-ink-faint italic">No changes in the text.</p>;
  return (
    <pre className="max-h-[50vh] overflow-auto rounded border border-card-border bg-well p-2 font-mono text-label leading-5 allow-select">
      {lines.map((l, i) => (
        <div key={i} className={STYLE[l.kind]}>
          <span className="inline-block w-4 select-none text-ink-faint">{MARK[l.kind]}</span>
          {l.text || " "}
        </div>
      ))}
    </pre>
  );
}
