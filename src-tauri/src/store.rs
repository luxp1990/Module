use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, Timelike, Utc};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::model::*;

#[cfg(test)]
#[path = "store_audit_tests.rs"]
mod audit_tests;

pub const MAX_TASK_LEVEL: usize = 4;
pub const MAX_DAILY_BACKUPS: usize = 10;
pub const MAX_PRE_CHANGE_BACKUPS: usize = 5;

static BACKUP_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SaveBackupMode {
    Normal,
    PreImport,
}

pub struct DataStore {
    pub file_path: PathBuf,
    pub data: AppData,
    pub undo_stack: Vec<UndoEntry>,
    pub(crate) disk_revision: Option<Vec<u8>>,
    pub(crate) pending_external_sync: bool,
}

impl DataStore {
    pub fn new() -> Self {
        let file_path = Self::resolve_data_path();
        let mut store = Self::for_path(file_path);
        store.load();
        store.pending_external_sync = false;
        store
    }

    pub fn for_path(file_path: PathBuf) -> Self {
        Self {
            file_path,
            data: AppData::default(),
            undo_stack: Vec::new(),
            disk_revision: None,
            pending_external_sync: false,
        }
    }

    pub fn resolve_data_path() -> PathBuf {
        // Same override as the Node bridge, also useful for isolated diagnostics.
        if let Some(path) = std::env::var_os("MODULE_DATA_PATH").filter(|p| !p.is_empty()) {
            return PathBuf::from(path);
        }
        let appdata = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
        let p1 = appdata.join("task-manager").join("tasks-data.json");
        if p1.exists() {
            return p1;
        }
        let p2 = appdata.join("Module").join("tasks-data.json");
        if p2.exists() {
            return p2;
        }
        p1
    }

    pub fn load(&mut self) {
        // A failed load must not reset data or bless unreadable bytes as a writable revision.
        if let Err(error) = self.refresh_from_disk() {
            log::error!("{}", error);
        }
    }

    pub fn parse_and_validate_app_data(bytes: &[u8]) -> Result<AppData, String> {
        let value: Value = serde_json::from_slice(bytes)
            .map_err(|e| format!("JSON 格式无效: {}", e))?;
        let obj = value
            .as_object()
            .ok_or_else(|| "数据顶层必须是 JSON 对象".to_string())?;
        if !obj.get("tasks").is_some_and(Value::is_array) {
            return Err("数据缺少有效的 tasks 数组".to_string());
        }
        let data: AppData = serde_json::from_value(value)
            .map_err(|e| format!("数据结构无效: {}", e))?;
        Self::validate_tasks(&data.tasks)?;
        Ok(data)
    }

    pub fn refresh_from_disk(&mut self) -> Result<(), String> {
        let bytes = match fs::read(&self.file_path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && self.disk_revision.is_none() => return Ok(()),
            Err(e) => return Err(format!("无法读取任务数据（{}），已保留原文件: {}", self.file_path.display(), e)),
        };
        if self.disk_revision.as_ref() != Some(&bytes) {
            let data = Self::parse_and_validate_app_data(&bytes).map_err(|e| {
                format!(
                    "任务数据格式无效（{}），已保留原文件且禁止覆盖，请修复文件或恢复备份: {}",
                    self.file_path.display(),
                    e
                )
            })?;
            self.data = data;
            self.disk_revision = Some(bytes);
            // Old history could overwrite another process's completed work.
            self.undo_stack.clear();
            self.pending_external_sync = true;
        }
        Ok(())
    }

    pub fn check_external_sync(&mut self) -> Result<bool, String> {
        self.refresh_from_disk()?;
        Ok(std::mem::take(&mut self.pending_external_sync))
    }

    pub fn backup_dir_for(file_path: &Path) -> PathBuf {
        let parent = file_path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let stem = file_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("data");
        let safe_stem: String = stem
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .collect();
        let safe_stem = if safe_stem.is_empty() {
            "data".to_string()
        } else {
            safe_stem
        };

        let mut normalized = file_path.to_string_lossy().replace('\\', "/");
        if cfg!(windows) {
            normalized = normalized.to_lowercase();
        }
        let mut hash: u64 = 0xcbf29ce484222325;
        for b in normalized.as_bytes() {
            hash ^= *b as u64;
            hash = hash.wrapping_mul(0x100000001b3);
        }
        parent
            .join("backups")
            .join(format!("{}-{:08x}", safe_stem, hash as u32))
    }

    pub fn backup_dir(&self) -> PathBuf {
        Self::backup_dir_for(&self.file_path)
    }

    pub fn validate_backup_id(id: &str) -> Result<&'static str, String> {
        if id.is_empty()
            || id.contains('/')
            || id.contains('\\')
            || id.contains("..")
            || id.contains('\0')
            || id.ends_with(".tmp")
            || !id.ends_with(".json")
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        {
            return Err("无效的备份文件名".to_string());
        }

