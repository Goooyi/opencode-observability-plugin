# Langfuse OpenCode Plugin

OpenCode plugin that sends OpenCode V2 session events to Langfuse. It traces user turns, assistant generations, tool calls, retries, reasoning output, compaction output, and failed generation steps.

This fork is V2-event-first. It uses `session.next.*` events keyed by `assistantMessageID` and `callID`, so it does not infer tool/reasoning parents from legacy `message.part.updated` events.

If `OPENCODE_TRACEPARENT` or `TRACEPARENT` is set, plugin spans join that W3C trace. This lets a host application create a platform trace first, start OpenCode with the traceparent in the environment, and get OpenCode generation/tool/reasoning spans as children of the platform trace.

V2 plugin hooks are serialized in arrival order inside the plugin. This preserves the natural `step.started -> reasoning/tool/text -> step.ended -> session.idle` sequence without timestamp offsets or inferred parent reconstruction.

The hooks are intentionally non-blocking from OpenCode's point of view. OpenCode may await plugin hook return values during API requests such as `POST /session`; this plugin queues telemetry internally and returns immediately so Langfuse export latency cannot stall agent sessions.

When OpenCode disposes the plugin, the queue is drained and the Langfuse exporter is shut down. This is important for short-lived or per-job OpenCode server processes where final `session.next.*` events may arrive immediately before process teardown.

## Quick Start

Enable the plugin in your `opencode.json` or `opencode.jsonc`:

```json
{
  "plugin": ["@goooyi/opencode-observability-plugin@latest"]
}
```

Enable OpenCode V2 session events before starting OpenCode:

```bash
export OPENCODE_EXPERIMENTAL_EVENT_SYSTEM=true
```

Restart OpenCode after changing the config.

OpenCode native `experimental.openTelemetry` is optional and separate. This plugin creates its own Langfuse OTEL spans from V2 events so reasoning text can be captured.

## Host-Managed OpenCode Servers

If your application owns the OpenCode server process and already consumes OpenCode's `/event` stream, prefer recording those V2 events in the host application. That path gives the host exact control over platform trace parenting, session lifecycle, retries, and shutdown.

Use this plugin when OpenCode's plugin runtime is the telemetry boundary, for example local OpenCode usage or deployments where plugin hooks are the cleanest integration point. In both cases the event source is the same V2 `session.next.*` event stream.

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
