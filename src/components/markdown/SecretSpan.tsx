import { useState } from "react";
import { CopyIcon, EyeIcon, EyeOffIcon } from "../../lib/icons";
import { toast } from "../common/Toast";

interface SecretSpanProps {
  secret: string;
}

export default function SecretSpan({ secret }: SecretSpanProps) {
  const [revealed, setRevealed] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      toast.success("Secret copied");
    } catch {
      toast.error("Failed to copy secret");
    }
  };

  return (
    <span className="inline-flex items-center gap-0.5">
      <span
        className={
          revealed
            ? "text-conduit-400 font-mono text-xs allow-select"
            : "text-conduit-400 font-mono text-xs blur-sm select-none"
        }
      >
        {secret}
      </span>
      <button
        type="button"
        onClick={() => setRevealed((r) => !r)}
        className="inline-flex items-center p-0 border-0 bg-transparent text-ink-muted hover:text-ink cursor-pointer"
        title={revealed ? "Hide secret" : "Reveal secret"}
      >
        {revealed ? <EyeOffIcon size={12} /> : <EyeIcon size={12} />}
      </button>
      {revealed && (
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center p-0 border-0 bg-transparent text-ink-muted hover:text-ink cursor-pointer"
          title="Copy secret"
        >
          <CopyIcon size={12} />
        </button>
      )}
    </span>
  );
}
