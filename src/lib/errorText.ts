/**
 * The readable text of a caught error, or `fallback` when it has none. invoke() rejects with an Error,
 * other code may throw a string, and serialized IPC or Supabase errors arrive as objects with a message.
 */
export function errorText(err: unknown, fallback: string): string {
  const text = messageOf(err)?.trim();
  return text ? text : fallback;
}

function messageOf(err: unknown): string | null {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    const { message } = err as { message: unknown };
    return typeof message === "string" ? message : null;
  }
  return null;
}
