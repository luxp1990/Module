use std::path::Path;
use chrono::{Datelike, Duration, Local, NaiveDate};
use rust_xlsxwriter::{Color, Format, FormatAlign, FormatBorder, Workbook};

use crate::model::GanttTask;

pub const MAX_GANTT_EXPORT_DAYS: i64 = 1095;
pub const MAX_GANTT_EXPORT_ROWS: usize = 5000;

const LEVEL_LABELS: [&str; 5] = ["主任务", "一级子任务", "二级子任务", "三级子任务", "四级子任务"];
const LEVEL_COLORS: [u32; 5] = [0x2563EB, 0x7C3AED, 0x0EA5E9, 0x10B981, 0xF97316];
const WEEKDAYS_ZH: [&str; 7] = ["一", "二", "三", "四", "五", "六", "日"];

fn parse_ymd(raw: &str) -> Option<NaiveDate> {
    let trimmed = raw.trim();
    let prefix = trimmed.get(..10)?;
    if !prefix.is_ascii() {
        return None;
    }
    NaiveDate::parse_from_str(prefix, "%Y-%m-%d").ok()
}

fn level_label(level: usize) -> String {
    LEVEL_LABELS
        .get(level)
        .map(|s| (*s).to_string())
        .unwrap_or_else(|| format!("L{}", level))
}

fn status_meta(task: &GanttTask, today: NaiveDate) -> (&'static str, u32) {
    match task.urgency.as_deref() {
        Some("overdue") => ("已延期", 0xEF4444),
        Some("today") | Some("due-soon") => ("即将到期", 0xF59E0B),
        Some("normal") => ("正常", 0x22C55E),
        _ => {
            if let Some(end_d) = parse_ymd(&task.end) {
                let diff = (end_d - today).num_days();
                if diff < 0 {
                    ("已延期", 0xEF4444)
                } else if diff <= 7 {
                    ("即将到期", 0xF59E0B)
                } else {
                    ("正常", 0x22C55E)
                }
            } else {
                ("无截止日期", 0x95A5A6)
            }
        }
    }
}

fn compute_timeline_bounds(tasks: &[GanttTask], today: NaiveDate) -> Result<(NaiveDate, NaiveDate), String> {
    let mut min_d: Option<NaiveDate> = None;
    let mut max_d: Option<NaiveDate> = None;

    for t in tasks {
        if let Some(sd) = parse_ymd(&t.start) {
            min_d = Some(min_d.map_or(sd, |cur| cur.min(sd)));
            max_d = Some(max_d.map_or(sd, |cur| cur.max(sd)));
        }
        if let Some(ed) = parse_ymd(&t.end) {
            min_d = Some(min_d.map_or(ed, |cur| cur.min(ed)));
            max_d = Some(max_d.map_or(ed, |cur| cur.max(ed)));
        }
    }

    let start = min_d.unwrap_or(today) - Duration::days(3);
    let mut end = max_d.unwrap_or_else(|| today + Duration::days(30)) + Duration::days(7);
    if end < start {
        end = start + Duration::days(30);
    }

    let span = (end - start).num_days() + 1;
    if span > MAX_GANTT_EXPORT_DAYS {
        return Err(format!(
            "甘特图时间跨度（{} 天）超过单次 Excel 导出上限（{} 天），请先通过「项目过滤」缩小范围或检查跨度过大的任务日期",
            span, MAX_GANTT_EXPORT_DAYS
        ));
    }

    Ok((start, end))
}

