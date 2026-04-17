import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const PROSE_CLASSES =
  "prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-pre:bg-well prose-pre:border prose-pre:border-stroke prose-code:text-conduit-300 prose-headings:text-ink";

export default function TextBlock({ content }: { content: string }) {
  if (!content.trim()) return null;
  return (
    <div className={`${PROSE_CLASSES} break-words overflow-hidden`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
