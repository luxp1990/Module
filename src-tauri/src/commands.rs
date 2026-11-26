use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use serde::Deserialize;
use serde_json::{json, Value};
use chrono::Local;

use crate::model::*;
use crate::store::DataStore;

pub type AppState = Arc<Mutex<DataStore>>;

pub fn broadcast(app: &AppHandle, patch: Value) {
    let payload = json!({
        "source": "peer",
        "patch": patch
    });
    let _ = app.emit("data-changed", payload);
}

// The initiating window reloads after invoke resolves. Only peers receive the event.
fn broadcast_from(app: &AppHandle, sender: &tauri::Window, mut patch: Value) {
    // Task writes can change descendants and auto-planned ancestors as well as the target.
    if patch["action"].as_str().is_some_and(|action| action.starts_with("TASK")) {
        patch["reloadTasks"] = json!(true);
    }
    let payload = json!({ "source": "peer", "patch": patch });
    for (label, _) in app.webview_windows() {
        if label != sender.label() { let _ = app.emit_to(label, "data-changed", payload.clone()); }
    }
}

#[tauri::command]
pub fn window_hide(window: tauri::Window) -> Result<(), String> {
    if window.label() == "widget" {
        flush_widget_bounds_for_window(&window);
    }
    window.hide().map_err(|e| e.to_string())
}

// ==================== Tasks ====================
#[tauri::command]
pub fn tasks_get_all(state: State<AppState>) -> Result<Vec<Task>, String> {
    let mut store = state.lock().unwrap();
    store.refresh_from_disk()?;
    Ok(store.get_all_tasks())
}

#[tauri::command]
pub fn tasks_get_active(state: State<AppState>) -> Result<Vec<Task>, String> {
    let mut store = state.lock().unwrap();
    store.refresh_from_disk()?;
    Ok(store.get_active_tasks())
}

#[tauri::command]
pub fn tasks_get_completed(state: State<AppState>) -> Result<Vec<Task>, String> {
    let mut store = state.lock().unwrap();
    store.refresh_from_disk()?;
    Ok(store.get_completed_tasks())
}

#[tauri::command]
pub fn tasks_create(app: AppHandle, window: tauri::Window, state: State<AppState>, task: Task) -> Result<Task, String> {
    let res = {
        let mut store = state.lock().unwrap();
        store.create_task(task)?
    };
    broadcast_from(&app, &window, json!({ "action": "TASK_CREATED", "payload": res }));
    Ok(res)
}

#[tauri::command]
pub fn tasks_batch_create(app: AppHandle, window: tauri::Window, state: State<AppState>, tasks: Vec<Task>) -> Result<Vec<Task>, String> {
    let res = {
        let mut store = state.lock().unwrap();
        store.batch_create_tasks(tasks)?
    };
    broadcast_from(&app, &window, json!({ "action": "TASKS_BATCH_CREATED" }));
    Ok(res)
}

#[tauri::command]
pub fn tasks_update(app: AppHandle, window: tauri::Window, state: State<AppState>, id: String, updates: Value) -> Result<Task, String> {
    let res = {
        let mut store = state.lock().unwrap();
        store.update_task(&id, updates)?
    };
    broadcast_from(&app, &window, json!({ "action": "TASK_UPDATED", "id": id, "payload": res }));
    Ok(res)
}

#[tauri::command]
pub fn tasks_delete(app: AppHandle, window: tauri::Window, state: State<AppState>, id: String) -> Result<Value, String> {
    let res = {
        let mut store = state.lock().unwrap();
        store.delete_task(&id)?
    };
    let payload = json!({ "deleted": res.clone(), "promoted": [], "promotedTasks": [] });
    broadcast_from(&app, &window, json!({ "action": "TASK_DELETED", "id": id, "payload": payload.clone() }));
    Ok(payload)
}

