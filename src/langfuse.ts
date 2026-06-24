import { LangfuseSpanProcessor } from "@langfuse/otel";
import type { Hooks } from "@opencode-ai/plugin";
import {
  SpanStatusCode,
  context,
  propagation,
  trace,
} from "@opentelemetry/api";
import type {
  Context as ApiContext,
  Span as ApiSpan,
  Tracer,
} from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Context as EffectContext, Effect } from "effect";

import { PLUGIN_VERSION } from "./version.js";

export class LangfuseClient {
  readonly baseUrl: string;
  readonly forceFlush: Effect.Effect<void, unknown>;
  readonly shutdown: Effect.Effect<void, unknown>;
  private readonly traceState: LangfuseTraceState;

  constructor(input: {
    baseUrl: string;
    traceState: LangfuseTraceState;
    forceFlush: Effect.Effect<void, unknown>;
    shutdown: Effect.Effect<void, unknown>;
  }) {
    this.baseUrl = input.baseUrl;
    this.traceState = input.traceState;
    this.forceFlush = input.forceFlush;
    this.shutdown = input.shutdown;
  }

  clearTraceState() {
    this.traceState.tracedMessageIds.clear();
    this.traceState.tracedGenerationIds.clear();
    this.traceState.tracedEventIds.clear();
    this.traceState.tracedReasoningIds.clear();
    this.traceState.tracedToolCallIds.clear();
    this.traceState.tracedToolResultIds.clear();
    this.traceState.textPartsByAssistantMessageId.clear();
    this.traceState.generationSpansByAssistantMessageId.clear();
    this.traceState.turnObservationsByMessageId.clear();
    this.traceState.latestTurnObservationsBySession.clear();
    this.traceState.activeToolObservations.clear();
  }

  endActiveToolObservations() {
    for (const observation of this.traceState.activeToolObservations.values()) {
      observation.span.end();
    }

    this.traceState.activeToolObservations.clear();
  }

  endActiveGenerationSteps() {
    for (const observation of this.traceState.generationSpansByAssistantMessageId.values()) {
      observation.span.end();
    }

    this.traceState.generationSpansByAssistantMessageId.clear();
  }

  endActiveTurnObservations() {
    for (const observation of new Set(
      this.traceState.latestTurnObservationsBySession.values(),
    )) {
      observation.span.end();
    }

    this.traceState.turnObservationsByMessageId.clear();
    this.traceState.latestTurnObservationsBySession.clear();
  }

  traceEvent(input: {
    id: string;
    sessionID: string;
    name: string;
    timestamp: number;
    input?: unknown;
    output?: unknown;
    metadata?: unknown;
    parentSpan?: ApiSpan;
  }) {
    if (this.traceState.tracedEventIds.has(input.id)) {
      return;
    }

    this.traceState.tracedEventIds.add(input.id);

    const startEvent = () => {
      const span = this.traceState.tracer.startSpan(input.name, {
        attributes: compactAttributes({
          "langfuse.observation.type": "event",
          "session.id": input.sessionID,
          "langfuse.observation.input":
            input.input === undefined ? undefined : stringify(input.input),
          "langfuse.observation.output":
            input.output === undefined ? undefined : stringify(input.output),
          "langfuse.observation.metadata": stringify(input.metadata),
        }),
        startTime: new Date(input.timestamp),
      });

      span.end(new Date(input.timestamp));
    };

    if (input.parentSpan) {
      context.with(
        trace.setSpan(context.active(), input.parentSpan),
        startEvent,
      );
      return;
    }

    this.withTurnParent(input.sessionID, undefined, startEvent);
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
      this.traceState.tracedMessageIds.has(input.messageID)
    ) {
      return;
    }

    const formattedInput = {
      role: "user" as const,
      parts: input.parts.map(formatMessagePart),
    };

    if (input.messageID) {
      this.traceState.tracedMessageIds.add(input.messageID);
    }

