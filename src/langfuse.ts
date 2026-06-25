import { LangfuseAPIClient, type IngestionEvent } from "@langfuse/core";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  setLangfuseTracerProvider,
  startObservation,
  type LangfuseTool,
} from "@langfuse/tracing";
import { TraceFlags, type SpanContext } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { Context as EffectContext, Effect } from "effect";
import { createHash, randomUUID } from "node:crypto";

import { PLUGIN_VERSION } from "./version.js";

export type MessagePart = Record<string, unknown> & {
  id?: string;
  messageID?: string;
  sessionID?: string;
  type: string;
};

export type UpdatedMessage = Record<string, unknown> & {
  id: string;
  role: string;
  sessionID?: string;
  providerID?: string;
  modelID?: string;
  error?: unknown;
  finish?: string;
  cost?: number;
  tokens?: TokenUsage;
  time?: {
    created?: number;
    completed?: number;
  };
};

export type TokenUsage = {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
};

type TurnObservation = {
  id: string;
  sessionID: string;
  messageID?: string;
};

export type ActiveGenerationStep = {
  id: string;
  assistantMessageID: string;
  sessionID: string;
  model?: {
    id?: string;
    providerID?: string;
    variant?: string;
  };
};

type ToolObservation = {
  id: string;
  observation: LangfuseTool;
  assistantMessageID: string;
  callID: string;
  sessionID: string;
  tool: string;
};

type TraceContext = {
  traceId: string;
  rootObservationId?: string;
};

type LangfuseTraceState = {
  environment: string;
  traceId: string;
  rootObservationId?: string;
  sessionTraceContext: Map<string, TraceContext>;
  tracedMessageIds: Set<string>;
  tracedGenerationIds: Set<string>;
  tracedEventIds: Set<string>;
  tracedReasoningIds: Set<string>;
  tracedToolCallIds: Set<string>;
  tracedToolResultIds: Set<string>;
  textPartsByAssistantMessageId: Map<string, Map<string, string>>;
  generationByAssistantMessageId: Map<string, ActiveGenerationStep>;
  turnByMessageId: Map<string, TurnObservation>;
  latestTurnBySession: Map<string, TurnObservation>;
  activeTools: Map<string, ToolObservation>;
};

