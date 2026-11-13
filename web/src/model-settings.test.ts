import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelSettings } from "./ModelSettings";
import type { MaskedSettings } from "./api";

function model(id: string, name: string) {
  return {
    id,
    name,
    contextWindow: 128_000,
    maxTokens: 8_192,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    status: "available",
  };
}

function settingsWith(defaultModel: string): MaskedSettings {
  return {
    providers: [
      {
        id: "deepseek",
        api: "openai-completions",
        baseUrl: "https://api.deepseek.com/v1",
        auth: "api-key",
        hasApiKey: true,
        models: [model("deepseek-chat", "DeepSeek Chat"), model("deepseek-flash", "DeepSeek Flash")],
      },
      {
        id: "openai",
        api: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
        auth: "api-key",
        hasApiKey: true,
        models: [model("gpt-4o-mini", "GPT-4o mini")],
      },
    ],
    selection: {
      defaultModel,
      aliases: {},
      fallbacks: [],
      modelParams: {},
      params: {},
      allow: [],
    },
    limits: {},
    learning: {},
    advisors: {},
    curation: {},
  } as unknown as MaskedSettings;
}

function render(settings: MaskedSettings): string {
  return renderToStaticMarkup(
    createElement(ModelSettings, { settings, onSaved: () => undefined }),
  );
}

describe("模型设置的默认模型下拉", () => {
  it("只列当前供应商的模型，不混入别家", () => {
    const html = render(settingsWith("deepseek/deepseek-chat"));
    expect(html).toContain("DeepSeek Chat");
    expect(html).toContain("DeepSeek Flash");
    expect(html).not.toContain("GPT-4o mini");
    expect(html).not.toContain("当前默认，其他供应商");
  });

  it("全局默认属于别家时保留一个当前值，供切回或确认", () => {
    const html = render(settingsWith("openai/gpt-4o-mini"));
    expect(html).toContain("openai/gpt-4o-mini（当前默认，其他供应商）");
  });
});
