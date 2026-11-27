# Module — 轻量级桌面任务管理器 / Lightweight Desktop Task Manager (v2.1.8)

[中文说明](#中文说明) | [English](#english)

---

<a id="中文说明"></a>

> 如果你也在做项目或个人计划管理时，被 **Project** 和 **Today（To Do）** 糟糕的交互逼疯，不妨试试 **Module**。

### 💡 为什么要写这个软件？

在自己管项目、拆计划的时候，市面上的工具用起来总觉得哪里不对劲：

- **用 Project？** 太重、太笨、学习成本高，改个任务层级和排期像在填报大型工程报表，平时随手拆个需求、调个顺序根本懒得打开。
- **用 Today / 传统待办？** 扁平得像一张购物清单——任务一多就全糊在一起，既看不出谁是谁的子任务，也一眼扫不到全局的 DDL，想整理一下优先级和归属得来回切视图、点无数次详情。

于是干脆自己做了 **Module** —— 只保留真正顺手的交互：

- **主视窗直接看清一切**：每个任务的**子母层级结构**和 **DDL（截止日期）** 一目了然，想调整顺序或改变上下级归属，**直接拖拽**就行。
- **桌面悬浮组件常驻盯梢**：一键呼出置顶小组件挂在桌面上，随时盯着待办事项，顺手记任务、记便签，不打断当前工作流。
- **AI 辅助复盘与拆解（自带 API）**：支持填写自己的 **OpenAI / DeepSeek / Gemini / Claude / 本地 Ollama** 等接口，一键生成**周报总结**、从**便签提取待办任务**或**拆解子任务**，并支持**自定义编辑 Prompt**。

基于 **Tauri 2.0 + Rust / System WebView2** 构建，冷启动秒开、低内存占用，支持**简体中文 / English**（默认跟随系统），同时原生集成 **Model Context Protocol (MCP)** 服务（`module.exe --mcp` 零 Node.js 依赖）。

---

### 📦 下载与使用

前往本仓库的 [Releases 页面](https://github.com/luxp1990/Module/releases) 直接下载可用产物：

| 版本类型 | 文件名 | 说明 |
| :--- | :--- | :--- |
| **安装版 (NSIS)** | `Module Setup 2.1.8.exe` | 标准 Windows 安装向导，支持桌面快捷方式与托盘常驻 |
| **绿色便携版 (ZIP)** | `Module-2.1.8-win.zip` | 解压即用，内含独立 `module.exe` |

---

### ✨ 核心特性

- **🤖 AI 助手（自有 API 驱动）**：
  - **多服务商接入与本地安全存储**：支持 OpenAI、DeepSeek、Gemini、Anthropic Claude、硅基流动、通义千问、Kimi、智谱 GLM、Ollama 本地模型及自定义 OpenAI 兼容接口；支持在线拉取模型列表；API Key 通过 Windows DPAPI 加密存储在本地，不随数据备份导出。
  - **AI 周报总结**：根据每周完成记录与备注一键生成周报总结，支持 Markdown 预览/编辑、纯文本复制，以及安全追加/替换到周报备注。
  - **AI 便签提取待办**：从备忘录中自动识别行动项、优先级与相对日期，预览确认归属项目后批量创建任务并关联来源便签。
  - **AI 任务拆解**：根据任务名称、描述与必填数量上限生成子任务建议（无拆解意义时不强行拆解）。
  - **自定义 Prompt**：设置页提供默认折叠的高级 Prompt 编辑区，支持微调三个场景的提示词与一键恢复默认（后端自动锁定 JSON 输出结构，防止误改破坏解析）。
- **🌐 中英文双语界面**：默认跟随系统语言（非中文环境自动切换英文），也可在设置中手动指定简体中文或 English，支持全窗口与系统托盘即时热切换。
- **🌳 5 级子母任务结构**：支持 `主任务 → 子任务 → 孙任务 → 曾孙 → 玄孙` 严密层级，主视窗直接展示层级与 DDL，支持拖拽调整顺序与上下级缩进。
- **📌 桌面悬浮组件 (`Widget`)**：无边框置顶小组件，常驻桌面盯梢近期与逾期任务，支持快速添加任务、记录便签以及深/浅色主题联动。
- **📊 交互式甘特图**：支持 50%~200% 多挡缩放、冻结左侧任务名列、日/周/月/季时间标尺、条形图拖拽调期、Excel/CSV/PNG/SVG 导出。
- **⚡ 智能排期 (`autoPlan`)**：开启「跟随排期」后，子任务起止时间变更会自动向上同步修正母任务工期边界。
- **📰 自动工作周报**：按 ISO 周自动汇总完成事项与每日趋势，支持补充周报备注并导出汇报。
- **⌨️ 键盘大纲流**：支持 `↑`/`↓` 选中、`Enter` 编辑、`Space` 完成、`/` 搜索、`n` 底栏快速新建、`Ctrl+Z` 多步撤回。
- **🔌 原生 MCP 服务**：支持 `module.exe --mcp`（或 `npm run mcp`）接入 Claude Desktop / Cursor / Antigravity 等 AI 客户端。

---

### 🛠️ 从源码构建与测试

```bash
# 安装依赖
npm install

# 开发模式启动 Tauri
npm run tauri:dev

# 编译 Release .exe 与 NSIS 安装包
npm run tauri:build

# 打包安装版与绿色 zip 到 dist/
node scripts/package-dist.js

# 运行全量审计测试（JS 回归/兼容 + UI 启动 + Rust 单元测试）
npm run test:audit
```

---

### 🤖 MCP 接入配置示例

```json
{
  "mcpServers": {
    "module-taskmanager": {
      "command": "C:\\Path\\To\\module.exe",
      "args": ["--mcp"]
    }
  }
}
```

---

<a id="english"></a>

## Module — Lightweight Desktop Task Manager (English)

> Tired of **Microsoft Project** being too heavy and **To Do** being too flat? **Module** keeps only the interactions that actually feel good in daily project planning.

### 💡 Why Module?

- **Hierarchy & Deadlines at a Glance**: View multi-level parent/child tasks (up to 5 levels) and deadlines in one clean outline. Drag and drop to reorder or re-indent tasks effortlessly.
- **Always-on-Top Desktop Widget**: Summon a borderless desktop sticky widget to track upcoming/overdue tasks, jot down quick notes, and add tasks without breaking your flow.
- **AI-Powered Weekly Reports & Note-to-Task Extraction (BYO API)**: Connect your own **OpenAI, DeepSeek, Gemini, Claude, Ollama**, or any OpenAI-compatible API to generate **weekly report summaries**, **extract tasks from notes**, and **break down tasks**—with **customizable Prompts** in Settings.

Built with **Tauri 2.0 + Rust / System WebView2** for instant cold starts and low memory usage, featuring **English / 简体中文** localization (auto-detecting system locale by default) and a built-in **Model Context Protocol (MCP)** server (`module.exe --mcp`, zero Node.js dependency).

---

### ✨ Key Features

- **🤖 AI Assistant (Bring Your Own API)**:
  - **Multi-Provider & Secure Local Storage**: Supports OpenAI, DeepSeek, Google Gemini, Anthropic Claude, SiliconFlow, Qwen, Moonshot (Kimi), Zhipu GLM, local Ollama, and custom OpenAI-compatible endpoints, with live model fetching. API keys are encrypted locally via Windows DPAPI and excluded from data exports.
  - **AI Weekly Report Summary**: Summarize completed tasks and notes into a structured weekly report with Markdown preview/edit, plain-text copy, and safe append/replace options.
  - **AI Notes-to-Tasks**: Extract actionable tasks (including priority and relative dates) from notes, review/assign a target project, and batch-create them with source note tracking.
  - **AI Task Breakdown**: Decompose tasks into subtasks using task title, description, and a required max-task limit.
  - **Customizable Prompts**: Collapsible advanced prompt editor in Settings for all three AI workflows (with one-click Reset to Default and backend-locked JSON output schemas).
- **🌐 Bilingual UI (`en-US` / `zh-CN`)**: Follows your OS language by default (non-Chinese systems default to English) or can be manually overridden in Settings with live cross-window and tray sync.
- **🌳 5-Level Task Hierarchy & `autoPlan`**: Drag-and-drop reordering and indentation, plus optional `autoPlan` to automatically roll up child date bounds to parent tasks.
- **📊 Interactive Gantt Chart**: Frozen left task-name column, 50%–200% zoom, day/week/month/quarter scales, drag-to-reschedule bars, and Excel/CSV/PNG/SVG export.
- **📰 Automatic Weekly Reports & Notes**: ISO-week progress tracking, daily completion charts, pinned color-coded notes, and multi-step Undo (`Ctrl+Z`).
- **🔌 Native MCP Server**: Run `module.exe --mcp` to connect Claude Desktop, Cursor, or Antigravity directly to your tasks and notes.
