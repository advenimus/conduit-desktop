import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkSecret from "./remarkSecret";
import SecretSpan from "./SecretSpan";
import { MARKDOWN_PROSE_CLASSES } from "./markdownProseClasses";
import type { ComponentPropsWithoutRef } from "react";

function SecretSpanBridge(props: ComponentPropsWithoutRef<"span">) {
  const secret = (props as Record<string, unknown>)["data-secret"];
  if (typeof props.className === "string" && props.className.includes("conduit-secret") && typeof secret === "string") {
    return <SecretSpan secret={secret} />;
  }
  return <span {...props} />;
}

function ExternalLink(props: ComponentPropsWithoutRef<"a">) {
  return <a {...props} target="_blank" rel="noopener noreferrer" />;
}

const components = {
  span: SecretSpanBridge,
  a: ExternalLink,
};

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

export default function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  if (!content.trim()) return null;

  return (
    <div className={className ? `${MARKDOWN_PROSE_CLASSES} ${className}` : MARKDOWN_PROSE_CLASSES}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkSecret]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
