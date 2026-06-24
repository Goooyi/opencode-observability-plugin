import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Hooks, Plugin } from "@opencode-ai/plugin";
import { Data, Effect, Layer, Schema } from "effect";

import {
  LangfuseClientService,
  createLangfuseClient,
  type ActiveGenerationStep,
  type LangfuseClient,
  type MessagePart,
  type TokenUsage,
  type UpdatedMessage,
} from "./langfuse.js";
import { OpencodeClientService } from "./opencode.js";
import { log } from "./utils.js";

// opencode emits these session.next.* events at runtime, but the published
// @opencode-ai/plugin Hooks["event"] type still omits them from its Event union.
type SessionNextEvent =
  | {
      id: string;
      type: "session.next.step.started";
      properties: {
        sessionID: string;
        timestamp: number;
        assistantMessageID: string;
        agent: string;
        model: NonNullable<ActiveGenerationStep["model"]>;
        snapshot?: string;
      };
    }
  | {
      id: string;
      type: "session.next.step.ended";
      properties: {
        sessionID: string;
        timestamp: number;
        assistantMessageID: string;
        finish: string;
        cost: number;
        tokens: TokenUsage;
        snapshot?: string;
      };
    }
  | {
      id: string;
      type: "session.next.step.failed";
      properties: {
        sessionID: string;
        timestamp: number;
        assistantMessageID: string;
        error: { message: string };
      };
    }
  | {
      id: string;
      type: "session.next.text.ended";
      properties: {
        sessionID: string;
        timestamp: number;
        assistantMessageID: string;
        textID: string;
        text: string;
      };
    }
  | {
      id: string;
      type: "session.next.retried";
      properties: {
        sessionID: string;
        timestamp: number;
        attempt: number;
        error: unknown;
      };
    }
  | {
      id: string;
      type: "session.next.reasoning.ended";
      properties: {
        sessionID: string;
        timestamp: number;
        assistantMessageID: string;
        reasoningID: string;
        text: string;
        providerMetadata?: unknown;
      };
    }
  | {
      id: string;
      type: "session.next.tool.called";
      properties: {
        sessionID: string;
        timestamp: number;
        assistantMessageID: string;
        callID: string;
        tool: string;
        input: Record<string, unknown>;
        provider?: unknown;
      };
    }
  | {
      id: string;
      type: "session.next.tool.success";
      properties: {
        sessionID: string;
        timestamp: number;
        assistantMessageID: string;
        callID: string;
        structured: Record<string, unknown>;
        content: unknown[];
        outputPaths?: string[];
        result?: unknown;
        provider?: unknown;
      };
    }
  | {
      id: string;
      type: "session.next.tool.failed";
      properties: {
        sessionID: string;
        timestamp: number;
        assistantMessageID: string;
        callID: string;
        error: unknown;
        result?: unknown;
        provider?: unknown;
      };
    }
  | {
      id: string;
      type: "session.next.compaction.ended";
      properties: {
        sessionID: string;
        timestamp: number;
        text: string;
        include?: string;
      };
    };

type OpencodeEvent =
  | Parameters<NonNullable<Hooks["event"]>>[0]["event"]
  | SessionNextEvent;

const LangfuseCredentialsSchema = Schema.Struct({
  publicKey: Schema.NonEmptyString,
  secretKey: Schema.NonEmptyString,
  baseUrl: Schema.optional(Schema.NonEmptyString),
  environment: Schema.optional(Schema.NonEmptyString),
  userId: Schema.optional(Schema.NonEmptyString),
});

type LangfuseCredentials = typeof LangfuseCredentialsSchema.Type;

class MissingLangfuseCredentials extends Data.TaggedError(
  "MissingLangfuseCredentials",
) {}

