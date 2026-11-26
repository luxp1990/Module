use std::io::{self, BufRead, Write};
use std::sync::{Arc, Mutex};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use chrono::{Local, NaiveDate};

use crate::model::Task;
use crate::store::DataStore;

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct JsonRpcRequest {
    jsonrpc: String,
    id: Option<Value>,
    method: String,
    params: Option<Value>,
}

#[derive(Debug, Serialize)]
struct JsonRpcResponse {
    jsonrpc: String,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<Value>,
}

pub fn run_mcp_server(store: Arc<Mutex<DataStore>>) {
    let stdin = io::stdin();
    let mut stdout = io::stdout();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let req: JsonRpcRequest = match serde_json::from_str(line) {
            Ok(r) => r,
            Err(e) => {
                let err_res = json!({
                    "jsonrpc": "2.0",
                    "id": null,
                    "error": { "code": -32700, "message": format!("Parse error: {}", e) }
                });
                let _ = writeln!(stdout, "{}", err_res);
                let _ = stdout.flush();
                continue;
            }
        };

        if req.method == "notifications/initialized" {
            continue;
        }

        let id = req.id.unwrap_or(Value::Null);

        match req.method.as_str() {
            "initialize" => {
                let res = JsonRpcResponse {
                    jsonrpc: "2.0".to_string(),
                    id,
                    result: Some(json!({
                        "protocolVersion": "2024-11-05",
                        "capabilities": {
                            "tools": {}
                        },
                        "serverInfo": {
                            "name": "Module-MCP-Server",
                            "version": env!("CARGO_PKG_VERSION")
                        }
                    })),
                    error: None,
                };
                let _ = writeln!(stdout, "{}", serde_json::to_string(&res).unwrap());
                let _ = stdout.flush();
            }
            "tools/list" => {
                let tools = get_tools_list();
                let res = JsonRpcResponse {
                    jsonrpc: "2.0".to_string(),
                    id,
                    result: Some(json!({ "tools": tools })),
                    error: None,
                };
                let _ = writeln!(stdout, "{}", serde_json::to_string(&res).unwrap());
                let _ = stdout.flush();
            }
            "tools/call" => {
                let params = req.params.unwrap_or(Value::Null);
                let tool_name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let arguments = params.get("arguments").cloned().unwrap_or(json!({}));

                let mut s = store.lock().unwrap();
                // Each request sees external changes; save still rejects a concurrent race.
                match s.refresh_from_disk().and_then(|()| execute_tool(&mut s, tool_name, arguments)) {
                    Ok(val) => {
                        let text = serde_json::to_string_pretty(&val).unwrap_or_default();
                        let res = JsonRpcResponse {
                            jsonrpc: "2.0".to_string(),
                            id,
                            result: Some(json!({
                                "content": [
                                    { "type": "text", "text": text }
                                ]
                            })),
                            error: None,
                        };
                        let _ = writeln!(stdout, "{}", serde_json::to_string(&res).unwrap());
                        let _ = stdout.flush();
                    }
                    Err(err) => {
                        let res = JsonRpcResponse {
                            jsonrpc: "2.0".to_string(),
                            id,
                            result: Some(json!({
                                "isError": true,
                                "content": [
                                    { "type": "text", "text": format!("Error: {}", err) }
                                ]
                            })),
                            error: None,
                        };
                        let _ = writeln!(stdout, "{}", serde_json::to_string(&res).unwrap());
                        let _ = stdout.flush();
                    }
                }
            }
            _ => {
                let res = JsonRpcResponse {
                    jsonrpc: "2.0".to_string(),
                    id,
                    result: None,
                    error: Some(json!({
                        "code": -32601,
                        "message": format!("Method not found: {}", req.method)
                    })),
                };
                let _ = writeln!(stdout, "{}", serde_json::to_string(&res).unwrap());
                let _ = stdout.flush();
            }
        }
    }
}