#[tauri::command]
pub fn tasks_complete(app: AppHandle, window: tauri::Window, state: State<AppState>, id: String) -> Result<Vec<Task>, String> {
    let mut store = state.lock().unwrap();
    let (target, affected) = store.complete_task(&id)?;
    let mut all_completed = vec![target];
    all_completed.extend(affected);
    let ids: Vec<String> = all_completed.iter().map(|t| t.id.clone()).collect();
    drop(store);
    broadcast_from(&app, &window, json!({ "action": "TASK_COMPLETED", "id": id, "payload": { "ids": ids } }));
    Ok(all_completed)
}

#[tauri::command]
pub fn tasks_uncomplete(app: AppHandle, window: tauri::Window, state: State<AppState>, id: String) -> Result<Task, String> {
    let mut store = state.lock().unwrap();
    let res = store.uncomplete_task(&id)?;
    drop(store);
    broadcast_from(&app, &window, json!({ "action": "TASK_UNCOMPLETED", "id": id, "payload": res }));
    Ok(res)
}

#[tauri::command]
pub fn tasks_batch_complete(app: AppHandle, window: tauri::Window, state: State<AppState>, ids: Vec<String>) -> Result<Vec<String>, String> {
    let mut store = state.lock().unwrap();
    let res = store.batch_complete_tasks(ids.clone())?;
    drop(store);
    broadcast_from(&app, &window, json!({ "action": "TASKS_BATCH_COMPLETED", "ids": ids }));
    Ok(res)
}

#[tauri::command]
pub fn tasks_batch_uncomplete(app: AppHandle, window: tauri::Window, state: State<AppState>, ids: Vec<String>) -> Result<Vec<String>, String> {
    let mut store = state.lock().unwrap();
    let res = store.batch_uncomplete_tasks(ids.clone())?;
    drop(store);
    broadcast_from(&app, &window, json!({ "action": "TASKS_BATCH_UNCOMPLETED", "ids": ids }));
    Ok(res)
}

#[tauri::command]
pub fn tasks_batch_delete(app: AppHandle, window: tauri::Window, state: State<AppState>, ids: Vec<String>) -> Result<usize, String> {
    let mut store = state.lock().unwrap();
    let count = store.batch_delete_tasks(ids.clone())?;
    drop(store);
    broadcast_from(&app, &window, json!({ "action": "TASKS_BATCH_DELETED", "ids": ids }));
    Ok(count)
}

#[tauri::command]
pub fn tasks_batch_set_priority(app: AppHandle, window: tauri::Window, state: State<AppState>, ids: Vec<String>, priority: Option<String>) -> Result<usize, String> {
    let mut store = state.lock().unwrap();
    let count = store.batch_set_priority(ids.clone(), priority.as_deref())?;
    drop(store);
    broadcast_from(&app, &window, json!({ "action": "TASKS_BATCH_PRIORITY", "ids": ids }));
    Ok(count)
}

#[tauri::command]
pub fn tasks_reorder(app: AppHandle, window: tauri::Window, state: State<AppState>, items: Vec<Value>) -> Result<bool, String> {
    let mut store = state.lock().unwrap();
    let res = store.reorder_tasks(items)?;
    drop(store);
    broadcast_from(&app, &window, json!({ "action": "TASK_REORDERED" }));
    Ok(res)
}

#[tauri::command]
pub fn tasks_cleanup(app: AppHandle, window: tauri::Window, state: State<AppState>) -> Result<Value, String> {
    let mut store = state.lock().unwrap();
    let count = store.cleanup_tasks()?;
    drop(store);
    broadcast_from(&app, &window, json!({ "action": "TASKS_CLEANED" }));
    Ok(json!({ "removed": count }))
}

// ==================== Reports ====================
#[tauri::command]
pub fn reports_list(state: State<AppState>) -> Result<Vec<WeeklyReport>, String> {
    let mut store = state.lock().unwrap();
    store.refresh_from_disk()?;
    Ok(store.list_reports())
}

#[tauri::command]
pub fn reports_get(state: State<AppState>, week_id: String) -> Result<Option<WeeklyReport>, String> {
    let mut store = state.lock().unwrap();
    store.refresh_from_disk()?;
    Ok(store.get_report(&week_id))
}

