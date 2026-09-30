import Field from "../Field";
import MarkdownEditor from "../../markdown/MarkdownEditor";
import { TextInput } from "../../ui";

interface InformationTabProps {
  tags: string;
  setTags: (v: string) => void;
  notes: string;
  setNotes: (v: string) => void;
}

export default function InformationTab({ tags, setTags, notes, setNotes }: InformationTabProps) {
  return (
    <div className="space-y-4">
      <Field label="Tags">
        <TextInput value={tags} onChange={(e) => setTags(e.target.value)} placeholder="production, linux (comma-separated)" />
      </Field>

      <Field label="Notes" group>
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
