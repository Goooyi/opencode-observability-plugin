import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Hooks, Plugin } from "@opencode-ai/plugin";
import {
  createOpencodeClient as createOpencodeMetadataClient,
  type OpencodeClient as MetadataOpencodeClient,
} from "@opencode-ai/sdk";
import { Data, Effect, Layer, Schema } from "effect";

import {
  LangfuseClientService,
  createLangfuseClient,
  type ActiveGenerationStep,
  type TokenUsage,
} from "./langfuse.js";
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

type SessionStatusEvent = {
  id: string;
  type: "session.status";
  properties: {
    sessionID: string;
    status: { type: "idle" | "busy" | "retry"; [key: string]: unknown };
  };
};

type OpencodeEvent =
  | Parameters<NonNullable<Hooks["event"]>>[0]["event"]
  | SessionNextEvent
  | SessionStatusEvent;

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

    if (isIdleOpenCodeEvent(event)) {
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

    if (event.type === "session.created" || event.type === "session.updated") {
      const info = sessionInfo(event);
      const sessionID =
        stringValue(info?.id) ||
        stringValue(info?.sessionID) ||
        stringValue(eventProperties(event)?.sessionID);
      if (sessionID) {
        langfuse.rememberSession({
          sessionID,
          metadata: info?.metadata,
        });
      }
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

const rememberSessionFromClient = (input: {
  client: MetadataOpencodeClient;
  langfuse: import("./langfuse.js").LangfuseClient;
  sessionID: string;
}) =>
  Effect.tryPromise({
    try: async () => {
      if (input.langfuse.hasSessionTraceContext(input.sessionID)) return;
      const response = await input.client.session.get<true>(
        {
          path: { id: input.sessionID },
          throwOnError: true,
        },
      );
      const session = isRecord(response.data as unknown)
        ? (response.data as Record<string, unknown>)
        : undefined;
      input.langfuse.rememberSession({
        sessionID: input.sessionID,
        metadata: session?.metadata,
      });
    },
    catch: (error) => error,
  }).pipe(Effect.catchAll(() => Effect.void));

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

const main = (context: { metadataClient: MetadataOpencodeClient }) =>
  Effect.gen(function* () {
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

    const hooksLayer = Layer.succeed(LangfuseClientService, langfuse);

    const runHook = (
      hookName: string,
      effect: Effect.Effect<unknown, unknown, LangfuseClientService>,
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
      effect: Effect.Effect<unknown, unknown, LangfuseClientService>,
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
          Effect.gen(function* () {
            const metadata = traceMetadataFromParts(output.parts);
            if (metadata) {
              langfuse.rememberSession({
                sessionID: input.sessionID,
                metadata,
              });
            }
            yield* rememberSessionFromClient({
              client: context.metadataClient,
              langfuse,
              sessionID: input.sessionID,
            });
            langfuse.traceUserMessage({
              sessionID: input.sessionID,
              messageID: input.messageID,
              agent: input.agent,
              model: input.model,
              parts: output.parts,
            });
          }),
        );
        return Promise.resolve();
      },
    };

    return hooks;
  });

export const LangfusePlugin: Plugin = async ({ serverUrl }) => {
  const metadataClient = createOpencodeMetadataClient({
    baseUrl: serverUrl.toString(),
  });
  return Effect.runPromise(main({ metadataClient }));
};

export default LangfusePlugin;

function isIdleOpenCodeEvent(event: unknown): boolean {
  if (!isRecord(event)) return false;
  if (event.type === "session.idle") return true;
  if (event.type !== "session.status") return false;
  const properties = eventProperties(event);
  const status = properties?.status;
  return isRecord(status) && status.type === "idle";
}

function eventProperties(event: unknown): Record<string, unknown> | undefined {
  if (!isRecord(event)) return undefined;
  const properties = event.properties;
  return isRecord(properties) ? properties : undefined;
}

function sessionInfo(event: unknown): Record<string, unknown> | undefined {
  const properties = eventProperties(event);
  const info = properties?.info;
  return isRecord(info) ? info : undefined;
}

function traceMetadataFromParts(parts: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(parts)) return undefined;
  for (const part of parts) {
    if (!isRecord(part)) continue;
    const metadata = part.metadata;
    if (!isRecord(metadata)) continue;
    if (stringValue(metadata.traceparent)) return metadata;
  }
  return undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
