/*!
 * Word（.docx）内置技能：随系统预装，脚本作为技能附带文件一起落库。
 *
 * 内容来源与许可：
 * - docx-track-changes、docx-formula、docx-writer 的排版与 OOXML 处理方式取自
 *   https://github.com/wintersdragon-c/office-docx-skills （MIT，Copyright (c) 2026 wintersdragon-c），
 *   已改写为中文技能说明 + 命令行脚本，并在脚本文件头保留上游出处。
 * - docx-reader 与 docx_inspect.py 为本项目原创。
 * - 刻意不依赖 pandoc / LibreOffice / docx npm 包：只用 python-docx + lxml，
 *   这样 run_skill_script 在本机（含 Windows）能直接跑。
 *
 * 这些 .py 源码就是下面模板字符串里的内容；改动脚本请先改出一份能通过
 * test/docx-skills.test.ts 的版本，再同步到这里（构建不会带外部资源目录）。
 */

import type { BuiltinSkillSeed } from "./builtin";

export const DOCX_SKILLS: BuiltinSkillSeed[] = [
  {
    name: "docx-writer",
    description: "生成排版规范的 Word 文档：Markdown 一键转 .docx，中西字体、A4 页边距、标题层级与中文论文默认格式，产出后自检结构。",
    source: "本项目内置；排版默认值与中西字体设置参考 GitHub · wintersdragon-c/office-docx-skills（MIT，已改写为中文化与命令行工具）",
    instructions: `# 生成 Word 文档

用户要「一份 Word / docx / 文档成稿」时用它。产出落在文件工作区（files/），右侧「文件」标签能直接预览。

## 适用与不适用

- 适用：报告、方案、论文稿、制度文件、会议纪要要落成 .docx；已有 .docx 要改排版。
- 不适用：只要聊天里的文字（直接回）；PDF 定稿（先出 docx 再让用户转）；读取现有 Word 用 docx-reader；改动要留痕用 docx-track-changes。

## 主路径：先写 Markdown，再一条命令转 Word

1. 用 file_write 把内容写成 files/草稿.md（标题用 # 到 ####、列表用 - 或 1.、表格用 | 管道 |、代码用三反引号、分页写 <pagebreak>）。
2. 用 run_skill_script 执行 scripts/docx_from_md.py，**带上 \`"cwd": "."\`**（省略 cwd 会在 files/.skill-runtime/docx-writer/ 里跑，读不到 file_write 写的草稿，产出也进不了右侧「文件」）：
   - args：["草稿.md", "成稿.docx", "--profile", "general", "--title", "报告标题"]
   - 中文论文/公文档用 "--profile", "cn-paper"（A4、上下 2.54cm 左右 3.18cm、正文宋体小四 1.5 倍行距、首行缩进 2 字符、一级标题居中黑体加粗）。
3. 用 run_skill_script 执行 scripts/docx_inspect.py 复核（同样 \`"cwd": "."\`）：args 为 ["成稿.docx"]。看页面尺寸、Normal/heading 的中英文字体、段落数、表格数、公式数、修订数。
4. 回复里说清产出文件名与结构（几章几张表），不要贴大段正文。
5. 产出文件名要和回复一致：\`run_skill_script\` 的成功输出里有「工作目录：files/…」，据此确认 .docx 真的落在文件工作区，再告诉用户路径。

## 需要精确控制时直接写 python-docx

docx_from_md 覆盖不了的场景（图表、页眉页脚、目录域、复杂表格合并）就自己写脚本：

- 用 file_write 写 files/build.py，再用 run_command 执行。Windows 上命令写 \`py -3 build.py\`（\`python\` 经常是 Microsoft Store 占位程序，会报「Python was not found」）。
- 缺依赖时先 \`py -3 -m pip install python-docx lxml\`，不要假设环境里有。
- 只设 run.font.name 对中文无效：必须同时写 w:eastAsia。可直接抄 docx_from_md.py 里的 set_fonts / indent_chars / shade。
- 字号用 Pt()、尺寸用 Cm()；首行缩进按「字符数」写 w:firstLineChars=200，比固定磅值稳。

## 中文排版默认值（用户没给模板时）

1. 中文宋体、西文与数字 Times New Roman、代码 Consolas、公式 Cambria Math；正文颜色为黑。
2. 正文 12pt（小四）、1.5 倍行距、两端对齐；论文档首行缩进 2 字符，通用文档不缩进、段后 6 磅。
3. 标题分级：文档大标题 18pt 居中加粗，一级 16pt，二三级 14/12pt 加粗，标题不缩进。
4. 图表居中，图题写「图1：……」，表题写「表1：……」；标题紧跟公式或表格时，只给该标题加段前距（约 10–12pt），不要改全局标题样式。
5. 用户给了模板或指定期刊/学校格式时，一切以模板为准，本默认值让位。

## 常见坑

1. Word 的目录（TOC）域不会被脚本刷新：生成后提醒用户在 Word 里右键「更新域」。
2. 别把整篇文档塞进 Normal 再逐段手工加粗：标题要用 Heading 样式，否则目录和导航都失效。
3. 覆写同名文件前确认是不是用户已有成果；重要改动另存为 \`成稿-v2.docx\`。
4. 表格超过页面宽度时缩小字号或改成两列，不要指望 Word 自动折行。
5. 生成失败先跑 docx_inspect.py 或 \`py -3 -c "import docx"\` 判断是脚本问题还是依赖问题，别反复重跑同一条命令。`,
    files: [
      { path: "scripts/docx_from_md.py", content: `"""把 Markdown 文本转成排版规范的 .docx。

用法（推荐用 run_skill_script 执行，解释器会自动挑选）：
    python docx_from_md.py 草稿.md 成稿.docx --profile cn-paper
    python docx_from_md.py 草稿.md 成稿.docx --title "报告标题" --author 张三

profile:
    general   通用正式文档（正文 12pt、1.5 倍行距、两端对齐、无首行缩进）
    cn-paper  中文论文/公文默认档（A4、上下 2.54cm 左右 3.18cm、正文宋体小四 1.5 倍、
              首行缩进 2 字符、一级标题居中加粗、参考文献与摘要标签按中文习惯）

支持的 Markdown 语法：# 到 #### 标题、段落、**加粗**、*斜体*、\`等宽\`、
[文字](链接)、- 无序列表、1. 有序列表、| 管道表格 |、\`\`\` 代码块 \`\`\`、
> 引用、--- 分页（写成 <pagebreak>）、<!--toc--> 目录占位。
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

try:
    from docx import Document
    from docx.enum.section import WD_SECTION
    from docx.enum.table import WD_TABLE_ALIGNMENT
    from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
    from docx.oxml.ns import qn
    from docx.shared import Cm, Pt, RGBColor
except ImportError:  # pragma: no cover - 运行环境缺依赖时给出可执行的下一步
    sys.stderr.write(
        "缺少 python-docx。请先安装：\\n"
        "    py -3 -m pip install python-docx lxml\\n"
        "（Windows 上 python 可能指向 Microsoft Store 占位程序，请用 py -3。）\\n"
    )
    raise SystemExit(2)

BACKTICK = chr(96)

BODY_PT = 12.0
HEADING_PT = {1: 16.0, 2: 14.0, 3: 12.0, 4: 12.0}


def set_fonts(run, latin: str, east_asia: str) -> None:
    """中西字体分开设置：只设 run.font.name 时中文不会生效，Word 还要 w:eastAsia。"""
    run.font.name = latin
    rpr = run._element.get_or_add_rPr()
    fonts = rpr.get_or_add_rFonts()
    fonts.set(qn("w:ascii"), latin)
    fonts.set(qn("w:hAnsi"), latin)
    fonts.set(qn("w:eastAsia"), east_asia)


def indent_chars(paragraph, chars: int) -> None:
    """按「字符数」缩进，和 Word 的首行缩进 2 字符一致，避免固定磅值在不同字号下失真。"""
    ppr = paragraph._p.get_or_add_pPr()
    ind = ppr.find(qn("w:ind"))
    if ind is None:
        ind = ppr.makeelement(qn("w:ind"), {})
        ppr.append(ind)
    ind.set(qn("w:firstLineChars"), str(chars * 100))
    ind.set(qn("w:firstLine"), "0")


def shade(paragraph, fill: str) -> None:
    ppr = paragraph._p.get_or_add_pPr()
    shd = ppr.makeelement(qn("w:shd"), {})
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill)
    ppr.append(shd)


class Profile:
    def __init__(self, name: str):
        self.name = name
        self.latin = "Times New Roman"
        self.east_asia = "宋体"
        self.heading_east_asia = "黑体"
        self.body_pt = BODY_PT
        self.line_spacing = 1.5
        self.first_line_indent = 0
        self.space_after_pt = 6.0
        self.page = (Cm(21.0), Cm(29.7), Cm(3.18), Cm(3.18), Cm(2.54), Cm(2.54))
        self.title_centered_heading = name == "cn-paper"
        if name == "cn-paper":
            self.first_line_indent = 2
            self.space_after_pt = 0.0

    def apply_page(self, document) -> None:
        width, height, left, right, top, bottom = self.page
        for section in document.sections:
            section.page_width = width
            section.page_height = height
            section.left_margin = left
            section.right_margin = right
            section.top_margin = top
            section.bottom_margin = bottom


def setup_document(profile: Profile, title: str | None) -> Document:
    document = Document()
    normal = document.styles["Normal"]
    normal.font.size = Pt(profile.body_pt)
    normal.font.color.rgb = RGBColor(0, 0, 0)
    rpr = normal._element.get_or_add_rPr()
    fonts = rpr.get_or_add_rFonts()
    fonts.set(qn("w:ascii"), profile.latin)
    fonts.set(qn("w:hAnsi"), profile.latin)
    fonts.set(qn("w:eastAsia"), profile.east_asia)
    fmt = normal.paragraph_format
    fmt.line_spacing = profile.line_spacing
    fmt.space_after = Pt(profile.space_after_pt)
    fmt.space_before = Pt(0)
    fmt.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY

    for level in (1, 2, 3, 4):
        style_name = f"Heading {level}"
        if style_name not in [style.name for style in document.styles]:
            continue
        style = document.styles[style_name]
        style.font.size = Pt(HEADING_PT[level])
        style.font.bold = True
        style.font.color.rgb = RGBColor(0, 0, 0)
        sfonts = style._element.get_or_add_rPr().get_or_add_rFonts()
        sfonts.set(qn("w:ascii"), profile.latin)
        sfonts.set(qn("w:hAnsi"), profile.latin)
        sfonts.set(qn("w:eastAsia"), profile.heading_east_asia)
        style.paragraph_format.space_before = Pt(12 if level > 1 else 6)
        style.paragraph_format.space_after = Pt(6)
        style.paragraph_format.line_spacing = 1.5
        if profile.title_centered_heading:
            # 中文论文一档习惯居中，二档以下顶格。
            style.paragraph_format.alignment = (
                WD_ALIGN_PARAGRAPH.CENTER if level == 1 else WD_ALIGN_PARAGRAPH.LEFT
            )
    profile.apply_page(document)
    if title:
        para = document.add_paragraph()
        run = para.add_run(title)
        set_fonts(run, profile.latin, profile.heading_east_asia)
        run.font.size = Pt(18)
        run.font.bold = True
        run.font.color.rgb = RGBColor(0, 0, 0)
        para.alignment = WD_ALIGN_PARAGRAPH.CENTER
        para.paragraph_format.space_after = Pt(18)
    return document


INLINE_RE = re.compile(
    r"(\\*\\*[^*]+\\*\\*|\\*[^*]+\\*|"
    + re.escape(BACKTICK)
    + r"[^" + re.escape(BACKTICK) + r"]+"
    + re.escape(BACKTICK)
    + r"|\\[[^]]+\\]\\([^)]+\\))"
)


def add_inline(paragraph, text: str, profile: Profile, mono_fill: str | None = None) -> None:
    """把一行 Markdown 文本写成带格式的 run；不支持嵌套强调，够用且不会写坏 XML。"""
    pos = 0
    for match in INLINE_RE.finditer(text):
        if match.start() > pos:
            run = paragraph.add_run(text[pos : match.start()])
            set_fonts(run, profile.latin, profile.east_asia)
            run.font.size = Pt(profile.body_pt)
        token = match.group(0)
        if token.startswith("**"):
            run = paragraph.add_run(token[2:-2])
            set_fonts(run, profile.latin, profile.east_asia)
            run.font.size = Pt(profile.body_pt)
            run.font.bold = True
        elif token.startswith("*"):
            run = paragraph.add_run(token[1:-1])
            set_fonts(run, profile.latin, profile.east_asia)
            run.font.size = Pt(profile.body_pt)
            run.font.italic = True
        elif token.startswith(BACKTICK):
            run = paragraph.add_run(token.strip(BACKTICK))
            set_fonts(run, "Consolas", profile.east_asia)
            run.font.size = Pt(profile.body_pt - 1)
        else:
            label = re.match(r"\\[([^]]*)\\]\\(([^)]+)\\)", token)
            run = paragraph.add_run(f"{label.group(1)}（{label.group(2)}）")
            set_fonts(run, profile.latin, profile.east_asia)
            run.font.size = Pt(profile.body_pt)
            run.font.underline = True
        pos = match.end()
    if pos < len(text):
        run = paragraph.add_run(text[pos:])
        set_fonts(run, profile.latin, profile.east_asia)
        run.font.size = Pt(profile.body_pt)
    if mono_fill is not None:
        shade(paragraph, mono_fill)


def is_table_row(line: str) -> bool:
    return line.strip().startswith("|") and line.strip().count("|") >= 2


def is_divider_row(line: str) -> bool:
    cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
    return bool(cells) and all(re.fullmatch(r":?-{2,}:?", cell or "-") for cell in cells)


def split_row(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def add_table(document, rows: list[list[str]], profile: Profile) -> None:
    if not rows:
        return
    cols = max(len(row) for row in rows)
    table = document.add_table(rows=len(rows), cols=cols)
    table.style = "Table Grid"
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    for r, row in enumerate(rows):
        for c in range(cols):
            cell = table.cell(r, c)
            cell.text = ""
            paragraph = cell.paragraphs[0]
            add_inline(paragraph, row[c] if c < len(row) else "", profile)
            paragraph.paragraph_format.line_spacing = 1.0
            paragraph.paragraph_format.space_after = Pt(2)
            if r == 0:
                for run in paragraph.runs:
                    run.font.bold = True


def add_paragraph_lines(document, buffer: list[str], profile: Profile) -> None:
    text = " ".join(line.strip() for line in buffer).strip()
    if not text:
        return
    paragraph = document.add_paragraph()
    add_inline(paragraph, text, profile)
    if profile.first_line_indent:
        indent_chars(paragraph, profile.first_line_indent)
    paragraph.paragraph_format.line_spacing = profile.line_spacing


def build(markdown: str, profile_name: str, title: str | None, author: str | None) -> Document:
    profile = Profile(profile_name)
    document = setup_document(profile, title)
    lines = markdown.replace("\\r\\n", "\\n").split("\\n")
    paragraph_buffer: list[str] = []
    table_rows: list[list[str]] = []
    index = 0
    while index < len(lines):
        raw = lines[index]
        line = raw.rstrip()
        stripped = line.strip()

        if stripped.startswith("\`\`\`"):
            if paragraph_buffer:
                add_paragraph_lines(document, paragraph_buffer, profile)
                paragraph_buffer = []
            index += 1
            code: list[str] = []
            while index < len(lines) and not lines[index].strip().startswith("\`\`\`"):
                code.append(lines[index])
                index += 1
            index += 1  # 跳过结束的 \`\`\`
            for entry in code or [""]:
                paragraph = document.add_paragraph()
                run = paragraph.add_run(entry)
                set_fonts(run, "Consolas", profile.east_asia)
                run.font.size = Pt(profile.body_pt - 1)
                paragraph.paragraph_format.line_spacing = 1.0
                paragraph.paragraph_format.space_after = Pt(0)
                shade(paragraph, "F2F2F2")
            continue

        if is_table_row(line):
            if paragraph_buffer:
                add_paragraph_lines(document, paragraph_buffer, profile)
                paragraph_buffer = []
            while index < len(lines) and is_table_row(lines[index]):
                cells = split_row(lines[index])
                if not is_divider_row(lines[index]):
                    table_rows.append(cells)
                index += 1
            add_table(document, table_rows, profile)
            table_rows = []
            continue

        heading = re.match(r"^(#{1,4})\\s+(.*)$", stripped)
        if heading:
            if paragraph_buffer:
                add_paragraph_lines(document, paragraph_buffer, profile)
                paragraph_buffer = []
            level = len(heading.group(1))
            document.add_heading("", level=min(level, 4))
            paragraph = document.paragraphs[-1]
            add_inline(paragraph, heading.group(2).strip(), profile)
            for run in paragraph.runs:
                run.font.bold = True
                run.font.size = Pt(HEADING_PT[min(level, 4)])
            index += 1
            continue

        bullet = re.match(r"^[-*+]\\s+(.*)$", stripped)
        if bullet:
            if paragraph_buffer:
                add_paragraph_lines(document, paragraph_buffer, profile)
                paragraph_buffer = []
            paragraph = document.add_paragraph(style="List Bullet")
            add_inline(paragraph, bullet.group(1), profile)
            paragraph.paragraph_format.line_spacing = profile.line_spacing
            index += 1
            continue

        numbered = re.match(r"^(\\d+)[.)]\\s+(.*)$", stripped)
        if numbered:
            if paragraph_buffer:
                add_paragraph_lines(document, paragraph_buffer, profile)
                paragraph_buffer = []
            paragraph = document.add_paragraph(style="List Number")
            add_inline(paragraph, numbered.group(2), profile)
            paragraph.paragraph_format.line_spacing = profile.line_spacing
            index += 1
            continue

        if stripped.startswith(">"):
            if paragraph_buffer:
                add_paragraph_lines(document, paragraph_buffer, profile)
                paragraph_buffer = []
            paragraph = document.add_paragraph()
            add_inline(paragraph, stripped.lstrip("> ").strip(), profile)
            paragraph.paragraph_format.left_indent = Cm(0.74)
            paragraph.paragraph_format.line_spacing = profile.line_spacing
            index += 1
            continue

        if stripped == "<pagebreak>":
            if paragraph_buffer:
                add_paragraph_lines(document, paragraph_buffer, profile)
                paragraph_buffer = []
            document.add_page_break()
            index += 1
            continue

        if re.fullmatch(r"-{3,}|\\*{3,}", stripped):
            if paragraph_buffer:
                add_paragraph_lines(document, paragraph_buffer, profile)
                paragraph_buffer = []
            index += 1
            continue

        if not stripped:
            if paragraph_buffer:
                add_paragraph_lines(document, paragraph_buffer, profile)
                paragraph_buffer = []
            index += 1
            continue

        paragraph_buffer.append(stripped)
        index += 1

    if paragraph_buffer:
        add_paragraph_lines(document, paragraph_buffer, profile)
    if author:
        para = document.add_paragraph()
        run = para.add_run(f"（{author}）")
        set_fonts(run, profile.latin, profile.east_asia)
        run.font.size = Pt(profile.body_pt)
        para.alignment = WD_ALIGN_PARAGRAPH.CENTER
    return document


def main() -> int:
    parser = argparse.ArgumentParser(description="Markdown 转 Word（.docx）")
    parser.add_argument("source", type=Path, help="Markdown 源文件")
    parser.add_argument("output", type=Path, help="输出的 .docx 路径")
    parser.add_argument("--profile", choices=["general", "cn-paper"], default="general")
    parser.add_argument("--title", default=None, help="文档大标题（写为首个居中段落）")
    parser.add_argument("--author", default=None, help="标题下方署名")
    args = parser.parse_args()

    if not args.source.exists():
        sys.stderr.write(f"找不到源文件：{args.source}\\n")
        return 2
    if args.output.suffix.lower() != ".docx":
        sys.stderr.write("输出文件名必须以 .docx 结尾\\n")
        return 2
    markdown = args.source.read_text(encoding="utf-8")
    document = build(markdown, args.profile, args.title, args.author)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    document.save(str(args.output))
    paragraphs = len(document.paragraphs)
    tables = len(document.tables)
    print(f"已生成 {args.output.name}：{paragraphs} 段、{tables} 张表、profile={args.profile}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
` },
      { path: "scripts/docx_inspect.py", content: `"""读取 .docx 的结构与格式，用于生成后自检（只用标准库 + lxml，不需要 python-docx）。

用法：
    python docx_inspect.py 成稿.docx
    python docx_inspect.py 成稿.docx --json
    python docx_inspect.py 成稿.docx --paragraphs 80

输出内容：页面尺寸与页边距、Normal 样式字体、段落总数、各级标题、
表格/图片/公式/修订数量，以及前 N 段的「序号 + 样式 + 文本摘要」。
排查「中文没换成宋体」「修订没显示」「公式变成纯文本」这类问题时先看这里。
"""

from __future__ import annotations

import argparse
import json
import sys
import zipfile
from pathlib import Path

try:
    from lxml import etree
except ImportError:  # pragma: no cover
    sys.stderr.write("缺少 lxml，请先安装：py -3 -m pip install lxml\\n")
    raise SystemExit(2)

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
M = "http://schemas.openxmlformats.org/officeDocument/2006/math"
NS = {"w": W}
TWIPS_PER_CM = 567.0
REVISION_TAGS = ("ins", "del", "moveFrom", "moveTo", "rPrChange", "pPrChange", "sectPrChange")


def qn(tag: str) -> str:
    """接受 \`w:body\` 或 \`body\` 两种写法，统一成 lxml 需要的 Clark 记法。"""
    return f"{{{W}}}{tag.split(':')[-1]}"


def part_xml(archive: zipfile.ZipFile, name: str):
    if name not in archive.namelist():
        return None
    return etree.fromstring(archive.read(name))


def para_text(paragraph) -> str:
    pieces = []
    for node in paragraph.iter():
        if node.tag in (qn("t"), qn("delText")):
            pieces.append(node.text or "")
    return "".join(pieces)


def para_style(paragraph) -> str:
    direct = paragraph.find(qn("w:pPr") + "/" + qn("w:pStyle"))
    if direct is not None:
        return direct.get(qn("w:val")) or "Normal"
    # 没有 pStyle 就是正文（Normal）；python-docx 也只在非默认样式上写 pStyle。
    return "Normal"


def font_report(styles) -> list[str]:
    lines: list[str] = []
    if styles is None:
        return ["（缺少 word/styles.xml）"]
    for style in styles.findall(qn("w:style")):
        if style.get(qn("w:type")) != "paragraph":
            continue
        name = style.find(qn("w:name"))
        label = name.get(qn("w:val")) if name is not None else (style.get(qn("w:styleId")) or "?")
        if label not in {"Normal", "heading 1", "heading 2"}:
            continue
        fonts = style.find(qn("w:rPr") + "/" + qn("w:rFonts"))
        size = style.find(qn("w:rPr") + "/" + qn("w:sz"))
        west = fonts.get(qn("w:ascii")) if fonts is not None else None
        east = fonts.get(qn("w:eastAsia")) if fonts is not None else None
        half_points = size.get(qn("w:val")) if size is not None else None
        points = f"{int(half_points) / 2}pt" if half_points else "未设"
        lines.append(f"{label}：西文={west or '未设'}、中文={east or '未设'}、字号={points}")
    return lines or ["（styles.xml 里没有段落样式）"]


def section_report(body) -> list[str]:
    lines: list[str] = []
    for sect in body.iter(qn("sectPr")):
        size = sect.find(qn("w:pgSz"))
        margin = sect.find(qn("w:pgMar"))
        if size is None or margin is None:
            continue
        width = int(size.get(qn("w:w")) or 0) / TWIPS_PER_CM
        height = int(size.get(qn("w:h")) or 0) / TWIPS_PER_CM
        lines.append(
            "页面 {:.1f}×{:.1f} cm，边距 上{:.2f} 下{:.2f} 左{:.2f} 右{:.2f} cm".format(
                width,
                height,
                int(margin.get(qn("w:top")) or 0) / TWIPS_PER_CM,
                int(margin.get(qn("w:bottom")) or 0) / TWIPS_PER_CM,
                int(margin.get(qn("w:left")) or 0) / TWIPS_PER_CM,
                int(margin.get(qn("w:right")) or 0) / TWIPS_PER_CM,
            )
        )
    return lines or ["（没有 sectPr，使用 Word 默认页面）"]


def inspect(path: Path) -> dict:
    with zipfile.ZipFile(path) as archive:
        document = part_xml(archive, "word/document.xml")
        styles = part_xml(archive, "word/styles.xml")
        names = archive.namelist()
    if document is None:
        raise ValueError("不是有效的 .docx：压缩包里没有 word/document.xml")
    body = document.find(qn("w:body"))
    paragraphs = body.findall(qn("w:p")) if body is not None else []
    revisions = {tag: len(list(document.iter(qn(tag)))) for tag in REVISION_TAGS}
    math_count = len(list(document.iter(f"{{{M}}}oMath")))
    heading_counts: dict[str, int] = {}
    rows = []
    for index, paragraph in enumerate(paragraphs):
        style = para_style(paragraph)
        text = para_text(paragraph).strip()
        if style.startswith("Heading") or style.startswith("heading"):
            heading_counts[style] = heading_counts.get(style, 0) + 1
        rows.append({"index": index, "style": style, "chars": len(text), "text": text[:70]})
    return {
        "file": path.name,
        "bytes": path.stat().st_size,
        "parts": len(names),
        "has_numbering": "word/numbering.xml" in names,
        "media": [name for name in names if name.startswith("word/media/")],
        "paragraph_count": len(paragraphs),
        "table_count": len(body.findall(qn("w:tbl"))) if body is not None else 0,
        "image_count": len(list(document.iter(qn("w:drawing")))),
        "math_count": math_count,
        "revisions": revisions,
        "headings": heading_counts,
        "pages": section_report(body) if body is not None else [],
        "fonts": font_report(styles),
        "paragraphs": rows,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="检查 .docx 的结构与格式")
    parser.add_argument("docx", type=Path)
    parser.add_argument("--json", action="store_true", help="输出 JSON，便于脚本继续处理")
    parser.add_argument("--paragraphs", type=int, default=40, help="打印前几段摘要，默认 40")
    args = parser.parse_args()

    if not args.docx.exists():
        sys.stderr.write(f"找不到文件：{args.docx}\\n")
        return 2
    try:
        report = inspect(args.docx)
    except (ValueError, zipfile.BadZipFile) as err:
        sys.stderr.write(f"{err}\\n")
        return 2

    if args.json:
        print(json.dumps(report, ensure_ascii=False))
        return 0

    print(f"文件：{report['file']}（{report['bytes']} 字节，{report['parts']} 个部件）")
    for line in report["pages"]:
        print(f"  {line}")
    for line in report["fonts"]:
        print(f"  样式 {line}")
    print(
        "  段落 {p} · 表格 {t} · 图片 {i} · 公式 {m} · 媒体 {media}".format(
            p=report["paragraph_count"],
            t=report["table_count"],
            i=report["image_count"],
            m=report["math_count"],
            media=len(report["media"]),
        )
    )
    if report["headings"]:
        print("  标题：" + "、".join(f"{k}×{v}" for k, v in sorted(report["headings"].items())))
    revision_hits = {k: v for k, v in report["revisions"].items() if v}
    print(f"  修订标记：{revision_hits or '无'}")
    shown = report["paragraphs"][: max(0, args.paragraphs)]
    for row in shown:
        text = row["text"] or "（空）"
        print(f"  [{row['index']}] {row['style']} · {text}")
    if len(report["paragraphs"]) > len(shown):
        print(f"  …还有 {len(report['paragraphs']) - len(shown)} 段，用 --paragraphs 调大或 --json 全量输出")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
` },
    ],
  },
  {
    name: "docx-reader",
    description: "读取现有 .docx：抽出带结构的正文（标题、列表、表格、公式、修订标注），按段落编号回指，看清文档里到底有什么。",
    source: "本项目内置",
    instructions: `# 读取 Word 文档

file_read 读 .docx 只会拿到 zip 乱码。要看内容、改内容或核对格式，用这个技能。

## 三步走

1. 先看结构：docx_inspect.py 属于 **docx-writer** 技能，\`run_skill_script\` 时 skill 填 "docx-writer"、path 填 "scripts/docx_inspect.py"，args 为 ["文件名.docx"]：确认段落数、表格数、公式数、修订数、页面尺寸与字体设置，判断这份文档到底有什么。
2. 再跑 scripts/docx_extract.py 取正文：
   - **两次调用都带 \`"cwd": "."\`**，这样 "文件名.docx" 就是文件工作区里的相对路径（"reports/x.docx" 也一样），\`--out\` 写出的正文才会出现在右侧「文件」里；省略 cwd 时脚本在 files/.skill-runtime/… 里跑，读不到用户的 .docx。
   - args 为 ["文件名.docx", "--numbers"]：每段前给 ¶ 序号，方便回指「第 ¶12 段」。
   - 要写进文件加 "--out", "正文.md"；文件很长时必须加 --out，否则 32KB 输出上限会截断。
   - 怀疑有修订时加 "--revision-note"，会标出「插入/删除 + 作者」。
3. 需要更细的信息（页眉页脚、批注、脚注、样式定义）时，用 run_command 解压看部件：
   - \`py -3 -c "import zipfile; z=zipfile.ZipFile('x.docx'); print(z.namelist())"\`（Windows 用 py -3，别用 python）。
   - 页眉页脚在 word/header1.xml、word/footer1.xml；批注在 word/comments.xml；样式在 word/styles.xml。

## 输出形态

extract 出来的文本保留结构：标题变 # 到 ####、列表变 - 或 1.、表格变 | 管道 |、公式标成 [公式]…[/]、图片只统计数量不带内容。

## 注意

1. 表格是按 body 顺序穿插输出的，段落序号连续，但表格里没有 ¶ 号；引用表格时说「第几张表」。
2. 公式在 run.text 里不可见，脚本已单独标出 [公式]；如果计数为 0 但用户说有公式，多半是图片或老式 OLE 对象（看 word/media/ 与 w:object）。
3. 只读用户给的原文档，不要顺手改；要改动用 docx-track-changes 或直接编辑后另存新文件。
4. 大文档不要整篇贴进聊天；摘出与任务相关的章节，其余用序号引用。

## 缺依赖时

报 ModuleNotFoundError: docx 就执行 \`py -3 -m pip install python-docx lxml\`；inspect 只需要 lxml，实在装不上可只用 inspect 拿结构。`,
    files: [
      { path: "scripts/docx_extract.py", content: `"""把现有 .docx 抽成带结构的文本（Markdown 风格），供智能体阅读与改写。

用法：
    python docx_extract.py 稿件.docx
    python docx_extract.py 稿件.docx --out 稿件.md --numbers
    python docx_extract.py 稿件.docx --revision-note   # 额外标注哪些文字属于修订

只读正文（body）：标题按 #~####、列表按 -/1.、表格转成 | 管道 |、
代码段与引用保留原样顺序；页眉页脚、批注与脚注不在这个脚本范围内，
需要时用 run_command 直接解压查看 word/header1.xml 等部件。
"""

from __future__ import annotations

import argparse
import sys
import zipfile
from pathlib import Path

try:
    from docx import Document
    from docx.table import Table
    from docx.text.paragraph import Paragraph
    from docx.oxml.ns import qn
except ImportError:  # pragma: no cover
    sys.stderr.write(
        "缺少 python-docx。请先安装：\\n"
        "    py -3 -m pip install python-docx lxml\\n"
        "（Windows 上 python 可能指向 Microsoft Store 占位程序，请用 py -3。）\\n"
    )
    raise SystemExit(2)

M_NS = "http://schemas.openxmlformats.org/officeDocument/2006/math"


def iter_block_items(document):
    """按 body 里的真实顺序返回段落与表格，python-docx 的 paragraphs 会把表格漏掉。"""
    body = document.element.body
    for child in body.iterchildren():
        if child.tag == qn("w:p"):
            yield Paragraph(child, document)
        elif child.tag == qn("w:tbl"):
            yield Table(child, document)


def heading_level(paragraph: Paragraph) -> int:
    name = (paragraph.style.name or "") if paragraph.style else ""
    if name.startswith("Heading"):
        try:
            return max(1, min(4, int(name.split()[-1])))
        except (IndexError, ValueError):
            return 0
    if name == "Title":
        return 1
    return 0


def is_list(paragraph: Paragraph) -> str:
    name = (paragraph.style.name or "") if paragraph.style else ""
    if "List Bullet" in name:
        return "bullet"
    if "List Number" in name:
        return "number"
    # 直接套了 numPr 但样式仍是正文的列表也要认出来
    ppr = paragraph._p.find(qn("w:pPr"))
    if ppr is not None and ppr.find(qn("w:numPr")) is not None:
        return "number" if "Number" in name else "bullet"
    return ""


def paragraph_text(paragraph: Paragraph, revision_note: bool, plain: bool = False) -> str:
    parts: list[str] = []
    for run in paragraph.runs:
        text = run.text
        if not text:
            continue
        if not plain and run.bold:
            text = f"**{text}**"
        if not plain and run.italic:
            text = f"*{text}*"
        if revision_note:
            parent = run._element.getparent()
            if parent is not None and parent.tag in (qn("w:ins"), qn("w:del")):
                kind = "插入" if parent.tag == qn("w:ins") else "删除"
                author = parent.get(qn("w:author")) or "?"
                text = f"[{kind}·{author}]{text}[/]"
        parts.append(text)
    # 正文里的 OMML 公式在 run.text 中不可见，单独标出来避免误判「公式丢了」
    for node in paragraph._p.iter(f"{{{M_NS}}}oMath"):
        math_text = "".join((t.text or "") for t in node.iter(f"{{{M_NS}}}t"))
        if math_text:
            parts.append(f"[公式]{math_text}[/]")
    return "".join(parts).strip()


def table_to_markdown(table: Table) -> list[str]:
    lines: list[str] = []
    for r, row in enumerate(table.rows):
        cells = []
        for cell in row.cells:
            text = " ".join(p.text.strip() for p in cell.paragraphs if p.text.strip())
            cells.append(text.replace("|", "\\\\|").replace("\\n", " "))
        lines.append("| " + " | ".join(cells) + " |")
        if r == 0:
            lines.append("|" + "|".join([" --- "] * len(cells)) + "|")
    return lines


def extract(path: Path, revision_note: bool, numbering: bool) -> str:
    with zipfile.ZipFile(path) as archive:
        if "word/document.xml" not in archive.namelist():
            raise ValueError("不是有效的 .docx：缺少 word/document.xml")
    document = Document(str(path))
    out: list[str] = []
    para_no = 0
    for block in iter_block_items(document):
        if isinstance(block, Table):
            out.extend(table_to_markdown(block))
            out.append("")
            continue
        level = heading_level(block)
        # 标题本身已由样式加粗，再套 ** 只会让抽出来的文本更难读
        text = paragraph_text(block, revision_note, plain=level > 0)
        if not text:
            continue
        para_no += 1
        prefix = f"¶{para_no} " if numbering else ""
        if level:
            out.append(f"{prefix}{'#' * level} {text}")
            continue
        kind = is_list(block)
        if kind == "bullet":
            out.append(f"{prefix}- {text}")
        elif kind == "number":
            out.append(f"{prefix}1. {text}")
        else:
            out.append(f"{prefix}{text}")
            out.append("")
            continue
    while out and out[-1] == "":
        out.pop()
    return "\\n".join(out) + "\\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="读取 .docx 正文并转成结构化文本")
    parser.add_argument("docx", type=Path)
    parser.add_argument("--out", type=Path, default=None, help="写入文件；默认打印到标准输出")
    parser.add_argument("--numbers", action="store_true", help="每段前加 ¶ 序号，便于回指修改位置")
    parser.add_argument("--revision-note", action="store_true", help="标注修订归属（插入/删除 + 作者）")
    args = parser.parse_args()

    if not args.docx.exists():
        sys.stderr.write(f"找不到文件：{args.docx}\\n")
        return 2
    try:
        text = extract(args.docx, args.revision_note, args.numbers)
    except (ValueError, zipfile.BadZipFile) as err:
        sys.stderr.write(f"{err}\\n")
        return 2

    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text, encoding="utf-8")
        print(f"已写出 {args.out.name}（{len(text)} 字符）")
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
` },
    ],
  },
  {
    name: "docx-track-changes",
    description: "以 Word 修订模式改 .docx：改动显示为红线插入/删除，带作者与时间，支持批量 edits.json、小节范围定位与条数复核。",
    source: "GitHub · wintersdragon-c/office-docx-skills · docx-tracked-changes（MIT，改写：批量编辑入口、小节定位防误插、中文报错）",
    instructions: `# Word 修订模式改文档

用户要在 Word 里**看得见改了哪里**（红线、修订、审阅、accept/reject）时用这个技能。直接换文字不留痕就用 python-docx 或 docx-writer，不要用修订。

原理：.docx 是 zip，修订是 word/document.xml 里的 w:ins / w:del 节点，w:del 里的文字必须写成 w:delText。python-docx 不支持修订，所以这里只用 lxml 动 XML。不需要 pandoc，也不需要 LibreOffice。

## 流程

1. 定位：\`run_skill_script\` 执行 scripts/tracked_changes.py，args 为 ["原稿.docx", "--list", "40"]，拿到段落序号和现有修订数。要读内容配合 docx-reader。
2. 写 edits.json（用 file_write）：
   - {"para_index": 12, "replace": "整段替换成的新文字"}
   - {"find": "段内关键字", "replace": "新文字"}
   - {"after": "参考文献", "insert": "新增的一条"}（在定位到的段落之后插入）
   - {"scope_after": "参考文献", "find": "…", "…}：把搜索限制在该楼层名之后
3. 执行：args 为 ["原稿.docx", "修订后.docx", "--author", "审阅人", "--edits", "edits.json"]。
4. 复核：scripts/verify_tracked_changes.py，args 为 ["修订后.docx", "--author", "审阅人", "--expect", "3"]；条数不符退出码非 0，必须查原因再回复用户。

**每次 \`run_skill_script\` 都带 \`"cwd": "."\`**：省略时脚本在 files/.skill-runtime/docx-track-changes/ 里跑，"原稿.docx" 与 "edits.json" 都指向那个临时目录，既读不到用户文件，修订成果也不会出现在右侧「文件」里。

## 四条硬规则

1. **一轮改完**：所有编辑放进同一个 edits.json 一次执行。分多次跑时，后一轮必须读前一轮的输出文件；读原稿会静默丢掉前面的修订，这是最常见的事故。
2. **绝不覆盖原稿**：输出必须是新文件（\`xxx-修订.docx\`），由用户在 Word 里确认后再替换。脚本已拒绝输出等于输入。
3. **按小节定位**：正文里的作者名会先于参考文献条目命中。凡是要在某个列表/章节里插入，必须带 "scope_after"；找不到该标题时脚本直接失败而不是插错位置。
4. **整段替换是粗活**：段落里混排（前半句加粗、后半句正常）时，replace 会把整段格式拉平。这种段落改成逐 run 定位，或者先跟用户确认可以整段重写。

## 已知边界

1. 只处理正文段落；页眉页脚、脚注、文本框里的内容不支持修订。
2. 已有大量修订的段落：脚本只取直接的 w:r，不会把修订套进修订。这种先让用户在 Word 里「接受所有修订」再改。
3. 目录（TOC）不会自动更新，提醒用户在 Word 里更新域。
4. 修订 id 由脚本扫描全文最大值后递增，不会和既有 id 撞号。

## 学术论文额外注意

改写论文段落时保留原文里所有 (Author Year) 形式的引用：先抽取原段引用列表，替换文本里必须逐条出现，再用 verify 核对条数。丢引用会让文末参考文献条目变成孤儿，审稿人会直接指出。`,
    files: [
      { path: "scripts/tracked_changes.py", content: `"""以 Word「修订模式」可见的方式编辑 .docx。

改编自 https://github.com/wintersdragon-c/office-docx-skills （MIT，Copyright (c) 2026 wintersdragon-c）；
改动：新增按文本定位/限定小节范围的命令行入口、批量 edits.json、编辑后自检与更明确的失败提示。

为什么不用 python-docx：python-docx 没有修订支持，必须直接写 OOXML 的 w:ins / w:del。
依赖只有 lxml（+ 可选 python-docx 用于看样式），不需要 pandoc，也不需要 LibreOffice。

用法：
    python tracked_changes.py 原稿.docx 修订后.docx --author 审阅人 --edits edits.json
    python tracked_changes.py 原稿.docx --list 20          # 只列出段落，确认序号

edits.json 的每一项支持：
    {"para_index": 3, "replace": "整段替换成的新文字"}
    {"find": "段内关键字", "replace": "新文字"}
    {"find": "参考文献", "after": "Acharya", "insert": "一条新的参考文献"}
    可选 "scope_after": "参考文献"：把 find/after 的搜索范围限制在该小节之后，
    避免正文里的作者名先命中、把参考文献条目插进正文。
"""

from __future__ import annotations

import argparse
import copy
import json
import shutil
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile

try:
    from lxml import etree
except ImportError:  # pragma: no cover
    sys.stderr.write("缺少 lxml，请先安装：py -3 -m pip install lxml\\n")
    raise SystemExit(2)

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"
NSMAP = {"w": W}
REVISION_ID_TAGS = ("ins", "del", "rPrChange", "pPrChange", "sectPrChange")


def qn(tag: str) -> str:
    return f"{{{W}}}{tag.split(':')[-1]}"


class TrackedChangeEditor:
    """把正文段落的改动写成 Word 能显示的 w:ins / w:del 修订。"""

    def __init__(self, docx_path: Path, author: str = "智能体") -> None:
        self.docx_path = Path(docx_path)
        self.author = author
        self.date = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

        try:
            with zipfile.ZipFile(self.docx_path, "r") as archive:
                self.doc_xml = archive.read("word/document.xml")
        except KeyError as err:
            raise ValueError(f"{self.docx_path.name} 里没有 {err}，不是有效的 .docx") from err

        self.root = etree.fromstring(self.doc_xml)
        self.body = self.root.find("w:body", NSMAP)
        if self.body is None:
            raise ValueError("word/document.xml 里没有 body 元素")

        self._find_max_id()
        self._index_body_paragraphs()

    def _find_max_id(self) -> None:
        # 修订 id 必须全文唯一，撞号会让 Word 把修订历史弄坏
        self.max_id = 0
        for tag in REVISION_ID_TAGS:
            for element in self.root.findall(f".//w:{tag}", NSMAP):
                revision_id = element.get(qn("w:id"))
                if not revision_id:
                    continue
                try:
                    self.max_id = max(self.max_id, int(revision_id))
                except ValueError:
                    continue

    def _next_id(self) -> str:
        self.max_id += 1
        return str(self.max_id)

    def _index_body_paragraphs(self) -> None:
        """优先取目录（w:sdt）之后的正文段落；没有 sdt 时退回全部段落。"""
        self.body_paras = []
        past_toc = False
        for child in self.body:
            tag = child.tag.split("}")[-1] if "}" in child.tag else child.tag
            if tag == "sdt":
                past_toc = True
                continue
            if past_toc and tag == "p":
                self.body_paras.append(child)
        if not self.body_paras:
            self.body_paras = self.body.findall("w:p", NSMAP)

    def para_text(self, paragraph) -> str:
        return "".join(t.text for t in paragraph.findall(".//w:t", NSMAP) if t.text)

    def _start_index(self, scope_after: str | None) -> int:
        """把搜索范围压到某个标题之后：正文里出现的作者名会先于参考文献条目命中。"""
        if not scope_after:
            return 0
        for index, paragraph in enumerate(self.body_paras):
            if self.para_text(paragraph).strip() == scope_after.strip():
                return index + 1
        raise ValueError(f"找不到小节标题「{scope_after}」，已停止以免插错位置")

    def find_paragraph(self, needle: str, start: int = 0) -> int:
        for index in range(start, len(self.body_paras)):
            if needle in self.para_text(self.body_paras[index]):
                return index
        raise ValueError(f"正文里没有包含「{needle}」的段落（从第 {start} 段起找过）")

    def _get_default_rpr(self, paragraph):
        for run in paragraph.findall(".//w:r", NSMAP):
            run_properties = run.find("w:rPr", NSMAP)
            if run_properties is not None:
                return copy.deepcopy(run_properties)
        return None

    def _collect_direct_runs(self, paragraph):
        """只取段落的直接子 run：已经在 w:ins/w:del 里的 run 不能再套一层修订。"""
        return [child for child in paragraph if child.tag == qn("w:r")]

    def replace_paragraph_text(self, para_index: int, new_text: str) -> None:
        paragraph = self.body_paras[para_index]
        direct_runs = self._collect_direct_runs(paragraph)
        if not direct_runs:
            raise ValueError(f"第 {para_index} 段没有可直接替换的文字（可能是纯表格或已有修订）")

        default_rpr = self._get_default_rpr(paragraph)
        first_run_pos = list(paragraph).index(direct_runs[0])

        deletion = etree.Element(qn("w:del"))
        deletion.set(qn("w:id"), self._next_id())
        deletion.set(qn("w:author"), self.author)
        deletion.set(qn("w:date"), self.date)
        for run in direct_runs:
            for text in run.findall("w:t", NSMAP):
                text.tag = qn("w:delText")  # 删除里的文字必须是 w:delText，不能留 w:t
            paragraph.remove(run)
            deletion.append(run)

        insertion = etree.Element(qn("w:ins"))
        insertion.set(qn("w:id"), self._next_id())
        insertion.set(qn("w:author"), self.author)
        insertion.set(qn("w:date"), self.date)
        new_run = etree.SubElement(insertion, qn("w:r"))
        if default_rpr is not None:
            new_run.append(copy.deepcopy(default_rpr))  # 沿用原段字体字号，避免改完变样式
        new_text_node = etree.SubElement(new_run, qn("w:t"))
        new_text_node.set(XML_SPACE, "preserve")
        new_text_node.text = new_text

        paragraph.insert(first_run_pos, deletion)
        paragraph.insert(first_run_pos + 1, insertion)

    def insert_paragraph_after(self, para_index: int, new_text: str) -> None:
        anchor = self.body_paras[para_index]
        new_paragraph = etree.Element(qn("w:p"))
        insertion = etree.SubElement(new_paragraph, qn("w:ins"))
        insertion.set(qn("w:id"), self._next_id())
        insertion.set(qn("w:author"), self.author)
        insertion.set(qn("w:date"), self.date)
        new_run = etree.SubElement(insertion, qn("w:r"))
        default_rpr = self._get_default_rpr(anchor)
        if default_rpr is not None:
            new_run.append(copy.deepcopy(default_rpr))
        new_text_node = etree.SubElement(new_run, qn("w:t"))
        new_text_node.set(XML_SPACE, "preserve")
        new_text_node.text = new_text

        body_children = list(self.body)
        anchor_position = body_children.index(anchor)
        self.body.insert(anchor_position + 1, new_paragraph)
        self._index_body_paragraphs()

    def apply(self, edits: list[dict], scope_default: str | None = None) -> list[str]:
        log: list[str] = []
        for position, edit in enumerate(edits):
            if not isinstance(edit, dict):
                raise ValueError(f"edits[{position}] 必须是对象")
            scope = edit.get("scope_after", scope_default)
            start = self._start_index(scope)
            replace = edit.get("replace")
            insert = edit.get("insert")
            if replace is None and insert is None:
                raise ValueError(f"edits[{position}] 既没有 replace 也没有 insert")
            if "para_index" in edit:
                index = int(edit["para_index"])
                if not 0 <= index < len(self.body_paras):
                    raise ValueError(f"para_index={index} 超出范围（共 {len(self.body_paras)} 段）")
            elif edit.get("after"):
                index = self.find_paragraph(str(edit["after"]), start)
            elif edit.get("find"):
                index = self.find_paragraph(str(edit["find"]), start)
            else:
                raise ValueError(f"edits[{position}] 需要 para_index、find 或 after 之一来定位")

            if replace is not None:
                before = self.para_text(self.body_paras[index])
                self.replace_paragraph_text(index, str(replace))
                log.append(f"[{index}] 替换：{before[:40] or '（空）'} → {str(replace)[:40]}")
            if insert is not None:
                self.insert_paragraph_after(index, str(insert))
                log.append(f"[{index + 1}] 新增：{str(insert)[:40]}")
        return log

    def summary(self) -> dict:
        return {
            "ins": len(self.root.findall(".//w:ins", NSMAP)),
            "del": len(self.root.findall(".//w:del", NSMAP)),
            "paragraphs": len(self.body_paras),
        }

    def save(self, output_path: Path) -> None:
        """重打包时只替换 word/document.xml，其余部件原样保留。"""
        output_path = Path(output_path)
        doc_xml_new = etree.tostring(
            self.root, xml_declaration=True, encoding="UTF-8", standalone=True
        )
        with NamedTemporaryFile(suffix=".docx", delete=False) as tmp_file:
            tmp_path = Path(tmp_file.name)
        try:
            with zipfile.ZipFile(self.docx_path, "r") as zin:
                with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zout:
                    for item in zin.infolist():
                        if item.filename == "word/document.xml":
                            zout.writestr(item, doc_xml_new)
                        else:
                            zout.writestr(item, zin.read(item.filename))
            shutil.move(str(tmp_path), str(output_path))
        finally:
            if tmp_path.exists():
                tmp_path.unlink()


def main() -> int:
    parser = argparse.ArgumentParser(description="用 Word 修订模式编辑 .docx")
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path, nargs="?", help="输出路径；省略时只列出段落")
    parser.add_argument("--author", default="智能体")
    parser.add_argument("--edits", type=Path, help="edits.json 路径")
    parser.add_argument("--scope-after", default=None, help="默认只在该楼层名之后搜索")
    parser.add_argument("--list", type=int, default=0, metavar="N", help="列出前 N 段后退出")
    args = parser.parse_args()

    if not args.source.exists():
        sys.stderr.write(f"找不到文件：{args.source}\\n")
        return 2
    try:
        editor = TrackedChangeEditor(args.source, author=args.author)
    except (ValueError, zipfile.BadZipFile) as err:
        sys.stderr.write(f"{err}\\n")
        return 2

    if args.list or not args.output:
        for index, paragraph in enumerate(editor.body_paras[: args.list or 20]):
            print(f"[{index}] {editor.para_text(paragraph)[:70]}")
        stats = editor.summary()
        print(f"正文段落 {stats['paragraphs']}，现有修订 插入×{stats['ins']} 删除×{stats['del']}")
        return 0

    if not args.edits:
        sys.stderr.write("需要 --edits 指向一个 edits.json；或先用 --list 看段落序号\\n")
        return 2
    edits = json.loads(args.edits.read_text(encoding="utf-8"))
    if not isinstance(edits, list) or not edits:
        sys.stderr.write("edits.json 必须是非空数组\\n")
        return 2
    if args.output.resolve() == args.source.resolve():
        sys.stderr.write("输出路径不能覆盖原稿：请另存为新文件，确认后由用户替换\\n")
        return 2

    try:
        log = editor.apply(edits, scope_default=args.scope_after)
    except (ValueError, json.JSONDecodeError) as err:
        sys.stderr.write(f"编辑失败，原稿未改动：{err}\\n")
        return 1

    editor.save(args.output)
    stats = editor.summary()
    print(f"已写出 {args.output.name}（作者 {args.author}）")
    for line in log:
        print(f"  {line}")
    print(f"  合计修订：插入×{stats['ins']} 删除×{stats['del']}；请用 verify_tracked_changes.py 复核")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
` },
      { path: "scripts/verify_tracked_changes.py", content: `"""核对 .docx 里的 Word 修订标记，确认改动真的写进去了。

改编自 https://github.com/wintersdragon-c/office-docx-skills （MIT，Copyright (c) 2026 wintersdragon-c）；
改动：输出中文化、支持 --expect 校验条数、按作者过滤时给出可判定的退出码。

用法：
    python verify_tracked_changes.py 修订后.docx
    python verify_tracked_changes.py 修订后.docx --author 审阅人 --expect 3
"""

from __future__ import annotations

import argparse
import sys
import zipfile
from pathlib import Path

try:
    from lxml import etree
except ImportError:  # pragma: no cover
    sys.stderr.write("缺少 lxml，请先安装：py -3 -m pip install lxml\\n")
    raise SystemExit(2)

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NSMAP = {"w": W}


def qn(tag: str) -> str:
    return f"{{{W}}}{tag.split(':')[-1]}"


def element_text(element, text_tag: str) -> str:
    return "".join(t.text for t in element.findall(f".//w:{text_tag}", NSMAP) if t.text)


def main() -> int:
    parser = argparse.ArgumentParser(description="核对 .docx 里的修订标记")
    parser.add_argument("docx", type=Path)
    parser.add_argument("--author", default=None)
    parser.add_argument("--expect", type=int, default=None, help="期望的插入条数，不符则退出码 1")
    args = parser.parse_args()

    if not args.docx.exists():
        sys.stderr.write(f"找不到文件：{args.docx}\\n")
        return 2
    try:
        with zipfile.ZipFile(args.docx) as archive:
            xml = archive.read("word/document.xml")
    except KeyError as err:
        sys.stderr.write(f"{args.docx.name} 里没有 {err}，不是有效的 .docx\\n")
        return 2

    root = etree.fromstring(xml)
    insertions = root.findall(".//w:ins", NSMAP)
    deletions = root.findall(".//w:del", NSMAP)
    authors = sorted(
        {
            item.get(qn("w:author"))
            for item in insertions + deletions
            if item.get(qn("w:author"))
        }
    )
    if args.author:
        insertions = [item for item in insertions if item.get(qn("w:author")) == args.author]
        deletions = [item for item in deletions if item.get(qn("w:author")) == args.author]

    print(f"作者过滤：{args.author or '（全部）'}，文档里的修订作者：{'、'.join(authors) or '无'}")
    print(f"插入 {len(insertions)} 处：")
    for index, item in enumerate(insertions, start=1):
        print(f"  ins[{index}] {element_text(item, 't')[:80]}")
    print(f"删除 {len(deletions)} 处：")
    for index, item in enumerate(deletions, start=1):
        print(f"  del[{index}] {element_text(item, 'delText')[:80]}")

    if not insertions and not deletions:
        sys.stderr.write("没有任何修订标记：改动可能被后续脚本覆盖，或第二轮回读了原稿\\n")
        return 1
    if args.expect is not None and len(insertions) != args.expect:
        sys.stderr.write(f"插入 {len(insertions)} 处，与期望的 {args.expect} 处不符\\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
` },
    ],
  },
  {
    name: "docx-formula",
    description: "在 .docx 里写 Word 原生可编辑公式（OMML）：分式、上下标、根号、求和积分、希腊字母，不依赖 pandoc 与 LibreOffice。",
    source: "GitHub · wintersdragon-c/office-docx-skills · word-formula-writing（MIT，改写：LaTeX 子集结构转 OMML、命令行入口与自检）",
    instructions: `# Word 里写可编辑公式

公式在 Word 里必须是「双击能改」的公式对象（OMML），不能是 a^2、x_t 这种纯文本，也不能贴图片。本机没有 pandoc、没有 LibreOffice，所以走脚本直写 OMML 这条路。

## 用法

1. 往已有文档追加公式：\`run_skill_script\` 执行 scripts/formula_writer.py，args 为 ["稿件.docx", "--latex", "E = \\\\frac{mc^2}{2}", "--number", "(1)"]。
2. 新建一份只演示公式的文档：args 为 ["公式.docx", "--create", "--caption", "能量与质量的关系：", "--latex", "E=mc^2"]。
3. 结构太复杂、脚本转不动时，退回可编辑的纯文本公式：args 为 ["稿件.docx", "--text", "R = \\\\sqrt{\\\\sum x_i^2}"] 改成 "--text", "R = √(Σxᵢ²)"（直接给 Unicode，Word 里仍是公式对象）。
4. 必须复核：用 **docx-writer** 的 scripts/docx_inspect.py（skill 填 "docx-writer"）看「公式」计数是否等于写入的条数。计数 0 说明还是文字，不是公式。

**每条 \`run_skill_script\` 都带 \`"cwd": "."\`**（docx-formula 和 docx-writer 的复核脚本都要带）：省略时脚本在 files/.skill-runtime/<技能名>/ 里跑，"稿件.docx" 指向那个临时目录，既找不到用户文件，改好的文档也不会出现在右侧「文件」里。

## 支持的写法

- 分式 \`\\frac{a}{b}\`、上下标 \`x^{2}\` / \`x_i\`、根号 \`\\sqrt{x}\`、带限的 \`\\sum_{i=1}^{n}\`、\`\\int_{a}^{b}\`。
- 希腊字母 \`\\alpha\` … \`\\Omega\`；符号 \`\\times \\cdot \\div \\pm \\leq \\geq \\neq \\approx \\infty \\partial \\nabla \\in \\subset \\cup \\cap \\rightarrow \\ldots\`。
- 认不出的记号会原样写成文本放进公式，不会让整篇失败；需要复杂结构（矩阵、分段函数、cases）时直接写 lxml 拼 OMML，参考脚本里的 OmmlParser 结构。

## 排版约定

1. 公式字体固定 Cambria Math；正文仍是宋体 + Times New Roman，两者不要混。
2. 显示公式独占一段、居中，公式段不要用正文样式。
3. 长公式手动拆成多行，别指望 Word 自动折行；推导步骤拆成逐条公式更清楚。
4. 符号首次出现要在正文里解释：紧跟公式写「其中 x 表示……」。
5. 有编号就用 --number "(1)"，正文引用「式 (1)」；标题紧跟公式时只给那个标题加约 10pt 段前距，不要放宽全局标题间距。

## 老文档里的公式

导入的文档可能用图片、WMF/EMF 或 OLE 对象存公式（w:object、v:imagedata、w:drawing），不是 OMML。要保留它们就得连关系文件一起搬：rId 属于特定部件，跨部件复制必须新建关系并重写 r:embed/r:id，同时更新 [Content_Types].xml。搬运前后要按「每对」比对签名（对象类型、目标文件、尺寸、所在段落）而不是只比文档级总数。`,
    files: [
      { path: "scripts/formula_writer.py", content: `"""在 .docx 里写 Word 原生可编辑公式（OMML），不依赖 pandoc 或 LibreOffice。

改编自 https://github.com/wintersdragon-c/office-docx-skills（MIT，Copyright (c) 2026 wintersdragon-c）：
保留了它的 m:oMath / m:r / m:t 最小写法；分式、上下标、根号、求和积分的结构转换与
「认不出就退化成可编辑文本」的兜底为本仓库补写。

用法（推荐 run_skill_script 执行，解释器会自动挑选）：
    python formula_writer.py 稿件.docx --latex "E = \\\\frac{mc^2}{2}" --number "(1)"
    python formula_writer.py 新文档.docx --create --caption "能量与质量的关系：" --latex "E=mc^2"
    python formula_writer.py 稿件.docx --text "x+1=2"        # 不做语法转换，只要一个公式对象

支持的 LaTeX 子集：\\\\frac{a}{b}、x^{2} / x_1、\\\\sqrt{x}、\\\\sum_{i=1}^{n}、\\\\int_{a}^{b}、
希腊字母（\\\\alpha … \\\\Omega）、常用符号（\\\\times \\\\leq \\\\approx \\\\infty …）。
其余记号原样作为文本放进公式，不会报错；写完用 docx_inspect.py 看「公式」计数。
"""

from __future__ import annotations

import argparse
import sys
import zipfile
from pathlib import Path

try:
    from docx import Document
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Pt
except ImportError:  # pragma: no cover
    sys.stderr.write(
        "缺少 python-docx。请先安装：\\n"
        "    py -3 -m pip install python-docx lxml\\n"
        "（Windows 上 python 可能指向 Microsoft Store 占位程序，请用 py -3。）\\n"
    )
    raise SystemExit(2)

MATH_NS = "http://schemas.openxmlformats.org/officeDocument/2006/math"

GREEK = {
    "alpha": "α", "beta": "β", "gamma": "γ", "delta": "δ", "epsilon": "ε",
    "zeta": "ζ", "eta": "η", "theta": "θ", "iota": "ι", "kappa": "κ",
    "lambda": "λ", "mu": "μ", "nu": "ν", "xi": "ξ", "pi": "π", "rho": "ρ",
    "sigma": "σ", "tau": "τ", "upsilon": "υ", "phi": "φ", "chi": "χ",
    "psi": "ψ", "omega": "ω",
    "Gamma": "Γ", "Delta": "Δ", "Theta": "Θ", "Lambda": "Λ", "Xi": "Ξ",
    "Pi": "Π", "Sigma": "Σ", "Phi": "Φ", "Psi": "Ψ", "Omega": "Ω",
}
SYMBOLS = {
    "times": "×", "cdot": "·", "div": "÷", "pm": "±", "mp": "∓",
    "leq": "≤", "le": "≤", "geq": "≥", "ge": "≥", "neq": "≠", "ne": "≠",
    "approx": "≈", "equiv": "≡", "propto": "∝", "infty": "∞", "partial": "∂",
    "nabla": "∇", "in": "∈", "notin": "∉", "subset": "⊂", "subseteq": "⊆",
    "cup": "∪", "cap": "∩", "forall": "∀", "exists": "∃",
    "rightarrow": "→", "to": "→", "leftarrow": "←", "Rightarrow": "⇒",
    "langle": "⟨", "rangle": "⟩", "ldots": "…", "cdots": "⋯",
    "degree": "°", "circ": "∘", "prime": "′",
}
NARY_CHARS = {"sum": "∑", "prod": "∏", "int": "∫", "oint": "∮", "coprod": "∐",
              "bigcup": "⋃", "bigcap": "⋂"}
SCRIPT_TAGS = {"^": "sup", "_": "sub"}


def m_tag(local: str) -> str:
    return f"{{{MATH_NS}}}{local}"


def math_run(text: str):
    """一个 m:r：字体固定 Cambria Math，Word 才把它当公式字符。"""
    run = OxmlElement("m:r")
    rpr = OxmlElement("w:rPr")
    fonts = OxmlElement("w:rFonts")
    fonts.set(qn("w:ascii"), "Cambria Math")
    fonts.set(qn("w:hAnsi"), "Cambria Math")
    rpr.append(fonts)
    run.append(rpr)
    node = OxmlElement("m:t")
    node.text = text
    run.append(node)
    return run


class OmmlParser:
    """LaTeX 子集 → OMML 节点；每个方法把节点追加进传入的父元素。"""

    def __init__(self, text: str) -> None:
        self.text = text
        self.pos = 0

    def emit(self, parent) -> None:
        buffer = ""
        while self.pos < len(self.text):
            char = self.text[self.pos]
            if char == "}":
                break
            if char == "\\\\":
                self._flush(parent, buffer)
                buffer = ""
                self._command(parent)
                continue
            if char in SCRIPT_TAGS:
                self._flush(parent, buffer)
                buffer = ""
                if self._script(parent):
                    continue
                buffer = char
                continue
            buffer += char
            self.pos += 1
        self._flush(parent, buffer)

    def _flush(self, parent, buffer: str) -> None:
        text = buffer.strip()
        if text:
            parent.append(math_run(text))

    def _word(self) -> str:
        """读取反斜杠后面的命令名：字母命令取到非字母为止，符号命令取一个字符。"""
        start = self.pos
        if start >= len(self.text):
            return ""
        if self.text[start].isalpha():
            index = start
            while index < len(self.text) and self.text[index].isalpha():
                index += 1
            self.pos = index
            return self.text[start:index]
        self.pos = start + 1
        return self.text[start]

    def _argument(self) -> str:
        """读取一个参数单元，返回其原始 LaTeX 文本（去掉外层花括号）。"""
        while self.pos < len(self.text) and self.text[self.pos] == " ":
            self.pos += 1
        if self.pos >= len(self.text):
            return ""
        if self.text[self.pos] == "{":
            depth = 0
            for index in range(self.pos, len(self.text)):
                if self.text[index] == "{":
                    depth += 1
                elif self.text[index] == "}":
                    depth -= 1
                    if depth == 0:
                        inner = self.text[self.pos + 1 : index]
                        self.pos = index + 1
                        return inner
            inner = self.text[self.pos + 1 :]
            self.pos = len(self.text)
            return inner
        char = self.text[self.pos]
        if char == "\\\\":
            # 单个命令也要当成一个整体参数：\\sum \\alpha 里的 \\alpha 不能被拆成「\\」+「alpha」
            self.pos += 1
            return "\\\\" + self._word()
        self.pos += 1
        return char

    def _command(self, parent) -> None:
        self.pos += 1  # 跳过反斜杠
        name = self._word()
        if name == "frac":
            numerator = self._argument()
            denominator = self._argument()
            fraction = OxmlElement("m:f")
            for tag, content in (("m:num", numerator), ("m:den", denominator)):
                holder = OxmlElement(tag)
                child = OmmlParser(content)
                child.emit(holder)
                fraction.append(holder)
            parent.append(fraction)
            return
        if name == "sqrt":
            inner = self._argument()
            radical = OxmlElement("m:rad")
            properties = OxmlElement("m:radPr")
            hide = OxmlElement("m:degHide")
            hide.set(m_tag("val"), "1")
            properties.append(hide)
            radical.append(properties)
            radical.append(OxmlElement("m:deg"))
            holder = OxmlElement("m:e")
            OmmlParser(inner).emit(holder)
            radical.append(holder)
            parent.append(radical)
            return
        if name in NARY_CHARS:
            self._nary(parent, name)
            return
        if name in GREEK:
            parent.append(math_run(GREEK[name]))
            return
        if name in SYMBOLS:
            parent.append(math_run(SYMBOLS[name]))
            return
        # 不认识的命令：原样留下命令名，公式仍可编辑，不会整篇失败
        parent.append(math_run(name or "\\\\"))

    def _atom_with_scripts(self) -> str:
        """取「一个原子 + 紧跟它的上下标」：\\\\sum_{i}^{n} \\\\alpha_i 的被加数应是 \\\\alpha_i。"""
        atom = self._argument()
        while self.pos < len(self.text) and self.text[self.pos] in SCRIPT_TAGS:
            marker = self.text[self.pos]
            self.pos += 1
            operand = self._argument()
            atom += marker + (operand if len(operand) == 1 else "{" + operand + "}")
        return atom

    def _nary(self, parent, name: str) -> None:
        lower = self._optional_script("_")
        upper = self._optional_script("^")
        body = self._atom_with_scripts()
        nary = OxmlElement("m:nary")
        properties = OxmlElement("m:naryPr")
        character = OxmlElement("m:chr")
        character.set(m_tag("val"), NARY_CHARS[name])
        properties.append(character)
        limit_location = OxmlElement("m:limLoc")
        limit_location.set(m_tag("val"), "undOvr" if name.startswith(("sum", "prod", "big")) else "subSup")
        properties.append(limit_location)
        nary.append(properties)
        for tag, content in (("m:sub", lower), ("m:sup", upper), ("m:e", body)):
            holder = OxmlElement(tag)
            if content:
                OmmlParser(content).emit(holder)
            nary.append(holder)
        parent.append(nary)

    def _optional_script(self, marker: str) -> str:
        saved = self.pos
        while self.pos < len(self.text) and self.text[self.pos] == " ":
            self.pos += 1
        if self.pos < len(self.text) and self.text[self.pos] == marker:
            self.pos += 1
            return self._argument()
        self.pos = saved
        return ""

    def _script(self, parent) -> bool:
        marker = self.text[self.pos]
        self.pos += 1
        value = self._argument()
        target = OxmlElement("m:sSup" if marker == "^" else "m:sSub")
        base = OxmlElement("m:e")
        script = OxmlElement(f"m:{SCRIPT_TAGS[marker]}")
        # 底座就是刚刚吐出来的那个节点：把它从父级里取出来放进 m:e，
        # 否则 x^2 会渲染成「x」加一个空底数的上标。
        script_nodes = tuple(m_tag(name) for name in ("r", "sSup", "sSub", "f", "rad", "nary"))
        previous = parent[-1] if len(parent) else None
        if previous is not None and previous.tag in script_nodes:
            parent.remove(previous)
            base.append(previous)
        else:
            base.append(math_run(""))
        OmmlParser(value).emit(script)
        target.append(base)
        target.append(script)
        parent.append(target)
        return True


def o_math(latex: str):
    container = OxmlElement("m:oMath")
    OmmlParser(latex).emit(container)
    return container


def plain_math(text: str):
    container = OxmlElement("m:oMath")
    container.append(math_run(text))
    return container


def append_formula(document, latex: str | None, plain_text: str | None, number: str | None):
    """正文结构：公式独占一段，段内只放 m:oMath 与编号文本。"""
    paragraph = document.add_paragraph()
    paragraph.alignment = 1  # 显示公式按 Word 惯例居中
    paragraph.paragraph_format.space_before = Pt(6)
    paragraph.paragraph_format.space_after = Pt(6)
    paragraph._p.append(o_math(latex) if latex is not None else plain_math(plain_text or ""))
    if number:
        run = paragraph.add_run("  " + number)
        run.font.size = Pt(12)
    return paragraph


def main() -> int:
    parser = argparse.ArgumentParser(description="向 .docx 写入 Word 原生可编辑公式")
    parser.add_argument("docx", type=Path)
    parser.add_argument("--latex", default=None, help="LaTeX 子集，见文件头说明")
    parser.add_argument("--text", default=None, help="跳过语法转换，直接放一个文本公式对象")
    parser.add_argument("--number", default=None, help="公式编号，如 (1)")
    parser.add_argument("--create", action="store_true", help="目标不存在时新建文档")
    parser.add_argument("--caption", default=None, help="新建文档时写在公式前面的一句话")
    args = parser.parse_args()

    if args.latex is None and args.text is None:
        sys.stderr.write("需要 --latex 或 --text 之一\\n")
        return 2

    if args.docx.exists() and not args.create:
        try:
            with zipfile.ZipFile(args.docx) as archive:
                if "word/document.xml" not in archive.namelist():
                    sys.stderr.write(f"{args.docx.name} 不是有效的 .docx\\n")
                    return 2
        except zipfile.BadZipFile:
            sys.stderr.write(f"{args.docx.name} 已损坏或不是 .docx\\n")
            return 2
        document = Document(str(args.docx))
    else:
        document = Document()
        if args.caption:
            document.add_paragraph(args.caption)

    append_formula(document, args.latex, args.text, args.number)
    args.docx.parent.mkdir(parents=True, exist_ok=True)
    document.save(str(args.docx))
    count = len(document.element.body.findall(".//" + m_tag("oMath")))
    print(f"已在 {args.docx.name} 写入公式，文档现有 {count} 个可编辑公式对象")
    print("复核：py -3 docx_inspect.py 该文件，「公式」应等于上面的计数。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
` },
    ],
  },
];