    const previousTurn = this.traceState.latestTurnObservationsBySession.get(
      input.sessionID,
    );

    if (previousTurn) {
      previousTurn.span.end();
      this.traceState.latestTurnObservationsBySession.delete(input.sessionID);
    }

    const span = this.withRootParent(() =>
      this.traceState.tracer.startSpan("opencode.turn", {
        attributes: compactAttributes({
          "langfuse.observation.type": "span",
          "session.id": input.sessionID,
          "langfuse.observation.input": stringify(formattedInput),
          "langfuse.observation.metadata": stringify({
            messageID: input.messageID,
            agent: input.agent,
            providerID: input.model?.providerID,
            modelID: input.model?.modelID,
          }),
        }),
      }),
    );

    const observation = {
      span,
      sessionID: input.sessionID,
      messageID: input.messageID,
    } satisfies TurnObservation;

    if (input.messageID) {
      this.traceState.turnObservationsByMessageId.set(
        input.messageID,
        observation,
      );
    }

    this.traceState.latestTurnObservationsBySession.set(
      input.sessionID,
      observation,
    );

    context.with(trace.setSpan(context.active(), span), () => {
      const event = this.traceState.tracer.startSpan("opencode.message.user", {
        attributes: compactAttributes({
          "langfuse.observation.type": "event",
          "session.id": input.sessionID,
          "langfuse.observation.input": stringify(formattedInput),
          "langfuse.observation.metadata": stringify({
            messageID: input.messageID,
            agent: input.agent,
            providerID: input.model?.providerID,
            modelID: input.model?.modelID,
          }),
        }),
      });

      event.end();
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
      timestamp: input.message.time.created,
    });

    if (input.message.error) {
      this.failGenerationStep({
        sessionID: input.sessionID,
        assistantMessageID: input.message.id,
        timestamp: input.message.time.completed ?? input.message.time.created,
        error: {
          message: extractErrorMessage(input.message.error),
        },
      });
      return;
    }