#[tauri::command]
pub fn reports_generate(app: AppHandle, window: tauri::Window, state: State<AppState>, week_id: String) -> Result<WeeklyReport, String> {
    let mut store = state.lock().unwrap();
    let report = store.generate_report(&week_id)?;
    drop(store);
    broadcast_from(&app, &window, json!({ "action": "REPORT_GENERATED", "weekId": week_id }));
    Ok(report)
}

#[tauri::command]
pub fn reports_current_week_id() -> String {
    DataStore::current_week_id()
}

#[tauri::command]
pub fn reports_last_week_id() -> String {
    DataStore::last_week_id()
}

#[tauri::command]
pub fn reports_delete(app: AppHandle, window: tauri::Window, state: State<AppState>, week_id: String) -> Result<bool, String> {
    let mut store = state.lock().unwrap();
    let res = store.delete_report(&week_id)?;
    drop(store);
    broadcast_from(&app, &window, json!({ "action": "REPORT_DELETED", "weekId": week_id }));
    Ok(res)
}

#[tauri::command]
pub fn reports_update(app: AppHandle, window: tauri::Window, state: State<AppState>, week_id: String, updates: Value) -> Result<WeeklyReport, String> {
    let mut store = state.lock().unwrap();
    let res = store.update_report(&week_id, updates)?;
    drop(store);
    broadcast_from(&app, &window, json!({ "action": "REPORT_UPDATED", "weekId": week_id }));
    Ok(res)
}

// ==================== Clipboard ====================
#[tauri::command]
pub fn clipboard_write(app: AppHandle, text: String) -> Result<bool, String> {
    app.clipboard().write_text(text).map_err(|e| e.to_string())?;
    Ok(true)
}

// ==================== Config ====================
#[tauri::command]
pub fn config_get(state: State<AppState>) -> Result<AppConfig, String> {
    let mut store = state.lock().unwrap();
    store.refresh_from_disk()?;
    Ok(store.get_config())
}

#[tauri::command]
pub fn config_update(app: AppHandle, window: tauri::Window, state: State<AppState>, updates: Value) -> Result<AppConfig, String> {
    let res = {
        let mut store = state.lock().unwrap();
        store.update_config(updates)?
    };
    broadcast_from(&app, &window, json!({ "action": "CONFIG_UPDATED", "payload": res }));
    Ok(res)
}

// ==================== Gantt ====================
#[tauri::command]
pub fn gantt_data(state: State<AppState>) -> Result<Vec<GanttTask>, String> {
    let mut store = state.lock().unwrap();
    store.refresh_from_disk()?;
    Ok(store.get_gantt_data())
}

#[tauri::command]
pub fn gantt_request_save_path(app: AppHandle, window: tauri::Window) -> Result<Value, String> {
    let stamp = Local::now().format("%Y%m%d").to_string();
    let default_name = format!("甘特图-{}.png", stamp);

    let file_path = app.dialog()
        .file()
        .add_filter("PNG 图像", &["png"])
        .set_file_name(&default_name)
        .blocking_save_file();

    if let Some(path) = file_path {
        let local_path = path.as_path().ok_or("请选择本地文件路径")?.to_path_buf();
        let p_str = local_path.to_string_lossy().to_string();
        let token = crate::image_save::authorize(window.label(), local_path)?;
        Ok(json!({ "filePath": p_str, "token": token }))
    } else {
        Ok(json!({ "canceled": true }))
    }
}

#[tauri::command]
pub fn gantt_write_image_buffer(window: tauri::Window, file_path: String, data: Vec<u8>, token: Option<String>) -> Result<Value, String> {
    crate::image_save::write(window.label(), &file_path, &data, token.as_deref())?;
    Ok(json!({ "success": true, "path": file_path }))
}

