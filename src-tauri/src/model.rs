use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    #[serde(default)]
    pub id: String,
    pub content: String,
    #[serde(default)]
    pub deadline: Option<String>,
    #[serde(default)]
    pub start_date: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub order: Option<Value>,
    #[serde(default)]
    pub completed: bool,
    #[serde(default)]
    pub completed_at: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    #[serde(default)]
    pub id: String,
    pub content: String,
    #[serde(default = "default_color")]
    pub color: String,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub order: Option<i64>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

fn default_color() -> String {
    "default".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeeklyEntry {
    pub task_id: String,
    pub content: String,
    pub completed_at: String,
    pub level: usize,
    pub parent_content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeeklyReport {
    pub week_id: String,
    pub start_date: String,
    pub end_date: String,
    pub generated_at: String,
    pub count: usize,
    pub entries: Vec<WeeklyEntry>,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default = "default_task_retention")]
    pub task_retention_days: i64,
    #[serde(default = "default_report_retention")]
    pub report_retention_weeks: i64,
    #[serde(default)]
    pub auto_plan: bool,
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default)]
    pub project_scope_ids: Vec<String>,
    #[serde(default)]
    pub widget_project_scope_ids: Vec<String>,
    #[serde(default = "default_view")]
    pub last_view: String,
    #[serde(default)]
    pub daily_reminder_enabled: bool,
    #[serde(default = "default_reminder_hour")]
    pub daily_reminder_hour: u32,
    #[serde(default = "default_reminder_minute")]
    pub daily_reminder_minute: u32,
    #[serde(default)]
    pub last_daily_reminder_date: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            task_retention_days: 180,
            report_retention_weeks: 22,
            auto_plan: false,
            theme: "light".to_string(),
            project_scope_ids: vec![],
            widget_project_scope_ids: vec![],
            last_view: "hierarchy".to_string(),
            daily_reminder_enabled: false,
            daily_reminder_hour: 17,
            daily_reminder_minute: 0,
            last_daily_reminder_date: None,
            extra: HashMap::new(),
        }
    }
}

fn default_task_retention() -> i64 { 180 }
fn default_report_retention() -> i64 { 22 }
fn default_theme() -> String { "light".to_string() }
fn default_view() -> String { "hierarchy".to_string() }
fn default_reminder_hour() -> u32 { 17 }
fn default_reminder_minute() -> u32 { 0 }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppData {
    #[serde(default)]
    pub tasks: Vec<Task>,
    #[serde(default)]
    pub weekly_reports: Vec<WeeklyReport>,
    #[serde(default)]
    pub deleted_weekly_reports: Vec<String>,
    #[serde(default)]
    pub notes: Vec<Note>,
    #[serde(default)]
    pub config: AppConfig,
}

impl Default for AppData {
    fn default() -> Self {
        Self {
            tasks: vec![],
            weekly_reports: vec![],
            deleted_weekly_reports: vec![],
            notes: vec![],
            config: AppConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UndoEntry {
    pub action: String,
    pub snapshot: UndoSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum UndoSnapshot {
    Tasks(Vec<Task>),
    Notes(Vec<Note>),
    Reports(Vec<WeeklyReport>, Vec<String>),
    Import(AppData),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GanttTask {
    pub id: String,
    pub content: String,
    pub start: String,
    pub end: String,
    pub parent_id: Option<String>,
    pub level: usize,
    pub dfs_order: usize,
    pub urgency: Option<String>,
    pub days_left: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntry {
    pub id: String,
    pub kind: String,
    pub created_at: String,
    pub task_count: usize,
    pub note_count: usize,
    pub report_count: usize,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreBackupResult {
    pub ok: bool,
    pub restored_from: String,
    pub corrupt_backup_path: Option<String>,
    pub undoable: bool,
    pub task_count: usize,
    pub note_count: usize,
}
