use super::*;

struct TestStore(DataStore);
impl TestStore {
    fn new() -> Self {
        Self(DataStore::for_path(std::env::temp_dir().join(format!("module-audit-{}.json", Uuid::new_v4()))))
    }
}
impl Drop for TestStore {
    fn drop(&mut self) {
        let dir = self.0.backup_dir();
        if dir.exists() {
            let _ = fs::remove_dir_all(&dir);
        }
        if let Some(parent) = self.0.file_path.parent() {
            if let Some(fname) = self.0.file_path.file_name().and_then(|s| s.to_str()) {
                let prefix = format!("{}.corrupt-", fname);
                if let Ok(entries) = fs::read_dir(parent) {
                    for e in entries.flatten() {
                        if e.file_name().to_string_lossy().starts_with(&prefix) {
                            let _ = fs::remove_file(e.path());
                        }
                    }
                }
            }
        }
        let _ = fs::remove_file(&self.0.file_path);
        let _ = fs::remove_file(self.0.file_path.with_extension("tmp"));
        let _ = fs::remove_file(format!("{}.lock", self.0.file_path.display()));
    }
}
fn task(id: &str, parent: Option<&str>) -> Task {
    serde_json::from_value(json!({"id": id, "content": id, "parentId": parent})).unwrap()
}

#[test]
fn replace_import_replaces_all_collections_and_can_be_undone() {
    let mut fixture = TestStore::new();
    let s = &mut fixture.0;
    s.create_task(task("old", None)).unwrap();
    let note = s.create_note(json!({"content": "keep me"})).unwrap();
    s.import_snapshot(json!({"tasks": [task("new", None)], "notes": []}), "replace").unwrap();
    assert!(s.get_task("old").is_none());
    assert!(s.data.notes.is_empty());
    s.undo().unwrap();
    assert!(s.get_task("old").is_some());
    assert_eq!(s.data.notes[0].id, note.id);
}

#[test]
fn report_undo_restores_notes_and_deletion_tombstone() {
    let mut fixture = TestStore::new();
    let s = &mut fixture.0;
    s.generate_report("2026-W46").unwrap();
    s.update_report("2026-W46", json!({"notes": "draft"})).unwrap();
    s.delete_report("2026-W46").unwrap();
    assert_eq!(s.undo().unwrap(), "删除周报");
    assert_eq!(s.get_report("2026-W46").unwrap().notes.as_deref(), Some("draft"));
    assert!(s.data.deleted_weekly_reports.is_empty());
    s.undo().unwrap();
    assert!(s.get_report("2026-W46").unwrap().notes.is_none());
}

#[test]
fn note_undo_does_not_revert_tasks_or_config() {
    let mut fixture = TestStore::new();
    let s = &mut fixture.0;
    s.create_task(task("a", None)).unwrap();
    let n = s.create_note(json!({"content": "draft"})).unwrap();
    s.update_note(&n.id, json!({"content": "edited"})).unwrap();
    s.update_config(json!({"theme": "dark"})).unwrap();
    s.undo().unwrap();
    assert_eq!(s.data.notes[0].content, "draft");
    assert_eq!(s.data.config.theme, "dark");
    assert!(s.get_task("a").is_some());
}

#[test]
fn update_rejects_cycles_and_missing_parents_without_mutation() {
    let mut fixture = TestStore::new();
    let s = &mut fixture.0;
    s.batch_create_tasks(vec![task("a", None), task("b", Some("a"))]).unwrap();
    let before = s.export_snapshot()["tasks"].clone();
    let undo_len = s.undo_stack.len();
    assert!(s.update_task("a", json!({"parentId": "b"})).is_err());
    assert_eq!(s.export_snapshot()["tasks"], before);
    assert_eq!(s.undo_stack.len(), undo_len);
    assert!(s.update_task("a", json!({"parentId": "missing"})).is_err());
}

#[test]
fn create_and_batch_reject_duplicate_ids_and_excess_depth() {
    let mut fixture = TestStore::new();
    let s = &mut fixture.0;
    s.create_task(task("a", None)).unwrap();
    assert!(s.create_task(task("a", None)).is_err());
    let chain: Vec<Task> = (0..6).map(|i| task(&format!("t{i}"), if i == 0 { None } else { Some("unused") }))
        .enumerate().map(|(i, mut t)| { t.parent_id = if i == 0 { None } else { Some(format!("t{}", i-1)) }; t }).collect();
    assert!(s.batch_create_tasks(chain).is_err());
    assert_eq!(s.data.tasks.len(), 1);
}

