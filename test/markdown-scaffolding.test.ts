import { describe, expect, it } from "vitest";
import {
  findCodeRanges,
  isBlockArtText,
  normalizeLineBreaks,
  stripAssistantScaffolding,
} from "../web/src/markdown/scaffolding";

const FENCE = "```";

/** 测试里的尖括号标签一律拼接生成：源码中直接写闭合序列会干扰工具链解析。 */
function close(name: string): string {
  return "<" + "/" + name + ">";
}

function open(name: string): string {
  return "<" + name + ">";
}

describe("stripAssistantScaffolding", () => {
  it("隐藏成对的推理标签块", () => {
    const text = open("thinking") + "先查配置\n再动手" + close("thinking") + "结论是 A";
    expect(stripAssistantScaffolding(text)).toBe("结论是 A");
  });

  it("流式输出时未闭合的推理块不闪现，已完成的正文照常显示", () => {
    expect(
      stripAssistantScaffolding("已完成第一步\n" + open("thinking") + "接下来要不要", {
        streaming: true,
      }),
    ).toBe("已完成第一步\n");
  });

  it("隐藏 invoke / parameter 这类工具调用块", () => {
    const text =
      '<invoke name="exec">\n' + open("parameter=cmd") + "npm test" + close("parameter") + "\n" + close("invoke");
    expect(stripAssistantScaffolding(text)).toBe("");
  });

  it("保留工具调用块前后的正文", () => {
    const text =
      "好的\n" +
      '<invoke name="exec">\n' +
      open("parameter=cmd") +
      "npm test" +
      close("parameter") +
      "\n" +
      close("invoke") +
      "\n上面那段是脚手架";
    // 删掉整块后留下的空行按普通 Markdown 分段处理，不做换行手术：
    // 压缩换行会破坏字符画这类逐行结构。
    expect(stripAssistantScaffolding(text)).toBe("好的\n\n上面那段是脚手架");
  });

  it("丢弃工具轨迹行，保留正常正文", () => {
    expect(stripAssistantScaffolding("Tool Call: exec ls\n目录里有 3 个文件")).toBe("目录里有 3 个文件");
  });

  it("relevant_memories 块整体隐藏", () => {
    const text = "前\n" + open("relevant_memories") + "提示词" + close("relevant_memories") + "后";
    expect(stripAssistantScaffolding(text)).toBe("前\n后");
  });

  it("代码块内的标签示例属于用户可见内容，原样保留", () => {
    const sample = FENCE + "md\n" + open("thinking") + "示例" + close("thinking") + "\n" + FENCE;
    expect(stripAssistantScaffolding(sample)).toBe(sample);
  });

  it("围栏未闭合时保护到文本末尾，流式半截代码不会被当脚手架删掉", () => {
    const half = "说明\n" + FENCE + "python\n" + open("thinking");
    expect(stripAssistantScaffolding(half, { streaming: true })).toBe(half);
    const ranges = findCodeRanges(half);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.block).toBe(true);
    expect(ranges[0]?.end).toBe(half.length);
  });

  it("行内代码区间同样受保护", () => {
    const text = "用 `Tool Call: exec` 引用命令\nTool Call: read a.ts\n正文保留";
    const projected = stripAssistantScaffolding(text);
    expect(projected).toContain("用 `Tool Call: exec` 引用命令");
    expect(projected).not.toContain("read a.ts");
  });

  it("早期形态的方括号工具块只删确实像工具负载的内容", () => {
    const closeBracket = "[" + "/TOOL_CALL]";
    const load = '[TOOL_CALL] tool="exec" args={"cmd":"ls"} ' + closeBracket + "正文";
    expect(stripAssistantScaffolding(load)).toBe("正文");
    const prose = "[TOOL_CALL] 只是引用这个名字";
    expect(stripAssistantScaffolding(prose)).toBe(prose);
  });

  it("整块不可见字符视为空文本", () => {
    expect(stripAssistantScaffolding("   \n")).toBe("");
  });

  it("脚手架不影响正常 Markdown 的分段与逐行结构", () => {
    const prose = "第一段\n\n第二段\n\n\n第三段";
    expect(stripAssistantScaffolding(prose)).toBe(prose);
    const mixed = "第一段\n\n" + open("thinking") + "内部" + close("thinking") + "\n\n第二段";
    expect(stripAssistantScaffolding(mixed)).toBe("第一段\n\n\n\n第二段");
    const A = "▀▄█";
    const B = "█▀▄";
    const art = [A + B + A + B + A, B + A + B + A + B, A + B + A + B + A, B + A + B + A + B].join("\n");
    expect(isBlockArtText(stripAssistantScaffolding(art))).toBe(true);
  });

  it("整条消息都是脚手架时可见正文为空，UI 据此显示占位而不是原始标签", () => {
    const only = open("thinking") + "只有推理，没有正文" + close("thinking");
    expect(stripAssistantScaffolding(only)).toBe("");
  });

  it("移除模型特殊 token", () => {
    expect(stripAssistantScaffolding("结果<｜end｜>正确")).toBe("结果正确");
  });
});

describe("文本形态判定", () => {
  it("归一化 CRLF 与 U+2028", () => {
    expect(normalizeLineBreaks("a\r\nb c")).toBe("a\nb\nc");
  });

  it("识别字符画并拒绝普通文本", () => {
    const art = ["██", "▀▄", "█▀", "▄█", "██", "▀▄", "█▀"].join("\n");
    expect(isBlockArtText(art)).toBe(true);
    expect(isBlockArtText("█ 只有一个方块")).toBe(false);
  });
});
