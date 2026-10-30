# Agent Collaboration · 协同作战室

一个**群聊式多智能体协同系统**：用户在一个作战室里 @ 成员派活，主智能体与子成员在同一个群聊中协作、汇报，所有过程、任务与文件都可观察。

本项目是一套自研的轻量 TypeScript 运行时（Node + Express + React），核心调度、上下文预算、记忆检索，以及部分健壮性机制深度参考并移植自 OpenClaw（MIT，相关文件保留版权声明）。

当前版本：**v1.0.0**

## 功能特性

- **群聊式协同**：主智能体负责拆解与分派，成员以 @ 提及接收任务，完成后在群里汇报并唤醒上级汇总；运行状态通过 SSE 实时推送。
- **双模式协同**：标题栏可在「委派」与「自由交流」间一键切换。委派模式由主智能体拆解分派、成员只对分内任务汇报；自由交流模式允许成员直接 @ 彼此讨论，讨论安静后由主智能体统一收集并总结。模式随房间持久化。
- **每用户独立房间**：管理员创建账号，每个账号拥有独立的作战室、成员、任务、设置与文件工作区，数据互不可见。
- **任务看板**：任务卡由智能体创建、更新与登记产出；右侧面板可在「任务 / 文件」间切换。
- **文件工作区**：上传、下载、预览、删除与多级目录导航；用户与智能体共用同一 `files/` 目录，智能体通过 `file_list` / `file_read` / `file_write` 读写成果。
- **技能库**：共享技能与个人技能，支持从 `SKILL.md` 导入；按 9 个分类（协同与规划、调研与写作、数据分析、开发与测试、产品与文档、设计与可视化、网页与检索、智能体与技能、其他）自动归类，可按分类筛选、按关键词搜索并按分类分组展示；可为每个成员单独勾选允许使用的技能。
- **智能体文件**：每个成员拥有 `MEMORY.md` / `USER.md` / `SOUL.md` / `IDENTITY.md`，可在右侧面板直接编辑保存。
- **命令执行**：智能体可用 `run_command` 在文件工作区内运行 Python / Node / Shell 等命令，用 `run_skill_script` 执行技能附带的脚本（自动展开技能文件、参数不经 shell）；默认 30 秒超时、输出截断 32 KB。
- **联网工具**：内置 `web_search` / `web_fetch`（含 SSRF 防护、正文转 Markdown、长度截断与续读），并预装对应内置技能。
- **斜杠命令**：`/help`、`/clear`、`/stop`、`/status`、`/context` 全部在浏览器本地执行，不进入聊天记录；输入 `/` 会给出命令提示，支持 ↑↓ / Tab / Enter / Esc。
- **运行可靠性**：单次运行步数用尽时自动基于已有进展收尾而非整轮报错；工具调用去重、失败重试、上下文预算与自动压缩、工作记忆检索。

## 快速开始

要求 Node.js 20+（推荐 22/24）、npm 9+。

```bash
npm run check:env   # 安装环境自检（无需 node_modules 即可运行）
npm install
npm run web:build   # 构建 Web 静态资源到 web/dist
npm start           # 启动服务：http://127.0.0.1:8788
```

首次打开页面会引导创建管理员账号；登录后即进入自己的作战室。服务默认只监听 `127.0.0.1`，可用 `PORT` 环境变量修改端口。

### 开发模式

```bash
npm run dev        # 后端，tsx watch，8788
npm run web:dev    # 前端，Vite，5274，/api 代理到 8788
```

> 后端代码改动需要重启服务；仅前端改动执行 `npm run web:build` 后刷新页面即可。

### 环境检查

在另一台机器上部署时，先运行：

```bash
npm run check:env
```

脚本只使用 Node 内置模块，`npm install` 之前也能运行。它会检查 Node/npm 版本、源码是否完整、项目目录与 `data/` 是否可写、磁盘空间、依赖是否装齐、`web/dist` 是否已构建、npm 源连通性、Python 3（可选）以及默认端口占用。退出码 `0` 表示可以安装/运行，`1` 表示存在阻断问题。

- 离线或使用本地缓存安装：`npm run check:env -- --offline`（跳过 npm 源检查）
- 供脚本/CI 读取：`npm run check:env -- --json`

## 配置模型

进入「设置 → 模型设置」添加 OpenAI 兼容 Provider，填写 `baseUrl`、`model` 与 API Key。默认带有：

- `demo`：`mock` Provider，无需密钥，用于本地演示
- `deepseek`：`https://api.deepseek.com/v1` + `deepseek-chat`，填入密钥即可使用

API Key 只保存在本机 `data/workspaces/<userId>/settings.json`，不会写入仓库。

## 目录结构

```
src/
  server/       Express 服务入口、路由与 SSE
  auth/         账号、密码哈希、会话与登录限流
  workspace/    每用户工作区装配（总线、看板、编排器、记忆、文件）
  room/         群聊消息总线、@ 提及解析、成员唤醒
  agent/        成员运行时、编排器、工具注册、提示词
    loop/       模型循环（工具修复、重试、重复调用保护）
    context/    上下文预算与自动压缩
    spawn/      成员准入、层级与限额
  skills/       技能库、内置技能、SKILL.md 导入
  memory/       记忆索引、混合检索、召回与记忆工具
  files/        文件工作区（路径校验、预览、上传下载）
  web/          web_search / web_fetch 与 SSRF 防护
  workboard/    任务看板
  store/        JSON 持久化
web/            React 前端（群聊、看板、技能库、设置）
test/           Vitest 测试
```

## 测试与检查

```bash
npm test              # 完整测试套件（Vitest）
npm run typecheck     # 服务端类型检查
npm run typecheck:web # 前端类型检查
```

## 数据与安全

- `data/` 为运行时数据（账号、会话、技能库、各用户工作区），已在 `.gitignore` 中忽略，请勿提交。
- 密码使用 scrypt 加盐哈希；会话令牌只存哈希；登录失败限流；退出与改密会注销其他会话。
- 文件工作区与智能体文件接口均做路径归一化与越界校验，符号链接不跟随。
- 命令执行与联网抓取受同一工作区约束：命令的 cwd 只能位于 `files/`，子进程不继承 `*KEY*` / `*TOKEN*` / `*SECRET*` 等密钥类环境变量；命令仍以服务进程权限运行，请勿将其暴露到不受信任网络。
- 联网抓取限制为 http(s)、逐跳校验重定向并阻断内网/回环等地址。
