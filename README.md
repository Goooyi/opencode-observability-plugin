# Langfuse OpenCode Plugin

OpenCode plugin that sends OpenCode session telemetry to Langfuse. It traces user turns, assistant generations, tool calls, retries, reasoning output, compaction output, and failed generation steps.

This fork is V2-event-first. When OpenCode emits `session.next.*` events, it uses those events keyed by `assistantMessageID` and `callID`. It also supports the common `message.updated` / `message.part.updated` event stream used by OpenCode server integrations. If OpenCode's plugin event hook does not deliver assistant events in server mode, the plugin falls back to polling OpenCode's own session messages through the SDK and emits the same generation, reasoning, and tool observations from the completed message snapshot.

If `OPENCODE_TRACEPARENT` or `TRACEPARENT` is set, plugin spans join that W3C trace. This lets a host application create a platform trace first, start OpenCode with the traceparent in the environment, and get OpenCode generation/tool/reasoning spans as children of the platform trace.

Plugin hooks are serialized in arrival order inside the plugin. This preserves the natural `step.started -> reasoning/tool/text -> step.ended -> session.idle` sequence when V2 events are available, and keeps message-update or session-snapshot fallback observations idempotent when OpenCode emits repeated part updates.

The hooks are intentionally non-blocking from OpenCode's point of view. OpenCode may await plugin hook return values during API requests such as `POST /session`; this plugin queues telemetry internally and returns immediately so Langfuse export latency cannot stall agent sessions.

When OpenCode disposes the plugin, the queue is drained and the Langfuse exporter is shut down. This is important for short-lived or per-job OpenCode server processes where final `session.next.*` events may arrive immediately before process teardown.

## Quick Start

Enable the plugin in your `opencode.json` or `opencode.jsonc`:

```json
{
  "plugin": ["@goooyi/opencode-observability-plugin@latest"]
}
```

Enable OpenCode V2 session events before starting OpenCode when your OpenCode version supports them:

```bash
export OPENCODE_EXPERIMENTAL_EVENT_SYSTEM=true
```

Restart OpenCode after changing the config.

OpenCode native `experimental.openTelemetry` is optional and separate. This plugin creates its own Langfuse OTEL spans from OpenCode plugin events so reasoning text can be captured.

## Host-Managed OpenCode Servers

Use this plugin when OpenCode's plugin runtime is the telemetry boundary, including host-managed `opencode serve` deployments. Host applications should pass `TRACEPARENT` or `OPENCODE_TRACEPARENT` to the OpenCode process when they want OpenCode observations to join an existing platform trace. The host can still consume OpenCode's `/event` stream for live UI, while this plugin owns durable Langfuse generation/tool/reasoning traces.

## Langfuse Credentials

Create `~/.config/opencode/opencode-langfuse.json` with your Langfuse credentials.

```json
{
  "publicKey": "pk-lf-...",
  "secretKey": "sk-lf-...",
  "baseUrl": "https://cloud.langfuse.com",
  "environment": "development",
  "userId": "your-user-id"
}
```

Only `publicKey` and `secretKey` are required. If `baseUrl` is not set, the plugin uses `https://cloud.langfuse.com`. If `environment` is not set, it uses `development`.

You can also set credentials with environment variables:

```bash
export LANGFUSE_PUBLIC_KEY="pk-lf-..."
export LANGFUSE_SECRET_KEY="sk-lf-..."
export LANGFUSE_BASEURL="https://cloud.langfuse.com"
export LANGFUSE_ENVIRONMENT="development"
export LANGFUSE_USER_ID="your-user-id"
```

If both `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are set, the plugin uses environment variables instead of reading the config file. Optional values can be supplied either way.

## License

[MIT](./LICENSE)