#[test]
fn invalid_reorder_is_atomic() {
    let mut fixture = TestStore::new();
    let s = &mut fixture.0;
    s.batch_create_tasks(vec![task("a", None), task("b", None)]).unwrap();
    let before = s.export_snapshot()["tasks"].clone();
    let undo_len = s.undo_stack.len();
    assert!(s.reorder_tasks(vec![json!({"id": "a", "order": 99}), json!({"id": "b", "parentId": "b"})]).is_err());
    assert_eq!(s.export_snapshot()["tasks"], before);
    assert_eq!(s.undo_stack.len(), undo_len);
}

#[test]
fn batch_complete_includes_descendants_and_batch_restore_detaches_completed_parent() {
    let mut fixture = TestStore::new();
    let s = &mut fixture.0;
    s.batch_create_tasks(vec![task("a", None), task("b", Some("a")), task("c", Some("b"))]).unwrap();
    let affected = s.batch_complete_tasks(vec!["a".into()]).unwrap();
    assert_eq!(affected.len(), 3);
    assert!(s.data.tasks.iter().all(|t| t.completed));
    s.batch_uncomplete_tasks(vec!["b".into()]).unwrap();
    assert!(s.get_task("b").unwrap().parent_id.is_none());
    assert!(!s.get_task("b").unwrap().completed);
}

#[test]
fn failed_undo_keeps_state_and_history_for_retry() {
    let mut fixture = TestStore::new();
    let s = &mut fixture.0;
    s.create_task(task("a", None)).unwrap();
    let original_path = s.file_path.clone();
    s.file_path = original_path.join("cannot-write.json");
    assert!(s.undo().is_err());
    assert!(s.get_task("a").is_some());
    assert_eq!(s.undo_stack.len(), 1);
    s.file_path = original_path;
    s.undo().unwrap();
    assert!(s.data.tasks.is_empty());
}

#[test]
fn invalid_import_does_not_change_data_or_undo_history() {
    let mut fixture = TestStore::new();
    let s = &mut fixture.0;
    s.create_task(task("a", None)).unwrap();
    let undo_len = s.undo_stack.len();
    assert!(s.import_snapshot(json!({"tasks": [task("x", Some("x"))]}), "replace").is_err());
    assert!(s.get_task("a").is_some());
    assert_eq!(s.undo_stack.len(), undo_len);
    assert!(s.import_snapshot(json!({"tasks": []}), "typo").is_err());
}

#[test]
fn merge_restores_newer_tasks_notes_and_reports_but_respects_tombstones() {
    let mut fixture = TestStore::new();
    let s = &mut fixture.0;
    s.create_task(task("a", None)).unwrap();
    let n = s.create_note(json!({"content": "old note"})).unwrap();
    let mut snapshot = s.export_snapshot();
    snapshot["tasks"][0]["content"] = json!("newer task");
    snapshot["tasks"][0]["updatedAt"] = json!("2099-01-01T00:00:00Z");
    snapshot["notes"][0]["content"] = json!("newer note");
    snapshot["notes"][0]["updatedAt"] = json!("2099-01-01T00:00:00Z");
    let report = s.generate_report("2026-W46").unwrap();
    snapshot["weeklyReports"] = json!([report]);
    s.delete_report("2026-W46").unwrap();
    s.import_snapshot(snapshot, "merge").unwrap();
    assert_eq!(s.get_task("a").unwrap().content, "newer task");
    assert_eq!(s.get_notes().iter().find(|note| note.id == n.id).unwrap().content, "newer note");
    assert!(s.get_report("2026-W46").is_none());
}

#[test]
fn cleanup_promotes_surviving_children_instead_of_hiding_them() {
    let mut fixture = TestStore::new();
    let s = &mut fixture.0;
    s.batch_create_tasks(vec![task("a", None), task("b", Some("a"))]).unwrap();
    let parent = s.data.tasks.iter_mut().find(|t| t.id == "a").unwrap();
    parent.completed = true;
    parent.completed_at = Some("2000-01-01T00:00:00Z".into());
    assert_eq!(s.cleanup_tasks().unwrap(), 1);
    assert!(s.get_task("b").unwrap().parent_id.is_none());
    s.create_task(task("c", None)).unwrap();
    s.undo().unwrap();
    s.undo().unwrap();
    assert_eq!(s.get_task("b").unwrap().parent_id.as_deref(), Some("a"));
}

#[test]
fn auto_plan_batch_delete_updates_parent_and_manual_dates_remain_authoritative() {
    let mut fixture = TestStore::new();
    let s = &mut fixture.0;
    s.data.config.auto_plan = true;
    s.batch_create_tasks(vec![task("a", None), task("b", Some("a")), task("c", Some("a"))]).unwrap();
    s.update_task("b", json!({"deadline": "2026-11-20"})).unwrap();
    s.update_task("c", json!({"deadline": "2026-11-30"})).unwrap();
    s.batch_delete_tasks(vec!["c".into()]).unwrap();
    assert_eq!(s.get_task("a").unwrap().deadline.as_deref(), Some("2026-11-20"));
    s.update_task("a", json!({"deadline": "2026-12-01"})).unwrap();
    assert_eq!(s.get_task("a").unwrap().deadline.as_deref(), Some("2026-12-01"));
}

