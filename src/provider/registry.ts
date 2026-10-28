import type { Settings } from "../core/settings";
import { MockProvider, demoHandler, type MockHandler } from "./mock";
import { OpenAiCompatibleProvider } from "./openai-compatible";
import type { LlmProvider } from "./types";

export interface ResolvedProvider {
  provider: LlmProvider;
  model: string;
  providerId: string;
}

export interface ProviderDeps {
  settings: Settings;
  mockHandler?: MockHandler;
}

export function resolveProvider(memberProviderId: string, deps: ProviderDeps): ResolvedProvider {
  const activeId =
    memberProviderId === "default" ? deps.settings.activeProviderId : memberProviderId;
  const config =
    deps.settings.providers.find((p) => p.id === activeId) ?? deps.settings.providers[0];
  if (!config) throw new Error("未配置任何模型 provider，请在设置里添加");

  if (config.kind === "mock") {
    return {
      provider: new MockProvider(deps.mockHandler ?? demoHandler()),
      model: config.model || "mock",
      providerId: config.id,
    };
  }
  if (!config.apiKey) {
    throw new Error(`provider「${config.id}」缺少 API Key，请在设置里填写`);
  }
  return {
    provider: new OpenAiCompatibleProvider({
      id: config.id,
      baseUrl: config.baseUrl ?? "https://api.openai.com/v1",
      apiKey: config.apiKey,
      model: config.model,
    }),
    model: config.model,
    providerId: config.id,
  };
}