#[tauri::command]
pub fn gantt_export_excel(
    app: AppHandle,
    state: State<AppState>,
    project_scope_ids: Option<Vec<String>>,
) -> Result<Value, String> {
    let stamp = Local::now().format("%Y%m%d").to_string();
    let default_name = format!("甘特图-{}.xlsx", stamp);

    let file_path = app.dialog()
        .file()
        .add_filter("Excel 工作簿", &["xlsx"])
        .set_file_name(&default_name)
        .blocking_save_file();

    if let Some(path) = file_path {
        let local_path = path.as_path().ok_or("请选择本地文件路径")?;
        let scope_ids = project_scope_ids.unwrap_or_default();
        let mut store = state.lock().unwrap();
        store.refresh_from_disk()?;
        let gantt_tasks = store.get_scoped_gantt_data(&scope_ids);
        drop(store);

        crate::xlsx_gantt::export_gantt_xlsx(local_path, &gantt_tasks)?;
        Ok(json!({
            "success": true,
            "path": local_path.to_string_lossy().to_string(),
            "count": gantt_tasks.len()
        }))
    } else {
        Ok(json!({ "canceled": true }))
    }
}

#[tauri::command]
pub fn gantt_export_csv(
    app: AppHandle,
    state: State<AppState>,
    project_scope_ids: Option<Vec<String>>,
) -> Result<Value, String> {
    let stamp = Local::now().format("%Y%m%d").to_string();
    let default_name = format!("甘特图-{}.csv", stamp);

    let file_path = app.dialog()
        .file()
        .add_filter("CSV 表格", &["csv"])
        .set_file_name(&default_name)
        .blocking_save_file();

    if let Some(path) = file_path {
        let local_path = path.as_path().ok_or("请选择本地文件路径")?;
        let scope_ids = project_scope_ids.unwrap_or_default();
        let mut store = state.lock().unwrap();
        store.refresh_from_disk()?;
        let gantt_tasks = store.get_scoped_gantt_data(&scope_ids);
        drop(store);

        let mut csv = String::from("\u{FEFF}"); // UTF-8 BOM
        csv.push_str("任务ID,任务内容,层级,开始日期,截止日期\n");
        let count = gantt_tasks.len();
        for t in gantt_tasks {
            csv.push_str(&format!(
                "\"{}\",\"{}\",{},\"{}\",\"{}\"\n",
                t.id,
                t.content.replace('"', "\"\""),
                t.level,
                t.start,
                t.end
            ));
        }

        std::fs::write(local_path, csv).map_err(|e| e.to_string())?;
        Ok(json!({
            "success": true,
            "path": local_path.to_string_lossy().to_string(),
            "count": count
        }))
    } else {
        Ok(json!({ "canceled": true }))
    }
}

// ==================== Auto Backups ====================
#[tauri::command]
pub fn backups_list(state: State<AppState>) -> Result<Vec<BackupEntry>, String> {
    let store = state.lock().unwrap();
    store.list_backups()
}

#[tauri::command]
pub fn backups_restore(
    app: AppHandle,
    window: tauri::Window,
    state: State<AppState>,
    id: String,
) -> Result<RestoreBackupResult, String> {
    let res = {
        let mut store = state.lock().unwrap();
        store.restore_backup(&id)?
    };
    broadcast_from(&app, &window, json!({ "action": "DATA_IMPORTED" }));
    Ok(res)
}

// ==================== Undo ====================
#[tauri::command]
pub fn undo_list(state: State<AppState>) -> Vec<Value> {
    state.lock().unwrap().undo_list().into_iter().rev().map(|label| json!({ "label": label })).collect()
}

#[tauri::command]
pub fn undo_can_undo(state: State<AppState>) -> bool {
    state.lock().unwrap().can_undo()
}

#[tauri::command]
pub fn undo_undo(app: AppHandle, window: tauri::Window, state: State<AppState>) -> Result<Value, String> {
    let mut store = state.lock().unwrap();
    let action = store.undo()?;
    let remaining = store.undo_stack.len();
    drop(store);
    broadcast_from(&app, &window, json!({ "action": "DATA_UNDO", "restoredAction": action }));
    Ok(json!({ "ok": true, "label": action, "restoredAction": action, "remaining": remaining }))
}

#[tauri::command]
pub fn undo_clear(state: State<AppState>) {
    state.lock().unwrap().clear_undo();
}

// ==================== Debug ====================
#[tauri::command]
pub fn debug_data_path(state: State<AppState>) -> String {
    state.lock().unwrap().file_path.to_string_lossy().to_string()
}