pub fn build_gantt_xlsx_bytes(tasks: &[GanttTask], today: NaiveDate) -> Result<Vec<u8>, String> {
    if tasks.len() > MAX_GANTT_EXPORT_ROWS {
        return Err(format!(
            "甘特图任务数（{} 条）超过单次 Excel 导出上限（{} 条），请先通过「项目过滤」选择单个项目后再导出",
            tasks.len(), MAX_GANTT_EXPORT_ROWS
        ));
    }

    let (min_date, max_date) = compute_timeline_bounds(tasks, today)?;
    let total_days = ((max_date - min_date).num_days() + 1) as usize;

    let mut workbook = Workbook::new();

    let header_fmt = Format::new()
        .set_bold()
        .set_font_color(Color::White)
        .set_background_color(Color::RGB(0x2C3E50))
        .set_align(FormatAlign::Center)
        .set_align(FormatAlign::VerticalCenter)
        .set_text_wrap();

    let today_header_fmt = Format::new()
        .set_bold()
        .set_font_color(Color::RGB(0xB91C1C))
        .set_background_color(Color::RGB(0xFEE2E2))
        .set_align(FormatAlign::Center)
        .set_align(FormatAlign::VerticalCenter)
        .set_text_wrap();

    let weekend_header_fmt = Format::new()
        .set_bold()
        .set_font_color(Color::RGB(0xFCA5A5))
        .set_background_color(Color::RGB(0x334155))
        .set_align(FormatAlign::Center)
        .set_align(FormatAlign::VerticalCenter)
        .set_text_wrap();

    let center_fmt = Format::new()
        .set_align(FormatAlign::Center)
        .set_align(FormatAlign::VerticalCenter);

    let weekend_col_fmt = Format::new()
        .set_background_color(Color::RGB(0xF5F5F5))
        .set_align(FormatAlign::Center)
        .set_align(FormatAlign::VerticalCenter);

    let today_col_fmt = Format::new()
        .set_background_color(Color::RGB(0xFEF2F2))
        .set_border_right(FormatBorder::Medium)
        .set_border_right_color(Color::RGB(0xEF4444))
        .set_align(FormatAlign::Center)
        .set_align(FormatAlign::VerticalCenter);

    let level_formats: Vec<Format> = LEVEL_COLORS
        .iter()
        .map(|&rgb| Format::new().set_background_color(Color::RGB(rgb)))
        .collect();

    let name_formats: Vec<Format> = (0..=4)
        .map(|lvl| {
            let mut f = Format::new()
                .set_align(FormatAlign::Left)
                .set_align(FormatAlign::VerticalCenter)
                .set_indent(lvl as u8);
            if lvl == 0 {
                f = f.set_bold();
            }
            f
        })
        .collect();

    let status_overdue_fmt = Format::new()
        .set_bold()
        .set_font_color(Color::White)
        .set_background_color(Color::RGB(0xEF4444))
        .set_align(FormatAlign::Center)
        .set_align(FormatAlign::VerticalCenter);
    let status_soon_fmt = Format::new()
        .set_bold()
        .set_font_color(Color::White)
        .set_background_color(Color::RGB(0xF59E0B))
        .set_align(FormatAlign::Center)
        .set_align(FormatAlign::VerticalCenter);
    let status_normal_fmt = Format::new()
        .set_bold()
        .set_font_color(Color::White)
        .set_background_color(Color::RGB(0x22C55E))
        .set_align(FormatAlign::Center)
        .set_align(FormatAlign::VerticalCenter);
    let status_none_fmt = Format::new()
        .set_bold()
        .set_font_color(Color::White)
        .set_background_color(Color::RGB(0x95A5A6))
        .set_align(FormatAlign::Center)
        .set_align(FormatAlign::VerticalCenter);

    // ==================== Sheet 1: 甘特图 ====================
    let gantt_sheet = workbook.add_worksheet();
    gantt_sheet.set_name("甘特图").map_err(|e| e.to_string())?;
    gantt_sheet.set_freeze_panes(1, 5).map_err(|e| e.to_string())?;
    gantt_sheet.set_row_height(0, 30).map_err(|e| e.to_string())?;

    gantt_sheet.set_column_width(0, 14).map_err(|e| e.to_string())?;
    gantt_sheet.set_column_width(1, 42).map_err(|e| e.to_string())?;
    gantt_sheet.set_column_width(2, 13).map_err(|e| e.to_string())?;
    gantt_sheet.set_column_width(3, 13).map_err(|e| e.to_string())?;
    gantt_sheet.set_column_width(4, 12).map_err(|e| e.to_string())?;

    for (col_idx, title) in ["层级", "任务名称", "开始日期", "截止日期", "状态"].iter().enumerate() {
        gantt_sheet
            .write_string_with_format(0, col_idx as u16, *title, &header_fmt)
            .map_err(|e| e.to_string())?;
    }

    for day_idx in 0..total_days {
        let dt = min_date + Duration::days(day_idx as i64);
        let col = (5 + day_idx) as u16;
        gantt_sheet.set_column_width(col, 6.0).map_err(|e| e.to_string())?;

        let wd = dt.weekday().num_days_from_monday() as usize;
        let is_weekend = wd >= 5;
        let is_today = dt == today;

        if is_today {
            gantt_sheet.set_column_format(col, &today_col_fmt).map_err(|e| e.to_string())?;
        } else if is_weekend {
            gantt_sheet.set_column_format(col, &weekend_col_fmt).map_err(|e| e.to_string())?;
        }

        let label = format!("{}/{}\n{}", dt.month(), dt.day(), WEEKDAYS_ZH[wd]);
        let h_fmt = if is_today {
            &today_header_fmt
        } else if is_weekend {
            &weekend_header_fmt
        } else {
            &header_fmt
        };
        gantt_sheet
            .write_string_with_format(0, col, &label, h_fmt)
            .map_err(|e| e.to_string())?;
    }

    for (i, task) in tasks.iter().enumerate() {
        let row = (i + 1) as u32;
        gantt_sheet.set_row_height(row, 22).map_err(|e| e.to_string())?;

        let lvl = task.level.min(4);
        let lvl_text = level_label(task.level);
        let (status_text, _) = status_meta(task, today);
        let st_fmt = match status_text {
            "已延期" => &status_overdue_fmt,
            "即将到期" => &status_soon_fmt,
            "正常" => &status_normal_fmt,
            _ => &status_none_fmt,
        };

        gantt_sheet.write_string_with_format(row, 0, &lvl_text, &center_fmt).map_err(|e| e.to_string())?;
        gantt_sheet.write_string_with_format(row, 1, &task.content, &name_formats[lvl]).map_err(|e| e.to_string())?;
        gantt_sheet.write_string_with_format(row, 2, &task.start, &center_fmt).map_err(|e| e.to_string())?;
        gantt_sheet.write_string_with_format(row, 3, &task.end, &center_fmt).map_err(|e| e.to_string())?;
        gantt_sheet.write_string_with_format(row, 4, status_text, st_fmt).map_err(|e| e.to_string())?;

        // Sparse matrix: only write cells within [start, end] clamped to timeline range.
        if let (Some(sd), Some(ed)) = (parse_ymd(&task.start), parse_ymd(&task.end)) {
            let (s_clamped, e_clamped) = if sd <= ed { (sd, ed) } else { (ed, sd) };
            let start_offset = (s_clamped - min_date).num_days().max(0);
            let end_offset = (e_clamped - min_date).num_days().min((total_days as i64) - 1);
            if start_offset <= end_offset {
                let bar_fmt = &level_formats[lvl];
                for day_idx in start_offset..=end_offset {
                    let col = (5 + day_idx) as u16;
                    gantt_sheet.write_blank(row, col, bar_fmt).map_err(|e| e.to_string())?;
                }
            }
        }
    }

    // ==================== Sheet 2: 项目信息 ====================
    let info_sheet = workbook.add_worksheet();
    info_sheet.set_name("项目信息").map_err(|e| e.to_string())?;
    info_sheet.set_freeze_panes(1, 0).map_err(|e| e.to_string())?;
    info_sheet.set_row_height(0, 26).map_err(|e| e.to_string())?;

    info_sheet.set_column_width(0, 14).map_err(|e| e.to_string())?;
    info_sheet.set_column_width(1, 50).map_err(|e| e.to_string())?;
    info_sheet.set_column_width(2, 14).map_err(|e| e.to_string())?;
    info_sheet.set_column_width(3, 14).map_err(|e| e.to_string())?;
    info_sheet.set_column_width(4, 10).map_err(|e| e.to_string())?;
    info_sheet.set_column_width(5, 12).map_err(|e| e.to_string())?;

    for (col_idx, title) in ["层级", "任务名称", "开始日期", "截止日期", "天数", "状态"].iter().enumerate() {
        info_sheet
            .write_string_with_format(0, col_idx as u16, *title, &header_fmt)
            .map_err(|e| e.to_string())?;
    }

    for (i, task) in tasks.iter().enumerate() {
        let row = (i + 1) as u32;
        info_sheet.set_row_height(row, 21).map_err(|e| e.to_string())?;
        let lvl = task.level.min(4);
        let lvl_text = level_label(task.level);
        let (status_text, _) = status_meta(task, today);
        let st_fmt = match status_text {
            "已延期" => &status_overdue_fmt,
            "即将到期" => &status_soon_fmt,
            "正常" => &status_normal_fmt,
            _ => &status_none_fmt,
        };

        info_sheet.write_string_with_format(row, 0, &lvl_text, &center_fmt).map_err(|e| e.to_string())?;
        info_sheet.write_string_with_format(row, 1, &task.content, &name_formats[lvl]).map_err(|e| e.to_string())?;
        info_sheet.write_string_with_format(row, 2, &task.start, &center_fmt).map_err(|e| e.to_string())?;
        info_sheet.write_string_with_format(row, 3, &task.end, &center_fmt).map_err(|e| e.to_string())?;

        if let (Some(sd), Some(ed)) = (parse_ymd(&task.start), parse_ymd(&task.end)) {
            let days = ((ed - sd).num_days().abs() + 1) as f64;
            info_sheet.write_number_with_format(row, 4, days, &center_fmt).map_err(|e| e.to_string())?;
        } else {
            info_sheet.write_string_with_format(row, 4, "", &center_fmt).map_err(|e| e.to_string())?;
        }

        info_sheet.write_string_with_format(row, 5, status_text, st_fmt).map_err(|e| e.to_string())?;
    }

    workbook.save_to_buffer().map_err(|e| e.to_string())
}

pub fn export_gantt_xlsx(path: &Path, tasks: &[GanttTask]) -> Result<(), String> {
    let today = Local::now().naive_local().date();
    let bytes = build_gantt_xlsx_bytes(tasks, today)?;

    let parent = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
    if !parent.exists() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp_name = format!(
        ".{}.{}.tmp",
        path.file_name().and_then(|s| s.to_str()).unwrap_or("gantt"),
        uuid::Uuid::new_v4().simple()
    );
    let tmp_path = parent.join(tmp_name);
    if let Err(e) = std::fs::write(&tmp_path, &bytes) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("写入 Excel 临时文件失败: {}", e));
    }
    if let Err(e) = std::fs::rename(&tmp_path, path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("保存 Excel 失败（文件可能正在被其他程序占用）: {}", e));
    }
    Ok(())
}
