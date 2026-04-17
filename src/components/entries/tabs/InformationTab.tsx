import Field from "../Field";
import MarkdownEditor from "../../markdown/MarkdownEditor";

interface InformationTabProps {
  tags: string;
  setTags: (v: string) => void;
  notes: string;
  setNotes: (v: string) => void;
}

export default function InformationTab({ tags, setTags, notes, setNotes }: InformationTabProps) {
  return (
    <div className="space-y-3">
      <Field label="Tags">
        <input
          type="text"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="production, linux (comma-separated)"
          className="w-full px-3 py-2 bg-well border border-stroke rounded text-sm focus:outline-none focus:ring-2 focus:ring-conduit-500"
        />
      </Field>

      <Field label="Notes">
        <MarkdownEditor
          value={notes}
          onChange={setNotes}
          placeholder="Optional notes... (supports Markdown, use !!secret!! to mask sensitive text)"
          minRows={8}
        />
      </Field>
    </div>
  );
}