fn get_tools_list() -> Value {
    json!([
        {
            "name": "get_tasks",
            "description": "查询任务列表，支持按完成状态、优先级、父任务、关键词过滤以及数量限制。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "status": { "type": "string", "enum": ["active", "completed", "all"] },
                    "priority": { "type": "string", "enum": ["p0", "p1", "p2"] },
                    "parentId": { "type": "string" },
                    "keyword": { "type": "string" },
                    "limit": { "type": "integer" }
                }
            }
        },
        {
            "name": "get_task_tree",
            "description": "以递归多叉树结构获取当前全部活动任务层级树。",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "create_task",
            "description": "创建新任务，支持指定母任务ID、开始/截止日期、优先级、备注等。",
            "inputSchema": {
                "type": "object",
                "required": ["content"],
                "properties": {
                    "content": { "type": "string" },
                    "parentId": { "type": "string" },
                    "startDate": { "type": "string" },
                    "deadline": { "type": "string" },
                    "priority": { "type": "string" },
                    "notes": { "type": "string" }
                }
            }
        },
        {
            "name": "batch_create_tasks",
            "description": "批量创建多个任务，常用于拆解项目生成多条子任务。",
            "inputSchema": {
                "type": "object",
                "required": ["tasks"],
                "properties": { "tasks": { "type": "array" } }
            }
        },
        {
            "name": "update_task",
            "description": "更新指定任务的信息（标题、时间、优先级、归属母任务、备注等）。",
            "inputSchema": {
                "type": "object",
                "required": ["id"],
                "properties": { "id": { "type": "string" }, "updates": { "type": "object" } }
            }
        },
        {
            "name": "complete_task",
            "description": "完成指定任务，并级联将其名下所有活跃子任务一并标记完成。",
            "inputSchema": {
                "type": "object",
                "required": ["id"],
                "properties": { "id": { "type": "string" } }
            }
        },
        {
            "name": "delete_task",
            "description": "删除指定任务及其所有子孙后代任务。",
            "inputSchema": {
                "type": "object",
                "required": ["id"],
                "properties": { "id": { "type": "string" } }
            }
        },
        {
            "name": "get_deadline_buckets",
            "description": "按到期时间桶分类统计待办任务：已逾期、今天、明天、本周、下周、未来、无截止日。",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "get_gantt_data",
            "description": "获取用于甘特图呈现的任务条目与DFS树序结构。",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "get_weekly_report",
            "description": "获取或生成指定 ISO 周报（例如 2026-W45），缺省时自动计算本周。",
            "inputSchema": {
                "type": "object",
                "properties": { "weekId": { "type": "string" } }
            }
        },
        {
            "name": "manage_notes",
            "description": "备忘录/便签管理工具，支持 list / create / update / delete。",
            "inputSchema": {
                "type": "object",
                "required": ["action"],
                "properties": {
                    "action": { "type": "string", "enum": ["list", "create", "update", "delete"] },
                    "id": { "type": "string" },
                    "content": { "type": "string" },
                    "color": { "type": "string" },
                    "pinned": { "type": "boolean" }
                }
            }
        }
    ])
}