    if (input.message.time.completed == null) return;

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
        assistantMessageID: part.messageID,
        textID: part.id,
        text: part.text,
      });
      return;
    }

    if (part.type === "reasoning") {
      this.traceReasoning({
        assistantMessageID: part.messageID,
        reasoningID: part.id,
        sessionID: input.sessionID,
        timestamp: part.time.end ?? input.timestamp,
        text: part.text,
        providerMetadata: part.metadata,
      });
      return;
    }

    if (part.type !== "tool") return;
    const state = part.state;
    if (state.status === "pending") return;

    const start = "time" in state ? state.time.start : input.timestamp;
    this.traceToolCalled({
      sessionID: input.sessionID,
      assistantMessageID: part.messageID,
      callID: part.callID,
      tool: part.tool,
      args: state.input,
      timestamp: start,
      provider: part.metadata,
    });

    if (state.status === "completed") {
      this.traceToolSuccess({
        callID: part.callID,
        timestamp: state.time.end,
        output: {
          output: state.output,
          title: state.title,
          metadata: state.metadata,
          attachments: state.attachments,
        },
        provider: part.metadata,
      });
    }

    if (state.status === "error") {
      this.traceToolFailed({
        callID: part.callID,
        timestamp: state.time.end,
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
    if (this.traceState.tracedGenerationIds.has(input.message.id)) return true;

    this.startGenerationStep({
      sessionID: input.sessionID,
      assistantMessageID: input.message.id,
      model: {
        id: input.message.modelID,
        providerID: input.message.providerID,
      },
      timestamp: input.message.time.created,
    });

    for (const part of input.parts) {
      this.traceMessagePartUpdated({
        sessionID: input.sessionID,
        part,
        timestamp: Date.now(),
      });
    }

    if (input.message.error) {
      this.failGenerationStep({
        sessionID: input.sessionID,
        assistantMessageID: input.message.id,
        timestamp: input.message.time.completed ?? input.message.time.created,
        error: {
          message: extractErrorMessage(input.message.error),
        },
      });
      return true;
    }

    if (input.message.time.completed == null) return false;

    this.finishGenerationStep({
      sessionID: input.sessionID,
      assistantMessageID: input.message.id,
      timestamp: input.message.time.completed,
      finish: input.message.finish ?? "unknown",
      cost: input.message.cost,
      tokens: input.message.tokens,
    });
    return true;
  }

  startGenerationStep(input: {
    sessionID: string;
    assistantMessageID: string;
    agent?: string;
    model: NonNullable<ActiveGenerationStep["model"]>;
    timestamp: number;
    snapshot?: string;
  }) {
    if (this.traceState.tracedGenerationIds.has(input.assistantMessageID)) {
      return;
    }

    const existing = this.traceState.generationSpansByAssistantMessageId.get(
      input.assistantMessageID,
    );
    existing?.span.end(new Date(input.timestamp));

    this.withTurnParent(input.sessionID, undefined, () => {
      const span = this.traceState.tracer.startSpan("opencode.generation", {
        attributes: compactAttributes({
          "langfuse.observation.type": "generation",
          "session.id": input.sessionID,
          "langfuse.observation.model.name": input.model.id,
          "langfuse.observation.metadata": stringify({
            assistantMessageID: input.assistantMessageID,
            agent: input.agent,
            providerID: input.model.providerID,
            variant: input.model.variant,
            snapshot: input.snapshot,
          }),
        }),
        startTime: new Date(input.timestamp),
      });

      this.traceState.generationSpansByAssistantMessageId.set(
        input.assistantMessageID,
        {
          agent: input.agent,
          assistantMessageID: input.assistantMessageID,
          model: input.model,
          sessionID: input.sessionID,
          snapshot: input.snapshot,
          span,
        },
      );
    });
  }

  recordAssistantText(input: {
    assistantMessageID: string;
    textID: string;
    text: string;
  }) {
    const parts =
      this.traceState.textPartsByAssistantMessageId.get(
        input.assistantMessageID,
      ) ?? new Map<string, string>();
    parts.set(input.textID, input.text);
    this.traceState.textPartsByAssistantMessageId.set(
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

    const reasoningTraceKey = `${input.assistantMessageID}:${input.reasoningID}`;
    if (this.traceState.tracedReasoningIds.has(reasoningTraceKey)) return;
    this.traceState.tracedReasoningIds.add(reasoningTraceKey);

    this.traceEvent({
      id: `reasoning:${reasoningTraceKey}`,
      sessionID: input.sessionID,
      name: "opencode.generation.reasoning",
      timestamp: input.timestamp,
      output: { text: input.text },
      metadata: {
        assistantMessageID: input.assistantMessageID,
        reasoningID: input.reasoningID,
        providerMetadata: input.providerMetadata,
        source: "session.next.reasoning.ended",
      },
      parentSpan: this.traceState.generationSpansByAssistantMessageId.get(
        input.assistantMessageID,
      )?.span,
    });
  }

  finishGenerationStep(input: {
    sessionID: string;
    assistantMessageID: string;
    timestamp: number;
    finish: string;
    cost: number;
    tokens: TokenUsage;
    snapshot?: string;
  }) {
    if (this.traceState.tracedGenerationIds.has(input.assistantMessageID)) {
      return;
    }

    this.traceState.tracedGenerationIds.add(input.assistantMessageID);

    const observation = this.traceState.generationSpansByAssistantMessageId.get(
      input.assistantMessageID,
    );
    if (!observation) return;

    observation.span.setAttribute(
      "langfuse.observation.output",
      stringify({
        role: "assistant",
        content: this.getAssistantText(input.assistantMessageID),
      }),
    );
    observation.span.setAttribute(
      "langfuse.observation.usage_details",
      stringify({
        input: input.tokens.input,
        output: input.tokens.output,
        reasoning: input.tokens.reasoning,
        cache_read: input.tokens.cache?.read ?? 0,
        cache_write: input.tokens.cache?.write ?? 0,
        total:
          input.tokens.input + input.tokens.output + input.tokens.reasoning,
      }),
    );
    observation.span.setAttribute(
      "langfuse.observation.cost_details",
      stringify({ total: input.cost }),
    );
    observation.span.setAttribute(
      "langfuse.observation.metadata",
      stringify({
        assistantMessageID: input.assistantMessageID,
        agent: observation.agent,
        providerID: observation.model?.providerID,
        variant: observation.model?.variant,
        snapshot: input.snapshot ?? observation.snapshot,
        finish: input.finish,
      }),
    );
    observation.span.end(new Date(input.timestamp));
    this.traceState.generationSpansByAssistantMessageId.delete(
      input.assistantMessageID,
    );
  }

  failGenerationStep(input: {
    sessionID: string;
    assistantMessageID: string;
    timestamp: number;
    error: { message: string };
  }) {
    if (this.traceState.tracedGenerationIds.has(input.assistantMessageID)) {
      return;
    }

    this.traceState.tracedGenerationIds.add(input.assistantMessageID);

    const observation = this.traceState.generationSpansByAssistantMessageId.get(
      input.assistantMessageID,
    );

    if (!observation) return;

    observation.span.setAttribute(
      "langfuse.observation.output",
      stringify({ error: input.error }),
    );
    observation.span.setStatus({
      code: SpanStatusCode.ERROR,
      message: input.error.message,
    });
    observation.span.recordException(input.error);
    observation.span.end(new Date(input.timestamp));
    this.traceState.generationSpansByAssistantMessageId.delete(
      input.assistantMessageID,
    );
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
    if (this.traceState.tracedToolCallIds.has(input.callID)) return;
    this.traceState.tracedToolCallIds.add(input.callID);
    this.traceState.activeToolObservations.get(input.callID)?.span.end();

    const parent = this.traceState.generationSpansByAssistantMessageId.get(
      input.assistantMessageID,
    )?.span;

    const start = () => {
      const span = this.traceState.tracer.startSpan(input.tool, {
        attributes: compactAttributes({
          "langfuse.observation.type": "tool",
          "session.id": input.sessionID,
          "langfuse.observation.input": stringify(input.args),
          "langfuse.observation.metadata": stringify({
            assistantMessageID: input.assistantMessageID,
            callID: input.callID,
            provider: input.provider,
            tool: input.tool,
          }),
        }),
        startTime: new Date(input.timestamp),
      });

      this.traceState.activeToolObservations.set(input.callID, {
        assistantMessageID: input.assistantMessageID,
        args: input.args,
        sessionID: input.sessionID,
        span,
        tool: input.tool,
      });
    };

    parent
      ? context.with(trace.setSpan(context.active(), parent), start)
      : this.withRootParent(start);
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
    if (this.traceState.tracedToolResultIds.has(callID)) return;
    const observation = this.traceState.activeToolObservations.get(callID);
    if (!observation) return;
    this.traceState.tracedToolResultIds.add(callID);

    observation.span.setAttribute(
      "langfuse.observation.output",
      stringify(output),
    );
    observation.span.setAttribute(
      "langfuse.observation.metadata",
      stringify({
        assistantMessageID: observation.assistantMessageID,
        callID,
        provider,
        tool: observation.tool,
      }),
    );

    if (error) {
      const exception =
        error instanceof Error ? error : new Error(stringify(error));
      observation.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: exception.message,
      });
      observation.span.recordException(exception);
    }

    observation.span.end(new Date(timestamp));
    this.traceState.activeToolObservations.delete(callID);
  }

  private withTurnParent<T>(
    sessionID: string,
    messageID: string | undefined,
    fn: () => T,
  ) {
    const parentSpan =
      (messageID
        ? this.traceState.turnObservationsByMessageId.get(messageID)?.span
        : undefined) ??
      this.traceState.latestTurnObservationsBySession.get(sessionID)?.span;

    return parentSpan
      ? context.with(trace.setSpan(context.active(), parentSpan), fn)
      : this.withRootParent(fn);
  }

  private withRootParent<T>(fn: () => T) {
    return context.with(this.traceState.rootContext, fn);
  }

  private getAssistantText(assistantMessageID: string) {
    return Array.from(
      this.traceState.textPartsByAssistantMessageId
        .get(assistantMessageID)
        ?.values() ?? [],
    ).join("");
  }
}

