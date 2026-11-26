# Module 任务管理器 — MCP (Model Context Protocol) 服务

> 本服务遵循 Anthropic 标准 **Model Context Protocol (MCP)** 协议规范，通过 `stdio` 传输 JSON-RPC 2.0，为各类 AI Agent（如 Claude Desktop、Cursor、Antigravity、VS Code Copilot 等）提供对 **Module 任务管理器** 的双向智能调度能力。

---

## 🌟 核心特色：混合双模设计 (Hybrid Online/Offline)

1. **主程序运行中（在线模式）**：
   * MCP 服务通过 Windows 原生命名管道（`\\.\pipe\module-taskmanager-ipc`）与 Electron 主进程通信。
   * AI 创建、更新或完成任务时，主窗口与桌面悬浮挂件**毫秒级无感热刷新**，直观呈现最新状态。
2. **主程序未启动（离线模式）**：
   * MCP 服务独立加载 Node.js 数据引擎，直接读写本地数据库文件（`tasks-data.json`）。
   * 完整复用 `autoPlan` 向上工期传播、层级树校验与原子落盘机制。下次启动 Module，数据自动呈现。

---

## 🚀 客户端配置指南

### 1. Claude Desktop 配置

打开 Claude Desktop 配置文件：
* Windows: `%APPDATA%\Claude\claude_desktop_config.json`
* macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

在 `mcpServers` 节点中加入：

```json
{
  "mcpServers": {
    "module-taskmanager": {
      "command": "node",
      "args": [
        "D:\\onedrive\\Desktop\\工具库\\肥仔\\任务管理器\\mcp-server\\server.js"
      ]
    }
  }
}
```

### 2. Cursor / VS Code 配置

在项目根目录或全局设置中添加 MCP Server 配置：

```json
{
  "mcpServers": {
    "module-taskmanager": {
      "command": "node",
      "args": ["D:/onedrive/Desktop/工具库/肥仔/任务管理器/mcp-server/server.js"]
    }
  }
}
```

### 3. Antigravity 配置

在 Antigravity 的 MCP 设置中添加命令：
* **Server Name**: `module-taskmanager`
* **Command**: `node`
* **Arguments**: `["D:/onedrive/Desktop/工具库/肥仔/任务管理器/mcp-server/server.js"]`

---

## 🛠️ 提供的 MCP Tools 清单

| 工具名称 | 功能描述 | 核心参数示例 |
|---|---|---|
| `get_tasks` | 查询任务列表，支持状态/优先级/关键词/作用域过滤 | `status: "active"`, `priority: "p0"`, `keyword: "汇报"` |
| `get_task_tree` | 获取树形嵌套任务结构，直观呈现父子、孙子任务层级 | `activeOnly: true`, `scopeId: "..."` |
| `create_task` | 创建单个主任务或子任务（自动触发 autoPlan 向上计算工期） | `content: "设计方案评审"`, `deadline: "2026-11-05"`, `priority: "p0"` |
| `batch_create_tasks` | 批量创建任务，适合将大目标一次性拆解为多个子步骤 | `tasks: [{ content: "步骤1" }, { content: "步骤2" }]` |
| `update_task` | 更新任务的内容、起止工期、优先级或备注 | `id: "..."`, `content: "新标题"`, `priority: "p1"` |
| `complete_task` | 标记任务完成或取消完成重新激活 | `id: "..."`, `completed: true` |
| `delete_task` | 删除指定任务（自动级联删除子孙节点） | `id: "..."` |
| `get_deadline_buckets` | 获取截止时间分桶看板（逾期 overdue、今日 today、明日 tomorrow） | 无 |
| `get_gantt_data` | 获取甘特图时间轴排期数据 | 无 |
| `get_weekly_report` | 获取或生成指定周（如 `2026-W45`）的工作周报与时间足迹 | `weekId: "2026-W45"` |
| `manage_notes` | 随手记便签管理（支持 list / create / update / delete） | `action: "create"`, `content: "会议临时要点"` |

---

## 💻 命令行快速调试

在终端中可直接执行自动化测试套件：

```bash
npm run mcp        # 启动标准 stdio MCP 监听服务
node tests/_test_mcp_service.js  # 执行 14 项 MCP 端到端回归测试
```
