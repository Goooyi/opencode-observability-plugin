import { Effect } from "effect";

export const log = (level: "info" | "warn" | "error", message: string) =>
  Effect.sync(() => {
    const prefix = `[opencode-langfuse] ${message}`;
    if (level === "error") console.error(prefix);
    else if (level === "warn") console.warn(prefix);
    else console.info(prefix);
  });