const loadLangfuseCredentials = Effect.gen(function* () {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;

  if (publicKey && secretKey) {
    return {
      publicKey,
      secretKey,
      baseUrl: process.env.LANGFUSE_BASEURL,
      environment: process.env.LANGFUSE_ENVIRONMENT,
      userId: process.env.LANGFUSE_USER_ID,
    } satisfies LangfuseCredentials;
  }

  const configPath = join(
    homedir(),
    ".config",
    "opencode",
    "opencode-langfuse.json",
  );

  const credentials = yield* Effect.tryPromise({
    try: async () => JSON.parse(await readFile(configPath, "utf8")),
    catch: () => new MissingLangfuseCredentials(),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknown(LangfuseCredentialsSchema)),
    Effect.mapError(() => new MissingLangfuseCredentials()),
  );

  if (!credentials.publicKey || !credentials.secretKey) {
    return yield* Effect.fail(new MissingLangfuseCredentials());
  }

  return credentials;
});

const eventHook = (event: OpencodeEvent) =>
  Effect.gen(function* () {
    const langfuse = yield* LangfuseClientService;

    if (event.type === "session.idle") {
      yield* log("info", "Flushing spans");
      langfuse.endActiveToolObservations();
      langfuse.endActiveGenerationSteps();
      langfuse.endActiveTurnObservations();
      langfuse.clearTraceState();

      yield* langfuse.forceFlush;
    }

    if (event.type === "server.instance.disposed") {
      langfuse.endActiveToolObservations();
      langfuse.endActiveGenerationSteps();
      langfuse.endActiveTurnObservations();
      langfuse.clearTraceState();

      yield* langfuse.shutdown;
    }

    if (event.type === "message.updated") {
      langfuse.traceMessageUpdated({
        sessionID: event.properties.info.sessionID,
        message: event.properties.info,
      });
    }

    if (event.type === "message.part.updated") {
      langfuse.traceMessagePartUpdated({
        sessionID: event.properties.part.sessionID,
        part: event.properties.part,
        timestamp: Date.now(),
      });
    }

    if (event.type === "session.next.step.started") {
      langfuse.startGenerationStep({
        sessionID: event.properties.sessionID,
        assistantMessageID: event.properties.assistantMessageID,
        agent: event.properties.agent,
        model: event.properties.model,
        timestamp: event.properties.timestamp,
        snapshot: event.properties.snapshot,
      });
    }

    if (event.type === "session.next.step.ended") {
      langfuse.finishGenerationStep({
        sessionID: event.properties.sessionID,
        assistantMessageID: event.properties.assistantMessageID,
        timestamp: event.properties.timestamp,
        finish: event.properties.finish,
        cost: event.properties.cost,
        tokens: event.properties.tokens,
        snapshot: event.properties.snapshot,
      });
    }

    if (event.type === "session.next.step.failed") {
      langfuse.failGenerationStep({
        sessionID: event.properties.sessionID,
        assistantMessageID: event.properties.assistantMessageID,
        timestamp: event.properties.timestamp,
        error: event.properties.error,
      });
    }

    if (event.type === "session.next.text.ended") {
      langfuse.recordAssistantText({
        assistantMessageID: event.properties.assistantMessageID,
        textID: event.properties.textID,
        text: event.properties.text,
      });
    }

    if (event.type === "session.next.retried") {
      langfuse.traceEvent({
        id: event.id,
        sessionID: event.properties.sessionID,
        name: "opencode.generation.retry",
        timestamp: event.properties.timestamp,
        output: event.properties.error,
        metadata: {
          attempt: event.properties.attempt,
        },
      });
    }

    if (event.type === "session.next.reasoning.ended") {
      langfuse.traceReasoning({
        assistantMessageID: event.properties.assistantMessageID,
        reasoningID: event.properties.reasoningID,
        sessionID: event.properties.sessionID,
        timestamp: event.properties.timestamp,
        text: event.properties.text,
        providerMetadata: event.properties.providerMetadata,
      });
    }

    if (event.type === "session.next.tool.called") {
      langfuse.traceToolCalled({
        sessionID: event.properties.sessionID,
        assistantMessageID: event.properties.assistantMessageID,
        callID: event.properties.callID,
        tool: event.properties.tool,
        args: event.properties.input,
        timestamp: event.properties.timestamp,
        provider: event.properties.provider,
      });
    }

    if (event.type === "session.next.tool.success") {
      langfuse.traceToolSuccess({
        callID: event.properties.callID,
        timestamp: event.properties.timestamp,
        output: {
          structured: event.properties.structured,
          content: event.properties.content,
          outputPaths: event.properties.outputPaths,
          result: event.properties.result,
        },
        provider: event.properties.provider,
      });
    }

    if (event.type === "session.next.tool.failed") {
      langfuse.traceToolFailed({
        callID: event.properties.callID,
        timestamp: event.properties.timestamp,
        error: event.properties.error,
        result: event.properties.result,
        provider: event.properties.provider,
      });
    }

    if (event.type === "session.next.compaction.ended") {
      langfuse.traceEvent({
        id: event.id,
        sessionID: event.properties.sessionID,
        name: "opencode.generation.compaction",
        timestamp: event.properties.timestamp,
        output: { text: event.properties.text },
        metadata: {
          include: event.properties.include,
        },
      });
    }
  });