#[test]
fn weekly_report_includes_the_last_fractional_second_and_rejects_nonexistent_iso_weeks() {
    assert!(DataStore::get_week_range("2021-W53").is_err());
    let mut fixture = TestStore::new();
    let s = &mut fixture.0;
    s.create_task(task("a", None)).unwrap();
    let (_, end) = DataStore::get_week_range("2026-W46").unwrap();
    s.data.tasks[0].completed = true;
    s.data.tasks[0].completed_at = Some((end - Duration::nanoseconds(1)).to_rfc3339());
    assert_eq!(s.generate_report("2026-W46").unwrap().count, 1);
    let sunday = NaiveDate::from_ymd_opt(2026, 11, 15).unwrap().and_hms_milli_opt(23, 59, 59, 500).unwrap().and_local_timezone(Local).unwrap();
    s.data.tasks[0].completed_at = Some(sunday.to_rfc3339());
    assert_eq!(s.generate_report("2026-W46").unwrap().count, 1);
}

#[test]
fn failed_write_rolls_back_data_and_history() {
    let mut fixture = TestStore::new();
    let s = &mut fixture.0;
    s.create_task(task("a", None)).unwrap();
    let original = s.file_path.clone();
    let history_len = s.undo_stack.len();
    s.file_path = original.join("cannot-write.json");
    assert!(s.update_task("a", json!({"content": "unsaved"})).is_err());
    assert_eq!(s.get_task("a").unwrap().content, "a");
    assert_eq!(s.undo_stack.len(), history_len);
    s.file_path = original;
    let on_disk: AppData = serde_json::from_str(&fs::read_to_string(&s.file_path).unwrap()).unwrap();
    assert_eq!(on_disk.tasks[0].content, "a");
}

#[test]
fn stale_process_cannot_overwrite_another_process_changes() {
    let mut fixture = TestStore::new();
    let first = &mut fixture.0;
    first.create_task(task("a", None)).unwrap();
    let mut second = DataStore::for_path(first.file_path.clone());
    second.load();
    first.create_task(task("b", None)).unwrap();
    assert!(second.update_task("a", json!({"content": "stale overwrite"})).is_err());
    let disk: AppData = serde_json::from_slice(&fs::read(&first.file_path).unwrap()).unwrap();
    assert_eq!(disk.tasks.len(), 2);
    assert_eq!(disk.tasks[0].content, "a");
    assert!(second.undo_stack.is_empty());
    second.load();
    second.update_task("a", json!({"content": "after reload"})).unwrap();
    assert!(second.get_task("b").is_some());
}

#[test]
fn competing_writer_lock_rejects_save_without_mutating_memory() {
    let mut fixture = TestStore::new();
    let s = &mut fixture.0;
    s.create_task(task("a", None)).unwrap();
    let lock = fs::OpenOptions::new().read(true).write(true).open(format!("{}.lock", s.file_path.display())).unwrap();
    lock.try_lock().unwrap();
    assert!(s.create_task(task("b", None)).is_err());
    assert!(s.get_task("b").is_none());
    drop(lock);
    s.create_task(task("b", None)).unwrap();
}

#[test]
fn refresh_rejects_corrupted_external_data_without_resetting_memory() {
    let mut fixture = TestStore::new();
    let s = &mut fixture.0;
    s.create_task(task("a", None)).unwrap();
    fs::write(&s.file_path, "{incomplete json").unwrap();
    assert!(s.refresh_from_disk().is_err());
    assert_eq!(s.get_task("a").unwrap().content, "a");
    assert!(s.create_task(task("b", None)).is_err());
    assert_eq!(fs::read_to_string(&s.file_path).unwrap(), "{incomplete json");
}

#[test]
fn task_undo_preserves_reports_generated_after_the_task_operation() {
    let mut fixture = TestStore::new();
    let s = &mut fixture.0;
    s.create_task(task("a", None)).unwrap();
    s.generate_report("2026-W46").unwrap();
    s.undo().unwrap();
    assert!(s.data.tasks.is_empty());
    assert!(s.get_report("2026-W46").is_some());
}

#[test]
fn startup_load_error_preserves_memory_and_refuses_to_overwrite_damaged_file() {
    let mut fixture = TestStore::new();
    let s = &mut fixture.0;
    s.create_task(task("a", None)).unwrap();
    fs::write(&s.file_path, "{broken-json").unwrap();
    s.load();
    assert!(s.get_task("a").is_some());
    assert!(s.create_task(task("b", None)).is_err());
    assert_eq!(fs::read_to_string(&s.file_path).unwrap(), "{broken-json");
}