fn execute_tool(store: &mut DataStore, name: &str, args: Value) -> Result<Value, String> {
    match name {
        "get_tasks" => {
            let status = args.get("status").and_then(|v| v.as_str()).unwrap_or("active");
            let keyword = args.get("keyword").and_then(|v| v.as_str());
            let priority = args.get("priority").and_then(|v| v.as_str());
            let parent_id = args.get("parentId").and_then(|v| v.as_str());
            let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(50) as usize;

            let mut tasks: Vec<Task> = match status {
                "completed" => store.get_completed_tasks(),
                "all" => store.get_all_tasks(),
                _ => store.get_active_tasks(),
            };

            if let Some(kw) = keyword {
                let kw_lower = kw.to_lowercase();
                tasks.retain(|t| {
                    t.content.to_lowercase().contains(&kw_lower)
                        || t.notes.as_ref().map(|n| n.to_lowercase().contains(&kw_lower)).unwrap_or(false)
                });
            }

            if let Some(p) = priority {
                tasks.retain(|t| t.priority.as_deref() == Some(p));
            }

            if let Some(pid) = parent_id {
                if pid == "root" {
                    tasks.retain(|t| t.parent_id.is_none());
                } else {
                    tasks.retain(|t| t.parent_id.as_deref() == Some(pid));
                }
            }

            tasks.truncate(limit);
            Ok(json!({ "total": tasks.len(), "tasks": tasks }))
        }
        "get_task_tree" => {
            let active = store.get_active_tasks();
            let mut roots = Vec::new();
            for t in &active {
                if t.parent_id.is_none() {
                    roots.push(build_tree_node(t, &active));
                }
            }
            Ok(json!({ "tree": roots }))
        }
        "create_task" => {
            let content = args.get("content").and_then(|v| v.as_str()).ok_or("content is required")?;
            let task = Task {
                id: String::new(),
                content: content.to_string(),
                deadline: args.get("deadline").and_then(|v| v.as_str()).map(|s| s.to_string()),
                start_date: args.get("startDate").and_then(|v| v.as_str()).map(|s| s.to_string()),
                notes: args.get("notes").and_then(|v| v.as_str()).map(|s| s.to_string()),
                priority: args.get("priority").and_then(|v| v.as_str()).map(|s| s.to_string()),
                status: None,
                parent_id: args.get("parentId").and_then(|v| v.as_str()).map(|s| s.to_string()),
                order: None,
                completed: false,
                completed_at: None,
                created_at: None,
                updated_at: None,
                extra: std::collections::HashMap::new(),
            };
            let created = store.create_task(task)?;
            Ok(json!(created))
        }
        "batch_create_tasks" => {
            let arr = args.get("tasks").and_then(|v| v.as_array()).ok_or("tasks array is required")?;
            let mut to_create = Vec::new();
            for item in arr {
                let t: Task = serde_json::from_value(item.clone()).map_err(|e| e.to_string())?;
                to_create.push(t);
            }
            let res = store.batch_create_tasks(to_create)?;
            Ok(json!({ "createdCount": res.len(), "tasks": res }))
        }
        "update_task" => {
            let id = args.get("id").and_then(|v| v.as_str()).ok_or("id is required")?;
            let updates = args.get("updates").cloned().unwrap_or(args.clone());
            let updated = store.update_task(id, updates)?;
            Ok(json!(updated))
        }
        "complete_task" => {
            let id = args.get("id").and_then(|v| v.as_str()).ok_or("id is required")?;
            let (target, affected) = store.complete_task(id)?;
            Ok(json!({ "task": target, "affectedDescendants": affected.len() }))
        }
        "delete_task" => {
            let id = args.get("id").and_then(|v| v.as_str()).ok_or("id is required")?;
            let deleted = store.delete_task(id)?;
            Ok(json!({ "deletedIds": deleted, "count": deleted.len() }))
        }
        "get_deadline_buckets" => {
            let active = store.get_active_tasks();
            let today = Local::now().naive_local().date();

            let mut overdue = Vec::new();
            let mut today_tasks = Vec::new();
            let mut tomorrow_tasks = Vec::new();
            let mut this_week = Vec::new();
            let mut next_week = Vec::new();
            let mut future = Vec::new();
            let mut no_date = Vec::new();

            for t in active {
                if let Some(ref dl_str) = t.deadline {
                    if let Ok(dl_date) = NaiveDate::parse_from_str(dl_str, "%Y-%m-%d") {
                        let diff = (dl_date - today).num_days();
                        if diff < 0 {
                            overdue.push(t);
                        } else if diff == 0 {
                            today_tasks.push(t);
                        } else if diff == 1 {
                            tomorrow_tasks.push(t);
                        } else if diff <= 7 {
                            this_week.push(t);
                        } else if diff <= 14 {
                            next_week.push(t);
                        } else {
                            future.push(t);
                        }
                    } else {
                        no_date.push(t);
                    }
                } else {
                    no_date.push(t);
                }
            }

            Ok(json!({
                "overdue": overdue,
                "today": today_tasks,
                "tomorrow": tomorrow_tasks,
                "thisWeek": this_week,
                "nextWeek": next_week,
                "future": future,
                "noDate": no_date
            }))
        }
        "get_gantt_data" => {
            let data = store.get_gantt_data();
            Ok(json!(data))
        }
        "get_weekly_report" => {
            let week_id = args.get("weekId").and_then(|v| v.as_str()).map(|s| s.to_string())
                .unwrap_or_else(DataStore::current_week_id);

            if let Some(report) = store.get_report(&week_id) {
                Ok(json!(report))
            } else {
                let rep = store.generate_report(&week_id)?;
                Ok(json!(rep))
            }
        }
        "manage_notes" => {
            let action = args.get("action").and_then(|v| v.as_str()).unwrap_or("list");
            match action {
                "list" => {
                    let notes = store.get_notes();
                    Ok(json!({ "total": notes.len(), "notes": notes }))
                }
                "create" => {
                    let note = store.create_note(args)?;
                    Ok(json!(note))
                }
                "update" => {
                    let id = args.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()).ok_or("id is required")?;
                    let note = store.update_note(&id, args)?;
                    Ok(json!(note))
                }
                "delete" => {
                    let id = args.get("id").and_then(|v| v.as_str()).ok_or("id is required")?;
                    let res = store.delete_note(id)?;
                    Ok(json!({ "success": res }))
                }
                _ => Err(format!("Unknown action: {}", action)),
            }
        }
        _ => Err(format!("Unknown tool: {}", name)),
    }
}

fn build_tree_node(task: &Task, all_tasks: &[Task]) -> Value {
    let children: Vec<Value> = all_tasks.iter()
        .filter(|t| t.parent_id.as_deref() == Some(&task.id))
        .map(|c| build_tree_node(c, all_tasks))
        .collect();

    json!({
        "id": task.id,
        "content": task.content,
        "deadline": task.deadline,
        "startDate": task.start_date,
        "priority": task.priority,
        "notes": task.notes,
        "children": children
    })
}
