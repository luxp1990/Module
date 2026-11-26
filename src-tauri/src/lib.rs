pub mod model;
pub mod store;
pub mod commands;
pub mod mcp;
pub mod xlsx_gantt;
mod image_save;

use chrono::Local;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

use crate::commands::*;
use crate::store::DataStore;

static LAST_WIDGET_MOVE_TICK: AtomicI64 = AtomicI64::new(0);

fn handle_widget_bounds_changed(window: &tauri::Window) {
    if window.label() != "widget" { return; }
    let tick = LAST_WIDGET_MOVE_TICK.fetch_add(1, Ordering::Relaxed) + 1;
    let w = window.clone();
    tauri::async_runtime::spawn(async move {
        std::thread::sleep(std::time::Duration::from_millis(300));
        if LAST_WIDGET_MOVE_TICK.load(Ordering::Relaxed) == tick {
            crate::commands::flush_widget_bounds_for_window(&w);
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let store = Arc::new(Mutex::new(DataStore::new()));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(store.clone())
        .setup(move |app| {
            // Setup Tray Icon & Menu
            let show_i = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let widget_i = MenuItem::with_id(app, "widget", "桌面组件", true, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let settings_i = MenuItem::with_id(app, "settings", "⚙️ 设置", true, None::<&str>)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &widget_i, &sep1, &settings_i, &sep2, &quit_i])?;

            if let Some(icon) = app.default_window_icon() {
                let _tray = TrayIconBuilder::new()
                    .icon(icon.clone())
                    .tooltip("Module 任务管理器")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "quit" => {
                            app.exit(0);
                        }
                        "show" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.unminimize();
                                let _ = w.set_focus();
                            }
                        }
                        "widget" => {
                            let _ = crate::commands::widget_toggle(app.clone());
                        }
                        "settings" => {
                            if let Some(w) = app.get_webview_window("settings") {
                                let _ = w.show();
                                let _ = w.unminimize();
                                let _ = w.set_focus();
                            }
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        match event {
                            TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. }
                            | TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } => {
                                let app = tray.app_handle();
                                if let Some(w) = app.get_webview_window("main") {
                                    let _ = w.show();
                                    let _ = w.unminimize();
                                    let _ = w.set_focus();
                                }
                            }
                            _ => {}
                        }
                    })
                    .build(app)?;
            }

            // Register global hotkey for desktop widget toggle
            let saved_hotkey = crate::commands::get_saved_hotkey();
            if let Err(e) = crate::commands::register_hotkey(app.handle(), &saved_hotkey) {
                eprintln!("[hotkey] registration failed for {}: {}, falling back to default", saved_hotkey, e);
                let _ = crate::commands::register_hotkey(app.handle(), "CommandOrControl+Shift+M");
            }

            // Restore desktop widget bounds and pinned preference
            crate::commands::restore_widget_state(app.handle());

            // Auto-check weekly reports on startup
            {
                if let Ok(mut s) = store.lock() {
                    let generated_reports = s.try_auto_weekly_report();
                    drop(s);
                    for w in generated_reports {
                        crate::commands::broadcast(app.handle(), serde_json::json!({ "action": "REPORT_CREATED", "id": w }));
                    }
                }
            }

            // Spawn background timer for external sync watch (2s), daily reminders & periodic checks (60s)
            let app_handle = app.handle().clone();
            let store_bg = store.clone();
            std::thread::spawn(move || {
                let mut tick: u64 = 0;
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    tick = tick.wrapping_add(1);

                    let external_changed = {
                        match store_bg.try_lock() {
                            Ok(mut s) => match s.check_external_sync() {
                                Ok(changed) => changed,
                                Err(error) => {
                                    log::error!("External sync check failed: {}", error);
                                    false
                                }
                            },
                            Err(_) => false,
                        }
                    };
                    if external_changed {
                        crate::commands::broadcast(
                            &app_handle,
                            serde_json::json!({ "action": "EXTERNAL_DATA_CHANGED", "external": true }),
                        );
                    }

                    if tick % 30 != 0 {
                        continue;
                    }

                    let now = Local::now();

                    let mut should_remind = false;
                    let mut absorbed_external = false;
                    {
                        if let Ok(mut s) = store_bg.lock() {
                            match s.claim_daily_reminder(now) {
                                Ok(due) => should_remind = due,
                                Err(error) => log::error!("Daily reminder deferred: {}", error),
                            }
                            absorbed_external = std::mem::take(&mut s.pending_external_sync);
                        }
                    }

                    if should_remind {
                        let app_h = app_handle.clone();
                        let _ = app_handle.run_on_main_thread(move || {
                            if let Some(w) = app_h.get_webview_window("reminder") {
                                let _ = w.show();
                                let _ = w.unminimize();
                                let _ = w.set_focus();
                                let _ = app_h.emit("reminder-show", serde_json::json!({ "mode": "full", "useScope": false }));
                            }
                        });
                    }

                    // Periodic auto weekly report check
                    let (gen_weeks, report_absorbed_external) = {
                        if let Ok(mut s) = store_bg.lock() {
                            let generated = s.try_auto_weekly_report();
                            let ext = std::mem::take(&mut s.pending_external_sync);
                            (generated, ext)
                        } else {
                            (Vec::new(), false)
                        }
                    };
                    if absorbed_external || report_absorbed_external {
                        crate::commands::broadcast(
                            &app_handle,
                            serde_json::json!({ "action": "EXTERNAL_DATA_CHANGED", "external": true }),
                        );
                    }
                    for w in gen_weeks {
                        crate::commands::broadcast(&app_handle, serde_json::json!({ "action": "REPORT_CREATED", "id": w }));
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    // Prevent destroying windows; hide asynchronously to prevent tao event loop deadlocks
                    api.prevent_close();
                    crate::commands::flush_widget_bounds_for_window(window);
                    let window = window.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = window.hide();
                    });
                }
                tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                    handle_widget_bounds_changed(window);
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            tasks_get_all,
            tasks_get_active,
            tasks_get_completed,
            tasks_create,
            tasks_batch_create,
            tasks_update,
            tasks_delete,
            tasks_complete,
            tasks_uncomplete,
            tasks_batch_complete,
            tasks_batch_uncomplete,
            tasks_batch_delete,
            tasks_batch_set_priority,
            tasks_reorder,
            tasks_cleanup,
            reports_list,
            reports_get,
            reports_generate,
            reports_current_week_id,
            reports_last_week_id,
            reports_delete,
            reports_update,
            clipboard_write,
            config_get,
            config_update,
            gantt_data,
            gantt_request_save_path,
            gantt_write_image_buffer,
            gantt_export_excel,
            gantt_export_csv,
            backups_list,
            backups_restore,
            undo_list,
            undo_can_undo,
            undo_undo,
            undo_clear,
            debug_data_path,
            dialog_confirm,
            data_export,
            data_read_file,
            data_import,
            notes_list,
            notes_create,
            notes_update,
            notes_delete,
            notes_reorder,
            widget_toggle,
            widget_status,
            widget_focus_main,
            widget_set_always_on_top,
            widget_get_pinned,
            hotkey_set,
            hotkey_get,
            reminder_get_payload,
            reminder_open_panel,
            reminder_focus_task,
            window_hide,
            app_version,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Module application");
}