#[test]
fn cold_start_with_damaged_data_never_creates_a_new_empty_database() {
    let mut fixture = TestStore::new();
    let s = &mut fixture.0;
    fs::write(&s.file_path, "{broken-json").unwrap();
    s.load();
    assert!(s.create_task(task("a", None)).is_err());
    assert_eq!(fs::read_to_string(&s.file_path).unwrap(), "{broken-json");
    fs::write(&s.file_path, serde_json::to_vec(&AppData::default()).unwrap()).unwrap();
    s.refresh_from_disk().unwrap();
    s.create_task(task("a", None)).unwrap();
}

#[test]
fn restoring_a_completed_task_cannot_create_a_sixth_active_level() {
    let mut fixture = TestStore::new();
    let s = &mut fixture.0;
    for i in 0..5 {
        let parent = if i == 0 { None } else { Some(format!("t{}", i - 1)) };
        s.create_task(task(&format!("t{i}"), parent.as_deref())).unwrap();
    }
    s.create_task(task("done", None)).unwrap();
    s.complete_task("done").unwrap();
    s.update_task("done", json!({"parentId": "t4"})).unwrap();
    let undo_len = s.undo_stack.len();
    assert!(s.uncomplete_task("done").is_err());
    assert!(s.get_task("done").unwrap().completed);
    assert_eq!(s.undo_stack.len(), undo_len);
}

#[test]
fn active_children_of_completed_parents_are_rejected_for_create_update_and_import() {
    let mut fixture = TestStore::new();
    let s = &mut fixture.0;
    s.create_task(task("a", None)).unwrap();
    s.complete_task("a").unwrap();
    assert!(s.create_task(task("b", Some("a"))).is_err());
    assert!(s.batch_create_tasks(vec![task("b", Some("a"))]).is_err());
    s.create_task(task("c", None)).unwrap();
    assert!(s.update_task("c", json!({"parentId": "a"})).is_err());
    let mut snapshot = s.export_snapshot();
    snapshot["tasks"][1]["parentId"] = json!("a");
    assert!(s.import_snapshot(snapshot, "replace").is_err());
}

#[test]
fn batch_priority_can_be_cleared_and_undone() {
    let mut fixture = TestStore::new();
    let s = &mut fixture.0;
    s.batch_create_tasks(vec![task("a", None), task("b", None)]).unwrap();
    s.batch_set_priority(vec!["a".into(), "b".into()], Some("p1")).unwrap();
    assert_eq!(s.batch_set_priority(vec!["a".into(), "b".into()], None).unwrap(), 2);
    assert!(s.data.tasks.iter().all(|t| t.priority.is_none()));
    s.undo().unwrap();
    assert!(s.data.tasks.iter().all(|t| t.priority.as_deref() == Some("p1")));
}

#[test]
fn newly_generated_reports_store_calendar_dates() {
    let mut fixture = TestStore::new();
    let report = fixture.0.generate_report("2026-W46").unwrap();
    assert_eq!(report.start_date, "2026-11-09");
    assert_eq!(report.end_date, "2026-11-15");
}

#[test]
fn background_reminder_reloads_external_changes_and_marks_only_successful_saves() {
    let mut fixture = TestStore::new();
    let s = &mut fixture.0;
    s.data.config.daily_reminder_enabled = true;
    s.data.config.daily_reminder_hour = 0;
    s.data.config.daily_reminder_minute = 0;
    s.create_task(task("a", None)).unwrap();
    let mut external = DataStore::for_path(s.file_path.clone());
    external.load();
    external.create_task(task("external", None)).unwrap();
    let lock = fs::OpenOptions::new().read(true).write(true).open(format!("{}.lock", s.file_path.display())).unwrap();
    lock.try_lock().unwrap();
    let now = Local::now();
    assert!(s.claim_daily_reminder(now).is_err());
    assert!(s.data.config.last_daily_reminder_date.is_none());
    drop(lock);
    assert!(s.claim_daily_reminder(now).unwrap());
    assert!(s.get_task("external").is_some());
    assert!(!s.claim_daily_reminder(now).unwrap());
    let disk: AppData=serde_json::from_slice(&fs::read(&s.file_path).unwrap()).unwrap();
    assert_eq!(disk.config.last_daily_reminder_date.as_deref(),Some(now.format("%Y-%m-%d").to_string().as_str()));
}

#[test]
fn automatic_weekly_reports_refresh_before_attempting_a_write() {
    let mut fixture = TestStore::new();
    let s=&mut fixture.0;
    s.create_task(task("a",None)).unwrap();
    let mut external = DataStore::for_path(s.file_path.clone());
    external.load();
    external.create_task(task("external",None)).unwrap();
    s.try_auto_weekly_report();
    assert!(s.get_task("external").is_some());
}