const pollSessionMessages = (sessionID: string) =>
  Effect.gen(function* () {
    const opencode = yield* OpencodeClientService;
    const langfuse = yield* LangfuseClientService;
    const started = Date.now();
    let lastMessages: unknown[] = [];

    while (Date.now() - started < messagePollTimeoutMs()) {
      const response = yield* Effect.tryPromise({
        try: () =>
          opencode.session.messages({
            path: { id: sessionID },
            query: { limit: 50 },
            throwOnError: true,
          }),
        catch: (error) => error,
      });
      const messages = readMessageList(response);
      if (messages.length > 0) lastMessages = messages;

      if (traceAssistantSnapshots(langfuse, sessionID, messages)) {
        yield* langfuse.forceFlush;
        return;
      }

      yield* Effect.promise(
        () =>
          new Promise((resolve) =>
            setTimeout(resolve, messagePollIntervalMs()),
          ),
      );
    }

    traceAssistantSnapshots(langfuse, sessionID, lastMessages);
    yield* langfuse.forceFlush;
  });

function traceAssistantSnapshots(
  langfuse: LangfuseClient,
  sessionID: string,
  messages: unknown[],
): boolean {
  const assistantMessages = messages
    .map(readAssistantMessage)
    .filter(
      (message): message is { info: UpdatedMessage; parts: MessagePart[] } =>
        Boolean(message),
    );
  let latestCompletedText = false;
  for (const message of assistantMessages) {
    const completed = langfuse.traceAssistantMessageSnapshot({
      sessionID,
      message: message.info,
      parts: message.parts,
    });
    const hasText = message.parts.some(
      (part) => part.type === "text" && typeof part.text === "string",
    );
    if (completed && hasText) latestCompletedText = true;
  }
  return latestCompletedText;
}

function readMessageList(response: unknown): unknown[] {
  if (Array.isArray(response)) return response;
  if (isRecord(response) && Array.isArray(response.data)) return response.data;
  return [];
}