export class LangfuseClient {
  readonly baseUrl: string;
  readonly forceFlush: Effect.Effect<void, unknown>;
  readonly shutdown: Effect.Effect<void, unknown>;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly input: {
      api: LangfuseAPIClient;
      baseUrl: string;
      state: LangfuseTraceState;
      toolTraceProvider: BasicTracerProvider;
    },
  ) {
    this.baseUrl = input.baseUrl;
    this.forceFlush = Effect.tryPromise(async () => {
      await this.queue;
      await this.input.toolTraceProvider.forceFlush();
    });
    this.shutdown = Effect.tryPromise(async () => {
      await this.queue;
      await this.input.toolTraceProvider.shutdown();
    });
  }

  clearTraceState() {
    this.input.state.tracedMessageIds.clear();
    this.input.state.tracedGenerationIds.clear();
    this.input.state.tracedEventIds.clear();
    this.input.state.tracedReasoningIds.clear();
    this.input.state.tracedToolCallIds.clear();
    this.input.state.tracedToolResultIds.clear();
    this.input.state.textPartsByAssistantMessageId.clear();
    this.input.state.generationByAssistantMessageId.clear();
    this.input.state.turnByMessageId.clear();
    this.input.state.latestTurnBySession.clear();
    this.input.state.activeTools.clear();
  }

  endActiveToolObservations() {
    const now = new Date();
    for (const tool of this.input.state.activeTools.values()) {
      tool.observation.end(now);
    }
    this.input.state.activeTools.clear();
  }

  endActiveGenerationSteps() {
    const now = new Date().toISOString();
    for (const generation of this.input.state.generationByAssistantMessageId.values()) {
      this.emit({
        type: "generation-update",
        id: randomUUID(),
        timestamp: now,
        body: {
          id: generation.id,
          endTime: now,
          environment: this.input.state.environment,
        },
      });
    }
    this.input.state.generationByAssistantMessageId.clear();
  }

  endActiveTurnObservations() {
    const now = new Date().toISOString();
    for (const turn of new Set(this.input.state.latestTurnBySession.values())) {
      this.emit({
        type: "span-update",
        id: randomUUID(),
        timestamp: now,
        body: {
          id: turn.id,
          endTime: now,
          environment: this.input.state.environment,
        },
      });
    }
    this.input.state.turnByMessageId.clear();
    this.input.state.latestTurnBySession.clear();
  }

  rememberSession(input: { sessionID: string; metadata?: unknown }) {
    if (!input.sessionID) return;
    const metadata = isRecord(input.metadata) ? input.metadata : {};
    const parsed = parseTraceparent(stringField(metadata, "traceparent"));
    if (!parsed) return;
    this.input.state.sessionTraceContext.set(input.sessionID, {
      traceId: parsed.traceId,
      rootObservationId: parsed.parentObservationId,
    });
  }

  hasSessionTraceContext(sessionID: string) {
    return this.input.state.sessionTraceContext.has(sessionID);
  }

  traceEvent(input: {
    id: string;
    sessionID: string;
    name: string;
    timestamp: number;
    input?: unknown;
    output?: unknown;
    metadata?: unknown;
    parentSpan?: unknown;
  }) {
    void input.parentSpan;
    if (this.input.state.tracedEventIds.has(input.id)) return;
    this.input.state.tracedEventIds.add(input.id);
    this.emit({
      type: "event-create",
      id: randomUUID(),
      timestamp: iso(input.timestamp),
      body: compact({
        id: stableObservationId(`event:${input.id}`),
        traceId: this.traceIdForSession(input.sessionID),
        parentObservationId: this.parentForSession(input.sessionID),
        name: input.name,
        startTime: iso(input.timestamp),
        input: input.input,
        output: input.output,
        metadata: input.metadata,
        environment: this.input.state.environment,
      }),
    });
  }

  traceUserMessage(input: {
    sessionID: string;
    messageID?: string;
    agent?: string;
    model?: { providerID: string; modelID: string };
    parts: MessagePart[];
  }) {
    if (
      input.messageID &&
      this.input.state.tracedMessageIds.has(input.messageID)
    )
      return;
    if (input.messageID) this.input.state.tracedMessageIds.add(input.messageID);

    const formattedInput = {
      role: "user" as const,
      parts: input.parts.map(formatMessagePart),
    };

    const previousTurn = this.input.state.latestTurnBySession.get(
      input.sessionID,
    );
    if (previousTurn) {
      const now = new Date().toISOString();
      this.emit({
        type: "span-update",
        id: randomUUID(),
        timestamp: now,
        body: {
          id: previousTurn.id,
          endTime: now,
          environment: this.input.state.environment,
        },
      });
      this.input.state.latestTurnBySession.delete(input.sessionID);
    }

    const turnId = stableObservationId(
      `turn:${input.sessionID}:${input.messageID ?? randomUUID()}`,
    );
    this.emit({
      type: "span-create",
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      body: compact({
        id: turnId,
        traceId: this.traceIdForSession(input.sessionID),
        parentObservationId: this.rootForSession(input.sessionID),
        name: "opencode.turn",
        startTime: new Date().toISOString(),
        input: formattedInput,
        metadata: {
          messageID: input.messageID,
          agent: input.agent,
          providerID: input.model?.providerID,
          modelID: input.model?.modelID,
          pluginVersion: PLUGIN_VERSION,
        },
        environment: this.input.state.environment,
      }),
    });

    const turn = {
      id: turnId,
      sessionID: input.sessionID,
      messageID: input.messageID,
    } satisfies TurnObservation;
    if (input.messageID)
      this.input.state.turnByMessageId.set(input.messageID, turn);
    this.input.state.latestTurnBySession.set(input.sessionID, turn);

    this.emit({
      type: "event-create",
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      body: compact({
        id: stableObservationId(
          `user:${input.sessionID}:${input.messageID ?? randomUUID()}`,
        ),
        traceId: this.traceIdForSession(input.sessionID),
        parentObservationId: turnId,
        name: "opencode.message.user",
        startTime: new Date().toISOString(),
        input: formattedInput,
        metadata: {
          messageID: input.messageID,
          agent: input.agent,
          providerID: input.model?.providerID,
          modelID: input.model?.modelID,
        },
        environment: this.input.state.environment,
      }),
    });
  }

  traceMessageUpdated(input: { sessionID: string; message: UpdatedMessage }) {
    if (input.message.role !== "assistant") return;
    this.startGenerationStep({
      sessionID: input.sessionID,
      assistantMessageID: input.message.id,
      model: {
        id: input.message.modelID,
        providerID: input.message.providerID,
      },
      timestamp: input.message.time?.created,
    });

    if (input.message.error) {
      this.failGenerationStep({
        sessionID: input.sessionID,
        assistantMessageID: input.message.id,
        timestamp:
          input.message.time?.completed ??
          input.message.time?.created ??
          Date.now(),
        error: { message: extractErrorMessage(input.message.error) },
      });
      return;
    }

    if (input.message.time?.completed == null) return;
    this.finishGenerationStep({
      sessionID: input.sessionID,
      assistantMessageID: input.message.id,
      timestamp: input.message.time.completed,
      finish: input.message.finish ?? "unknown",
      cost: input.message.cost,
      tokens: input.message.tokens,
    });
  }

  traceMessagePartUpdated(input: {
    sessionID: string;
    part: MessagePart;
    timestamp: number;
  }) {
    const part = input.part;
    if (part.type === "text") {
      this.recordAssistantText({
        assistantMessageID: stringField(part, "messageID"),
        textID: stringField(part, "id"),
        text: stringField(part, "text"),
      });
      return;
    }

    if (part.type === "reasoning") {
      this.traceReasoning({
        assistantMessageID: stringField(part, "messageID"),
        reasoningID: stringField(part, "id"),
        sessionID: input.sessionID,
        timestamp:
          numericField(recordField(part, "time"), "end") ?? input.timestamp,
        text: stringField(part, "text"),
      });
      return;
    }

    if (part.type !== "tool") return;
    const state = recordField(part, "state");
    const status = stringField(state, "status");
    if (status === "pending") return;
    const time = recordField(state, "time");
    const callID = stringField(part, "callID") || stringField(part, "id");
    const tool = stringField(part, "tool") || stringField(part, "name");
    this.traceToolCalled({
      sessionID: input.sessionID,
      assistantMessageID: stringField(part, "messageID"),
      callID,
      tool,
      args: state.input,
      timestamp: numericField(time, "start") ?? input.timestamp,
      provider: part.metadata,
    });
    if (status === "completed") {
      this.traceToolSuccess({
        callID,
        timestamp: numericField(time, "end") ?? input.timestamp,
        output: {
          output: state.output,
          title: state.title,
          metadata: state.metadata,
          attachments: state.attachments,
        },
        provider: part.metadata,
      });
    }
    if (status === "error") {
      this.traceToolFailed({
        callID,
        timestamp: numericField(time, "end") ?? input.timestamp,
        error: state.error,
        result: state.metadata,
        provider: part.metadata,
      });
    }
  }

  traceAssistantMessageSnapshot(input: {
    sessionID: string;
    message: UpdatedMessage;
    parts: MessagePart[];
  }) {
    if (input.message.role !== "assistant") return false;
    if (this.input.state.tracedGenerationIds.has(input.message.id)) return true;
    this.traceMessageUpdated({
      sessionID: input.sessionID,
      message: input.message,
    });
    for (const part of input.parts) {
      this.traceMessagePartUpdated({
        sessionID: input.sessionID,
        part,
        timestamp: Date.now(),
      });
    }
    this.traceMessageUpdated({
      sessionID: input.sessionID,
      message: input.message,
    });
    return input.message.time?.completed != null;
  }

  startGenerationStep(input: {
    sessionID: string;
    assistantMessageID: string;
    agent?: string;
    model?: { id?: string; providerID?: string; variant?: string };
    timestamp?: number;
    snapshot?: string;
  }) {
    if (this.input.state.tracedGenerationIds.has(input.assistantMessageID))
      return;
    const existing = this.input.state.generationByAssistantMessageId.get(
      input.assistantMessageID,
    );
    if (existing) return;
    const id = stableObservationId(`generation:${input.assistantMessageID}`);
    this.input.state.generationByAssistantMessageId.set(
      input.assistantMessageID,
      {
        id,
        assistantMessageID: input.assistantMessageID,
        sessionID: input.sessionID,
      },
    );
    this.emit({
      type: "generation-create",
      id: randomUUID(),
      timestamp: iso(input.timestamp),
      body: compact({
        id,
        traceId: this.traceIdForSession(input.sessionID),
        parentObservationId: this.parentForSession(input.sessionID),
        name: "opencode.generation",
        startTime: iso(input.timestamp),
        model:
          [input.model?.providerID, input.model?.id]
            .filter(Boolean)
            .join("/") || undefined,
        metadata: {
          assistantMessageID: input.assistantMessageID,
          agent: input.agent,
          providerID: input.model?.providerID,
          modelID: input.model?.id,
          variant: input.model?.variant,
          snapshot: input.snapshot,
        },
        environment: this.input.state.environment,
      }),
    });
  }

  finishGenerationStep(input: {
    sessionID: string;
    assistantMessageID: string;
    timestamp: number;
    finish?: string;
    cost?: number;
    tokens?: TokenUsage;
    snapshot?: string;
  }) {
    if (this.input.state.tracedGenerationIds.has(input.assistantMessageID))
      return;
    this.input.state.tracedGenerationIds.add(input.assistantMessageID);
    const generation = this.input.state.generationByAssistantMessageId.get(
      input.assistantMessageID,
    ) ?? {
      id: stableObservationId(`generation:${input.assistantMessageID}`),
      assistantMessageID: input.assistantMessageID,
      sessionID: input.sessionID,
    };
    this.emit({
      type: "generation-update",
      id: randomUUID(),
      timestamp: iso(input.timestamp),
      body: compact({
        id: generation.id,
        endTime: iso(input.timestamp),
        output: this.getAssistantText(input.assistantMessageID),
        usageDetails: usageDetails(input.tokens),
        metadata: {
          assistantMessageID: input.assistantMessageID,
          finish: input.finish,
          cost: input.cost,
          snapshot: input.snapshot,
        },
        environment: this.input.state.environment,
      }),
    });
    this.input.state.generationByAssistantMessageId.delete(
      input.assistantMessageID,
    );
  }

  failGenerationStep(input: {
    sessionID: string;
    assistantMessageID: string;
    timestamp: number;
    error: { message: string };
  }) {
    if (this.input.state.tracedGenerationIds.has(input.assistantMessageID))
      return;
    this.input.state.tracedGenerationIds.add(input.assistantMessageID);
    const generation = this.input.state.generationByAssistantMessageId.get(
      input.assistantMessageID,
    ) ?? {
      id: stableObservationId(`generation:${input.assistantMessageID}`),
      assistantMessageID: input.assistantMessageID,
      sessionID: input.sessionID,
    };
    this.emit({
      type: "generation-update",
      id: randomUUID(),
      timestamp: iso(input.timestamp),
      body: compact({
        id: generation.id,
        endTime: iso(input.timestamp),
        output: { error: input.error },
        level: "ERROR" as const,
        statusMessage: input.error.message,
        environment: this.input.state.environment,
      }),
    });
    this.input.state.generationByAssistantMessageId.delete(
      input.assistantMessageID,
    );
  }

  recordAssistantText(input: {
    assistantMessageID: string;
    textID: string;
    text: string;
  }) {
    if (!input.assistantMessageID || !input.textID) return;
    const parts =
      this.input.state.textPartsByAssistantMessageId.get(
        input.assistantMessageID,
      ) ?? new Map<string, string>();
    parts.set(input.textID, input.text);
    this.input.state.textPartsByAssistantMessageId.set(
      input.assistantMessageID,
      parts,
    );
  }

  traceReasoning(input: {
    assistantMessageID: string;
    reasoningID: string;
    sessionID: string;
    timestamp: number;
    text: string;
    providerMetadata?: unknown;
  }) {
    if (!input.text.trim()) return;
    if (
      !input.reasoningID ||
      this.input.state.tracedReasoningIds.has(input.reasoningID)
    )
      return;
    this.input.state.tracedReasoningIds.add(input.reasoningID);
    this.emit({
      type: "event-create",
      id: randomUUID(),
      timestamp: iso(input.timestamp),
      body: compact({
        id: stableObservationId(`reasoning:${input.reasoningID}`),
        traceId: this.traceIdForSession(input.sessionID),
        parentObservationId:
          this.generationParent(input.assistantMessageID) ??
          this.parentForSession(input.sessionID),
        name: "opencode.reasoning",
        startTime: iso(input.timestamp),
        output: { text: input.text },
        metadata: {
          assistantMessageID: input.assistantMessageID,
          reasoningID: input.reasoningID,
        },
        environment: this.input.state.environment,
      }),
    });
  }

  traceToolCalled(input: {
    sessionID: string;
    assistantMessageID: string;
    callID: string;
    tool: string;
    args: unknown;
    timestamp: number;
    provider?: unknown;
  }) {
    if (!input.callID || this.input.state.tracedToolCallIds.has(input.callID))
      return;
    this.input.state.tracedToolCallIds.add(input.callID);
    const parentObservationId =
      this.generationParent(input.assistantMessageID) ??
      this.parentForSession(input.sessionID);
    const observation = startObservation(
      `tool.${input.tool}`,
      {
        input: input.args,
        metadata: {
          assistantMessageID: input.assistantMessageID,
          callID: input.callID,
          provider: input.provider,
          tool: input.tool,
        },
        environment: this.input.state.environment,
      },
      {
        asType: "tool",
        startTime: new Date(input.timestamp ?? Date.now()),
        parentSpanContext: this.parentSpanContext(
          input.sessionID,
          parentObservationId,
        ),
      },
    );
    this.input.state.activeTools.set(input.callID, {
      id: observation.id,
      observation,
      assistantMessageID: input.assistantMessageID,
      callID: input.callID,
      sessionID: input.sessionID,
      tool: input.tool,
    });
  }

  traceToolSuccess(input: {
    callID: string;
    timestamp: number;
    output: unknown;
    provider?: unknown;
  }) {
    this.endTool(input.callID, input.timestamp, input.output, input.provider);
  }

  traceToolFailed(input: {
    callID: string;
    timestamp: number;
    error: unknown;
    result?: unknown;
    provider?: unknown;
  }) {
    this.endTool(
      input.callID,
      input.timestamp,
      { error: input.error, result: input.result },
      input.provider,
      input.error,
    );
  }

  private endTool(
    callID: string,
    timestamp: number,
    output: unknown,
    provider?: unknown,
    error?: unknown,
  ) {
    if (!callID || this.input.state.tracedToolResultIds.has(callID)) return;
    const tool = this.input.state.activeTools.get(callID);
    if (!tool) return;
    this.input.state.tracedToolResultIds.add(callID);
    tool.observation.update(
      compact({
        output,
        metadata: {
          assistantMessageID: tool.assistantMessageID,
          callID,
          provider,
          tool: tool.tool,
          observationType: "tool",
        },
        ...(error
          ? {
              level: "ERROR" as const,
              statusMessage: extractErrorMessage(error),
            }
          : {}),
        environment: this.input.state.environment,
      }),
    );
    tool.observation.end(new Date(timestamp ?? Date.now()));
    this.input.state.activeTools.delete(callID);
  }

  private parentForSession(sessionID: string) {
    return (
      this.input.state.latestTurnBySession.get(sessionID)?.id ??
      this.rootForSession(sessionID)
    );
  }

  private generationParent(assistantMessageID: string) {
    return this.input.state.generationByAssistantMessageId.get(
      assistantMessageID,
    )?.id;
  }

  private traceIdForSession(sessionID: string) {
    return (
      this.input.state.sessionTraceContext.get(sessionID)?.traceId ??
      this.input.state.traceId
    );
  }

  private rootForSession(sessionID: string) {
    return (
      this.input.state.sessionTraceContext.get(sessionID)?.rootObservationId ??
      this.input.state.rootObservationId
    );
  }

  private parentSpanContext(
    sessionID: string,
    parentObservationId: string | undefined,
  ) {
    const traceId = this.traceIdForSession(sessionID);
    if (
      !parentObservationId ||
      !isTraceId(traceId) ||
      !isSpanId(parentObservationId)
    ) {
      return undefined;
    }
    return {
      traceId,
      spanId: parentObservationId,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    } satisfies SpanContext;
  }

  private getAssistantText(assistantMessageID: string) {
    return Array.from(
      this.input.state.textPartsByAssistantMessageId
        .get(assistantMessageID)
        ?.values() ?? [],
    ).join("");
  }

  private emit(event: IngestionEvent) {
    this.queue = this.queue
      .then(() =>
        this.input.api.ingestion
          .batch(
            {
              batch: [event],
              metadata: {
                sdk: "opencode-observability-plugin",
                version: PLUGIN_VERSION,
              },
            },
            { timeoutInSeconds: 5, maxRetries: 1 },
          )
          .then(() => undefined),
      )
      .catch((error) => {
        console.warn(
          "[opencode-langfuse] failed to send event",
          extractErrorMessage(error),
        );
      });
  }
}