export type LangfuseTraceState = {
  tracerName: string;
  tracer: Tracer;
  rootContext: ApiContext;
  hasExternalTraceParent: boolean;
  tracedMessageIds: Set<string>;
  tracedGenerationIds: Set<string>;
  tracedEventIds: Set<string>;
  tracedReasoningIds: Set<string>;
  tracedToolCallIds: Set<string>;
  tracedToolResultIds: Set<string>;
  textPartsByAssistantMessageId: Map<string, Map<string, string>>;
  generationSpansByAssistantMessageId: Map<string, ActiveGenerationStep>;
  turnObservationsByMessageId: Map<string, TurnObservation>;
  latestTurnObservationsBySession: Map<string, TurnObservation>;
  activeToolObservations: Map<string, ToolObservation>;
};

export type MessagePart = Extract<
  Parameters<NonNullable<Hooks["event"]>>[0]["event"],
  { type: "message.part.updated" }
>["properties"]["part"];

export type UpdatedMessage = Extract<
  Parameters<NonNullable<Hooks["event"]>>[0]["event"],
  { type: "message.updated" }
>["properties"]["info"];

export type FormattedMessagePart =
  | { type: string; text: string }
  | { type: string; filename?: string; url?: string }
  | { type: string; name?: string }
  | { type: string; prompt?: string; agent?: string }
  | { type: string; tool?: string; title?: string }
  | { type: string };