#[test]
fn external_sync_fires_even_after_prior_read_or_background_save_and_ignores_self_writes() {
    let mut fixture = TestStore::new();
    let s = &mut fixture.0;
    s.data.config.daily_reminder_enabled = true;
    s.data.config.daily_reminder_hour = 0;
    s.data.config.daily_reminder_minute = 0;
    s.create_task(task("local-aa", None)).unwrap();
    assert!(!s.check_external_sync().unwrap());

    let mut external = DataStore::for_path(s.file_path.clone());
    external.load();
    external.create_task(task("ext-bb", None)).unwrap();

    // Even if a read or background reminder consumes refresh_from_disk() and writes config first,
    // check_external_sync() must still report the external change exactly once.
    assert!(s.claim_daily_reminder(Local::now()).unwrap());
    assert!(s.get_task("ext-bb").is_some());
    assert!(s.check_external_sync().unwrap());
    assert!(!s.check_external_sync().unwrap());

    // Same-byte-length external edit must also be detected.
    external.load();
    external.update_task("local-aa", json!({"content": "local-cc"})).unwrap();
    assert!(s.check_external_sync().unwrap());
    assert_eq!(s.get_task("local-aa").unwrap().content, "local-cc");

    // Corrupted external disk must fail check_external_sync without wiping memory.
    fs::write(&s.file_path, "{corrupt").unwrap();
    assert!(s.check_external_sync().is_err());
    assert!(s.get_task("local-aa").is_some());
}

#[test]
fn backups_are_isolated_per_data_file_rotate_safely_and_block_writes_on_failure() {
    let dir_a = std::env::temp_dir().join(format!("module-iso-{}", Uuid::new_v4()));
    fs::create_dir_all(&dir_a).unwrap();
    let file_a = dir_a.join("a.json");
    let file_b = dir_a.join("b.json");
    assert_ne!(DataStore::backup_dir_for(&file_a), DataStore::backup_dir_for(&file_b));

    let mut sa = DataStore::for_path(file_a.clone());
    sa.create_task(task("t1", None)).unwrap();
    // Same-day edits only produce one daily backup (capturing the pre-edit state before the second write).
    sa.create_task(task("t2", None)).unwrap();
    sa.create_task(task("t3", None)).unwrap();
    let list_after_daily = sa.list_backups().unwrap();
    assert_eq!(list_after_daily.iter().filter(|b| b.kind == "daily").count(), 1);
    assert_eq!(list_after_daily[0].task_count, 1);

    // Unrelated files in the backup dir must never be deleted by rotation.
    let unrelated = sa.backup_dir().join("keep-user-file.txt");
    fs::write(&unrelated, b"keep").unwrap();

    // Trigger 7 replace imports (including same-second writes) -> rotate pre-change to 5.
    for i in 0..7 {
        let mut snap = sa.export_snapshot();
        snap["tasks"] = json!([task(&format!("imp{i}"), None)]);
        sa.import_snapshot(snap, "replace").unwrap();
    }
    let backups = sa.list_backups().unwrap();
    assert_eq!(backups.iter().filter(|b| b.kind != "daily").count(), MAX_PRE_CHANGE_BACKUPS);
    assert!(unrelated.exists());

    // Backup write failure must abort main write and roll back memory + undo stack.
    let mut blocker_fixture = TestStore::new();
    let sb = &mut blocker_fixture.0;
    sb.create_task(task("init", None)).unwrap();
    let bdir = sb.backup_dir();
    if bdir.exists() {
        fs::remove_dir_all(&bdir).unwrap();
    }
    fs::create_dir_all(bdir.parent().unwrap()).unwrap();
    fs::write(&bdir, b"not-a-directory").unwrap();
    let undo_before = sb.undo_stack.len();
    assert!(sb.import_snapshot(json!({"tasks": [task("new", None)]}), "replace").is_err());
    assert!(sb.get_task("init").is_some());
    assert!(sb.get_task("new").is_none());
    assert_eq!(sb.undo_stack.len(), undo_before);
    let _ = fs::remove_file(&bdir);

    let _ = fs::remove_dir_all(&dir_a);
}

