# Module — 轻量级桌面任务管理器 (v2.1.8)

> 如果你也在做项目或个人计划管理时，被「Project」和「Today」割裂的交互体验折腾得够呛，不妨试试 **Module**。
>
> 在主视窗中，你可以一目了然地看到每个任务的**子母层级结构**与 **DDL（截止日期）**，并直接通过**拖拽**调整任务的层级深度与排列顺序；同时支持一键呼出**桌面悬浮组件**常驻盯梢待办事项，随时随地快速记录任务与便签；还能一键生成**甘特图**与**工作周报**，让工作复盘与汇报更有条理。

基于 **Tauri 2.0 + Rust / System WebView2** 构建，安装包仅 **3.42 MB**，绿色便携包仅 **4.53 MB**，冷启动秒开、低内存占用，同时原生集成 **Model Context Protocol (MCP)** 服务（`module.exe --mcp` 零 Node.js 依赖），方便外部 AI Agent 直接读写与调度任务。

---

## 📦 下载与使用

前往本仓库的 [Releases 页面](https://github.com/luxp1990/Module/releases/tag/v2.1.8) 直接下载可用产物：

| 版本类型 | 文件名 | 体积 | 说明 |
| :--- | :--- | :--- | :--- |
| **安装版 (NSIS)** | `Module Setup 2.1.8.exe` | 3.42 MB | 标准 Windows 安装向导，支持桌面快捷方式与托盘常驻 |
| **绿色便携版 (ZIP)** | `Module-2.1.8-win.zip` | 4.53 MB | 解压即用，内含独立 `module.exe` |

---

## ✨ 核心特性

- **🌳 5 级子母任务结构**：支持 `主任务 → 子任务 → 孙任务 → 曾孙 → 玄孙` 严密层级，主视窗直接展示层级与 DDL，支持拖拽调整顺序与上下级缩进（拖到目标行下方可左右调整层级）。
- **📌 桌面悬浮组件 (`Widget`)**：无边框置顶小组件，常驻桌面盯梢近期与逾期任务，支持快速添加任务、记录便签以及深/浅色主题联动。
- **📊 交互式甘特图**：支持 50%~200% 多挡缩放、日/周/月/季时间标尺、条形图拖拽调期、Excel/图片导出。
- **⚡ 智能排期 (`autoPlan`)**：开启「跟随排期」后，子任务起止时间变更会自动向上同步修正母任务工期边界。
- **📰 自动工作周报**：按 ISO 周自动汇总完成事项与每日趋势，支持补充周报备注并导出汇报。
- **⌨️ 键盘大纲流**：支持 `↑`/`↓` 选中、`Enter` 编辑、`Space` 完成、`/` 搜索、`n` 底栏快速新建、`Ctrl+Z` 多步撤回。
- **🤖 原生 MCP 服务**：支持 `module.exe --mcp`（或 `npm run mcp`）接入 Claude Desktop / Cursor / Antigravity 等 AI 客户端。

---

## 🛠️ 从源码构建与测试

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

## 🤖 MCP 接入配置示例

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