function readAssistantMessage(
  value: unknown,
): { info: UpdatedMessage; parts: MessagePart[] } | undefined {
  if (!isRecord(value)) return undefined;
  const info = isRecord(value.info) ? value.info : value;
  if (info.role !== "assistant") return undefined;
  const parts = Array.isArray(value.parts)
    ? value.parts
    : Array.isArray(value.content)
      ? value.content
      : [];
  return {
    info: info as UpdatedMessage,
    parts: parts.filter(isRecord) as MessagePart[],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messagePollTimeoutMs(): number {
  const parsed = Number(
    process.env.LANGFUSE_OPENCODE_MESSAGE_POLL_TIMEOUT_MS ?? 180_000,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 180_000;
}

function messagePollIntervalMs(): number {
  const parsed = Number(
    process.env.LANGFUSE_OPENCODE_MESSAGE_POLL_INTERVAL_MS ?? 1_000,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1_000;
}

const formatHookError = (error: unknown) => {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

const main = Effect.gen(function* () {
  const opencode = yield* OpencodeClientService;

  const langfuse = yield* Effect.gen(function* () {
    const credentials = yield* loadLangfuseCredentials;

    const baseUrl =
      credentials.baseUrl ??
      process.env.LANGFUSE_BASEURL ??
      "https://cloud.langfuse.com";

    const environment =
      credentials.environment ??
      process.env.LANGFUSE_ENVIRONMENT ??
      "development";

    const userId = credentials.userId ?? process.env.LANGFUSE_USER_ID;

    return yield* createLangfuseClient({
      publicKey: credentials.publicKey,
      secretKey: credentials.secretKey,
      baseUrl,
      environment,
      userId,
    });
  }).pipe(
    Effect.tap((client) =>
      log("info", `OTEL tracing initialized → ${client.baseUrl}`),
    ),
    Effect.catchTag("MissingLangfuseCredentials", () =>
      log("warn", "[Tracing disabled] Missing langfuse credentials"),
    ),
  );

  if (!langfuse) {
    return {};
  }

  const hooksLayer = Layer.merge(
    Layer.succeed(OpencodeClientService, opencode),
    Layer.succeed(LangfuseClientService, langfuse),
  );

  const runHook = (
    hookName: string,
    effect: Effect.Effect<
      unknown,
      unknown,
      OpencodeClientService | LangfuseClientService
    >,
  ) =>
    Effect.runPromise(
      effect.pipe(
        Effect.catchAllDefect((defect) =>
          log(
            "error",
            `Langfuse hook "${hookName}" failed: ${formatHookError(defect)}`,
          ).pipe(Effect.catchAll(() => Effect.void)),
        ),
        Effect.catchAll((error) =>
          log(
            "error",
            `Langfuse hook "${hookName}" failed: ${formatHookError(error)}`,
          ).pipe(Effect.catchAll(() => Effect.void)),
        ),
        Effect.asVoid,
        Effect.provide(hooksLayer),
      ),
    );

  let hookQueue = Promise.resolve();
  const enqueueHook = (
    hookName: string,
    effect: Effect.Effect<
      unknown,
      unknown,
      OpencodeClientService | LangfuseClientService
    >,
  ) => {
    hookQueue = hookQueue.then(
      () => runHook(hookName, effect),
      () => runHook(hookName, effect),
    );
    return hookQueue;
  };

  const hooks: Hooks = {
    dispose: async () => {
      await hookQueue.catch(() => undefined);
      await runHook(
        "dispose",
        Effect.gen(function* () {
          langfuse.endActiveToolObservations();
          langfuse.endActiveGenerationSteps();
          langfuse.endActiveTurnObservations();
          langfuse.clearTraceState();
          yield* langfuse.shutdown;
        }),
      );
    },

    event: ({ event }) => {
      void enqueueHook("event", eventHook(event));
      return Promise.resolve();
    },

    "chat.message": (input, output) => {
      void enqueueHook(
        "chat.message",
        Effect.try({
          try: () =>
            langfuse.traceUserMessage({
              sessionID: input.sessionID,
              messageID: input.messageID,
              agent: input.agent,
              model: input.model,
              parts: output.parts,
            }),
          catch: (error) => error,
        }),
      );
      void enqueueHook(
        "session.messages.poll",
        pollSessionMessages(input.sessionID),
      );
      return Promise.resolve();
    },
  };

  return hooks;
});

export const LangfusePlugin: Plugin = async ({ client }) => {
  const clientLayer = Layer.succeed(OpencodeClientService, client);
  return Effect.runPromise(main.pipe(Effect.provide(clientLayer)));
};

export default LangfusePlugin;