// ==================== Dialog ====================
#[derive(Debug, Deserialize)]
pub struct ConfirmOptions {
    pub message: Option<String>,
    pub detail: Option<String>,
    pub title: Option<String>,
}

#[tauri::command]
pub fn dialog_confirm(app: AppHandle, options: Option<ConfirmOptions>) -> bool {
    let opts = options.unwrap_or(ConfirmOptions {
        message: Some("确定要执行此操作吗？".to_string()),
        detail: None,
        title: Some("确认操作".to_string()),
    });

    let title = opts.title.unwrap_or_else(|| "确认操作".to_string());
    let msg = opts.message.unwrap_or_else(|| "确定要继续吗？".to_string());
    let detail = opts.detail.unwrap_or_default();
    let full_msg = if detail.is_empty() { msg } else { format!("{}\n\n{}", msg, detail) };

    app.dialog()
        .message(full_msg)
        .title(title)
        .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancel)
        .blocking_show()
}

// ==================== Data Export / Import ====================
#[tauri::command]
pub fn data_export(app: AppHandle, state: State<AppState>) -> Result<Value, String> {
    let stamp = Local::now().format("%Y%m%d_%H%M%S").to_string();
    let default_name = format!("数据备份-{}.json", stamp);

    let file_path = app.dialog()
        .file()
        .add_filter("JSON 数据文件", &["json"])
        .set_file_name(&default_name)
        .blocking_save_file();

    if let Some(path) = file_path {
        let mut store = state.lock().unwrap();
        store.refresh_from_disk()?;
        let snapshot = store.export_snapshot();
        let task_count = store.data.tasks.len();
        drop(store);
        let content = serde_json::to_string_pretty(&snapshot).map_err(|e| e.to_string())?;
        std::fs::write(path.as_path().ok_or("请选择本地文件路径")?, content).map_err(|e| e.to_string())?;
        Ok(json!({ "ok": true, "path": path.to_string(), "tasks": task_count }))
    } else {
        Ok(json!({ "ok": false, "canceled": true }))
    }
}

#[tauri::command]
pub fn data_read_file(app: AppHandle) -> Result<Value, String> {
    let file_path = app.dialog()
        .file()
        .add_filter("JSON 数据文件", &["json"])
        .blocking_pick_file();

    if let Some(path) = file_path {
        let p_buf = path.as_path().ok_or("请选择本地文件路径")?;
        let raw = std::fs::read_to_string(p_buf).map_err(|e| e.to_string())?;
        let snapshot: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        let task_count = snapshot.get("tasks").and_then(|t| t.as_array()).map(|a| a.len()).unwrap_or(0);
        Ok(json!({
            "ok": true,
            "path": path.to_string(),
            "snapshot": snapshot,
            "taskCount": task_count
        }))
    } else {
        Ok(json!({ "ok": false, "canceled": true }))
    }
}

#[tauri::command]
pub fn data_import(app: AppHandle, window: tauri::Window, state: State<AppState>, snapshot: Value, mode: Option<String>) -> Result<Value, String> {
    let mut store = state.lock().unwrap();
    let m = mode.unwrap_or_else(|| "merge".to_string());
    let res = store.import_snapshot(snapshot, &m)?;
    drop(store);
    broadcast_from(&app, &window, json!({ "action": "DATA_IMPORTED" }));
    Ok(res)
}

// ==================== Notes ====================
#[tauri::command]
pub fn notes_list(state: State<AppState>) -> Result<Vec<Note>, String> {
    let mut store = state.lock().unwrap();
    store.refresh_from_disk()?;
    Ok(store.get_notes())
}

#[tauri::command]
pub fn notes_create(app: AppHandle, window: tauri::Window, state: State<AppState>, input: Value) -> Result<Note, String> {
    let mut store = state.lock().unwrap();
    let note = store.create_note(input)?;
    drop(store);
    broadcast_from(&app, &window, json!({ "action": "NOTE_CREATED", "payload": note }));
    Ok(note)
}

