/*!
 * 内置技能：来自 https://github.com/anthropics/skills （Apache-2.0）。
 *
 * 许可与改动说明：
 * - 上游每个技能目录内的 LICENSE.txt 为 Apache License 2.0，完整文本见
 *   THIRD_PARTY_LICENSES/Apache-2.0.txt；本文件保留了来源与改动声明。
 * - 已改写：说明与示例中文化；工具名改为本运行时的 read_skill_file / run_skill_script /
 *   file_* / run_command；删除 poppler、qpdf、OCR、reportlab、浏览器渲染等本机不可用的路径。
 * - pdf 的 scripts/*.py 保留上游实现（未改逻辑），只预装不依赖 poppler 的 6 个脚本；
 *   convert_pdf_to_images.py 与 create_validation_image.py 需要把 PDF 渲染成图片，不预装。
 * - 刻意不引入上游的 docx / xlsx / pptx / canvas-design / claude-api 等技能：
 *   文件数超过 40 个，或依赖 LibreOffice / Playwright / 外部 API，无法随系统离线预装。
 */

import type { BuiltinSkillSeed } from "./builtin";

export const ANTHROPIC_SKILLS: BuiltinSkillSeed[] = [
  {
    name: "internal-comms",
    description: "撰写组织内部沟通材料：3P 周报、公司简报、FAQ、事故通报与通知，按体裁收集证据并成稿。",
    source: "GitHub · anthropics/skills · internal-comms（Apache-2.0，已中文化改写并适配本运行时）",
    instructions: `# 内部沟通材料

用户要写组织内部的沟通材料时用它：3P 周报、公司简报、FAQ、事故通报、领导层更新、项目进展、内部通知。

## 适用与不适用

- 适用：需要按固定体裁整理事实并成稿，读者是同事、上级或全员。
- 不适用：对外公关稿与营销文案；正式公文按 docx-writer 的成文结构另写；只做摘要用 summarize。

## 先定类型

| 类型 | 用途 | 参考文件 |
| --- | --- | --- |
| 3P 更新 | 周度进展：进度、计划、问题 | examples/3p-updates.md |
| 公司简报 | 面向全员的多板块汇总 | examples/company-newsletter.md |
| FAQ | 集中回答高频疑问 | examples/faq-answers.md |
| 事故通报 | 故障或事件的时间线与处置 | examples/incident-report.md |
| 其他通知 | 提醒、征询、政策变更 | examples/general-comms.md |

用 read_skill_file 读取对应文件，skill 填 internal-comms。类型拿不准时先问一句，不要硬套。

## 先收事实，再成稿

1. 用户直接给的材料最优先：消息、文件、数据、链接。
2. 工作区材料：file_list / file_read 读 files/ 下的相关文件；room_history 读当前房间的近期讨论；task_list 看任务卡状态。
3. 需要外部信息时用 web_search / web_fetch，并记录链接。
4. 本运行环境没有 Slack、邮件、日历、云盘接口，不要声称从这些渠道取过数据。缺什么就列「待补」，不编数字、人名、日期或项目名。

## 成稿规则

- 结论在前，依据在后；每条事实尽量带时间、来源与数字口径。
- 不写过程：不要出现「我先查了」「工具返回」这类话。
- 篇幅服从体裁：3P 三段各 1-3 句；简报 15-25 条；FAQ 一问一答。
- 事故类只写已核实的时间线与处置；原因未定就写「原因待查」，不推测、不点名未经确认的责任人。
- 数字缺失就留空并标「待补」，不用估算值替代。
- 需要留档时用 file_write 落到 files/comms/<日期>-<类型>.md；群里只回结论、文件名与待补项。
- 需要 Word 交付时，把 Markdown 交给 docx-writer 转换，不要在聊天里贴全文。
`,
    files: [
      {
        path: `examples/3p-updates.md`,
        content: `## 用途

周度 3P：Progress（本周完成）、Plans（下周计划）、Problems（阻塞与风险）。读者是上级、跨团队同事，通常只有部分背景。

## 格式（严格照此输出）

[一个 emoji] [团队名]（覆盖日期，通常一周）
进展：1-3 句，写已交付、里程碑、关键数字。
计划：1-3 句，写下周最高优先级。
问题：1-3 句，写阻塞、缺人、依赖未到位；没有就写「暂无」。

## 取材

优先用用户给的周报、任务卡与数据。可用 task_list 看任务状态、room_history 看本周讨论、file_read 读材料。没有数据源就请用户提供，不要编。

## 写法

- 团队越大写得越粗，团队越小写得越具体。
- 用事实和数字，不用形容词堆砌；每条不超过 3 句，全文 30-60 秒读完。
- 只写本周实际发生的事，不把计划写成进展。
`,
      },
      {
        path: `examples/company-newsletter.md`,
        content: `## 用途

面向全员的周/月简报，通常 15-25 条，按板块分组，让不在一线的人也能知道公司发生了什么。

## 板块示例

:megaphone: 公司公告
:dart: 重点进展（按业务线分组，每条 1-2 句）
:pillar: 领导层动态
:thread: 文化与社会活动

## 取材

用户提供的公告、文档、会议纪要优先；file_list / file_read 读 files/ 内材料；外部报道用 web_search 并附链接。没有 Slack、邮件、日历接口，不要假装读取。

## 写法

- 用「我们」的口吻；每条 1-2 句。
- 只写影响面大的事；团队细节留给 3P。
- 每条尽量带链接或文件名；不确定的标「待确认」。
- 避免与上一期重复；没有新内容就少写几条，不凑数。
`,
      },
      {
        path: `examples/faq-answers.md`,
        content: `## 用途

把一段时间内的高频问题整理成一问一答，减少重复解释，让信息口径一致。

## 取材

用户提供的提问记录、群聊讨论（room_history）、文件（file_read）优先；政策、流程类问题查官方来源并附链接。

## 格式

- **问**：一句话问题。
- **答**：1-2 句结论 + 依据（文件名或链接）。不确定就写「以官方通知为准」。

## 规则

- 只收影响面广的问题，不写只对一个人有用的细节。
- 答案必须有出处；没有出处就标「待确认」，不要凭印象回答。
- 涉及人事、薪酬、法务的问题，提示需要官方口径，不自行解释。
- 同一问题有多种说法时，并列说法与来源，不强行统一。
`,
      },
      {
        path: `examples/incident-report.md`,
        content: `## 用途

事故或故障的内部通报：发生了什么、影响多大、现在怎么样、接下来做什么。

## 结构

1. 一句话结论：当前状态（已恢复 / 处置中 / 影响持续）。
2. 时间线：时间（注明时区）+ 事件，只写已核实的节点。
3. 影响：受影响范围、用户或业务、起止时间；数字给口径。
4. 已采取措施：已做的处置与结果。
5. 待办与负责人：下一步、预计完成时间。
6. 原因：已确认就写；未确认写「原因待查」，不推测。

## 规则

- 不写未经证实的猜测，不点名未经确认的责任人。
- 不隐瞒影响；数字缺失标「待补」，不用估计值替代。
- 本文只用于内部；对外版本另行处理，不要直接转发。
- 处置未结束时不要写「已解决」；用「已恢复」与「观察中」区分。
`,
      },
      {
        path: `examples/general-comms.md`,
        content: `## 用途

不属于 3P、简报、FAQ、事故通报的内部通知与沟通材料。

## 先确认

1. 读者是谁：全员、某个部门、还是管理层。
2. 目的：通知、提醒、征询意见、政策变更。
3. 语气：正式、中性、紧急。
4. 截止时间与需要读者做什么。

## 写法

- 结论放第一段；行动项单独列出：谁、做什么、什么时候前完成。
- 用主动语态，少用套话与空泛表态。
- 附上依据文件或链接；没有就说明信息来源。
- 篇幅能短则短，不为凑结构加段落。
`,
      },
    ],
  },
  {
    name: "theme-factory",
    description: "为文档、网页或演示统一配色与字体：10 套主题按受众选用，给出色值与字体配对。",
    source: "GitHub · anthropics/skills · theme-factory（Apache-2.0，已中文化改写；未收展示用 PDF）",
    instructions: `# 视觉主题

给文档、网页或演示统一配色与字体时用它：报告封面与图表、HTML 页面、版式说明。

## 主题清单

| 主题 | 风格 | 适合 |
| --- | --- | --- |
| ocean-depths 海洋深处 | 冷静、专业 | 企业汇报、财务报告、咨询 |
| sunset-boulevard 日落大道 | 温暖、有活力 | 创意提案、市场活动、生活方式 |
| forest-canopy 森林冠层 | 自然、稳重 | 环保、可持续、户外与健康 |
| modern-minimalist 现代极简 | 灰阶、克制 | 科技、建筑、作品集、数据可视化 |
| golden-hour 黄金时刻 | 温暖、复古 | 餐饮、酒店、秋季活动、手作 |
| arctic-frost 北极霜 | 清冷、精准 | 医疗、科技方案、制药 |
| desert-rose 沙漠玫瑰 | 柔和、优雅 | 时尚、美妆、婚礼、室内设计 |
| tech-innovation 技术创新 | 高对比、锐利 | 科技创业、软件发布、AI |
| botanical-garden 植物园 | 清新、有机 | 食品、农业、植物品牌 |
| midnight-galaxy 午夜星河 | 深邃、戏剧化 | 娱乐、游戏、夜间场景、奢侈品牌 |

## 使用流程

1. 先确认受众、场景与交付格式；给 2-3 个候选主题并说明差异，不要一次抛 10 个。
2. 用户选定后，用 read_skill_file 读取 themes/<主题>.md，拿到完整色值与字体配对。
3. 落到产物：
   - HTML：写成 CSS 变量（--bg / --surface / --text / --accent），字体写完整回退链。
   - Word：先用 docx-writer 生成，再写 python-docx 脚本改标题色、强调色与字体；中文字体用宋体或微软雅黑，主题西文字体作为西文首选。
   - 演示：本项目暂无 PPT 技能，先交付 HTML 或 Markdown 版式说明。
4. 一个文档只用一套主题；同一系列的多份材料保持同一套。

## 约束

- 正文与背景对比度至少 4.5:1；不满足时加深文字或减淡背景，不硬套原色。
- 主题字体（DejaVu、FreeSans、FreeSerif）在本机未必安装，必须写回退；不要声称已经做过渲染验证。
- 用户已有品牌规范时品牌优先，主题只作参考。
- 色值以 themes/*.md 为准，不凭印象改色。
`,
    files: [
      {
        path: `themes/ocean-depths.md`,
        content: `# 海洋深处（Ocean Depths）

专业、平静的海洋主题，传达深海般的安定感。

## 配色

- **深海蓝**：\`#1a2332\` — 主背景色
- **青绿**：\`#2d8b8b\` — 强调色，用于高亮与重点
- **海沫**：\`#a8dadc\` — 次级强调色，用于浅色元素
- **奶油白**：\`#f1faee\` — 正文与浅色背景

## 字体

- **标题**：DejaVu Sans Bold
- **正文**：DejaVu Sans

## 适用场景

企业汇报、财务报告、专业咨询材料、需要建立信任感的内容。
`,
      },
      {
        path: `themes/sunset-boulevard.md`,
        content: `# 日落大道（Sunset Boulevard）

温暖而有活力的主题，取自黄金时刻的日落，适合需要感染力的场合。

## 配色

- **焦橙**：\`#e76f51\` — 主强调色
- **珊瑚**：\`#f4a261\` — 次级暖色强调
- **暖沙**：\`#e9c46a\` — 高亮与背景
- **深紫**：\`#264653\` — 深色对比与正文

## 字体

- **标题**：DejaVu Serif Bold
- **正文**：DejaVu Sans

## 适用场景

创意提案、市场活动、生活方式品牌、活动宣传、励志内容。
`,
      },
      {
        path: `themes/forest-canopy.md`,
        content: `# 森林冠层（Forest Canopy）

自然、稳重的主题，灵感来自密林中的大地色。

## 配色

- **森林绿**：\`#2d4a2b\` — 主深绿色
- **鼠尾草**：\`#7d8471\` — 低饱和绿色强调
- **橄榄**：\`#a4ac86\` — 浅色强调
- **象牙白**：\`#faf9f6\` — 背景与正文

## 字体

- **标题**：FreeSerif Bold
- **正文**：FreeSans

## 适用场景

环保议题、可持续发展报告、户外品牌、健康内容、有机产品。
`,
      },
      {
        path: `themes/modern-minimalist.md`,
        content: `# 现代极简（Modern Minimalist）

干净、当代的灰阶主题，适用面广。

## 配色

- **炭灰**：\`#36454f\` — 主深色
- **石板灰**：\`#708090\` — 中等灰度强调
- **浅灰**：\`#d3d3d3\` — 背景与分隔线
- **白**：\`#ffffff\` — 正文与干净背景

## 字体

- **标题**：DejaVu Sans Bold
- **正文**：DejaVu Sans

## 适用场景

科技汇报、建筑作品集、设计展示、现代商业提案、数据可视化。
`,
      },
      {
        path: `themes/golden-hour.md`,
        content: `# 黄金时刻（Golden Hour）

温暖浓郁的秋日色盘，营造亲切而有质感的氛围。

## 配色

- **芥末黄**：\`#f4a900\` — 醒目的主强调色
- **陶土红**：\`#c1666b\` — 暖色次级色
- **暖米色**：\`#d4b896\` — 中性背景
- **巧克力棕**：\`#4a403a\` — 深色正文与锚点

## 字体

- **标题**：FreeSans Bold
- **正文**：FreeSans

## 适用场景

餐饮、酒店与民宿、秋季活动、生活方式内容、手作与匠人品牌。
`,
      },
      {
        path: `themes/arctic-frost.md`,
        content: `# 北极霜（Arctic Frost）

清冷、利落的冬日主题，传达清晰、精准与专业。

## 配色

- **冰蓝**：\`#d4e4f7\` — 浅色背景与高亮
- **钢蓝**：\`#4a6fa5\` — 主强调色
- **银灰**：\`#c0c0c0\` — 金属感点缀
- **纯净白**：\`#fafafa\` — 干净背景与正文

## 字体

- **标题**：DejaVu Sans Bold
- **正文**：DejaVu Sans

## 适用场景

医疗健康、技术方案、冰雪运动、清洁能源、制药内容。
`,
      },
      {
        path: `themes/desert-rose.md`,
        content: `# 沙漠玫瑰（Desert Rose）

柔和、低饱和的灰粉色主题，适合优雅克制的场合。

## 配色

- **灰玫瑰**：\`#d4a5a5\` — 柔和主色
- **陶土**：\`#b87d6d\` — 大地色强调
- **沙色**：\`#e8d5c4\` — 温暖中性背景
- **深酒红**：\`#5d2e46\` — 深色对比

## 字体

- **标题**：FreeSans Bold
- **正文**：FreeSans

## 适用场景

时尚、美妆、婚礼策划、室内设计、精品品牌。
`,
      },
      {
        path: `themes/tech-innovation.md`,
        content: `# 技术创新（Tech Innovation）

大胆、现代的高对比主题，适合前沿技术内容。

## 配色

- **电光蓝**：\`#0066ff\` — 醒目的主强调色
- **霓虹青**：\`#00ffff\` — 高亮色
- **深灰**：\`#1e1e1e\` — 深色背景
- **白**：\`#ffffff\` — 正文与对比

## 字体

- **标题**：DejaVu Sans Bold
- **正文**：DejaVu Sans

## 适用场景

科技创业、软件发布、创新展示、AI 与机器学习、数字化转型。
`,
      },
      {
        path: `themes/botanical-garden.md`,
        content: `# 植物园（Botanical Garden）

清新、有机的主题，色彩取自花园，适合有生命力的内容。

## 配色

- **蕨绿**：\`#4a7c59\` — 浓郁自然的绿色
- **金盏黄**：\`#f9a620\` — 明亮的花卉强调色
- **陶土**：\`#b7472a\` — 温暖的大地色
- **奶油**：\`#f5f3ed\` — 柔和中性背景

## 字体

- **标题**：DejaVu Serif Bold
- **正文**：DejaVu Sans

## 适用场景

园艺与花店、食品、农场到餐桌、植物品牌、天然产品。
`,
      },
      {
        path: `themes/midnight-galaxy.md`,
        content: `# 午夜星河（Midnight Galaxy）

深邃、戏剧化的主题，深紫与宇宙色，适合有冲击力的内容。

## 配色

- **深紫**：\`#2b1e3e\` — 深色基底
- **宇宙蓝**：\`#4a4e8f\` — 神秘中间调
- **薰衣草紫**：\`#a490c2\` — 柔和强调色
- **银白**：\`#e6e6fa\` — 浅色高亮与正文

## 字体

- **标题**：FreeSans Bold
- **正文**：FreeSans

## 适用场景

娱乐行业、游戏、夜间场景、奢侈品牌、创意机构。
`,
      },
    ],
  },
  {
    name: "pdf",
    description: "读取与处理 PDF：抽取文本表格、合并拆分旋转、水印加密、检查并填写表单。",
    source: "GitHub · anthropics/skills · pdf（Apache-2.0，说明已中文化改写；脚本保留上游实现，仅预装 pypdf/pdfplumber 路径）",
    instructions: `# PDF 处理

用户要读取、拆分、合并或填写 PDF 时用它。

## 适用与不适用

- 适用：抽取文本与表格、合并 / 拆分 / 旋转、查看元数据、加水印、加密、检查与填写表单。
- 不适用：生成 PDF（本机没有 reportlab，先出 .docx 再让用户用 Word 另存）；扫描件 OCR（没有 pytesseract 与 poppler，直接说明做不了）；.docx 处理用 docx-reader / docx-writer。

## 基本规则

- PDF 是二进制，file_read 读不了，要用 Python。
- 所有路径相对 files/ 根目录写（如 reports/input.pdf），不要加 files/ 前缀。
- 处理结果写到新文件，不覆盖原文件；文件名只用字母、数字、短横线。
- 执行附带脚本用 run_skill_script（skill 填 pdf），并带 \`"cwd": "."\`；自己写脚本时先用 file_write 落成 files/xxx.py，再 run_command 执行 \`py -3 xxx.py ...\`（Windows 上不要用 \`python\`）。
- 本机已装 pypdf、pdfplumber、Pillow、pdf2image；未装 poppler（pdftotext / pdftoppm / pdftoppm 系工具）、qpdf、pytesseract、reportlab。缺什么就明说，不要写注定失败的命令。

## 读取文本与表格

页数与文本（pypdf）：

\`\`\`python
from pypdf import PdfReader

reader = PdfReader("reports/input.pdf")
print(len(reader.pages))
print(reader.pages[0].extract_text())
\`\`\`

带版式的文本与表格（pdfplumber）：

\`\`\`python
import pdfplumber

with pdfplumber.open("reports/input.pdf") as pdf:
    for i, page in enumerate(pdf.pages, 1):
        print(page.extract_text())
        for table in page.extract_tables():
            for row in table:
                print(row)
\`\`\`

需要落盘时写成 Markdown 或 CSV（用标准库 csv，不依赖 pandas）。表格单元格可能是 None，先转成空字符串。

## 合并、拆分、旋转、元数据

\`\`\`python
from pypdf import PdfReader, PdfWriter

writer = PdfWriter()
for path in ["reports/a.pdf", "reports/b.pdf"]:
    for page in PdfReader(path).pages:
        writer.add_page(page)
with open("reports/merged.pdf", "wb") as f:
    writer.write(f)
\`\`\`

- 拆分：每页一个 PdfWriter，输出 page-1.pdf 这类名字。
- 旋转：\`reader.pages[0].rotate(90)\`。
- 元数据：\`reader.metadata.title / author / subject / creator\`。
- 水印：用水印 PDF 的页 \`merge_page\` 叠加到每一页。
- 加密：\`writer.encrypt("用户密码", "所有者密码")\`。

## 填写表单

先判断类型：

1. 检查是否有可填字段：
   run_skill_script skill="pdf" path="scripts/check_fillable_fields.py" args=["reports/form.pdf"] cwd="."
2. 可填表单：先抽字段，再填。
   - 抽字段：scripts/extract_form_field_info.py，args=["reports/form.pdf", "reports/fields.json"]。
   - 读 fields.json：每个字段有 field_id、type、page（从 1 开始）与选项值；radio / choice / checkbox 必须用它给出的合法值。
   - 写值文件：\`[{"field_id": "name", "page": 1, "value": "张三"}]\`。
   - 填写：scripts/fill_fillable_fields.py，args=["reports/form.pdf", "reports/values.json", "reports/filled.pdf"]。
3. 不可填（平面表单或扫描件）：
   - 抽结构：scripts/extract_form_structure.py，args=["reports/form.pdf", "reports/structure.json"]，拿标签、横线、复选框坐标。
   - 按坐标构造 fields.json：pages 里写 page_number 与 pdf_width / pdf_height；form_fields 每项写 page_number、label_bounding_box、entry_bounding_box、entry_text。坐标原点在左上、y 向下。
   - 校验：scripts/check_bounding_boxes.py，args=["reports/fields.json"]；有交集或框太小先修。
   - 写入：scripts/fill_pdf_form_with_annotations.py，args=["reports/form.pdf", "reports/fields.json", "reports/filled.pdf"]。
4. 本机不能把 PDF 渲染成图片，填写效果无法自动验证；把输出路径给用户，让他在右侧「文件」里预览确认。

## 回复

- 说明做了什么、输出文件名、页数或字段数。
- 抽出的正文较多时写到 files/ 下的 .md 再给路径，不要整段贴进群聊。
- 遇到加密、损坏、扫描件，先说明限制再给替代方案，不硬做。
`,
    files: [
      {
        path: `scripts/check_fillable_fields.py`,
        content: `import sys
from pypdf import PdfReader




reader = PdfReader(sys.argv[1])
if (reader.get_fields()):
    print("This PDF has fillable form fields")
else:
    print("This PDF does not have fillable form fields; you will need to visually determine where to enter data")
`,
      },
      {
        path: `scripts/check_bounding_boxes.py`,
        content: `from dataclasses import dataclass
import json
import sys




@dataclass
class RectAndField:
    rect: list[float]
    rect_type: str
    field: dict


def get_bounding_box_messages(fields_json_stream) -> list[str]:
    messages = []
    fields = json.load(fields_json_stream)
    messages.append(f"Read {len(fields['form_fields'])} fields")

    def rects_intersect(r1, r2):
        disjoint_horizontal = r1[0] >= r2[2] or r1[2] <= r2[0]
        disjoint_vertical = r1[1] >= r2[3] or r1[3] <= r2[1]
        return not (disjoint_horizontal or disjoint_vertical)

    rects_and_fields = []
    for f in fields["form_fields"]:
        rects_and_fields.append(RectAndField(f["label_bounding_box"], "label", f))
        rects_and_fields.append(RectAndField(f["entry_bounding_box"], "entry", f))

    has_error = False
    for i, ri in enumerate(rects_and_fields):
        for j in range(i + 1, len(rects_and_fields)):
            rj = rects_and_fields[j]
            if ri.field["page_number"] == rj.field["page_number"] and rects_intersect(ri.rect, rj.rect):
                has_error = True
                if ri.field is rj.field:
                    messages.append(f"FAILURE: intersection between label and entry bounding boxes for \`{ri.field['description']}\` ({ri.rect}, {rj.rect})")
                else:
                    messages.append(f"FAILURE: intersection between {ri.rect_type} bounding box for \`{ri.field['description']}\` ({ri.rect}) and {rj.rect_type} bounding box for \`{rj.field['description']}\` ({rj.rect})")
                if len(messages) >= 20:
                    messages.append("Aborting further checks; fix bounding boxes and try again")
                    return messages
        if ri.rect_type == "entry":
            if "entry_text" in ri.field:
                font_size = ri.field["entry_text"].get("font_size", 14)
                entry_height = ri.rect[3] - ri.rect[1]
                if entry_height < font_size:
                    has_error = True
                    messages.append(f"FAILURE: entry bounding box height ({entry_height}) for \`{ri.field['description']}\` is too short for the text content (font size: {font_size}). Increase the box height or decrease the font size.")
                    if len(messages) >= 20:
                        messages.append("Aborting further checks; fix bounding boxes and try again")
                        return messages

    if not has_error:
        messages.append("SUCCESS: All bounding boxes are valid")
    return messages

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: check_bounding_boxes.py [fields.json]")
        sys.exit(1)
    with open(sys.argv[1]) as f:
        messages = get_bounding_box_messages(f)
    for msg in messages:
        print(msg)
`,
      },
      {
        path: `scripts/extract_form_field_info.py`,
        content: `import json
import sys

from pypdf import PdfReader




def get_full_annotation_field_id(annotation):
    components = []
    while annotation:
        field_name = annotation.get('/T')
        if field_name:
            components.append(field_name)
        annotation = annotation.get('/Parent')
    return ".".join(reversed(components)) if components else None


def make_field_dict(field, field_id):
    field_dict = {"field_id": field_id}
    ft = field.get('/FT')
    if ft == "/Tx":
        field_dict["type"] = "text"
    elif ft == "/Btn":
        field_dict["type"] = "checkbox"  
        states = field.get("/_States_", [])
        if len(states) == 2:
            if "/Off" in states:
                field_dict["checked_value"] = states[0] if states[0] != "/Off" else states[1]
                field_dict["unchecked_value"] = "/Off"
            else:
                print(f"Unexpected state values for checkbox \`\${field_id}\`. Its checked and unchecked values may not be correct; if you're trying to check it, visually verify the results.")
                field_dict["checked_value"] = states[0]
                field_dict["unchecked_value"] = states[1]
    elif ft == "/Ch":
        field_dict["type"] = "choice"
        states = field.get("/_States_", [])
        field_dict["choice_options"] = [{
            "value": state[0],
            "text": state[1],
        } for state in states]
    else:
        field_dict["type"] = f"unknown ({ft})"
    return field_dict


def get_field_info(reader: PdfReader):
    fields = reader.get_fields()

    field_info_by_id = {}
    possible_radio_names = set()

    for field_id, field in fields.items():
        if field.get("/Kids"):
            if field.get("/FT") == "/Btn":
                possible_radio_names.add(field_id)
            continue
        field_info_by_id[field_id] = make_field_dict(field, field_id)


    radio_fields_by_id = {}

    for page_index, page in enumerate(reader.pages):
        annotations = page.get('/Annots', [])
        for ann in annotations:
            field_id = get_full_annotation_field_id(ann)
            if field_id in field_info_by_id:
                field_info_by_id[field_id]["page"] = page_index + 1
                field_info_by_id[field_id]["rect"] = ann.get('/Rect')
            elif field_id in possible_radio_names:
                try:
                    on_values = [v for v in ann["/AP"]["/N"] if v != "/Off"]
                except KeyError:
                    continue
                if len(on_values) == 1:
                    rect = ann.get("/Rect")
                    if field_id not in radio_fields_by_id:
                        radio_fields_by_id[field_id] = {
                            "field_id": field_id,
                            "type": "radio_group",
                            "page": page_index + 1,
                            "radio_options": [],
                        }
                    radio_fields_by_id[field_id]["radio_options"].append({
                        "value": on_values[0],
                        "rect": rect,
                    })

    fields_with_location = []
    for field_info in field_info_by_id.values():
        if "page" in field_info:
            fields_with_location.append(field_info)
        else:
            print(f"Unable to determine location for field id: {field_info.get('field_id')}, ignoring")

    def sort_key(f):
        if "radio_options" in f:
            rect = f["radio_options"][0]["rect"] or [0, 0, 0, 0]
        else:
            rect = f.get("rect") or [0, 0, 0, 0]
        adjusted_position = [-rect[1], rect[0]]
        return [f.get("page"), adjusted_position]
    
    sorted_fields = fields_with_location + list(radio_fields_by_id.values())
    sorted_fields.sort(key=sort_key)

    return sorted_fields


def write_field_info(pdf_path: str, json_output_path: str):
    reader = PdfReader(pdf_path)
    field_info = get_field_info(reader)
    with open(json_output_path, "w") as f:
        json.dump(field_info, f, indent=2)
    print(f"Wrote {len(field_info)} fields to {json_output_path}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: extract_form_field_info.py [input pdf] [output json]")
        sys.exit(1)
    write_field_info(sys.argv[1], sys.argv[2])
`,
      },
      {
        path: `scripts/extract_form_structure.py`,
        content: `"""
Extract form structure from a non-fillable PDF.

This script analyzes the PDF to find:
- Text labels with their exact coordinates
- Horizontal lines (row boundaries)
- Checkboxes (small rectangles)

Output: A JSON file with the form structure that can be used to generate
accurate field coordinates for filling.

Usage: python extract_form_structure.py <input.pdf> <output.json>
"""

import json
import sys
import pdfplumber


def extract_form_structure(pdf_path):
    structure = {
        "pages": [],
        "labels": [],
        "lines": [],
        "checkboxes": [],
        "row_boundaries": []
    }

    with pdfplumber.open(pdf_path) as pdf:
        for page_num, page in enumerate(pdf.pages, 1):
            structure["pages"].append({
                "page_number": page_num,
                "width": float(page.width),
                "height": float(page.height)
            })

            words = page.extract_words()
            for word in words:
                structure["labels"].append({
                    "page": page_num,
                    "text": word["text"],
                    "x0": round(float(word["x0"]), 1),
                    "top": round(float(word["top"]), 1),
                    "x1": round(float(word["x1"]), 1),
                    "bottom": round(float(word["bottom"]), 1)
                })

            for line in page.lines:
                if abs(float(line["x1"]) - float(line["x0"])) > page.width * 0.5:
                    structure["lines"].append({
                        "page": page_num,
                        "y": round(float(line["top"]), 1),
                        "x0": round(float(line["x0"]), 1),
                        "x1": round(float(line["x1"]), 1)
                    })

            for rect in page.rects:
                width = float(rect["x1"]) - float(rect["x0"])
                height = float(rect["bottom"]) - float(rect["top"])
                if 5 <= width <= 15 and 5 <= height <= 15 and abs(width - height) < 2:
                    structure["checkboxes"].append({
                        "page": page_num,
                        "x0": round(float(rect["x0"]), 1),
                        "top": round(float(rect["top"]), 1),
                        "x1": round(float(rect["x1"]), 1),
                        "bottom": round(float(rect["bottom"]), 1),
                        "center_x": round((float(rect["x0"]) + float(rect["x1"])) / 2, 1),
                        "center_y": round((float(rect["top"]) + float(rect["bottom"])) / 2, 1)
                    })

    lines_by_page = {}
    for line in structure["lines"]:
        page = line["page"]
        if page not in lines_by_page:
            lines_by_page[page] = []
        lines_by_page[page].append(line["y"])

    for page, y_coords in lines_by_page.items():
        y_coords = sorted(set(y_coords))
        for i in range(len(y_coords) - 1):
            structure["row_boundaries"].append({
                "page": page,
                "row_top": y_coords[i],
                "row_bottom": y_coords[i + 1],
                "row_height": round(y_coords[i + 1] - y_coords[i], 1)
            })

    return structure


def main():
    if len(sys.argv) != 3:
        print("Usage: extract_form_structure.py <input.pdf> <output.json>")
        sys.exit(1)

    pdf_path = sys.argv[1]
    output_path = sys.argv[2]

    print(f"Extracting structure from {pdf_path}...")
    structure = extract_form_structure(pdf_path)

    with open(output_path, "w") as f:
        json.dump(structure, f, indent=2)

    print(f"Found:")
    print(f"  - {len(structure['pages'])} pages")
    print(f"  - {len(structure['labels'])} text labels")
    print(f"  - {len(structure['lines'])} horizontal lines")
    print(f"  - {len(structure['checkboxes'])} checkboxes")
    print(f"  - {len(structure['row_boundaries'])} row boundaries")
    print(f"Saved to {output_path}")


if __name__ == "__main__":
    main()
`,
      },
      {
        path: `scripts/fill_fillable_fields.py`,
        content: `import json
import sys

from pypdf import PdfReader, PdfWriter

from extract_form_field_info import get_field_info




def fill_pdf_fields(input_pdf_path: str, fields_json_path: str, output_pdf_path: str):
    with open(fields_json_path) as f:
        fields = json.load(f)
    fields_by_page = {}
    for field in fields:
        if "value" in field:
            field_id = field["field_id"]
            page = field["page"]
            if page not in fields_by_page:
                fields_by_page[page] = {}
            fields_by_page[page][field_id] = field["value"]
    
    reader = PdfReader(input_pdf_path)

    has_error = False
    field_info = get_field_info(reader)
    fields_by_ids = {f["field_id"]: f for f in field_info}
    for field in fields:
        existing_field = fields_by_ids.get(field["field_id"])
        if not existing_field:
            has_error = True
            print(f"ERROR: \`{field['field_id']}\` is not a valid field ID")
        elif field["page"] != existing_field["page"]:
            has_error = True
            print(f"ERROR: Incorrect page number for \`{field['field_id']}\` (got {field['page']}, expected {existing_field['page']})")
        else:
            if "value" in field:
                err = validation_error_for_field_value(existing_field, field["value"])
                if err:
                    print(err)
                    has_error = True
    if has_error:
        sys.exit(1)

    writer = PdfWriter(clone_from=reader)
    for page, field_values in fields_by_page.items():
        writer.update_page_form_field_values(writer.pages[page - 1], field_values, auto_regenerate=False)

    writer.set_need_appearances_writer(True)
    
    with open(output_pdf_path, "wb") as f:
        writer.write(f)


def validation_error_for_field_value(field_info, field_value):
    field_type = field_info["type"]
    field_id = field_info["field_id"]
    if field_type == "checkbox":
        checked_val = field_info["checked_value"]
        unchecked_val = field_info["unchecked_value"]
        if field_value != checked_val and field_value != unchecked_val:
            return f'ERROR: Invalid value "{field_value}" for checkbox field "{field_id}". The checked value is "{checked_val}" and the unchecked value is "{unchecked_val}"'
    elif field_type == "radio_group":
        option_values = [opt["value"] for opt in field_info["radio_options"]]
        if field_value not in option_values:
            return f'ERROR: Invalid value "{field_value}" for radio group field "{field_id}". Valid values are: {option_values}' 
    elif field_type == "choice":
        choice_values = [opt["value"] for opt in field_info["choice_options"]]
        if field_value not in choice_values:
            return f'ERROR: Invalid value "{field_value}" for choice field "{field_id}". Valid values are: {choice_values}'
    return None


def monkeypatch_pydpf_method():
    from pypdf.generic import DictionaryObject
    from pypdf.constants import FieldDictionaryAttributes

    original_get_inherited = DictionaryObject.get_inherited

    def patched_get_inherited(self, key: str, default = None):
        result = original_get_inherited(self, key, default)
        if key == FieldDictionaryAttributes.Opt:
            if isinstance(result, list) and all(isinstance(v, list) and len(v) == 2 for v in result):
                result = [r[0] for r in result]
        return result

    DictionaryObject.get_inherited = patched_get_inherited


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print("Usage: fill_fillable_fields.py [input pdf] [field_values.json] [output pdf]")
        sys.exit(1)
    monkeypatch_pydpf_method()
    input_pdf = sys.argv[1]
    fields_json = sys.argv[2]
    output_pdf = sys.argv[3]
    fill_pdf_fields(input_pdf, fields_json, output_pdf)
`,
      },
      {
        path: `scripts/fill_pdf_form_with_annotations.py`,
        content: `import json
import sys

from pypdf import PdfReader, PdfWriter
from pypdf.annotations import FreeText




def transform_from_image_coords(bbox, image_width, image_height, pdf_width, pdf_height):
    x_scale = pdf_width / image_width
    y_scale = pdf_height / image_height

    left = bbox[0] * x_scale
    right = bbox[2] * x_scale

    top = pdf_height - (bbox[1] * y_scale)
    bottom = pdf_height - (bbox[3] * y_scale)

    return left, bottom, right, top


def transform_from_pdf_coords(bbox, pdf_height):
    left = bbox[0]
    right = bbox[2]

    pypdf_top = pdf_height - bbox[1]      
    pypdf_bottom = pdf_height - bbox[3]   

    return left, pypdf_bottom, right, pypdf_top


def fill_pdf_form(input_pdf_path, fields_json_path, output_pdf_path):
    
    with open(fields_json_path, "r") as f:
        fields_data = json.load(f)
    
    reader = PdfReader(input_pdf_path)
    writer = PdfWriter()
    
    writer.append(reader)
    
    pdf_dimensions = {}
    for i, page in enumerate(reader.pages):
        mediabox = page.mediabox
        pdf_dimensions[i + 1] = [mediabox.width, mediabox.height]
    
    annotations = []
    for field in fields_data["form_fields"]:
        page_num = field["page_number"]

        page_info = next(p for p in fields_data["pages"] if p["page_number"] == page_num)
        pdf_width, pdf_height = pdf_dimensions[page_num]

        if "pdf_width" in page_info:
            transformed_entry_box = transform_from_pdf_coords(
                field["entry_bounding_box"],
                float(pdf_height)
            )
        else:
            image_width = page_info["image_width"]
            image_height = page_info["image_height"]
            transformed_entry_box = transform_from_image_coords(
                field["entry_bounding_box"],
                image_width, image_height,
                float(pdf_width), float(pdf_height)
            )
        
        if "entry_text" not in field or "text" not in field["entry_text"]:
            continue
        entry_text = field["entry_text"]
        text = entry_text["text"]
        if not text:
            continue
        
        font_name = entry_text.get("font", "Arial")
        font_size = str(entry_text.get("font_size", 14)) + "pt"
        font_color = entry_text.get("font_color", "000000")

        annotation = FreeText(
            text=text,
            rect=transformed_entry_box,
            font=font_name,
            font_size=font_size,
            font_color=font_color,
            border_color=None,
            background_color=None,
        )
        annotations.append(annotation)
        writer.add_annotation(page_number=page_num - 1, annotation=annotation)
        
    with open(output_pdf_path, "wb") as output:
        writer.write(output)
    
    print(f"Successfully filled PDF form and saved to {output_pdf_path}")
    print(f"Added {len(annotations)} text annotations")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print("Usage: fill_pdf_form_with_annotations.py [input pdf] [fields.json] [output pdf]")
        sys.exit(1)
    input_pdf = sys.argv[1]
    fields_json = sys.argv[2]
    output_pdf = sys.argv[3]
    
    fill_pdf_form(input_pdf, fields_json, output_pdf)
`,
      },
    ],
  },
];