export class LangfuseClientService extends EffectContext.Tag(
  "LangfuseClientService",
)<LangfuseClientService, LangfuseClient>() {}

export const createLangfuseClient = (input: {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  environment: string;
  userId?: string;
}) =>
  Effect.sync(() => {
    const parsed = parseTraceparent(
      process.env.OPENCODE_TRACEPARENT ?? process.env.TRACEPARENT,
    );
    const state: LangfuseTraceState = {
      environment: input.environment,
      traceId: parsed?.traceId ?? stableTraceId(randomUUID()),
      rootObservationId: parsed?.parentObservationId,
      sessionTraceContext: new Map<string, TraceContext>(),
      tracedMessageIds: new Set<string>(),
      tracedGenerationIds: new Set<string>(),
      tracedEventIds: new Set<string>(),
      tracedReasoningIds: new Set<string>(),
      tracedToolCallIds: new Set<string>(),
      tracedToolResultIds: new Set<string>(),
      textPartsByAssistantMessageId: new Map<string, Map<string, string>>(),
      generationByAssistantMessageId: new Map<string, ActiveGenerationStep>(),
      turnByMessageId: new Map<string, TurnObservation>(),
      latestTurnBySession: new Map<string, TurnObservation>(),
      activeTools: new Map<string, ToolObservation>(),
    };
    const api = new LangfuseAPIClient({
      username: () => input.publicKey,
      password: () => input.secretKey,
      baseUrl: () => input.baseUrl,
      environment: () => input.environment,
      xLangfuseSdkName: () => "opencode-observability-plugin",
      xLangfuseSdkVersion: () => PLUGIN_VERSION,
      xLangfusePublicKey: () => input.publicKey,
    });
    const toolTraceProvider = new BasicTracerProvider({
      spanProcessors: [
        new LangfuseSpanProcessor({
          publicKey: input.publicKey,
          secretKey: input.secretKey,
          baseUrl: input.baseUrl,
          environment: input.environment,
          exportMode: "immediate",
          flushAt: 1,
          flushInterval: 1,
        }),
      ],
    });
    setLangfuseTracerProvider(toolTraceProvider);
    return new LangfuseClient({
      api,
      baseUrl: input.baseUrl,
      state,
      toolTraceProvider,
    });
  });