        if let Some(rest) = id.strip_prefix("daily-") {
            if rest.len() > 11
                && rest.as_bytes()[10] == b'_'
                && NaiveDate::parse_from_str(&rest[..10], "%Y-%m-%d").is_ok()
            {
                return Ok("daily");
            }
            return Err("无效的备份文件名".to_string());
        }
        if id.starts_with("pre-import-") {
            return Ok("pre-import");
        }
        if id.starts_with("pre-restore-") {
            return Ok("pre-restore");
        }
        Err("无效的备份文件名".to_string())
    }

    fn backup_sort_key(filename: &str) -> String {
        if let Some(rest) = filename.strip_prefix("daily-") {
            if rest.len() >= 10 {
                return format!("{}{}", rest[..10].replace('-', ""), &rest[10..]);
            }
        }
        if let Some(rest) = filename.strip_prefix("pre-import-") {
            return rest.to_string();
        }
        if let Some(rest) = filename.strip_prefix("pre-restore-") {
            return rest.to_string();
        }
        filename.to_string()
    }

    fn make_backup_filename(kind: &str) -> String {
        let now = Local::now();
        let seq = BACKUP_SEQ.fetch_add(1, Ordering::Relaxed) % 10000;
        let short_id = Uuid::new_v4().simple().to_string();
        let short = &short_id[..6];
        match kind {
            "daily" => format!(
                "daily-{}_{}-{:04}-{}.json",
                now.format("%Y-%m-%d"),
                now.format("%H%M%S%3f"),
                seq,
                short
            ),
            "pre-import" => format!(
                "pre-import-{}_{}-{:04}-{}.json",
                now.format("%Y%m%d"),
                now.format("%H%M%S%3f"),
                seq,
                short
            ),
            _ => format!(
                "pre-restore-{}_{}-{:04}-{}.json",
                now.format("%Y%m%d"),
                now.format("%H%M%S%3f"),
                seq,
                short
            ),
        }
    }

    fn atomic_write_bytes(target: &Path, bytes: &[u8]) -> Result<(), String> {
        let parent = target
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let tmp_name = format!(
            ".{}.{}.tmp",
            target.file_name().and_then(|s| s.to_str()).unwrap_or("file"),
            Uuid::new_v4().simple()
        );
        let tmp_path = parent.join(tmp_name);
        if let Err(e) = fs::write(&tmp_path, bytes) {
            let _ = fs::remove_file(&tmp_path);
            return Err(e.to_string());
        }
        if let Err(e) = fs::rename(&tmp_path, target) {
            let _ = fs::remove_file(&tmp_path);
            return Err(e.to_string());
        }
        Ok(())
    }

    fn write_backup_bytes(&self, kind: &str, bytes: &[u8]) -> Result<String, String> {
        let dir = self.backup_dir();
        if !dir.exists() {
            fs::create_dir_all(&dir).map_err(|e| format!("创建备份目录失败: {}", e))?;
        }
        let filename = Self::make_backup_filename(kind);
        let dest = dir.join(&filename);
        Self::atomic_write_bytes(&dest, bytes)
            .map_err(|e| format!("写入自动备份失败: {}", e))?;
        Ok(filename)
    }

    fn rotate_backups_in(dir: &Path) -> Result<(), String> {
        if !dir.exists() {
            return Ok(());
        }
        let mut daily: Vec<String> = Vec::new();
        let mut pre_change: Vec<String> = Vec::new();

        let entries = fs::read_dir(dir).map_err(|e| format!("读取备份目录失败: {}", e))?;
        for entry in entries.flatten() {
            if !entry.path().is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            match Self::validate_backup_id(&name) {
                Ok("daily") => daily.push(name),
                Ok("pre-import") | Ok("pre-restore") => pre_change.push(name),
                _ => {}
            }
        }

        daily.sort_by(|a, b| Self::backup_sort_key(b).cmp(&Self::backup_sort_key(a)));
        for old in daily.into_iter().skip(MAX_DAILY_BACKUPS) {
            let _ = fs::remove_file(dir.join(old));
        }

        pre_change.sort_by(|a, b| Self::backup_sort_key(b).cmp(&Self::backup_sort_key(a)));
        for old in pre_change.into_iter().skip(MAX_PRE_CHANGE_BACKUPS) {
            let _ = fs::remove_file(dir.join(old));
        }

        Ok(())
    }

    fn has_today_daily_backup(dir: &Path, today_prefix: &str) -> Result<bool, String> {
        if !dir.exists() {
            return Ok(false);
        }
        let entries = fs::read_dir(dir).map_err(|e| format!("检查今日备份失败: {}", e))?;
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(today_prefix)
                && Self::validate_backup_id(&name).ok() == Some("daily")
                && fs::read(&path)
                    .ok()
                    .and_then(|bytes| Self::parse_and_validate_app_data(&bytes).ok())
                    .is_some()
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn maybe_backup_before_save(&self, old_bytes: &[u8], mode: SaveBackupMode) -> Result<(), String> {
        if Self::parse_and_validate_app_data(old_bytes).is_err() {
            return Ok(());
        }
        let dir = self.backup_dir();
        let today_prefix = format!("daily-{}_", Local::now().format("%Y-%m-%d"));
        let has_daily = Self::has_today_daily_backup(&dir, &today_prefix)?;
        if !has_daily {
            self.write_backup_bytes("daily", old_bytes)?;
        }
        if mode == SaveBackupMode::PreImport {
            self.write_backup_bytes("pre-import", old_bytes)?;
        }
        Self::rotate_backups_in(&dir)?;
        Ok(())
    }

    pub fn save(&mut self) -> Result<(), String> {
        self.save_with_mode(SaveBackupMode::Normal)
    }

    fn save_with_mode(&mut self, backup_mode: SaveBackupMode) -> Result<(), String> {
        let parent = self.file_path.parent().unwrap_or_else(|| Path::new("."));
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        // OS locks release on process exit, including crashes. Never unlink the lock file:
        // another process may already hold a handle to it.
        let mut lock_path = self.file_path.as_os_str().to_os_string();
        lock_path.push(".lock");
        let lock_file = fs::OpenOptions::new().read(true).write(true).create(true)
            .open(PathBuf::from(lock_path)).map_err(|e| e.to_string())?;
        lock_file.try_lock().map_err(|_| "另一个进程正在保存任务，请稍后重试".to_string())?;
        let current = match fs::read(&self.file_path) {
            Ok(bytes) => Some(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.to_string()),
        };
        if current != self.disk_revision {
            return Err("任务数据已被其他进程修改，本次保存已取消；请刷新数据或重启程序后再试".to_string());
        }

        if let Some(ref old_bytes) = current {
            self.maybe_backup_before_save(old_bytes, backup_mode)?;
        }

        let tmp_path = self.file_path.with_extension("tmp");
        let content = serde_json::to_string_pretty(&self.data).map_err(|e| e.to_string())?;
        fs::write(&tmp_path, &content).map_err(|e| e.to_string())?;
        fs::rename(&tmp_path, &self.file_path).map_err(|e| e.to_string())?;
        self.disk_revision = Some(content.into_bytes());
        Ok(())
    }

    pub fn push_undo(&mut self, action: &str) {
        self.push_snapshot(action, UndoSnapshot::Tasks(self.data.tasks.clone()));
    }

    fn push_snapshot(&mut self, action: &str, snapshot: UndoSnapshot) {
        self.undo_stack.push(UndoEntry {
            action: action.to_string(),
            snapshot,
        });
        if self.undo_stack.len() > 30 {
            self.undo_stack.remove(0);
        }
    }

    pub fn undo(&mut self) -> Result<String, String> {
        let entry = self.undo_stack.last().cloned().ok_or("No actions to undo")?;
        let before = self.data.clone();
        match entry.snapshot {
            UndoSnapshot::Tasks(tasks) => self.data.tasks = tasks,
            UndoSnapshot::Notes(notes) => self.data.notes = notes,
            UndoSnapshot::Reports(reports, deleted) => {
                self.data.weekly_reports = reports;
                self.data.deleted_weekly_reports = deleted;
            }
            UndoSnapshot::Import(mut data) => {
                data.config = self.data.config.clone();
                self.data = data;
            }
        }
        if let Err(e) = self.save() {
            self.data = before;
            return Err(e);
        }
        self.undo_stack.pop();
        Ok(entry.action)
    }

    pub fn can_undo(&self) -> bool {
        !self.undo_stack.is_empty()
    }

    pub fn clear_undo(&mut self) {
        self.undo_stack.clear();
    }

    pub fn undo_list(&self) -> Vec<String> {
        self.undo_stack.iter().map(|e| e.action.clone()).collect()
    }

    fn transaction<T>(&mut self, operation: impl FnOnce(&mut Self) -> Result<T, String>) -> Result<T, String> {
        self.transaction_with_mode(SaveBackupMode::Normal, operation)
    }

    fn transaction_with_mode<T>(&mut self, backup_mode: SaveBackupMode, operation: impl FnOnce(&mut Self) -> Result<T, String>) -> Result<T, String> {
        let before = self.data.clone();
        let history = self.undo_stack.clone();
        let result = operation(self).and_then(|value| self.save_with_mode(backup_mode).map(|()| value));
        match result {
            Ok(result) => Ok(result),
            Err(error) => { self.data = before; self.undo_stack = history; Err(error) }
        }
    }

    pub fn create_task(&mut self, task: Task) -> Result<Task, String> {
        self.transaction(|store| store.create_task_inner(task))
    }

    pub fn batch_create_tasks(&mut self, tasks: Vec<Task>) -> Result<Vec<Task>, String> {
        self.transaction(|store| store.batch_create_tasks_inner(tasks))
    }

    pub fn update_task(&mut self, id: &str, updates: Value) -> Result<Task, String> {
        self.transaction(|store| store.update_task_inner(id, updates))
    }

    pub fn complete_task(&mut self, id: &str) -> Result<(Task, Vec<Task>), String> {
        self.transaction(|store| store.complete_task_inner(id))
    }

    pub fn uncomplete_task(&mut self, id: &str) -> Result<Task, String> {
        self.transaction(|store| store.uncomplete_task_inner(id))
    }

    pub fn delete_task(&mut self, id: &str) -> Result<Vec<String>, String> {
        self.transaction(|store| store.delete_task_inner(id))
    }

    pub fn batch_complete_tasks(&mut self, ids: Vec<String>) -> Result<Vec<String>, String> {
        self.transaction(|store| store.batch_complete_tasks_inner(ids))
    }

    pub fn batch_uncomplete_tasks(&mut self, ids: Vec<String>) -> Result<Vec<String>, String> {
        self.transaction(|store| store.batch_uncomplete_tasks_inner(ids))
    }

    pub fn batch_delete_tasks(&mut self, ids: Vec<String>) -> Result<usize, String> {
        self.transaction(|store| store.batch_delete_tasks_inner(ids))
    }

    pub fn batch_set_priority(&mut self, ids: Vec<String>, priority: Option<&str>) -> Result<usize, String> {
        self.transaction(|store| store.batch_set_priority_inner(ids, priority))
    }

    pub fn reorder_tasks(&mut self, items: Vec<Value>) -> Result<bool, String> {
        self.transaction(|store| store.reorder_tasks_inner(items))
    }

    pub fn cleanup_tasks(&mut self) -> Result<usize, String> {
        self.transaction(|store| store.cleanup_tasks_inner())
    }

    pub fn generate_report(&mut self, week_id: &str) -> Result<WeeklyReport, String> {
        self.transaction(|store| store.generate_report_inner(week_id))
    }

    pub fn update_report(&mut self, week_id: &str, updates: Value) -> Result<WeeklyReport, String> {
        self.transaction(|store| store.update_report_inner(week_id, updates))
    }

    pub fn delete_report(&mut self, week_id: &str) -> Result<bool, String> {
        self.transaction(|store| store.delete_report_inner(week_id))
    }

    pub fn create_note(&mut self, input: Value) -> Result<Note, String> {
        self.transaction(|store| store.create_note_inner(input))
    }

    pub fn update_note(&mut self, id: &str, updates: Value) -> Result<Note, String> {
        self.transaction(|store| store.update_note_inner(id, updates))
    }

    pub fn delete_note(&mut self, id: &str) -> Result<bool, String> {
        self.transaction(|store| store.delete_note_inner(id))
    }

    pub fn reorder_notes(&mut self, items: Vec<Value>) -> Result<bool, String> {
        self.transaction(|store| store.reorder_notes_inner(items))
    }

    pub fn update_config(&mut self, updates: Value) -> Result<AppConfig, String> {
        self.transaction(|store| store.update_config_inner(updates))
    }

    pub fn import_snapshot(&mut self, snapshot: Value, mode: &str) -> Result<Value, String> {
        let backup_mode = if mode != "merge" {
            SaveBackupMode::PreImport
        } else {
            SaveBackupMode::Normal
        };
        self.transaction_with_mode(backup_mode, |store| store.import_snapshot_inner(snapshot, mode))
    }

    // ==================== Task Queries ====================
    pub fn get_all_tasks(&self) -> Vec<Task> {
        self.data.tasks.clone()
    }

    pub fn get_active_tasks(&self) -> Vec<Task> {
        self.data.tasks.iter().filter(|t| !t.completed).cloned().collect()
    }

    pub fn get_completed_tasks(&self) -> Vec<Task> {
        self.data.tasks.iter().filter(|t| t.completed).cloned().collect()
    }

    pub fn get_task(&self, id: &str) -> Option<&Task> {
        self.data.tasks.iter().find(|t| t.id == id)
    }

    // Validate the proposed tree before changing live state or the undo stack.
    fn validate_tasks(tasks: &[Task]) -> Result<(), String> {
        let mut by_id = HashMap::new();
        for task in tasks {
            if task.id.trim().is_empty() || by_id.insert(task.id.as_str(), task).is_some() {
                return Err("任务 ID 为空或重复".to_string());
            }
        }
        for task in tasks {
            let mut visited = HashSet::from([task.id.as_str()]);
            let mut parent_id = task.parent_id.as_deref();
            let mut level = 0;
            while let Some(pid) = parent_id {
                if !visited.insert(pid) {
                    return Err("任务层级存在循环引用".to_string());
                }
                let parent = by_id.get(pid).ok_or("父任务不存在")?;
                if !task.completed && parent.completed {
                    return Err("未完成任务不能隶属于已完成任务，请先恢复父任务".to_string());
                }
                level += 1;
                parent_id = parent.parent_id.as_deref();
            }
            if !task.completed && level > MAX_TASK_LEVEL {
                return Err("此操作会导致任务层级超过五层限制".to_string());
            }
        }
        Ok(())
    }

    // ==================== Hierarchy & Depth ====================
    pub fn compute_level(&self, task: &Task) -> usize {
        let mut level = 0;
        let mut cur_pid = task.parent_id.as_deref();
        let mut visited = HashSet::new();
        visited.insert(task.id.as_str());

        while let Some(pid) = cur_pid {
            if visited.contains(pid) {
                break;
            }
            visited.insert(pid);
            level += 1;
            if let Some(parent) = self.get_task(pid) {
                cur_pid = parent.parent_id.as_deref();
            } else {
                break;
            }
        }
        level
    }

    pub fn get_subtree_max_depth(&self, task_id: &str) -> usize {
        let mut visited = HashSet::new();
        visited.insert(task_id.to_string());
        self.get_subtree_max_depth_inner(task_id, &mut visited)
    }

    fn get_subtree_max_depth_inner(&self, task_id: &str, visited: &mut HashSet<String>) -> usize {
        let children: Vec<&Task> = self.data.tasks.iter()
            .filter(|t| t.parent_id.as_deref() == Some(task_id) && !t.completed)
            .collect();

        if children.is_empty() {
            return 1;
        }

        let mut max = 1;
        for c in children {
            if visited.contains(&c.id) {
                continue;
            }
            visited.insert(c.id.clone());
            let d = self.get_subtree_max_depth_inner(&c.id, visited);
            if d + 1 > max {
                max = d + 1;
            }
        }
        max
    }

    // ==================== AutoPlan Propagation ====================
    pub fn propagate_dates_to_ancestors(&mut self, start_id: &str, skip_start_id: bool) {
        self.propagate_dates_from_seeds(vec![(start_id.to_string(), skip_start_id)]);
    }

    fn merge_date_range(
        min_start: &mut Option<String>,
        max_deadline: &mut Option<String>,
        sd: Option<&str>,
        dl: Option<&str>,
    ) {
        if let Some(s) = sd {
            if min_start.as_deref().is_none_or(|cur| s < cur) {
                *min_start = Some(s.to_string());
            }
        }
        if let Some(d) = dl {
            if max_deadline.as_deref().is_none_or(|cur| d > cur) {
                *max_deadline = Some(d.to_string());
            }
        }
    }

    fn propagate_dates_from_seeds(&mut self, seeds: Vec<(String, bool)>) {
        if !self.data.config.auto_plan || seeds.is_empty() || self.data.tasks.is_empty() {
            return;
        }

        let n = self.data.tasks.len();
        let mut id_to_idx: HashMap<String, usize> = HashMap::with_capacity(n);
        for (i, t) in self.data.tasks.iter().enumerate() {
            id_to_idx.insert(t.id.clone(), i);
        }

        let mut parent_idx: Vec<Option<usize>> = vec![None; n];
        let mut active_children: Vec<Vec<usize>> = vec![Vec::new(); n];
        for (i, t) in self.data.tasks.iter().enumerate() {
            if let Some(ref pid) = t.parent_id {
                if let Some(&p) = id_to_idx.get(pid) {
                    parent_idx[i] = Some(p);
                    if !t.completed {
                        active_children[p].push(i);
                    }
                }
            }
        }

        let mut affected_set: HashSet<usize> = HashSet::new();
        for (seed_id, skip_self) in seeds {
            let mut cur = id_to_idx.get(&seed_id).copied();
            if skip_self {
                cur = cur.and_then(|i| parent_idx[i]);
            }
            while let Some(idx) = cur {
                if !affected_set.insert(idx) {
                    break;
                }
                cur = parent_idx[idx];
            }
        }

        if affected_set.is_empty() {
            return;
        }

        let mut depth: Vec<Option<usize>> = vec![None; n];
        let mut affected_list: Vec<usize> = affected_set.into_iter().collect();
        for &start in &affected_list {
            if depth[start].is_some() {
                continue;
            }
            let mut chain = Vec::new();
            let mut cur = Some(start);
            let mut guard = 0usize;
            let mut base_depth = 0usize;
            while let Some(idx) = cur {
                if let Some(d) = depth[idx] {
                    base_depth = d + 1;
                    break;
                }
                if guard >= n {
                    break;
                }
                chain.push(idx);
                cur = parent_idx[idx];
                guard += 1;
            }
            for (offset, &idx) in chain.iter().rev().enumerate() {
                depth[idx] = Some(base_depth + offset);
            }
        }

        affected_list.sort_by(|&a, &b| depth[b].unwrap_or(0).cmp(&depth[a].unwrap_or(0)));

        // Memoized active subtree (min_start, max_deadline) including the node itself once finalized.
        let mut memo: Vec<Option<(Option<String>, Option<String>)>> = vec![None; n];

        for u in affected_list {
            if active_children[u].is_empty() {
                continue;
            }

            let mut desc_min: Option<String> = None;
            let mut desc_max: Option<String> = None;

            for &child in &active_children[u] {
                if memo[child].is_none() {
                    let mut post_stack: Vec<(usize, bool)> = vec![(child, false)];
                    let mut seen: HashSet<usize> = HashSet::new();
                    while let Some((v, ready)) = post_stack.pop() {
                        if memo[v].is_some() {
                            continue;
                        }
                        if ready {
                            let mut ms = self.data.tasks[v].start_date.clone();
                            let mut md = self.data.tasks[v].deadline.clone();
                            for &gc in &active_children[v] {
                                if let Some((ref cms, ref cmd)) = memo[gc] {
                                    Self::merge_date_range(&mut ms, &mut md, cms.as_deref(), cmd.as_deref());
                                }
                            }
                            memo[v] = Some((ms, md));
                        } else if seen.insert(v) {
                            post_stack.push((v, true));
                            for &gc in &active_children[v] {
                                if memo[gc].is_none() {
                                    post_stack.push((gc, false));
                                }
                            }
                        }
                    }
                }
                if let Some((ref cms, ref cmd)) = memo[child] {
                    Self::merge_date_range(&mut desc_min, &mut desc_max, cms.as_deref(), cmd.as_deref());
                }
            }

            if let Some(ref ms) = desc_min {
                if self.data.tasks[u].start_date.as_ref() != Some(ms) {
                    self.data.tasks[u].start_date = Some(ms.clone());
                }
            }
            if let Some(ref md) = desc_max {
                if self.data.tasks[u].deadline.as_ref() != Some(md) {
                    self.data.tasks[u].deadline = Some(md.clone());
                }
            }

            let mut self_min = self.data.tasks[u].start_date.clone();
            let mut self_max = self.data.tasks[u].deadline.clone();
            Self::merge_date_range(&mut self_min, &mut self_max, desc_min.as_deref(), desc_max.as_deref());
            memo[u] = Some((self_min, self_max));
        }
    }

    // ==================== Task Mutations ====================
    fn create_task_inner(&mut self, mut task: Task) -> Result<Task, String> {
        if task.id.is_empty() {
            task.id = Uuid::new_v4().to_string();
        }

        if task.content.trim().is_empty() { return Err("任务内容不能为空".into()); }

        // Validate hierarchy limit
        if let Some(ref pid) = task.parent_id {
            if let Some(parent) = self.get_task(pid) {
                let p_level = self.compute_level(parent);
                if p_level >= MAX_TASK_LEVEL {
                    return Err(format!("Cannot add child task: maximum nesting level ({}) reached", MAX_TASK_LEVEL + 1));
                }
            }
        }

        let now = Utc::now().to_rfc3339();
        if task.created_at.is_none() {
            task.created_at = Some(now.clone());
        }
        task.updated_at = Some(now);
        task.completed = false;

        let task_id = task.id.clone();
        self.push_undo("创建任务");
        self.data.tasks.push(task.clone());
        Self::validate_tasks(&self.data.tasks)?;

        if self.data.config.auto_plan {
            self.propagate_dates_to_ancestors(&task_id, false);
        }

        Ok(task)
    }

    fn batch_create_tasks_inner(&mut self, tasks: Vec<Task>) -> Result<Vec<Task>, String> {
        let mut created = Vec::new();
        self.push_undo("批量创建任务");
        let now = Utc::now().to_rfc3339();

        for mut t in tasks {
            if t.id.is_empty() {
                t.id = Uuid::new_v4().to_string();
            }
            if t.created_at.is_none() {
                t.created_at = Some(now.clone());
            }
            t.updated_at = Some(now.clone());
            t.completed = false;
            created.push(t.clone());
            self.data.tasks.push(t);
        }

        Self::validate_tasks(&self.data.tasks)?;
        if created.iter().any(|t| t.content.trim().is_empty()) { return Err("任务内容不能为空".into()); }
        if self.data.config.auto_plan {
            let seeds: Vec<(String, bool)> = created.iter().map(|t| (t.id.clone(), false)).collect();
            self.propagate_dates_from_seeds(seeds);
        }

        Ok(created)
    }

    fn update_task_inner(&mut self, id: &str, updates: Value) -> Result<Task, String> {
        let task_idx = self.data.tasks.iter().position(|t| t.id == id).ok_or_else(|| "Task not found".to_string())?;
        self.push_undo("更新任务");

        let old_parent = self.data.tasks[task_idx].parent_id.clone();
        let mut new_parent_changed = false;

        if let Value::Object(map) = updates {
            let task = &mut self.data.tasks[task_idx];
            for (k, v) in map {
                match k.as_str() {
                    "content" => if let Some(s) = v.as_str() { task.content = s.to_string(); },
                    "notes" => task.notes = v.as_str().map(|s| s.to_string()),
                    "deadline" => task.deadline = v.as_str().map(|s| s.to_string()),
                    "startDate" => task.start_date = v.as_str().map(|s| s.to_string()),
                    "priority" => task.priority = v.as_str().map(|s| s.to_string()),
                    "status" => task.status = v.as_str().map(|s| s.to_string()),
                    "order" => task.order = Some(v.clone()),
                    "parentId" => {
                        let np = v.as_str().map(|s| s.to_string());
                        if np != task.parent_id {
                            task.parent_id = np;
                            new_parent_changed = true;
                        }
                    }
                    "id" | "completed" | "completedAt" | "createdAt" | "updatedAt" => {},
                    _ => {
                        task.extra.insert(k, v);
                    }
                }
            }
            task.updated_at = Some(Utc::now().to_rfc3339());
        }

        Self::validate_tasks(&self.data.tasks)?;
        if self.data.tasks[task_idx].content.trim().is_empty() { return Err("任务内容不能为空".into()); }
        if self.data.config.auto_plan {
            let mut seeds = vec![(id.to_string(), true)];
            if new_parent_changed {
                if let Some(ref op) = old_parent {
                    seeds.push((op.clone(), false));
                }
            }
            self.propagate_dates_from_seeds(seeds);
        }

        Ok(self.data.tasks[task_idx].clone())
    }

    fn complete_task_inner(&mut self, id: &str) -> Result<(Task, Vec<Task>), String> {
        let task_idx = self.data.tasks.iter().position(|t| t.id == id).ok_or_else(|| "Task not found".to_string())?;
        self.push_undo("完成任务");

        let now = Utc::now().to_rfc3339();
        self.data.tasks[task_idx].completed = true;
        self.data.tasks[task_idx].completed_at = Some(now.clone());
        self.data.tasks[task_idx].updated_at = Some(now.clone());

        let target_task = self.data.tasks[task_idx].clone();

        // Cascade complete descendants
        let mut affected = Vec::new();
        let mut queue = vec![id.to_string()];
        while let Some(pid) = queue.pop() {
            let child_ids: Vec<String> = self.data.tasks.iter()
                .filter(|t| t.parent_id.as_deref() == Some(&pid) && !t.completed)
                .map(|t| t.id.clone())
                .collect();

            for cid in child_ids {
                if let Some(t) = self.data.tasks.iter_mut().find(|t| t.id == cid) {
                    t.completed = true;
                    t.completed_at = Some(now.clone());
                    t.updated_at = Some(now.clone());
                    affected.push(t.clone());
                }
                queue.push(cid);
            }
        }

        if self.data.config.auto_plan {
            if let Some(ref pid) = target_task.parent_id {
                self.propagate_dates_to_ancestors(pid, false);
            }
        }

        Ok((target_task, affected))
    }

    fn uncomplete_task_inner(&mut self, id: &str) -> Result<Task, String> {
        let task_idx = self.data.tasks.iter().position(|t| t.id == id).ok_or_else(|| "Task not found".to_string())?;
        self.push_undo("恢复任务");

        let old_parent_id = self.data.tasks[task_idx].parent_id.clone();
        let now = Utc::now().to_rfc3339();

        // 自动剥离已完成父级
        let mut detached_from_parent = false;
        if let Some(ref opid) = old_parent_id {
            if let Some(parent) = self.data.tasks.iter().find(|t| t.id == *opid) {
                if parent.completed {
                    let prefix = format!("[原属: {}] ", parent.content);
                    let task = &mut self.data.tasks[task_idx];
                    if !task.content.starts_with(&prefix) {
                        task.content = format!("{}{}", prefix, task.content);
                    }
                    task.parent_id = None;
                    detached_from_parent = true;
                }
            }
        }

        let task = &mut self.data.tasks[task_idx];
        task.completed = false;
        task.completed_at = None;
        task.updated_at = Some(now);

        let res_task = task.clone();
        Self::validate_tasks(&self.data.tasks)?;

        if self.data.config.auto_plan {
            self.propagate_dates_to_ancestors(id, false);
            if detached_from_parent {
                if let Some(ref opid) = old_parent_id {
                    self.propagate_dates_to_ancestors(opid, false);
                }
            }
        }

        Ok(res_task)
    }

    fn delete_task_inner(&mut self, id: &str) -> Result<Vec<String>, String> {
        let parent_id = self.get_task(id).and_then(|t| t.parent_id.clone());
        self.push_undo("删除任务");

        // Collect id and all descendants
        let mut to_delete = HashSet::new();
        to_delete.insert(id.to_string());
        let mut queue = vec![id.to_string()];

        while let Some(pid) = queue.pop() {
            for c in self.data.tasks.iter().filter(|t| t.parent_id.as_deref() == Some(&pid)) {
                if !to_delete.contains(&c.id) {
                    to_delete.insert(c.id.clone());
                    queue.push(c.id.clone());
                }
            }
        }

        let deleted_ids: Vec<String> = to_delete.into_iter().collect();
        self.data.tasks.retain(|t| !deleted_ids.contains(&t.id));

        if self.data.config.auto_plan {
            if let Some(ref pid) = parent_id {
                self.propagate_dates_to_ancestors(pid, false);
            }
        }

        Ok(deleted_ids)
    }

    fn batch_complete_tasks_inner(&mut self, ids: Vec<String>) -> Result<Vec<String>, String> {
        let before = self.data.tasks.clone();
        let undo_len = self.undo_stack.len();
        // Discard per-item snapshots; keep exactly one snapshot for the batch.
        let history = self.undo_stack.clone();
        for id in &ids {
            if self.get_task(id).is_some_and(|t| !t.completed) {
                self.complete_task_inner(id)?;
            }
        }
        self.undo_stack = history;
        debug_assert_eq!(self.undo_stack.len(), undo_len);
        let affected = self.data.tasks.iter().filter(|t| t.completed && before.iter().any(|b| b.id == t.id && !b.completed)).map(|t| t.id.clone()).collect();
        self.push_snapshot("批量完成任务", UndoSnapshot::Tasks(before));
        Ok(affected)
    }

    fn batch_uncomplete_tasks_inner(&mut self, ids: Vec<String>) -> Result<Vec<String>, String> {
        let before = self.data.tasks.clone();
        let history = self.undo_stack.clone();
        let selected: HashSet<&str> = ids.iter().map(String::as_str).collect();
        // Parent-first order prevents a selected child from being detached from a selected parent.
        let mut ordered: Vec<Task> = self.data.tasks.iter().filter(|t| selected.contains(t.id.as_str())).cloned().collect();
        ordered.sort_by_key(|t| self.compute_level(t));
        let mut affected = Vec::new();
        for task in ordered {
            self.uncomplete_task_inner(&task.id)?;
            affected.push(task.id);
        }
        self.undo_stack = history;
        self.push_snapshot("批量恢复任务", UndoSnapshot::Tasks(before));
        Ok(affected)
    }

    fn batch_delete_tasks_inner(&mut self, ids: Vec<String>) -> Result<usize, String> {
        self.push_undo("批量删除任务");
        let initial_len = self.data.tasks.len();
        let mut to_delete = HashSet::new();

        for id in ids {
            to_delete.insert(id.clone());
            let mut queue = vec![id];
            while let Some(pid) = queue.pop() {
                for c in self.data.tasks.iter().filter(|t| t.parent_id.as_deref() == Some(&pid)) {
                    if !to_delete.contains(&c.id) {
                        to_delete.insert(c.id.clone());
                        queue.push(c.id.clone());
                    }
                }
            }
        }

        let affected_parents: HashSet<String> = self.data.tasks.iter()
            .filter(|t| to_delete.contains(&t.id)).filter_map(|t| t.parent_id.clone())
            .filter(|pid| !to_delete.contains(pid)).collect();
        self.data.tasks.retain(|t| !to_delete.contains(&t.id));
        if self.data.config.auto_plan {
            let seeds: Vec<(String, bool)> = affected_parents.into_iter().map(|pid| (pid, false)).collect();
            self.propagate_dates_from_seeds(seeds);
        }
        let count = initial_len - self.data.tasks.len();
        Ok(count)
    }

    fn batch_set_priority_inner(&mut self, ids: Vec<String>, priority: Option<&str>) -> Result<usize, String> {
        self.push_undo("批量设置优先级");
        let now = Utc::now().to_rfc3339();
        let mut count = 0;

        for id in ids {
            if let Some(t) = self.data.tasks.iter_mut().find(|t| t.id == id) {
                t.priority = priority.filter(|p| !p.is_empty()).map(str::to_string);
                t.updated_at = Some(now.clone());
                count += 1;
            }
        }

        Ok(count)
    }

    fn task_order_f64(task: &Task) -> f64 {
        let n = task
            .order
            .as_ref()
            .and_then(|v| v.as_f64())
            .filter(|v| v.is_finite())
            .unwrap_or(0.0);
        if n == 0.0 { 0.0 } else { n }
    }

    fn renormalize_affected_sibling_orders(&mut self, affected_parents: &HashSet<Option<String>>) {
        for pid in affected_parents {
            let mut indices: Vec<usize> = self
                .data
                .tasks
                .iter()
                .enumerate()
                .filter(|(_, t)| !t.completed && &t.parent_id == pid)
                .map(|(i, _)| i)
                .collect();
            if indices.len() <= 1 {
                continue;
            }
            indices.sort_by(|&a, &b| {
                Self::task_order_f64(&self.data.tasks[a])
                    .total_cmp(&Self::task_order_f64(&self.data.tasks[b]))
            });

            let mut needs_renorm = indices.iter().any(|&i| {
                self.data.tasks[i]
                    .order
                    .as_ref()
                    .and_then(|v| v.as_f64())
                    .is_some_and(|n| !n.is_finite())
            });
            if !needs_renorm {
                for pair in indices.windows(2) {
                    let a = Self::task_order_f64(&self.data.tasks[pair[0]]);
                    let b = Self::task_order_f64(&self.data.tasks[pair[1]]);
                    if (b - a).abs() < 1e-6 {
                        needs_renorm = true;
                        break;
                    }
                }
            }
            if needs_renorm {
                for (pos, idx) in indices.into_iter().enumerate() {
                    self.data.tasks[idx].order = Some(json!((pos as i64) * 1000));
                }
            }
        }
    }

    fn reorder_tasks_inner(&mut self, items: Vec<Value>) -> Result<bool, String> {
        let mut affected_parents: HashSet<Option<String>> = HashSet::new();
        self.push_undo("重新排序任务");
        for item in items {
            let id = item.get("id").and_then(Value::as_str).ok_or("缺少任务 ID")?;
            let task = self.data.tasks.iter_mut().find(|t| t.id == id).ok_or("任务不存在")?;
            affected_parents.insert(task.parent_id.clone());
            if let Some(parent) = item.get("parentId") {
                if !parent.is_null() && !parent.is_string() { return Err("父任务 ID 无效".into()); }
                task.parent_id = parent.as_str().filter(|s| !s.is_empty()).map(str::to_string);
            }
            if let Some(order) = item.get("order") { task.order = Some(order.clone()); }
            affected_parents.insert(task.parent_id.clone());
            task.updated_at = Some(Utc::now().to_rfc3339());
        }
        Self::validate_tasks(&self.data.tasks)?;
        self.renormalize_affected_sibling_orders(&affected_parents);
        if self.data.config.auto_plan {
            let seeds: Vec<(String, bool)> = affected_parents
                .into_iter()
                .flatten()
                .map(|pid| (pid, false))
                .collect();
            self.propagate_dates_from_seeds(seeds);
        }
        Ok(true)
    }

    fn cleanup_tasks_inner(&mut self) -> Result<usize, String> {
        let retention_days = self.data.config.task_retention_days;
        if retention_days <= 0 {
            return Ok(0);
        }

        let cutoff = Utc::now() - Duration::days(retention_days);
        let initial_len = self.data.tasks.len();

        self.push_undo("清理已归档任务");
        self.data.tasks.retain(|t| {
            if !t.completed {
                return true;
            }
            if let Some(ref cat) = t.completed_at {
                if let Ok(dt) = DateTime::parse_from_rfc3339(cat) {
                    if dt.with_timezone(&Utc) < cutoff {
                        return false;
                    }
                }
            }
            true
        });

        let surviving_ids: HashSet<String> = self.data.tasks.iter().map(|t| t.id.clone()).collect();
        for task in &mut self.data.tasks {
            if task.parent_id.as_ref().is_some_and(|pid| !surviving_ids.contains(pid)) {
                task.parent_id = None;
                task.updated_at = Some(Utc::now().to_rfc3339());
            }
        }
        let count = initial_len - self.data.tasks.len();
        Ok(count)
    }

    // ==================== Weekly Reports ====================
    pub fn get_week_range(week_id: &str) -> Result<(DateTime<Utc>, DateTime<Utc>), String> {
        let parts: Vec<&str> = week_id.split("-W").collect();
        if parts.len() != 2 {
            return Err("Invalid weekId format (expected YYYY-Www)".to_string());
        }
        let year: i32 = parts[0].parse().map_err(|_| "Invalid year")?;
        let week: u32 = parts[1].parse().map_err(|_| "Invalid week number")?;
        if week == 0 || week > 53 {
            return Err("Invalid week number (must be 1-53)".to_string());
        }

        let target_monday = NaiveDate::from_isoywd_opt(year, week, chrono::Weekday::Mon).ok_or("Invalid ISO week")?;
        let target_sunday = target_monday.checked_add_signed(Duration::days(6)).ok_or("Invalid date")?;

        // Local day boundaries converted to UTC to respect user's local timezone
        let naive_start = target_monday.and_hms_opt(0, 0, 0).unwrap();
        let naive_end = target_sunday.and_hms_nano_opt(23, 59, 59, 999_999_999).unwrap();
        let local_start = naive_start.and_local_timezone(Local).earliest().unwrap_or_else(|| naive_start.and_utc().with_timezone(&Local));
        let local_end = naive_end.and_local_timezone(Local).latest().unwrap_or_else(|| naive_end.and_utc().with_timezone(&Local));

        let start_dt = local_start.with_timezone(&Utc);
        let end_dt = local_end.with_timezone(&Utc);
        Ok((start_dt, end_dt))
    }

    pub fn current_week_id() -> String {
        let now = Local::now();
        format!("{}-W{:02}", now.iso_week().year(), now.iso_week().week())
    }

    pub fn last_week_id() -> String {
        let last = Local::now() - Duration::days(7);
        format!("{}-W{:02}", last.iso_week().year(), last.iso_week().week())
    }

    pub fn list_reports(&self) -> Vec<WeeklyReport> {
        let mut reports = self.data.weekly_reports.clone();
        reports.sort_by(|a, b| b.week_id.cmp(&a.week_id));
        let max = self.data.config.report_retention_weeks as usize;
        reports.truncate(max);
        reports
    }

    pub fn get_report(&self, week_id: &str) -> Option<WeeklyReport> {
        self.data.weekly_reports.iter().find(|r| r.week_id == week_id).cloned()
    }

    pub fn try_auto_weekly_report(&mut self) -> Vec<String> {
        if let Err(error) = self.refresh_from_disk() {
            log::error!("Auto weekly report skipped: {}", error);
            return Vec::new();
        }
        let mut generated = Vec::new();
        let now = Local::now();
        let weekday = now.weekday();
        let hour = now.hour();
        let min = now.minute();

        // 1. 周五 17:30 之后或周末：触发生成本周周报
        let is_friday_after_cutoff = weekday == chrono::Weekday::Fri && (hour > 17 || (hour == 17 && min >= 30));
        let is_weekend = weekday == chrono::Weekday::Sat || weekday == chrono::Weekday::Sun;
        if is_friday_after_cutoff || is_weekend {
            let cur_week = Self::current_week_id();
            if self.get_report(&cur_week).is_none() && !self.data.deleted_weekly_reports.contains(&cur_week) {
                if let Ok(_) = self.generate_report(&cur_week) {
                    generated.push(cur_week);
                }
            }
        }

        // 2. 跨周补漏与终态收尾：检查上周周报
        let last_week = Self::last_week_id();
        if !self.data.deleted_weekly_reports.contains(&last_week) {
            if let Ok((_start, end)) = Self::get_week_range(&last_week) {
                let now_utc = now.with_timezone(&Utc);
                if now_utc > end {
                    let existing = self.get_report(&last_week);
                    let needs_gen = match existing {
                        None => true,
                        Some(ref r) => {
                            if let Ok(gen_dt) = DateTime::parse_from_rfc3339(&r.generated_at) {
                                gen_dt.with_timezone(&Utc) <= end
                            } else {
                                false
                            }
                        }
                    };
                    if needs_gen {
                        if let Ok(_) = self.generate_report(&last_week) {
                            generated.push(last_week);
                        }
                    }
                }
            }
        }

        generated
    }

    pub fn claim_daily_reminder(&mut self, now: DateTime<Local>) -> Result<bool, String> {
        self.refresh_from_disk()?;
        let today = now.format("%Y-%m-%d").to_string();
        let config = &self.data.config;
        if !config.daily_reminder_enabled || config.last_daily_reminder_date.as_deref() == Some(&today) {
            return Ok(false);
        }
        if now.hour() < config.daily_reminder_hour
            || (now.hour() == config.daily_reminder_hour && now.minute() < config.daily_reminder_minute) {
            return Ok(false);
        }
        self.update_config(json!({ "lastDailyReminderDate": today }))?;
        Ok(true)
    }

    fn generate_report_inner(&mut self, week_id: &str) -> Result<WeeklyReport, String> {
        let (start, end) = Self::get_week_range(week_id)?;

        let mut entries = Vec::new();
        for t in self.data.tasks.iter().filter(|t| t.completed && t.completed_at.is_some()) {
            if let Some(ref cat) = t.completed_at {
                if let Ok(dt) = DateTime::parse_from_rfc3339(cat) {
                    let dt_utc = dt.with_timezone(&Utc);
                    if dt_utc >= start && dt_utc <= end {
                        let parent = t.parent_id.as_deref().and_then(|pid| self.get_task(pid));
                        entries.push(WeeklyEntry {
                            task_id: t.id.clone(),
                            content: t.content.clone(),
                            completed_at: cat.clone(),
                            level: self.compute_level(t),
                            parent_content: parent.map(|p| p.content.clone()),
                        });
                    }
                }
            }
        }

        entries.sort_by(|a, b| a.completed_at.cmp(&b.completed_at));

        let existing_notes = self.data.weekly_reports.iter()
            .find(|r| r.week_id == week_id)
            .and_then(|r| r.notes.clone());

        let report = WeeklyReport {
            week_id: week_id.to_string(),
            start_date: start.with_timezone(&Local).format("%Y-%m-%d").to_string(),
            end_date: end.with_timezone(&Local).format("%Y-%m-%d").to_string(),
            generated_at: Utc::now().to_rfc3339(),
            count: entries.len(),
            entries,
            notes: existing_notes,
        };

        self.data.weekly_reports.retain(|r| r.week_id != week_id);
        self.data.weekly_reports.push(report.clone());
        self.data.deleted_weekly_reports.retain(|id| id != week_id);

        let max = self.data.config.report_retention_weeks as usize;
        self.data.weekly_reports.sort_by(|a, b| b.week_id.cmp(&a.week_id));
        self.data.weekly_reports.truncate(max);

        Ok(report)
    }

    fn update_report_inner(&mut self, week_id: &str, updates: Value) -> Result<WeeklyReport, String> {
        self.push_snapshot("更新周报备注", UndoSnapshot::Reports(self.data.weekly_reports.clone(), self.data.deleted_weekly_reports.clone()));
        let report = self.data.weekly_reports.iter_mut().find(|r| r.week_id == week_id).ok_or("Report not found")?;
        if let Some(notes) = updates.get("notes").and_then(|v| v.as_str()) {
            report.notes = Some(notes.to_string());
        }
        let report = report.clone();
        Ok(report)
    }

    fn delete_report_inner(&mut self, week_id: &str) -> Result<bool, String> {
        self.push_snapshot("删除周报", UndoSnapshot::Reports(self.data.weekly_reports.clone(), self.data.deleted_weekly_reports.clone()));
        self.data.weekly_reports.retain(|r| r.week_id != week_id);
        if !self.data.deleted_weekly_reports.contains(&week_id.to_string()) {
            self.data.deleted_weekly_reports.push(week_id.to_string());
        }
        Ok(true)
    }

    // ==================== Notes CRUD ====================
    pub fn get_notes(&self) -> Vec<Note> {
        let mut notes = self.data.notes.clone();
        notes.sort_by(|a, b| {
            if a.pinned && !b.pinned {
                return std::cmp::Ordering::Less;
            }
            if !a.pinned && b.pinned {
                return std::cmp::Ordering::Greater;
            }
            if let (Some(ao), Some(bo)) = (a.order, b.order) {
                return ao.cmp(&bo);
            }
            b.updated_at.cmp(&a.updated_at)
        });
        notes
    }

    fn create_note_inner(&mut self, input: Value) -> Result<Note, String> {
        self.push_snapshot("创建便签", UndoSnapshot::Notes(self.data.notes.clone()));
        let content = input.get("content").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if content.is_empty() {
            return Err("便签内容不能为空".to_string());
        }
        let color = input.get("color").and_then(|v| v.as_str()).unwrap_or("default").to_string();
        let max_order = self.data.notes.iter()
            .filter(|n| !n.pinned)
            .filter_map(|n| n.order)
            .max()
            .unwrap_or(0);

        let now = Utc::now().to_rfc3339();
        let note = Note {
            id: Uuid::new_v4().to_string(),
            content,
            color,
            pinned: false,
            order: Some(max_order + 1),
            created_at: now.clone(),
            updated_at: now,
            extra: HashMap::new(),
        };

        self.data.notes.push(note.clone());
        Ok(note)
    }

    fn update_note_inner(&mut self, id: &str, updates: Value) -> Result<Note, String> {
        self.push_snapshot("更新便签", UndoSnapshot::Notes(self.data.notes.clone()));
        let note = self.data.notes.iter_mut().find(|n| n.id == id).ok_or("备忘录不存在")?;
        if let Some(c) = updates.get("content").and_then(|v| v.as_str()) {
            note.content = c.trim().to_string();
        }
        if let Some(col) = updates.get("color").and_then(|v| v.as_str()) {
            note.color = col.to_string();
        }
        if let Some(p) = updates.get("pinned").and_then(|v| v.as_bool()) {
            note.pinned = p;
        }
        if let Some(o) = updates.get("order").and_then(|v| v.as_i64()) {
            note.order = Some(o);
        }
        note.updated_at = Utc::now().to_rfc3339();
        let note = note.clone();
        Ok(note)
    }

    fn delete_note_inner(&mut self, id: &str) -> Result<bool, String> {
        self.push_snapshot("删除便签", UndoSnapshot::Notes(self.data.notes.clone()));
        let initial_len = self.data.notes.len();
        self.data.notes.retain(|n| n.id != id);
        if self.data.notes.len() < initial_len {
                Ok(true)
        } else {
            Err("Note not found".to_string())
        }
    }

    fn reorder_notes_inner(&mut self, items: Vec<Value>) -> Result<bool, String> {
        self.push_snapshot("排序便签", UndoSnapshot::Notes(self.data.notes.clone()));
        for item in items {
            if let (Some(id), Some(order)) = (item.get("id").and_then(|v| v.as_str()), item.get("order").and_then(|v| v.as_i64())) {
                if let Some(n) = self.data.notes.iter_mut().find(|n| n.id == id) {
                    n.order = Some(order);
                }
            }
        }
        Ok(true)
    }

    // ==================== Config ====================
    pub fn get_config(&self) -> AppConfig {
        self.data.config.clone()
    }

    fn update_config_inner(&mut self, updates: Value) -> Result<AppConfig, String> {
        if let Value::Object(map) = updates {
            for (k, v) in map {
                match k.as_str() {
                    "taskRetentionDays" => if let Some(n) = v.as_i64() { self.data.config.task_retention_days = n; },
                    "reportRetentionWeeks" => if let Some(n) = v.as_i64() { self.data.config.report_retention_weeks = n; },
                    "autoPlan" => if let Some(b) = v.as_bool() { self.data.config.auto_plan = b; },
                    "theme" => if let Some(s) = v.as_str() { self.data.config.theme = s.to_string(); },
                    "projectScopeIds" => {
                        if let Some(arr) = v.as_array() {
                            self.data.config.project_scope_ids = arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect();
                        }
                    }
                    "widgetProjectScopeIds" => {
                        if let Some(arr) = v.as_array() {
                            self.data.config.widget_project_scope_ids = arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect();
                        }
                    }
                    "lastView" => if let Some(s) = v.as_str() { self.data.config.last_view = s.to_string(); },
                    "dailyReminderEnabled" => if let Some(b) = v.as_bool() { self.data.config.daily_reminder_enabled = b; },
                    "dailyReminderHour" => if let Some(h) = v.as_u64() { self.data.config.daily_reminder_hour = h as u32; },
                    "dailyReminderMinute" => if let Some(m) = v.as_u64() { self.data.config.daily_reminder_minute = m as u32; },
                    "lastDailyReminderDate" => self.data.config.last_daily_reminder_date = v.as_str().map(|s| s.to_string()),
                    _ => {
                        self.data.config.extra.insert(k, v);
                    }
                }
            }
        }
        Ok(self.data.config.clone())
    }

    // ==================== Gantt Data ====================
    pub fn get_gantt_data(&self) -> Vec<GanttTask> {
        let active = self.get_active_tasks();
        let mut sorted = active.clone();
        sorted.sort_by(|a, b| Self::task_order_f64(a).total_cmp(&Self::task_order_f64(b)));

        let mut children_map: HashMap<String, Vec<&Task>> = HashMap::new();
        for t in &sorted {
            let pid = t.parent_id.clone().unwrap_or_else(|| "__root__".to_string());
            children_map.entry(pid).or_default().push(t);
        }

        let mut dfs_order: HashMap<String, usize> = HashMap::new();
        let mut dfs_idx = 0;
        fn walk<'a>(
            pid: &str,
            children_map: &HashMap<String, Vec<&'a Task>>,
            dfs_order: &mut HashMap<String, usize>,
            dfs_idx: &mut usize,
        ) {
            if let Some(children) = children_map.get(pid) {
                for c in children {
                    dfs_order.insert(c.id.clone(), *dfs_idx);
                    *dfs_idx += 1;
                    walk(&c.id, children_map, dfs_order, dfs_idx);
                }
            }
        }
        walk("__root__", &children_map, &mut dfs_order, &mut dfs_idx);

        let today = Local::now().naive_local().date();
        let mut result = Vec::new();
        for t in active.iter().filter(|t| t.deadline.is_some()) {
            let end_str = t.deadline.as_ref().unwrap().clone();
            let start_str = if let Some(ref sd) = t.start_date {
                sd.clone()
            } else if let Some(ref cd) = t.created_at {
                if let Some(c_slice) = cd.trim().get(..10) {
                    if c_slice > end_str.as_str() {
                        end_str.clone()
                    } else {
                        c_slice.to_string()
                    }
                } else {
                    end_str.clone()
                }
            } else {
                end_str.clone()
            };

            let level = self.compute_level(t);
            let order_val = dfs_order.get(&t.id).copied().unwrap_or(99999);
            let (urgency, days_left) = if let Ok(dl) = NaiveDate::parse_from_str(end_str.trim().get(..10).unwrap_or(&end_str), "%Y-%m-%d") {
                let diff = (dl - today).num_days();
                let u = if diff < 0 {
                    "overdue"
                } else if diff == 0 {
                    "today"
                } else if diff <= 7 {
                    "due-soon"
                } else {
                    "normal"
                };
                (Some(u.to_string()), Some(diff))
            } else {
                (None, None)
            };

            result.push(GanttTask {
                id: t.id.clone(),
                content: t.content.clone(),
                start: start_str,
                end: end_str,
                parent_id: t.parent_id.clone(),
                level,
                dfs_order: order_val,
                urgency,
                days_left,
            });
        }

        result.sort_by_key(|t| t.dfs_order);
        result
    }

    pub fn get_scoped_gantt_data(&self, scope_ids: &[String]) -> Vec<GanttTask> {
        let mut items = self.get_gantt_data();
        let cleaned_ids: Vec<String> = scope_ids
            .iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        if cleaned_ids.is_empty() {
            return items;
        }

        let mut children: HashMap<&str, Vec<&str>> = HashMap::new();
        for t in &self.data.tasks {
            if let Some(ref pid) = t.parent_id {
                children.entry(pid.as_str()).or_default().push(t.id.as_str());
            }
        }
        let mut visible: HashSet<&str> = HashSet::new();
        let mut stack: Vec<&str> = cleaned_ids.iter().map(String::as_str).collect();
        while let Some(id) = stack.pop() {
            if !visible.insert(id) {
                continue;
            }
            if let Some(kids) = children.get(id) {
                for kid in kids {
                    stack.push(kid);
                }
            }
        }

        items.retain(|g| visible.contains(g.id.as_str()));
        items
    }

    // ==================== Auto Backups & Recovery ====================
    fn parse_backup_created_at(filename: &str, meta: &fs::Metadata) -> String {
        let stamp_part = Self::backup_sort_key(filename);
        if stamp_part.len() >= 15 && stamp_part.as_bytes()[8] == b'_' {
            let d = &stamp_part[..8];
            let t = &stamp_part[9..15];
            if d.bytes().all(|b| b.is_ascii_digit()) && t.bytes().all(|b| b.is_ascii_digit()) {
                return format!(
                    "{}-{}-{} {}:{}:{}",
                    &d[0..4], &d[4..6], &d[6..8],
                    &t[0..2], &t[2..4], &t[4..6]
                );
            }
        }
        meta.modified()
            .ok()
            .map(|st| DateTime::<Local>::from(st).format("%Y-%m-%d %H:%M:%S").to_string())
            .unwrap_or_default()
    }

    pub fn list_backups(&self) -> Result<Vec<BackupEntry>, String> {
        let dir = self.backup_dir();
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let entries = fs::read_dir(&dir).map_err(|e| format!("读取备份目录失败: {}", e))?;
        let mut list = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let kind = match Self::validate_backup_id(&name) {
                Ok(k) => k,
                Err(_) => continue,
            };
            let Ok(bytes) = fs::read(&path) else { continue };
            let Ok(parsed) = Self::parse_and_validate_app_data(&bytes) else { continue };
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            list.push(BackupEntry {
                created_at: Self::parse_backup_created_at(&name, &meta),
                id: name,
                kind: kind.to_string(),
                task_count: parsed.tasks.len(),
                note_count: parsed.notes.len(),
                report_count: parsed.weekly_reports.len(),
                size_bytes: meta.len(),
            });
        }
        list.sort_by(|a, b| Self::backup_sort_key(&b.id).cmp(&Self::backup_sort_key(&a.id)));
        Ok(list)
    }

    pub fn restore_backup(&mut self, backup_id: &str) -> Result<RestoreBackupResult, String> {
        let _kind = Self::validate_backup_id(backup_id)?;
        let backup_path = self.backup_dir().join(backup_id);
        let backup_bytes = fs::read(&backup_path)
            .map_err(|e| format!("无法读取备份文件 {}: {}", backup_id, e))?;
        let restored = Self::parse_and_validate_app_data(&backup_bytes)
            .map_err(|e| format!("备份文件无效: {}", e))?;

        let parent = self
            .file_path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut lock_path = self.file_path.as_os_str().to_os_string();
        lock_path.push(".lock");
        let lock_file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(PathBuf::from(lock_path))
            .map_err(|e| e.to_string())?;
        lock_file
            .try_lock()
            .map_err(|_| "另一个进程正在保存任务，请稍后重试".to_string())?;

        let current = match fs::read(&self.file_path) {
            Ok(bytes) => Some(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(format!("读取当前任务文件失败: {}", e)),
        };

        let mut corrupt_backup_path: Option<String> = None;
        let mut undo_before: Option<AppData> = None;
        let mut disk_changed_since_load = false;

        if let Some(ref cur_bytes) = current {
            match Self::parse_and_validate_app_data(cur_bytes) {
                Ok(old_data) => {
                    disk_changed_since_load = self.disk_revision.as_ref() != Some(cur_bytes);
                    let dir = self.backup_dir();
                    let today_prefix = format!("daily-{}_", Local::now().format("%Y-%m-%d"));
                    if !Self::has_today_daily_backup(&dir, &today_prefix)? {
                        self.write_backup_bytes("daily", cur_bytes)?;
                    }
                    self.write_backup_bytes("pre-restore", cur_bytes)?;
                    Self::rotate_backups_in(&dir)?;
                    undo_before = Some(old_data);
                }
                Err(_) => {
                    let now = Local::now();
                    let seq = BACKUP_SEQ.fetch_add(1, Ordering::Relaxed) % 10000;
                    let file_name = self
                        .file_path
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or("tasks-data.json");
                    let diag_name = format!(
                        "{}.corrupt-{}_{}-{:04}.bak",
                        file_name,
                        now.format("%Y%m%d"),
                        now.format("%H%M%S%3f"),
                        seq
                    );
                    let diag_path = parent.join(diag_name);
                    Self::atomic_write_bytes(&diag_path, cur_bytes)
                        .map_err(|e| format!("保存损坏文件诊断副本失败，已取消恢复: {}", e))?;
                    corrupt_backup_path = Some(diag_path.to_string_lossy().to_string());
                }
            }
        }

        let content = serde_json::to_string_pretty(&restored).map_err(|e| e.to_string())?;
        Self::atomic_write_bytes(&self.file_path, content.as_bytes())
            .map_err(|e| format!("写入恢复数据失败: {}", e))?;

        let task_count = restored.tasks.len();
        let note_count = restored.notes.len();
        self.data = restored;
        self.disk_revision = Some(content.into_bytes());
        self.pending_external_sync = false;

        let undoable = if let Some(old_data) = undo_before {
            if disk_changed_since_load {
                self.undo_stack.clear();
            }
            self.push_snapshot("恢复备份", UndoSnapshot::Import(old_data));
            true
        } else {
            self.undo_stack.clear();
            false
        };

        Ok(RestoreBackupResult {
            ok: true,
            restored_from: backup_id.to_string(),
            corrupt_backup_path,
            undoable,
            task_count,
            note_count,
        })
    }

    // ==================== Export / Import ====================
    pub fn export_snapshot(&self) -> Value {
        json!({
            "version": "2.0.0",
            "exportedAt": Utc::now().to_rfc3339(),
            "tasks": self.data.tasks,
            "weeklyReports": self.data.weekly_reports,
            "deletedWeeklyReports": self.data.deleted_weekly_reports,
            "notes": self.data.notes,
            "config": self.data.config,
        })
    }

    fn import_snapshot_inner(&mut self, snapshot: Value, mode: &str) -> Result<Value, String> {
        if !["replace", "overwrite", "merge"].contains(&mode) {
            return Err(format!("未知导入模式: {}", mode));
        }
        if !snapshot.get("tasks").is_some_and(Value::is_array) {
            return Err("快照必须包含 tasks 数组".into());
        }
        let imported: AppData = serde_json::from_value(snapshot).map_err(|e| format!("Invalid snapshot format: {}", e))?;
        let before = self.data.clone();
        let mut added_count = 0;
        if mode != "merge" {
            self.data = imported;
        } else {
            fn time(values: &[Option<&str>]) -> i64 {
                values.iter().flatten().filter_map(|s| DateTime::parse_from_rfc3339(s).ok()).map(|d| d.timestamp_millis()).max().unwrap_or(i64::MIN)
            }
            for t in imported.tasks {
                if let Some(existing) = self.data.tasks.iter_mut().find(|e| e.id == t.id) {
                    if time(&[t.updated_at.as_deref(), t.completed_at.as_deref(), t.created_at.as_deref()]) > time(&[existing.updated_at.as_deref(), existing.completed_at.as_deref(), existing.created_at.as_deref()]) { *existing = t; }
                } else { self.data.tasks.push(t); added_count += 1; }
            }
            for n in imported.notes {
                if let Some(existing) = self.data.notes.iter_mut().find(|e| e.id == n.id) {
                    if time(&[Some(&n.updated_at), Some(&n.created_at)]) > time(&[Some(&existing.updated_at), Some(&existing.created_at)]) { *existing = n; }
                } else { self.data.notes.push(n); }
            }
            for id in imported.deleted_weekly_reports {
                if !self.data.deleted_weekly_reports.contains(&id) { self.data.deleted_weekly_reports.push(id); }
            }
            for report in imported.weekly_reports {
                if let Some(existing) = self.data.weekly_reports.iter_mut().find(|e| e.week_id == report.week_id) {
                    if time(&[Some(&report.generated_at)]) > time(&[Some(&existing.generated_at)]) { *existing = report; }
                } else { self.data.weekly_reports.push(report); }
            }
            self.data.weekly_reports.retain(|r| !self.data.deleted_weekly_reports.contains(&r.week_id));
        }
        Self::validate_tasks(&self.data.tasks)?;
        self.push_snapshot("导入数据", UndoSnapshot::Import(before));
        Ok(json!({ "mode": mode, "addedTasks": added_count, "taskCount": self.data.tasks.len(), "totalTasks": self.data.tasks.len() }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_auto_weekly_report_structure() {
        let mut store = DataStore::for_path(PathBuf::from("dummy.json"));

        let cur_week = DataStore::current_week_id();
        assert!(cur_week.contains("-W"));
        let last_week = DataStore::last_week_id();
        assert!(last_week.contains("-W"));

        // If explicitly deleted, auto generation will not restore it
        store.data.deleted_weekly_reports.push(cur_week.clone());
        store.data.deleted_weekly_reports.push(last_week.clone());
        let generated = store.try_auto_weekly_report();
        assert!(generated.is_empty());
    }
}