#[tauri::command]
pub fn notes_update(app: AppHandle, window: tauri::Window, state: State<AppState>, id: String, updates: Value) -> Result<Note, String> {
    let mut store = state.lock().unwrap();
    let note = store.update_note(&id, updates)?;
    drop(store);
    broadcast_from(&app, &window, json!({ "action": "NOTE_UPDATED", "id": id, "payload": note }));
    Ok(note)
}

#[tauri::command]
pub fn notes_delete(app: AppHandle, window: tauri::Window, state: State<AppState>, id: String) -> Result<bool, String> {
    let mut store = state.lock().unwrap();
    let res = store.delete_note(&id)?;
    drop(store);
    broadcast_from(&app, &window, json!({ "action": "NOTE_DELETED", "id": id }));
    Ok(res)
}

#[tauri::command]
pub fn notes_reorder(app: AppHandle, window: tauri::Window, state: State<AppState>, items: Vec<Value>) -> Result<bool, String> {
    let mut store = state.lock().unwrap();
    let res = store.reorder_notes(items)?;
    drop(store);
    broadcast_from(&app, &window, json!({ "action": "NOTES_REORDERED" }));
    Ok(res)
}

// ==================== Widget Window Control ====================
static WIDGET_STATE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn flush_widget_bounds_for_window(window: &tauri::Window) {
    if window.label() != "widget" { return; }
    if let Ok(scale) = window.scale_factor() {
        if let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) {
            let logical_pos = pos.to_logical::<f64>(scale);
            let logical_size = size.to_logical::<f64>(scale);
            save_widget_bounds(
                logical_pos.x,
                logical_pos.y,
                logical_size.width,
                logical_size.height,
            );
        }
    }
}

pub fn flush_widget_bounds_for_app(app: &AppHandle) {
    if let Some(widget) = app.get_webview_window("widget") {
        flush_widget_bounds_for_window(&widget.as_ref().window());
    }
}

#[tauri::command]
pub fn widget_toggle(app: AppHandle) -> Value {
    if let Some(widget) = app.get_webview_window("widget") {
        let is_visible = widget.is_visible().unwrap_or(false);
        if is_visible {
            flush_widget_bounds_for_window(&widget.as_ref().window());
            let _ = widget.hide();
            json!({ "open": false })
        } else {
            restore_widget_state(&app);
            let _ = widget.show();
            let _ = widget.set_focus();
            json!({ "open": true })
        }
    } else {
        json!({ "open": false })
    }
}

#[tauri::command]
pub fn widget_status(app: AppHandle) -> Value {
    if let Some(widget) = app.get_webview_window("widget") {
        let is_visible = widget.is_visible().unwrap_or(false);
        json!({ "open": is_visible })
    } else {
        json!({ "open": false })
    }
}

#[tauri::command]
pub fn widget_focus_main(app: AppHandle) -> Value {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
    json!({ "ok": true })
}

fn get_user_data_dir() -> std::path::PathBuf {
    crate::store::DataStore::resolve_data_path()
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

fn get_hotkey_pref_file() -> std::path::PathBuf {
    get_user_data_dir().join("hotkey-pref.json")
}

fn get_widget_state_file() -> std::path::PathBuf {
    get_user_data_dir().join("widget-state.json")
}

pub fn get_saved_hotkey() -> String {
    let p = get_hotkey_pref_file();
    if p.exists() {
        if let Ok(content) = std::fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<Value>(&content) {
                if let Some(k) = v.get("hotkey").and_then(|s| s.as_str()) {
                    return k.to_string();
                }
            }
        }
    }
    "CommandOrControl+Shift+M".to_string()
}

pub fn load_widget_state() -> Value {
    let _guard = WIDGET_STATE_LOCK.lock().unwrap();
    let p = get_widget_state_file();
    if p.exists() {
        if let Ok(content) = std::fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<Value>(&content) {
                return v;
            }
        }
    }
    json!({ "isPinned": true, "width": 340, "height": 520 })
}