export type TurnObservation = {
  span: ApiSpan;
  sessionID: string;
  messageID?: string;
};

export type ToolObservation = {
  assistantMessageID: string;
  args: unknown;
  span: ApiSpan;
  sessionID: string;
  tool: string;
};

export type TokenUsage = {
  input: number;
  output: number;
  reasoning: number;
  cache?: { read: number; write: number };
};

export type ActiveGenerationStep = {
  agent?: string;
  assistantMessageID: string;
  model?: {
    id: string;
    providerID: string;
    variant?: string;
  };
  sessionID: string;
  snapshot?: string;
  span: ApiSpan;
};

export class LangfuseClientService extends EffectContext.Tag(
  "LangfuseClientService",
)<LangfuseClientService, LangfuseClient>() {}

const makeUserIdSpanProcessor = (userId: string) =>
  ({
    onStart: (span: Span, _parentContext: unknown) => {
      span.setAttribute("langfuse.user.id", userId);
    },
    onEnd: (_span: ReadableSpan) => {},
    shutdown: () => Promise.resolve(),
    forceFlush: () => Promise.resolve(),
  }) satisfies SpanProcessor;

const makePluginVersionSpanProcessor = () =>
  ({
    onStart: (span: Span, _parentContext: unknown) => {
      span.setAttribute("langfuse.plugin.version", PLUGIN_VERSION);
    },
    onEnd: (_span: ReadableSpan) => {},
    shutdown: () => Promise.resolve(),
    forceFlush: () => Promise.resolve(),
  }) satisfies SpanProcessor;