#[test]
fn backup_restore_validates_id_supports_undo_and_recovers_corrupted_db() {
    let mut fixture = TestStore::new();
    let s = &mut fixture.0;
    s.create_task(task("v1", None)).unwrap();
    s.create_task(task("v2", None)).unwrap();
    let daily_id = s.list_backups().unwrap().into_iter().find(|b| b.kind == "daily").unwrap().id;

    // Reject path traversal & unknown filenames.
    for bad in ["../a.json", "sub/a.json", "a\\b.json", "evil.json", "daily-bad.json"] {
        assert!(s.restore_backup(bad).is_err(), "must reject {}", bad);
    }

    // Normal restore creates pre-restore backup and can be undone.
    let normal_res = s.restore_backup(&daily_id).unwrap();
    assert!(normal_res.undoable);
    assert!(normal_res.corrupt_backup_path.is_none());
    assert_eq!(s.data.tasks.len(), 1);
    assert!(s.list_backups().unwrap().iter().any(|b| b.kind == "pre-restore"));
    s.undo().unwrap();
    assert_eq!(s.data.tasks.len(), 2);

    // Corrupted main DB recovery: saves diagnostic copy and restores without refresh_from_disk blocking.
    fs::write(&s.file_path, "{broken-json").unwrap();
    let mut damaged = DataStore::for_path(s.file_path.clone());
    damaged.load();
    assert!(damaged.disk_revision.is_none());
    assert!(!damaged.list_backups().unwrap().is_empty());
    let rec = damaged.restore_backup(&daily_id).unwrap();
    assert!(!rec.undoable);
    let diag = PathBuf::from(rec.corrupt_backup_path.expect("diagnostic copy"));
    assert_eq!(fs::read_to_string(&diag).unwrap(), "{broken-json");
    assert_eq!(damaged.data.tasks.len(), 1);
    damaged.create_task(task("after-recover", None)).unwrap();
}

#[test]
fn scoped_xlsx_gantt_export_produces_valid_workbook_with_colors_and_sparse_cells() {
    use std::io::Read;
    let mut fixture = TestStore::new();
    let s = &mut fixture.0;
    s.batch_create_tasks(vec![
        serde_json::from_value(json!({"id": "p1", "content": "项目A & <测试>", "startDate": "2026-11-20", "deadline": "2026-11-25"})).unwrap(),
        serde_json::from_value(json!({"id": "c1", "content": "子任务1", "parentId": "p1", "startDate": "2026-11-21", "deadline": "2026-11-23"})).unwrap(),
        serde_json::from_value(json!({"id": "p2", "content": "排除项目B", "startDate": "2026-11-20", "deadline": "2026-11-28"})).unwrap(),
    ]).unwrap();

    let scoped = s.get_scoped_gantt_data(&["p1".to_string()]);
    assert_eq!(scoped.len(), 2);
    assert!(scoped.iter().all(|t| t.id != "p2"));

    let out_path = std::env::temp_dir().join(format!("module-gantt-{}.xlsx", Uuid::new_v4()));
    crate::xlsx_gantt::export_gantt_xlsx(&out_path, &scoped).unwrap();

    let file = fs::File::open(&out_path).unwrap();
    let mut archive = zip::ZipArchive::new(file).unwrap();
    let mut wb_xml = String::new();
    archive.by_name("xl/workbook.xml").unwrap().read_to_string(&mut wb_xml).unwrap();
    assert!(wb_xml.contains("甘特图"));
    assert!(wb_xml.contains("项目信息"));

    let mut styles_xml = String::new();
    archive.by_name("xl/styles.xml").unwrap().read_to_string(&mut styles_xml).unwrap();
    assert!(styles_xml.contains("2563EB"));
    assert!(styles_xml.contains("7C3AED"));

    let mut shared_or_sheet = String::new();
    if let Ok(mut ss) = archive.by_name("xl/sharedStrings.xml") {
        ss.read_to_string(&mut shared_or_sheet).unwrap();
    }
    let mut sheet1_xml = String::new();
    archive.by_name("xl/worksheets/sheet1.xml").unwrap().read_to_string(&mut sheet1_xml).unwrap();
    let combined = format!("{}\n{}", shared_or_sheet, sheet1_xml);
    assert!(combined.contains("项目A &amp; &lt;测试&gt;") || combined.contains("项目A & <测试>"));
    assert!(!combined.contains("排除项目B"));
    assert!(sheet1_xml.contains("xSplit=\"5\""));

    let _ = fs::remove_file(&out_path);
}

#[test]
fn xlsx_export_handles_multibyte_invalid_dates_and_rejects_oversized_rows_or_span() {
    let today = NaiveDate::from_ymd_opt(2026, 11, 25).unwrap();

    // Non-ASCII invalid date strings must not panic on byte slice boundaries.
    let bad_unicode = GanttTask {
        id: "u1".into(),
        content: "中文日期测试".into(),
        start: "你好你好你好".into(),
        end: "2026-11-28".into(),
        parent_id: None,
        level: 0,
        dfs_order: 0,
        urgency: None,
        days_left: None,
    };
    let bytes = crate::xlsx_gantt::build_gantt_xlsx_bytes(&[bad_unicode], today).unwrap();
    assert!(!bytes.is_empty());

    // >5000 rows must return an explicit error instead of truncating.
    let many: Vec<GanttTask> = (0..=crate::xlsx_gantt::MAX_GANTT_EXPORT_ROWS)
        .map(|i| GanttTask {
            id: format!("t{i}"),
            content: format!("t{i}"),
            start: "2026-11-25".into(),
            end: "2026-11-26".into(),
            parent_id: None,
            level: 0,
            dfs_order: i,
            urgency: None,
            days_left: None,
        })
        .collect();
    assert!(crate::xlsx_gantt::build_gantt_xlsx_bytes(&many, today).is_err());

    // >1095 days timeline span must return an explicit error instead of clamping to today.
    let wide = GanttTask {
        id: "wide".into(),
        content: "跨度超限".into(),
        start: "2020-01-01".into(),
        end: "2026-11-28".into(),
        parent_id: None,
        level: 0,
        dfs_order: 0,
        urgency: None,
        days_left: None,
    };
    assert!(crate::xlsx_gantt::build_gantt_xlsx_bytes(&[wide], today).is_err());
}