pub fn save_widget_bounds(x: f64, y: f64, width: f64, height: f64) {
    let _guard = WIDGET_STATE_LOCK.lock().unwrap();
    let p = get_widget_state_file();
    let mut state = json!({ "isPinned": true, "width": 340, "height": 520 });
    if p.exists() {
        if let Ok(content) = std::fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<Value>(&content) {
                state = v;
            }
        }
    }
    if let Value::Object(ref mut map) = state {
        map.insert("x".to_string(), json!(x));
        map.insert("y".to_string(), json!(y));
        map.insert("width".to_string(), json!(width));
        map.insert("height".to_string(), json!(height));
    }
    let _ = std::fs::write(&p, serde_json::to_string(&state).unwrap_or_default());
}

pub fn restore_widget_state(app: &AppHandle) {
    if let Some(widget) = app.get_webview_window("widget") {
        let state = load_widget_state();
        let is_pinned = state.get("isPinned").and_then(|b| b.as_bool()).unwrap_or(true);
        let _ = widget.set_always_on_top(is_pinned);

        const DEFAULT_WIDTH: f64 = 340.0;
        const DEFAULT_HEIGHT: f64 = 520.0;
        let mut width = state.get("width").and_then(|n| n.as_f64()).unwrap_or(DEFAULT_WIDTH);
        let mut height = state.get("height").and_then(|n| n.as_f64()).unwrap_or(DEFAULT_HEIGHT);

        if width < 280.0 { width = DEFAULT_WIDTH; }
        if height < 400.0 { height = DEFAULT_HEIGHT; }

        let _ = widget.set_size(tauri::Size::Logical(tauri::LogicalSize::new(width, height)));

        let x = state.get("x").and_then(|n| n.as_f64());
        let y = state.get("y").and_then(|n| n.as_f64());

        if let (Some(px), Some(py)) = (x, y) {
            if let Ok(monitors) = widget.available_monitors() {
                let scale = widget.scale_factor().unwrap_or(1.0);
                let win_phys_x = px * scale;
                let win_phys_y = py * scale;
                let win_phys_w = width * scale;
                let win_phys_h = height * scale;

                let mut is_visible = false;
                for mon in &monitors {
                    let m_pos = mon.position();
                    let m_size = mon.size();
                    let mon_x = m_pos.x as f64;
                    let mon_y = m_pos.y as f64;
                    let mon_w = m_size.width as f64;
                    let mon_h = m_size.height as f64;

                    // Physical rectangle intersection: must have at least 50px overlap
                    let overlap_w = (win_phys_x + win_phys_w).min(mon_x + mon_w) - win_phys_x.max(mon_x);
                    let overlap_h = (win_phys_y + win_phys_h).min(mon_y + mon_h) - win_phys_y.max(mon_y);

                    if overlap_w >= 50.0 && overlap_h >= 50.0 {
                        is_visible = true;
                        break;
                    }
                }

                if is_visible {
                    let _ = widget.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(px, py)));
                } else if let Some(primary) = monitors.first() {
                    let p_scale = primary.scale_factor();
                    let p_pos = primary.position();
                    let p_size = primary.size();
                    let safe_x = (p_pos.x as f64 + (p_size.width as f64 - win_phys_w).max(0.0) / 2.0) / p_scale;
                    let safe_y = (p_pos.y as f64 + (p_size.height as f64 - win_phys_h).max(0.0) / 2.0) / p_scale;
                    let _ = widget.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(safe_x, safe_y)));
                }
            }
        }
    }
}

#[tauri::command]
pub fn widget_set_always_on_top(app: AppHandle, flag: bool) -> Value {
    let _guard = WIDGET_STATE_LOCK.lock().unwrap();
    let p = get_widget_state_file();
    let mut state = json!({ "isPinned": true, "width": 340, "height": 520 });
    if p.exists() {
        if let Ok(content) = std::fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<Value>(&content) {
                state = v;
            }
        }
    }
    if let Value::Object(ref mut map) = state {
        map.insert("isPinned".to_string(), Value::Bool(flag));
    }
    let _ = std::fs::write(&p, serde_json::to_string(&state).unwrap_or_default());

    if let Some(widget) = app.get_webview_window("widget") {
        let _ = widget.set_always_on_top(flag);
        json!({ "ok": true, "isPinned": flag })
    } else {
        json!({ "ok": false })
    }
}

