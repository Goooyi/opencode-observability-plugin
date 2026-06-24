import type { PluginInput } from "@opencode-ai/plugin";
import { Context as EffectContext } from "effect";

export type OpencodeClient = {
  app: PluginInput["client"]["app"];
  event: PluginInput["client"]["event"];
  session: PluginInput["client"]["session"];
};

export class OpencodeClientService extends EffectContext.Tag(
  "OpencodeClientService",
)<OpencodeClientService, OpencodeClient>() {}
