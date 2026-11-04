import { describe, expect, it } from "vitest";
import { defaultSettings } from "../src/core/settings";
import { catalogSuggestions } from "../src/model/catalog";
import { resolveModelChain } from "../src/model/refs";
import { probeModel } from "../src/model/probe";

describe("内置模型目录建议", () => {
  it("只给同族模型，不会把别家的模型 id 建议过来", () => {
    const openai = catalogSuggestions("openai").map((item) => item.ref);
    expect(openai).toContain("openai/gpt-4o-mini");
    expect(openai.some((ref) => /deepseek|qwen|glm|kimi|moonshot|grok|llama/.test(ref))).toBe(false);

    const deepseek = catalogSuggestions("deepseek").map((item) => item.ref);
    expect(deepseek).toContain("deepseek/deepseek-chat");
    expect(deepseek.some((ref) => /gpt|qwen|glm/.test(ref))).toBe(false);
  });

  it("认不出族的自定义供应商不给建议，避免造出解析不了的引用", () => {
    expect(catalogSuggestions("company-gateway")).toEqual([]);
  });
});

describe("模型引用解析", () => {
  it("默认模型被清空时给出可操作的中文提示", () => {
    const settings = defaultSettings();
    settings.selection.defaultModel = "";
    expect(() => resolveModelChain(settings, "")).toThrowError(/还没有设置默认模型/);
  });
});

describe("测试连接探针", () => {
  it("面板里的临时供应商测的是它自己的第一个模型", async () => {
    const settings = defaultSettings();
    // 复现「默认模型还没填就点测试连接」：探针不该退回默认模型并报「供应商「」不存在」。
    settings.selection.defaultModel = "";
    const result = await probeModel(
      {
        provider: { id: "tmp", api: "mock", models: [{ id: "t1", name: "临时模型" }] },
      },
      { settings },
    );
    expect(result.ref).toBe("tmp/t1");
    expect(result.status).toBe("ok");
  });

  it("临时供应商一个模型都没加时，提示先登记模型", async () => {
    const settings = defaultSettings();
    settings.selection.defaultModel = "";
    const result = await probeModel(
      { provider: { id: "tmp", api: "mock", models: [] } },
      { settings },
    );
    expect(result.status).toBe("no_model");
    expect(result.error).toMatch(/供应商「tmp」/);
  });
});
