#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use serde::Serialize;
use std::path::Path;
use std::thread;
use std::time::Duration;
use tauri::Manager;
use tokio::task;
use walkdir::WalkDir;

#[derive(Serialize, Clone)]
struct ProcessResult {
    success_count: usize,
    fail_count: usize,
    messages: Vec<String>,
}

#[derive(Serialize)]
struct DirEntry {
    name: String,
    is_dir: bool,
}

/// 读取目录内容（预览用）
#[tauri::command]
async fn read_directory(path: String) -> Result<Vec<DirEntry>, String> {
    let path = Path::new(&path);
    if !path.exists() {
        return Err("路径不存在".to_string());
    }
    if !path.is_dir() {
        return Err("路径不是目录".to_string());
    }

    let mut entries: Vec<DirEntry> = Vec::new();

    match std::fs::read_dir(path) {
        Ok(read_dir) => {
            for entry in read_dir.flatten() {
                let file_name = entry.file_name().to_string_lossy().to_string();
                let is_dir = entry.path().is_dir();
                entries.push(DirEntry {
                    name: file_name,
                    is_dir,
                });
            }
        }
        Err(e) => return Err(format!("无法读取目录: {}", e)),
    }

    entries.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(entries)
}

/// 带重试的文件重命名（对抗安全软件的文件锁定）
fn rename_with_retry(from: &Path, to: &Path, max_retries: u32, delay_ms: u64) -> Result<(), std::io::Error> {
    let mut last_err = None;
    for attempt in 1..=max_retries {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = Some(e);
                if attempt < max_retries {
                    thread::sleep(Duration::from_millis(delay_ms));
                }
            }
        }
    }
    Err(last_err.unwrap())
}

/// touch 操作：遍历文件，依次执行 添加.{suffix}后缀 → 移除.{suffix}后缀
/// 如果 path 是文件，只处理该文件；如果 path 是目录，递归处理
/// 只有两步都成功才算成功，否则回滚（带重试）
fn touch_single_file(
    file_path: &Path,
    suffix: &str,
    app_handle: &tauri::AppHandle,
    messages: &mut Vec<String>,
    success: &mut usize,
    fail: &mut usize,
) -> Result<(), String> {
    let original_name = file_path
        .file_name()
        .ok_or("无法获取文件名")?
        .to_string_lossy()
        .to_string();

    let parent = file_path.parent().ok_or("无法获取父目录")?;

    // 步骤1: 添加 .{suffix} 后缀（最多重试3次）
    let suffixed_name = format!("{}.{}", original_name, suffix);
    let suffixed_path = parent.join(&suffixed_name);

    if let Err(e) = rename_with_retry(file_path, &suffixed_path, 3, 200) {
        let log_msg = format!("[失败] {} - 添加.{}失败(重试3次): {}", original_name, suffix, e);
        messages.push(log_msg.clone());
        *fail += 1;
        let _ = app_handle.emit_all("process-log", log_msg);
        return Err(e.to_string());
    }

    // 等待200ms让安全软件释放锁定
    thread::sleep(Duration::from_millis(200));

    // 步骤2: 移除 .{suffix} 后缀（还原，最多重试5次）
    match rename_with_retry(&suffixed_path, file_path, 5, 300) {
        Ok(_) => {
            let log_msg = format!(
                "[成功] {} (touch完成: 添加.{} → 移除.{})",
                original_name, suffix, suffix
            );
            messages.push(log_msg.clone());
            *success += 1;
            let _ = app_handle.emit_all("process-log", log_msg);
        }
        Err(e) => {
            // 回滚：把 .{suffix} 文件重命名回原名
            let rollback_msg = format!(
                "[回滚] {} - 移除.{}失败(重试5次): {}，正在尝试回滚...",
                suffixed_name, suffix, e
            );
            let _ = app_handle.emit_all("process-log", rollback_msg.clone());
            messages.push(rollback_msg);

            if let Err(rollback_err) = rename_with_retry(&suffixed_path, file_path, 3, 200) {
                let err_msg = format!(
                    "[错误] {} - 回滚也失败，文件可能残留为 {}: {}",
                    suffixed_name, suffixed_name, rollback_err
                );
                messages.push(err_msg.clone());
                let _ = app_handle.emit_all("process-log", err_msg);
            } else {
                let ok_msg = format!("[回滚成功] {} 已恢复为 {}", suffixed_name, original_name);
                messages.push(ok_msg.clone());
                let _ = app_handle.emit_all("process-log", ok_msg);
            }

            *fail += 1;
            return Err(e.to_string());
        }
    }

    Ok(())
}

fn process_touch_path(
    path: &Path,
    suffix: &str,
    app_handle: &tauri::AppHandle,
    messages: &mut Vec<String>,
    success: &mut usize,
    fail: &mut usize,
) {
    if path.is_file() {
        let _ = touch_single_file(path, suffix, app_handle, messages, success, fail);
    } else if path.is_dir() {
        for entry in WalkDir::new(path)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if entry.file_type().is_file() {
                let _ = touch_single_file(entry.path(), suffix, app_handle, messages, success, fail);
            }
        }
    }
}

/// 对多个路径执行 touch 操作（每个文件：添加.{suffix} → 移除.{suffix}）
#[tauri::command]
async fn touch_files(paths: Vec<String>, suffix: String, app_handle: tauri::AppHandle) -> Result<ProcessResult, String> {
    let result = task::spawn_blocking(move || {
        let mut success: usize = 0;
        let mut fail: usize = 0;
        let mut messages: Vec<String> = Vec::new();

        for path_str in &paths {
            let path = Path::new(path_str);
            if !path.exists() {
                let msg = format!("[跳过] 路径不存在: {}", path_str);
                messages.push(msg.clone());
                fail += 1;
                let _ = app_handle.emit_all("process-log", msg);
                continue;
            }
            process_touch_path(path, &suffix, &app_handle, &mut messages, &mut success, &mut fail);
        }

        ProcessResult {
            success_count: success,
            fail_count: fail,
            messages,
        }
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))?;

    Ok(result)
}

fn main() {
    env_logger::init();
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            touch_files,
            read_directory,
        ])
        .run(tauri::generate_context!())
        .expect("启动失败");
}