const makeAppRootSpanProcessor = (
  tracerName: string,
  hasExternalTraceParent: boolean,
) =>
  ({
    onStart: (span: Span, _parentContext: unknown) => {
      if (span.instrumentationScope.name !== tracerName) return;
      span.setAttribute(
        "langfuse.internal.is_app_root",
        !hasExternalTraceParent && span.name === "opencode.turn",
      );
    },
    onEnd: (_span: ReadableSpan) => {},
    shutdown: () => Promise.resolve(),
    forceFlush: () => Promise.resolve(),
  }) satisfies SpanProcessor;

export const createLangfuseClient = (input: {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  environment: string;
  userId?: string;
}) =>
  Effect.gen(function* () {
    const tracerName = "opencode-langfuse-plugin";
    const traceparent =
      process.env.OPENCODE_TRACEPARENT ?? process.env.TRACEPARENT;
    const traceState: LangfuseTraceState = {
      tracerName,
      tracer: trace.getTracer(tracerName, PLUGIN_VERSION),
      rootContext: context.active(),
      hasExternalTraceParent: Boolean(traceparent),
      tracedMessageIds: new Set<string>(),
      tracedGenerationIds: new Set<string>(),
      tracedEventIds: new Set<string>(),
      tracedReasoningIds: new Set<string>(),
      tracedToolCallIds: new Set<string>(),
      tracedToolResultIds: new Set<string>(),
      textPartsByAssistantMessageId: new Map<string, Map<string, string>>(),
      generationSpansByAssistantMessageId: new Map<
        string,
        ActiveGenerationStep
      >(),
      turnObservationsByMessageId: new Map<string, TurnObservation>(),
      latestTurnObservationsBySession: new Map<string, TurnObservation>(),
      activeToolObservations: new Map<string, ToolObservation>(),
    };

    const processor = new LangfuseSpanProcessor({
      publicKey: input.publicKey,
      secretKey: input.secretKey,
      baseUrl: input.baseUrl,
      environment: input.environment,
      shouldExportSpan: ({ otelSpan }) =>
        otelSpan.instrumentationScope.name === traceState.tracerName,
    });

    const sdk = new NodeSDK({
      spanProcessors: [
        makePluginVersionSpanProcessor(),
        ...(input.userId ? [makeUserIdSpanProcessor(input.userId)] : []),
        processor,
        makeAppRootSpanProcessor(
          traceState.tracerName,
          traceState.hasExternalTraceParent,
        ),
      ],
    });
    let isShutdown = false;

    yield* Effect.sync(() => sdk.start());
    traceState.rootContext = traceparent
      ? propagation.extract(context.active(), { traceparent })
      : context.active();

    return new LangfuseClient({
      baseUrl: input.baseUrl,
      traceState,
      forceFlush: Effect.tryPromise(() => processor.forceFlush()),
      shutdown: Effect.tryPromise(async () => {
        if (isShutdown) return;
        isShutdown = true;
        await sdk.shutdown();
      }),
    });
  });

function formatMessagePart(part: MessagePart): FormattedMessagePart {
  if (part.type === "text") return { type: part.type, text: part.text ?? "" };
  if (part.type === "file")
    return { type: part.type, filename: part.filename, url: part.url };
  if (part.type === "agent") return { type: part.type, name: part.name };
  if (part.type === "subtask")
    return { type: part.type, prompt: part.prompt, agent: part.agent };
  if (part.type === "tool") {
    return {
      type: part.type,
      tool: part.tool,
      title: "title" in part.state ? part.state.title : undefined,
    };
  }
  return { type: part.type };
}

function extractErrorMessage(error: unknown) {
  if (typeof error === "object" && error !== null && "data" in error) {
    const data = (error as { data?: unknown }).data;
    if (typeof data === "object" && data !== null && "message" in data) {
      const message = (data as { message?: unknown }).message;
      if (typeof message === "string") return message;
    }
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return stringify(error);
}

function stringify(input: unknown) {
  return JSON.stringify(input);
}

function compactAttributes(
  input: Record<string, string | number | boolean | undefined>,
) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}