#[test]
fn refresh_rejects_invalid_external_task_graph_and_restore_clears_stale_undo() {
    let mut fixture = TestStore::new();
    let s = &mut fixture.0;
    s.create_task(task("first", None)).unwrap();
    s.create_task(task("second", None)).unwrap();
    let daily_id = s.list_backups().unwrap().into_iter().find(|b| b.kind == "daily").unwrap().id;

    // External cyclic/orphan task tree must be rejected without mutating memory or triggering sync.
    let saved_bytes = fs::read(&s.file_path).unwrap();
    let cyclic = json!({
        "tasks": [
            {"id": "x1", "content": "x1", "parentId": "x2"},
            {"id": "x2", "content": "x2", "parentId": "x1"}
        ]
    });
    fs::write(&s.file_path, serde_json::to_vec(&cyclic).unwrap()).unwrap();
    assert!(s.check_external_sync().is_err());
    assert!(s.get_task("first").is_some());
    assert!(s.get_task("x1").is_none());
    fs::write(&s.file_path, &saved_bytes).unwrap();

    // External valid change followed by local restore_backup must invalidate older stale undo entries.
    let mut external = DataStore::for_path(s.file_path.clone());
    external.load();
    external.create_task(task("external-important", None)).unwrap();

    // Failure during restore must keep memory and undo_stack untouched.
    assert!(s.restore_backup("../evil.json").is_err());
    assert_eq!(s.undo_stack.len(), 2);

    assert!(s.restore_backup(&daily_id).unwrap().undoable);
    assert!(s.get_task("external-important").is_none());
    s.undo().unwrap();
    assert!(s.get_task("external-important").is_some());
    assert!(!s.can_undo());
}