function parseTraceparent(traceparent: string | undefined) {
  const match = traceparent?.match(
    /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i,
  );
  if (!match) return undefined;
  return {
    traceId: match[1].toLowerCase(),
    parentObservationId: match[2].toLowerCase(),
  };
}

function stableTraceId(seed: string) {
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

function isTraceId(value: string) {
  return /^[0-9a-f]{32}$/i.test(value);
}

function isSpanId(value: string) {
  return /^[0-9a-f]{16}$/i.test(value);
}

function stableObservationId(seed: string) {
  return createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

function iso(timestamp: number | undefined) {
  return new Date(timestamp ?? Date.now()).toISOString();
}

function compact<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as T;
}

function usageDetails(tokens: TokenUsage | undefined) {
  if (!tokens) return undefined;
  const usage: Record<string, number> = {};
  if (typeof tokens.input === "number") usage.input = tokens.input;
  if (typeof tokens.output === "number") usage.output = tokens.output;
  if (typeof tokens.reasoning === "number") usage.reasoning = tokens.reasoning;
  if (typeof tokens.cache?.read === "number")
    usage.cache_read = tokens.cache.read;
  if (typeof tokens.cache?.write === "number")
    usage.cache_write = tokens.cache.write;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function formatMessagePart(part: MessagePart) {
  if (part.type === "text")
    return { type: part.type, text: stringField(part, "text") };
  if (part.type === "file")
    return {
      type: part.type,
      filename: stringField(part, "filename"),
      url: stringField(part, "url"),
    };
  if (part.type === "tool")
    return {
      type: part.type,
      tool: stringField(part, "tool") || stringField(part, "name"),
      title: stringField(recordField(part, "state"), "title"),
    };
  if (part.type === "reasoning")
    return { type: part.type, text: stringField(part, "text") };
  return { type: part.type };
}

function recordField(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const field = (value as Record<string, unknown>)[key];
  return field && typeof field === "object"
    ? (field as Record<string, unknown>)
    : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(value: unknown, key: string): string {
  if (!value || typeof value !== "object") return "";
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : "";
}

function numericField(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" ? field : undefined;
}

function extractErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
