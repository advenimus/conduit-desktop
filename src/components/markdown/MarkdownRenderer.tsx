import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkSecret from "./remarkSecret";
import remarkSecretRef from "./remarkSecretRef";
import SecretSpan from "./SecretSpan";
import SecretChip from "./SecretChip";
import { MARKDOWN_PROSE_CLASSES } from "./markdownProseClasses";
import type { ComponentPropsWithoutRef } from "react";

function SecretSpanBridge(props: ComponentPropsWithoutRef<"span">) {
  const data = props as Record<string, unknown>;
  const className = typeof props.className === "string" ? props.className : "";
  if (className.includes("conduit-secret-ref") && typeof data["data-ref-id"] === "string") {
    const field = data["data-ref-field"];
    return (
      <SecretChip
        kind={data["data-ref-kind"] === "cred" ? "cred" : "secret"}
        id={data["data-ref-id"]}
        field={field === "username" || field === "password" || field === "totp" ? field : null}
        pending={data["data-ref-pending"] === "1"}
        label={typeof data["data-ref-label"] === "string" && data["data-ref-label"] ? data["data-ref-label"] : null}
      />
    );
  }
  const secret = data["data-secret"];
  if (className.includes("conduit-secret") && typeof secret === "string") {
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
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkSecretRef, remarkSecret]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