#[test]
fn strict_snapshot_rejects_empty_object_allows_empty_tasks_and_recovers_semantic_corruption() {
    let mut fixture = TestStore::new();
    let s = &mut fixture.0;
    s.create_task(task("important", None)).unwrap();
    s.create_task(task("second", None)).unwrap();
    let valid_daily = s.list_backups().unwrap().into_iter().find(|b| b.kind == "daily").unwrap().id;

    // 1. Corrupt/0-byte and `{}` backups are ignored by list, rejected by restore, and do not block today's valid backup.
    let bdir = s.backup_dir();
    fs::remove_file(bdir.join(&valid_daily)).unwrap();
    let today = Local::now().format("%Y-%m-%d").to_string();
    let broken_daily = format!("daily-{}_000000000-0001-deadbe.json", today);
    let empty_obj = "pre-import-empty-object.json";
    fs::write(bdir.join(&broken_daily), b"").unwrap();
    fs::write(bdir.join(empty_obj), b"{}").unwrap();

    s.create_task(task("third", None)).unwrap();
    let listed = s.list_backups().unwrap();
    assert!(!listed.iter().any(|b| b.id == broken_daily || b.id == empty_obj));
    assert_eq!(listed.iter().filter(|b| b.kind == "daily").count(), 1);
    assert!(s.restore_backup(empty_obj).is_err());

    // 2. Empty object `{}` on main DB must be rejected on refresh without wiping memory; `{"tasks": []}` is allowed.
    let saved_main = fs::read(&s.file_path).unwrap();
    fs::write(&s.file_path, b"{}").unwrap();
    assert!(s.refresh_from_disk().is_err());
    assert_eq!(s.data.tasks.len(), 3);
    fs::write(&s.file_path, &saved_main).unwrap();

    let empty_tasks_id = "pre-import-empty-tasks.json";
    fs::write(bdir.join(empty_tasks_id), br#"{"tasks":[]}"#).unwrap();
    assert!(s.list_backups().unwrap().iter().any(|b| b.id == empty_tasks_id));

    // 3. Semantic corruption (self-cycle in valid JSON) on main DB must save diagnostic copy and be non-undoable.
    let mut broken_graph = s.export_snapshot();
    broken_graph["tasks"][0]["parentId"] = json!(broken_graph["tasks"][0]["id"]);
    fs::write(&s.file_path, serde_json::to_vec(&broken_graph).unwrap()).unwrap();
    let new_daily = listed.into_iter().find(|b| b.kind == "daily").unwrap().id;
    let rec = s.restore_backup(&new_daily).unwrap();
    assert!(!rec.undoable);
    assert!(rec.corrupt_backup_path.is_some());
    assert!(!s.can_undo());
    let mut cold = DataStore::for_path(s.file_path.clone());
    assert!(cold.refresh_from_disk().is_ok());

    // Clean up explicit custom-named backup files in temp dir.
    let _ = fs::remove_file(bdir.join(empty_obj));
    let _ = fs::remove_file(bdir.join(empty_tasks_id));
    let _ = fs::remove_file(bdir.join(broken_daily));
}

#[test]
fn gantt_order_supports_fractional_negative_stable_ties_and_60_bisection_renorm() {
    let mut fixture = TestStore::new();
    let s = &mut fixture.0;

    let t = |id: &str, parent: Option<&str>, ord: Value| -> Task {
        serde_json::from_value(json!({
            "id": id,
            "content": id,
            "parentId": parent,
            "order": ord,
            "startDate": "2026-11-20",
            "deadline": "2026-11-28"
        }))
        .unwrap()
    };

    s.batch_create_tasks(vec![
        t("done", None, json!(0.5)),
        t("tie1", None, json!(0)),
        t("tie2", None, json!(0)),
        t("a", None, json!(1)),
        t("b", None, json!(2)),
        t("c", None, json!(1.5)),
        t("neg", None, json!(-0.5)),
    ])
    .unwrap();
    s.complete_task("done").unwrap();
    let done_order_before = s.get_task("done").unwrap().order.clone();

    let ids: Vec<String> = s.get_gantt_data().into_iter().map(|g| g.id).collect();
    assert_eq!(ids, vec!["neg", "tie1", "tie2", "a", "c", "b"]);

    // Simulate 60 consecutive midpoint drags between the first two items ("neg" and "tie1").
    for step in 0..60 {
        let gantt = s.get_gantt_data();
        let o0 = s.get_task(&gantt[0].id).unwrap().order.as_ref().unwrap().as_f64().unwrap();
        let o1 = s.get_task(&gantt[1].id).unwrap().order.as_ref().unwrap().as_f64().unwrap();
        let mid = (o0 + o1) / 2.0;
        let mover = if step % 2 == 0 { "c" } else { "b" };
        s.reorder_tasks(vec![json!({ "id": mover, "order": mid })]).unwrap();
    }

    // Completed task order was untouched, and active tasks remain strictly ordered & distinct.
    assert_eq!(s.get_task("done").unwrap().order, done_order_before);
    let final_ids: Vec<String> = s.get_gantt_data().into_iter().map(|g| g.id).collect();
    assert_eq!(final_ids.len(), 6);
    assert_ne!(
        s.get_task(&final_ids[0]).unwrap().order,
        s.get_task(&final_ids[1]).unwrap().order
    );
}

#[test]
fn auto_plan_batch_and_wide_tree_preserve_existing_date_semantics() {
    let mut fixture = TestStore::new();
    let s = &mut fixture.0;
    s.data.config.auto_plan = true;

    let mk = |id: &str, parent: Option<&str>, sd: Option<&str>, dl: Option<&str>| -> Task {
        serde_json::from_value(json!({
            "id": id, "content": id, "parentId": parent, "startDate": sd, "deadline": dl
        }))
        .unwrap()
    };

    let mut wide = vec![mk("root", None, None, None)];
    for i in 0..500 {
        let dl = if i == 499 { "2026-12-15" } else { "2026-11-28" };
        let sd = if i == 0 { "2026-11-05" } else { "2026-11-20" };
        wide.push(mk(&format!("c{i}"), Some("root"), Some(sd), Some(dl)));
    }
    s.batch_create_tasks(wide).unwrap();
    assert_eq!(s.get_task("root").unwrap().start_date.as_deref(), Some("2026-11-05"));
    assert_eq!(s.get_task("root").unwrap().deadline.as_deref(), Some("2026-12-15"));

    // update_task uses skipStartId=true (explicit parent input wins over children).
    s.update_task("root", json!({"deadline": "2027-01-01"})).unwrap();
    assert_eq!(s.get_task("root").unwrap().deadline.as_deref(), Some("2027-01-01"));

    // Completing the last active child keeps the parent's existing dates.
    let mut f2 = TestStore::new();
    let s2 = &mut f2.0;
    s2.data.config.auto_plan = true;
    s2.batch_create_tasks(vec![
        mk("p", None, None, None),
        mk("only", Some("p"), Some("2026-11-10"), Some("2026-11-20")),
    ])
    .unwrap();
    s2.complete_task("only").unwrap();
    assert_eq!(s2.get_task("p").unwrap().start_date.as_deref(), Some("2026-11-10"));
    assert_eq!(s2.get_task("p").unwrap().deadline.as_deref(), Some("2026-11-20"));
}
