import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import MarkdownText, {
  hasMarkdownStructure,
  visibleMessageText,
} from "./MarkdownText";

/** 把气泡正文渲染成静态 HTML，用来断言结构而不是快照字符串。 */
function render(text: string, streaming?: boolean): string {
  return renderToStaticMarkup(createElement(MarkdownText, { text, streaming }));
}

describe("作战室气泡的渲染门控", () => {
  it("只对带 Markdown 结构的正文显示原文切换", () => {
    expect(hasMarkdownStructure("## 标题")).toBe(true);
    expect(hasMarkdownStructure("- 项目一")).toBe(true);
    expect(hasMarkdownStructure("结论是 A")).toBe(false);
  });

  it("结构判断以去脚手架后的正文为准", () => {
    // 整段只有 invoke 块：原文没有任何 Markdown 记号，可见正文却完全不同。
    // 若按原文判断就会被当纯文本，把内部标签原样显示到作战室里。
    const paramOpen = "<" + "parameter=cmd" + ">";
    const paramClose = "<" + "/param" + "eter" + ">";
    const invokeClose = "<" + "/invoke" + ">";
    const onlyScaffolding = '<invoke name="exec">\n' + paramOpen + "npm test" + paramClose + "\n" + invokeClose;
    expect(hasMarkdownStructure(onlyScaffolding)).toBe(false);
    expect(visibleMessageText(onlyScaffolding)).toBe("");
    expect(visibleMessageText("正文 **加粗**")).toBe("正文 **加粗**");
  });
});

describe("作战室 Markdown 预览渲染", () => {
  it("标题、列表、加粗、行内代码渲染成对应元素", () => {
    const html = render("## 结论\n\n- **首要** 方案\n- `fallback`\n");
    expect(html).toContain("<h2>结论</h2>");
    expect(html).toContain("<strong>首要</strong>");
    expect(html).toContain('<code class="inline-code">fallback</code>');
  });

  it("围栏代码走代码块组件并带上语言", () => {
    const html = render("```ts\nconst a = 1;\n```");
    expect(html).toContain("code-block");
    expect(html).toContain("const a = 1;");
  });

  it("任务列表渲染成禁用复选框", () => {
    const html = render("- [x] 已完成\n- [ ] 待办\n");
    expect(html).toContain('class="task-list-item"');
    expect(html).toContain("checkbox");
    expect(html).toContain("checked");
  });

  it("有序列表默认从 1 开始，只有非 1 起始才写 start", () => {
    expect(render("1. 先测基线\n2. 再开并行\n")).not.toContain("start=");
    expect(render("3. 第三步\n4. 第四步\n")).toContain('start="3"');
  });

  it("表格包在横向滚动容器里", () => {
    const html = render("| 成员 | 状态 |\n| --- | --- |\n| 研究员 | 完成 |\n");
    expect(html).toContain('class="markdown-table-viewport"');
    expect(html).toContain("<th>成员</th>");
  });

  it("软换行按聊天排版翻成 br", () => {
    expect(render("第一行\n第二行")).toContain("<br/>");
  });

  it("原文 HTML 只作为转义文本出现，不产生元素", () => {
    const html = render('<img src=x onerror="alert(1)">正文');
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
    expect(html).toContain("正文");
  });

  it("危险链接降级为纯文本，正常链接带 noopener", () => {
    expect(render("[点我](javascript:alert(1))")).not.toContain("<a");
    const ok = render("[官网](https://example.com/docs)");
    expect(ok).toContain('href="https://example.com/docs"');
    expect(ok).toContain("noopener");
  });

  it("远程图片折叠成标签加打开链接，不外链加载", () => {
    const html = render("![截图](https://cdn.example.com/a.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain("markdown-external-image");
    expect(html).toContain("截图");
  });

  it("推理块隐藏、正文照常渲染", () => {
    const html = render("<thinking>先看配置" + "<" + "/thinking>\n\n**结论**：方案 A");
    expect(html).not.toContain("先看配置");
    expect(html).toContain("<strong>结论</strong>");
  });

  it("流式期间未闭合的推理块不闪现", () => {
    const html = render("已完成一步\n<thinking>下一步", true);
    expect(html).toContain("已完成一步");
    expect(html).not.toContain("下一步");
  });

  it("整条消息都是脚手架时只显示占位符", () => {
    const html = render('<invoke name="exec">\n<parameter=cmd>ls</para' + "meter" + ">\n</in" + "voke>");
    expect(html).toContain("markdown-empty");
    expect(html).not.toContain("invoke");
  });

  it("方块画字符走代码块，避免被 Markdown 折叠", () => {
    const art = ["▀▄█▀▄", "█▀▄█▀", "▀█▄▀█"].join("\n");
    expect(render(art)).toContain("block-art");
  });
});
