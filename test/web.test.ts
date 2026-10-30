import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildWebTools, type WebToolOptions } from "../src/web/tools";
import { fetchWebPage } from "../src/web/fetch";
import { searchWeb } from "../src/web/search";
import { assertPublicHttpUrl, isPrivateAddress, WebUrlBlockedError } from "../src/web/ssrf";
import { decodeEntities, extractTitle, htmlToMarkdown } from "../src/web/html";
import { BUILTIN_SHARED_SKILLS } from "../src/skills/builtin";
import { SkillLibrary } from "../src/skills/library";

const signal = new AbortController().signal;
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

function htmlResponse(
  body: string | Uint8Array,
  init: { status?: number; contentType?: string } = {},
): Response {
  return new Response(body as ConstructorParameters<typeof Response>[0], {
    status: init.status ?? 200,
    headers: { "content-type": init.contentType ?? "text/html; charset=utf-8" },
  });
}

function asFetch(
  handler: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>,
): typeof fetch {
  return handler as unknown as typeof fetch;
}

describe("html 抽取", () => {
  it("标题、段落、链接、列表与实体都能转换为可读 Markdown", () => {
    const html = `<html><head><title> 标题 &amp; 副标题 </title><style>.x{}</style></head>
      <body><h1>一级</h1><p>正文 <a href="/a?x=1&amp;y=2">链接</a> &lt;保留&gt;</p>
      <ul><li>甲</li><li>乙</li></ul><script>alert(1)</script>
      <pre>const a = 1;\n  if (a) {}</pre></body></html>`;
    expect(extractTitle(html)).toBe("标题 & 副标题");
    const markdown = htmlToMarkdown(html, "https://example.com/dir/page");
    expect(markdown).toContain("# 一级");
    expect(markdown).toContain("[链接](https://example.com/a?x=1&y=2)");
    expect(markdown).toContain("<保留>");
    expect(markdown).toContain("- 甲");
    expect(markdown).not.toContain("alert(1)");
    expect(markdown).not.toContain(".x{}");
    expect(markdown).toContain("const a = 1;\n  if (a) {}");
  });

  it("实体解码覆盖命名与数字形式", () => {
    expect(decodeEntities("&amp;&lt;&#65;&#x4e2d;&nbsp;&hellip;")).toBe("&<A中 …");
  });
});

describe("SSRF 防护", () => {
  it("拒绝本地主机、私网、非 http 协议与带凭据的链接", async () => {
    await expect(assertPublicHttpUrl("http://127.0.0.1/")).rejects.toBeInstanceOf(WebUrlBlockedError);
    await expect(assertPublicHttpUrl("http://localhost:8788/")).rejects.toBeInstanceOf(WebUrlBlockedError);
    await expect(assertPublicHttpUrl("file:///etc/passwd")).rejects.toBeInstanceOf(WebUrlBlockedError);
    await expect(assertPublicHttpUrl("http://user:pass@example.com/")).rejects.toBeInstanceOf(WebUrlBlockedError);
    await expect(
      assertPublicHttpUrl("http://internal.example/", async () => [{ address: "10.0.0.5", family: 4 }]),
    ).rejects.toBeInstanceOf(WebUrlBlockedError);
    await expect(
      assertPublicHttpUrl("http://[::1]/", async () => [{ address: "::1", family: 6 }]),
    ).rejects.toBeInstanceOf(WebUrlBlockedError);
  });

  it("允许公网地址，并放行代理 fake-ip 段 198.18/15", async () => {
    await expect(assertPublicHttpUrl("https://example.com/", publicLookup)).resolves.toBeInstanceOf(URL);
    await expect(
      assertPublicHttpUrl("https://example.com/", async () => [{ address: "198.18.14.173", family: 4 }]),
    ).resolves.toBeInstanceOf(URL);
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
    expect(isPrivateAddress("198.18.14.173")).toBe(false);
  });
});

describe("fetchWebPage", () => {
  it("抽取标题与正文，并逐跳校验重定向", async () => {
    const calls: string[] = [];
    const page = await fetchWebPage("https://example.com/start", {
      lookup: publicLookup,
      fetchImpl: asFetch(async (input) => {
        calls.push(String(input));
        if (calls.length === 1) {
          return new Response(null, { status: 302, headers: { location: "/next" } });
        }
        return htmlResponse("<title>下一页</title><p>正文 <a href='/x'>链接</a></p>");
      }),
    });
    expect(page.status).toBe(200);
    expect(page.finalUrl).toBe("https://example.com/next");
    expect(page.redirects).toBe(1);
    expect(page.title).toBe("下一页");
    expect(page.text).toContain("[链接](https://example.com/x)");
  });

  it("重定向到内网地址会被拦截", async () => {
    await expect(
      fetchWebPage("https://example.com/", {
        lookup: publicLookup,
        fetchImpl: asFetch(async () =>
          new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } }),
        ),
      }),
    ).rejects.toThrow(/内网/);
  });

  it("按 maxChars/start 截断并给出续读位置", async () => {
    const body = `<title>长文</title><p>${"字".repeat(1200)}</p>`;
    const page = await fetchWebPage("https://example.com/", {
      lookup: publicLookup,
      maxChars: 500,
      start: 500,
      fetchImpl: asFetch(async () => htmlResponse(body)),
    });
    expect(page.totalChars).toBeGreaterThanOrEqual(1200);
    expect(page.text.length).toBe(500);
    expect(page.nextStart).toBe(1000);
    expect(page.truncated).toBe(true);
  });

  it("按响应头 charset 解码中文页面", async () => {
    const bytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);
    const page = await fetchWebPage("https://example.com/", {
      lookup: publicLookup,
      fetchImpl: asFetch(async () =>
        htmlResponse(bytes, { contentType: "text/html; charset=gbk" }),
      ),
    });
    expect(page.text).toBe("中文");
  });

  it("识别验证页与不支持的内容类型", async () => {
    const challenge = await fetchWebPage("https://example.com/", {
      lookup: publicLookup,
      fetchImpl: asFetch(async () =>
        htmlResponse("<title>Just a moment...</title><p>Checking your browser</p>"),
      ),
    });
    expect(challenge.warning).toMatch(/验证/);

    const binary = await fetchWebPage("https://example.com/a.pdf", {
      lookup: publicLookup,
      fetchImpl: asFetch(async () => htmlResponse("", { contentType: "application/pdf" })),
    });
    expect(binary.extractor).toBe("binary");
    expect(binary.warning).toMatch(/不支持的内容类型/);
  });
});

