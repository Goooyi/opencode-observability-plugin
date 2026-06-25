# Langfuse OpenCode Plugin

OpenCode plugin that sends OpenCode session telemetry to Langfuse. It traces user turns, assistant generations, tool calls, retries, reasoning output, compaction output, and failed generation steps.

This fork traces the stable OpenCode plugin event stream. It supports the common `message.updated` / `message.part.updated` events used by OpenCode server integrations, and also accepts `session.next.*` events when an OpenCode version delivers them through the plugin hook. It does not poll completed session messages to reconstruct traces.

If `OPENCODE_TRACEPARENT` or `TRACEPARENT` is set, plugin spans join that W3C trace. For long-lived OpenCode hosts, put `traceparent` in OpenCode session metadata instead; the plugin will use the session metadata parent for observations from that session. This lets a host application reuse one OpenCode server while each OpenCode session still joins the correct platform trace.

Plugin hooks are serialized in arrival order inside the plugin. This keeps message-update observations idempotent when OpenCode emits repeated part updates, and preserves `session.next.*` ordering when those events are available. The plugin also accepts deprecated `session.idle` events for older OpenCode versions.

The hooks avoid blocking OpenCode on Langfuse export. `chat.message` records the user turn and returns immediately; assistant/tool/reasoning events are processed asynchronously from OpenCode's native plugin event hook.

When OpenCode disposes the plugin, the queue is drained and the Langfuse exporter is shut down.

## Quick Start

Enable the plugin in your `opencode.json` or `opencode.jsonc`:

```json
{
  "plugin": ["@goooyi/opencode-observability-plugin@latest"]
}
```

Restart OpenCode after changing the config.

OpenCode native `experimental.openTelemetry` is optional and separate. This plugin sends Langfuse ingestion events from OpenCode plugin events so reasoning text can be captured without installing a process-wide OTEL SDK inside OpenCode.

## Host-Managed OpenCode Servers

Use this plugin when OpenCode's plugin runtime is the telemetry boundary, including host-managed `opencode serve` deployments. Host applications can pass `TRACEPARENT` or `OPENCODE_TRACEPARENT` to a short-lived OpenCode process. For reused hosts, create each OpenCode session with metadata like:

```json
{
  "traceparent": "00-<trace-id>-<parent-observation-id>-01"
}
```

The host can still consume OpenCode's `/event` stream for live UI; this plugin uses OpenCode's native plugin hooks for durable Langfuse generation/tool/reasoning traces.

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