#[tauri::command]
pub fn widget_get_pinned(_app: AppHandle) -> bool {
    let state = load_widget_state();
    state.get("isPinned").and_then(|b| b.as_bool()).unwrap_or(true)
}

pub fn register_hotkey(app: &AppHandle, key: &str) -> Result<(), String> {
    let norm_key = if key.contains("Ctrl+") && !key.contains("CommandOrControl+") {
        key.replace("Ctrl+", "CommandOrControl+")
    } else {
        key.to_string()
    };

    let old_key = get_saved_hotkey();
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();

    let app_handle = app.clone();
    if let Err(e) = gs.on_shortcut(norm_key.as_str(), move |_app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            let _ = widget_toggle(app_handle.clone());
        }
    }) {
        // Rollback to old key
        if old_key != norm_key {
            let old_norm = if old_key.contains("Ctrl+") && !old_key.contains("CommandOrControl+") {
                old_key.replace("Ctrl+", "CommandOrControl+")
            } else {
                old_key.clone()
            };
            let app_handle2 = app.clone();
            let _ = gs.on_shortcut(old_norm.as_str(), move |_app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    let _ = widget_toggle(app_handle2.clone());
                }
            });
        }
        return Err(format!("快捷键注册失败: {}", e));
    }

    Ok(())
}

// ==================== Hotkey ====================
#[tauri::command]
pub fn hotkey_set(app: AppHandle, key: String) -> Value {
    let reserved = ["Alt+F4", "CommandOrControl+Alt+Delete", "PrintScreen", "Control+Alt+Delete", "Ctrl+Alt+Delete"];
    let k_clean = key.replace(' ', "").to_lowercase();
    for r in &reserved {
        if k_clean.contains(&r.to_lowercase()) {
            return json!({ "ok": false, "error": format!("快捷键 \"{}\" 为系统保留，不可设置", key) });
        }
    }

    if let Err(e) = register_hotkey(&app, &key) {
        return json!({ "ok": false, "error": e });
    }

    let p = get_hotkey_pref_file();
    let _ = std::fs::write(&p, serde_json::to_string(&json!({ "hotkey": key })).unwrap_or_default());

    json!({ "ok": true, "hotkey": key })
}

#[tauri::command]
pub fn hotkey_get() -> Value {
    json!({ "hotkey": get_saved_hotkey() })
}

// ==================== Reminder ====================
#[tauri::command]
pub fn reminder_get_payload(state: State<AppState>, _opts: Value) -> Value {
    let mut store = state.lock().unwrap();
    let _ = store.refresh_from_disk();
    let tasks = store.get_active_tasks();
    json!({
        "tasks": tasks,
        "dueSoon": tasks.iter().filter(|t| t.deadline.is_some()).collect::<Vec<_>>()
    })
}

#[tauri::command]
pub fn reminder_open_panel(app: AppHandle, opts: Value) -> Value {
    if let Some(reminder) = app.get_webview_window("reminder") {
        let _ = reminder.show();
        let _ = reminder.set_focus();
        let _ = app.emit("reminder-show", opts);
    }
    json!({ "ok": true })
}

#[tauri::command]
pub fn reminder_focus_task(app: AppHandle, id: String) -> Value {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
        let _ = app.emit("reminder-navigate-task", id);
    }
    json!({ "ok": true })
}

// ==================== App Info ====================
#[tauri::command]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;
    use tauri_plugin_global_shortcut::Shortcut;

    #[test]
    fn test_shortcuts() {
        let s1 = Shortcut::from_str("CommandOrControl+Shift+M");
        let s2 = Shortcut::from_str("Ctrl+Shift+M");
        let s3 = Shortcut::from_str("Alt+M");
        println!("s1 CommandOrControl+Shift+M: {:?}", s1);
        println!("s2 Ctrl+Shift+M: {:?}", s2);
        println!("s3 Alt+M: {:?}", s3);
    }
}