describe("searchWeb", () => {
  it("解析 DuckDuckGo 结果并还原真实链接", async () => {
    const html = `<div class="result">
      <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1&amp;rut=1">示例 &amp; 标题</a></h2>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">摘要 <b>一</b></a>
    </div>`;
    const response = await searchWeb("示例", {
      maxResults: 3,
      fetchImpl: asFetch(async () => htmlResponse(html)),
    });
    expect(response.provider).toBe("duckduckgo");
    expect(response.results).toHaveLength(1);
    expect(response.results[0]?.url).toBe("https://example.com/a?x=1");
    expect(response.results[0]?.title).toBe("示例 & 标题");
    expect(response.results[0]?.snippet).toBe("摘要 一");
  });

  it("DuckDuckGo 无结果时回退 Bing 并解码跳转链接", async () => {
    const target = "https://github.com/openclaw";
    const encoded = `a1${Buffer.from(target).toString("base64url")}`;
    const bing = `<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;u=${encoded}">openclaw · GitHub</a></h2><p>仓库说明</p></li>`;
    const response = await searchWeb("openclaw", {
      fetchImpl: asFetch(async (input) =>
        String(input).includes("duckduckgo") ? htmlResponse("<p>暂无结果</p>") : htmlResponse(bing),
      ),
    });
    expect(response.provider).toBe("bing");
    expect(response.warning).toMatch(/回退到 Bing/);
    expect(response.results[0]?.url).toBe(target);
  });

  it("两个引擎都失败时抛出可读错误", async () => {
    await expect(
      searchWeb("x", { fetchImpl: asFetch(async () => new Response("no", { status: 503 })) }),
    ).rejects.toThrow(/搜索失败/);
  });
});

describe("web 工具", () => {
  const options: WebToolOptions = {
    lookup: publicLookup,
    fetchImpl: asFetch(async (input) => {
      if (String(input).includes("duckduckgo")) {
        return htmlResponse(
          `<a class="result__a" href="https://example.com/doc">文档</a><a class="result__snippet">摘要</a>`,
        );
      }
      return htmlResponse(`<title>示例页</title><p>${"内容".repeat(400)}</p>`);
    }),
  };

  it("注册 web_search / web_fetch 并给出可直接执行的参数校验", async () => {
    const tools = buildWebTools(options);
    expect(tools.map((tool) => tool.schema.name)).toEqual(["web_search", "web_fetch"]);
    const search = tools[0]!;
    const fetchTool = tools[1]!;
    expect(await search.execute({}, signal)).toMatch(/query 不能为空/);
    expect(await search.execute({ query: "x", freshness: "hour" }, signal)).toMatch(/freshness/);
    expect(await fetchTool.execute({}, signal)).toMatch(/url 不能为空/);
    expect(await fetchTool.execute({ url: "ftp://x" }, signal)).toMatch(/http\/https/);
  });

  it("搜索输出包含编号、链接与外部内容提示", async () => {
    const tool = buildWebTools(options).find((candidate) => candidate.schema.name === "web_search")!;
    const text = await tool.execute({ query: "示例" }, signal);
    expect(text).toContain("1. 文档");
    expect(text).toContain("https://example.com/doc");
    expect(text).toContain("外部搜索结果");
  });

  it("抓取输出带正文标记与续读提示，内网地址直接拒绝", async () => {
    const tool = buildWebTools(options).find((candidate) => candidate.schema.name === "web_fetch")!;
    const text = await tool.execute({ url: "https://example.com/", max_chars: 500 }, signal);
    expect(text).toContain("标题：示例页");
    expect(text).toContain("正文开始");
    expect(text).toContain("续读：web_fetch");
    expect(await tool.execute({ url: "http://127.0.0.1/" }, signal)).toMatch(/抓取失败：.*内网/);
  });
});

describe("内置联网技能", () => {
  it("三个技能随系统预装为共享内置技能，且说明引用真实工具", async () => {
    const seeds = new Map(BUILTIN_SHARED_SKILLS.map((seed) => [seed.name, seed]));
    for (const name of ["web-search", "web-fetch", "web-browse"]) {
      const seed = seeds.get(name);
      expect(seed, name).toBeDefined();
      expect(seed!.instructions).toMatch(/web_(search|fetch)/);
      expect(seed!.source).toMatch(/MIT|Apache-2\.0/);
    }

    const dir = await mkdtemp(join(tmpdir(), "ac-web-skills-"));
    try {
      const library = new SkillLibrary(join(dir, "skills.json"));
      await library.init();
      const shared = library.listShared().filter((skill) => skill.builtin);
      expect(shared.map((skill) => skill.name)).toEqual(
        expect.arrayContaining(["web-search", "web-fetch", "web-browse"]),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
