use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::store::DataStore;

pub const AI_SECRETS_FILENAME: &str = "ai-secrets.json";
const HTTP_TIMEOUT_SECS: u64 = 45;
pub const MAX_AI_PROMPT_CHARS: usize = 60_000;

const TASK_JSON_SCHEMA_LOCK: &str = r#"
[NON-EDITABLE OUTPUT SCHEMA]
Output ONLY compact minified JSON (no markdown fences, no commentary).
Fill ONLY the fixed fields below for each task in {"tasks":[...]} (or a JSON array):
- "content": string (required, concise actionable title)
- "priority": "p0"|"p1"|"p2"|null (p0=urgent/high, p1=medium, p2=low)
- "startDate": "YYYY-MM-DD"|null (resolve relative dates from Current local date)
- "deadline": "YYYY-MM-DD"|null (resolve relative dates from Current local date)
- "children": array of same objects (omit or [] if none)
- For task breakdown: output ONLY the subtasks; NEVER repeat or wrap the target parent task itself as a node."#;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum AiProvider {
    #[default]
    Openai,
    Deepseek,
    Gemini,
    Anthropic,
    Siliconflow,
    Qwen,
    Moonshot,
    Zhipu,
    Ollama,
    #[serde(other)]
    Custom,
}

impl AiProvider {
    pub fn default_base_url(&self) -> &'static str {
        match self {
            Self::Openai => "https://api.openai.com/v1",
            Self::Deepseek => "https://api.deepseek.com/v1",
            Self::Gemini => "https://generativelanguage.googleapis.com/v1beta",
            Self::Anthropic => "https://api.anthropic.com/v1",
            Self::Siliconflow => "https://api.siliconflow.cn/v1",
            Self::Qwen => "https://dashscope.aliyuncs.com/compatible-mode/v1",
            Self::Moonshot => "https://api.moonshot.cn/v1",
            Self::Zhipu => "https://open.bigmodel.cn/api/paas/v4",
            Self::Ollama => "http://localhost:11434/v1",
            Self::Custom => "",
        }
    }

    pub fn default_model(&self) -> &'static str {
        match self {
            Self::Openai => "gpt-4o-mini",
            Self::Deepseek => "deepseek-chat",
            Self::Gemini => "gemini-2.5-flash",
            Self::Anthropic => "claude-sonnet-4-5-20250929",
            Self::Siliconflow => "Qwen/Qwen2.5-72B-Instruct",
            Self::Qwen => "qwen-plus",
            Self::Moonshot => "moonshot-v1-8k",
            Self::Zhipu => "glm-4-flash",
            Self::Ollama => "qwen2.5:7b",
            Self::Custom => "gpt-4o-mini",
        }
    }
}

pub fn default_weekly_report_prompt() -> String {
    "You are a concise, structured work-report assistant. Summarize the completed tasks into a clear weekly report grouped by theme or project, highlighting key outcomes and next steps. Respond in the requested language (Chinese if \"zh\"/Chinese, otherwise English).".to_string()
}

pub fn default_task_breakdown_prompt() -> String {
    "You are an expert project planner. Based on the task title, task description/notes, and any extra instruction, decide if the task genuinely benefits from decomposition. If it has clear multi-step scope, break it down into concrete, actionable subtasks within the requested maximum task count and nesting depth. Output ONLY the subtasks; NEVER repeat or wrap the target parent task itself as a node. If the task is already atomic, trivial, or lacks enough context/description (e.g., a vague short noun with no notes or instructions), DO NOT force a breakdown—return an empty array [] instead of inventing filler steps. Respond in the requested language (Chinese if \"zh\"/Chinese, otherwise English).".to_string()
}

pub fn default_notes_to_tasks_prompt() -> String {
    "You are an expert productivity assistant. Extract actionable tasks, priorities, and any implied dates from the provided note content. Respond in the requested language (Chinese if \"zh\"/Chinese, otherwise English).".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiPrompts {
    #[serde(default = "default_weekly_report_prompt")]
    pub weekly_report: String,
    #[serde(default = "default_task_breakdown_prompt")]
    pub task_breakdown: String,
    #[serde(default = "default_notes_to_tasks_prompt")]
    pub notes_to_tasks: String,
}

impl Default for AiPrompts {
    fn default() -> Self {
        Self {
            weekly_report: default_weekly_report_prompt(),
            task_breakdown: default_task_breakdown_prompt(),
            notes_to_tasks: default_notes_to_tasks_prompt(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    #[serde(default)]
    pub provider: AiProvider,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub prompts: AiPrompts,
}

impl AiConfig {
    pub fn effective_base_url(&self) -> String {
        let trimmed = self.base_url.trim().trim_end_matches('/');
        if trimmed.is_empty() {
            self.provider.default_base_url().to_string()
        } else {
            trimmed.to_string()
        }
    }

    pub fn effective_model(&self) -> String {
        let trimmed = self.model.trim();
        if trimmed.is_empty() {
            self.provider.default_model().to_string()
        } else {
            trimmed.to_string()
        }
    }

    pub fn to_public(&self) -> AiConfigPublic {
        let trimmed_key = self.api_key.trim();
        AiConfigPublic {
            provider: self.provider,
            has_api_key: !trimmed_key.is_empty(),
            api_key_masked: mask_api_key(trimmed_key),
            base_url: self.base_url.clone(),
            model: self.model.clone(),
            effective_base_url: self.effective_base_url(),
            effective_model: self.effective_model(),
            prompts: self.prompts.clone(),
            default_prompts: AiPrompts::default(),
        }
    }

    pub fn apply_input(&mut self, input: AiConfigInput) {
        self.provider = input.provider;
        if input.clear_api_key {
            self.api_key.clear();
        } else if let Some(key) = input.api_key {
            let trimmed = key.trim();
            if !trimmed.is_empty() {
                self.api_key = trimmed.to_string();
            }
        }
        self.base_url = input.base_url.trim().to_string();
        self.model = input.model.trim().to_string();
        if let Some(prompts) = input.prompts {
            self.prompts = AiPrompts {
                weekly_report: non_empty_or(prompts.weekly_report, default_weekly_report_prompt),
                task_breakdown: non_empty_or(prompts.task_breakdown, default_task_breakdown_prompt),
                notes_to_tasks: non_empty_or(prompts.notes_to_tasks, default_notes_to_tasks_prompt),
            };
        }
    }
}

fn non_empty_or(value: String, fallback: fn() -> String) -> String {
    if value.trim().is_empty() {
        fallback()
    } else {
        value
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigPublic {
    pub provider: AiProvider,
    pub has_api_key: bool,
    pub api_key_masked: String,
    pub base_url: String,
    pub model: String,
    pub effective_base_url: String,
    pub effective_model: String,
    pub prompts: AiPrompts,
    pub default_prompts: AiPrompts,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigInput {
    pub provider: AiProvider,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub clear_api_key: bool,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub prompts: Option<AiPrompts>,
}

fn deserialize_null_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    T: Default + Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    let opt = Option::deserialize(deserializer)?;
    Ok(opt.unwrap_or_default())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedTaskItem {
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub content: String,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub start_date: Option<String>,
    #[serde(default)]
    pub deadline: Option<String>,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub children: Vec<GeneratedTaskItem>,
}

pub fn mask_api_key(key: &str) -> String {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() <= 8 {
        return "****".to_string();
    }
    let prefix: String = chars[..4].iter().collect();
    let suffix: String = chars[chars.len() - 4..].iter().collect();
    format!("{prefix}****{suffix}")
}

pub fn secrets_path_for_data_path(data_path: &Path) -> PathBuf {
    let parent = data_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    parent.join(AI_SECRETS_FILENAME)
}

pub fn resolve_secrets_path() -> PathBuf {
    secrets_path_for_data_path(&DataStore::resolve_data_path())
}

const DPAPI_PREFIX: &str = "dpapi:";
const FALLBACK_ENC_PREFIX: &str = "b64:";
#[cfg(not(windows))]
const KEYRING_PREFIX: &str = "keyring:";
#[cfg(not(windows))]
const KEYRING_SERVICE: &str = "com.module.taskmanager";
#[cfg(all(not(windows), not(test)))]
const KEYRING_ACCOUNT: &str = "ai-api-key";
#[cfg(all(not(windows), test))]
const KEYRING_ACCOUNT: &str = "ai-api-key-test";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AiSecretsDisk {
    #[serde(default)]
    provider: AiProvider,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    api_key: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    api_key_enc: String,
    #[serde(default)]
    base_url: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    prompts: AiPrompts,
}

fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;

        out.push(TABLE[((triple >> 18) & 0x3F) as usize] as char);
        out.push(TABLE[((triple >> 12) & 0x3F) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((triple >> 6) & 0x3F) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(triple & 0x3F) as usize] as char
        } else {
            '='
        });
    }
    out
}

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    fn decode_char(b: u8) -> Option<u8> {
        match b {
            b'A'..=b'Z' => Some(b - b'A'),
            b'a'..=b'z' => Some(b - b'a' + 26),
            b'0'..=b'9' => Some(b - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    let cleaned: Vec<u8> = input.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    if cleaned.len() % 4 != 0 {
        return Err("Invalid base64 length".to_string());
    }
    let mut out = Vec::with_capacity((cleaned.len() / 4) * 3);
    for (idx, chunk) in cleaned.chunks_exact(4).enumerate() {
        let is_last = idx == cleaned.len() / 4 - 1;
        let pad = if chunk[3] == b'=' {
            if chunk[2] == b'=' { 2 } else { 1 }
        } else {
            0
        };
        if !is_last && pad > 0 {
            return Err("Invalid base64 padding".to_string());
        }
        let v0 = decode_char(chunk[0]).ok_or_else(|| "Invalid base64 character".to_string())?;
        let v1 = decode_char(chunk[1]).ok_or_else(|| "Invalid base64 character".to_string())?;
        let v2 = if pad == 2 {
            0
        } else {
            decode_char(chunk[2]).ok_or_else(|| "Invalid base64 character".to_string())?
        };
        let v3 = if pad >= 1 {
            0
        } else {
            decode_char(chunk[3]).ok_or_else(|| "Invalid base64 character".to_string())?
        };

        let triple = ((v0 as u32) << 18) | ((v1 as u32) << 12) | ((v2 as u32) << 6) | (v3 as u32);
        out.push(((triple >> 16) & 0xFF) as u8);
        if pad < 2 {
            out.push(((triple >> 8) & 0xFF) as u8);
        }
        if pad == 0 {
            out.push((triple & 0xFF) as u8);
        }
    }
    Ok(out)
}

#[cfg(windows)]
mod dpapi {
    use std::ffi::c_void;

    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

    #[repr(C)]
    struct DataBlob {
        cb_data: u32,
        pb_data: *mut u8,
    }

    #[link(name = "crypt32")]
    unsafe extern "system" {
        fn CryptProtectData(
            p_data_in: *const DataBlob,
            sz_data_descr: *const u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *mut c_void,
            p_prompt_struct: *mut c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;

        fn CryptUnprotectData(
            p_data_in: *const DataBlob,
            ppsz_data_descr: *mut *mut u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *mut c_void,
            p_prompt_struct: *mut c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn LocalFree(h_mem: *mut c_void) -> *mut c_void;
    }

    pub fn protect(plaintext: &[u8]) -> Result<Vec<u8>, String> {
        let mut in_buf = plaintext.to_vec();
        let in_blob = DataBlob {
            cb_data: u32::try_from(in_buf.len()).map_err(|_| "API key too long".to_string())?,
            pb_data: if in_buf.is_empty() {
                std::ptr::null_mut()
            } else {
                in_buf.as_mut_ptr()
            },
        };
        let mut out_blob = DataBlob {
            cb_data: 0,
            pb_data: std::ptr::null_mut(),
        };

        let ok = unsafe {
            CryptProtectData(
                &in_blob,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out_blob,
            )
        };
        if ok == 0 {
            return Err(format!(
                "DPAPI CryptProtectData failed: {}",
                std::io::Error::last_os_error()
            ));
        }

        let protected = unsafe {
            let result = if out_blob.pb_data.is_null() || out_blob.cb_data == 0 {
                Vec::new()
            } else {
                std::slice::from_raw_parts(out_blob.pb_data, out_blob.cb_data as usize).to_vec()
            };
            if !out_blob.pb_data.is_null() {
                LocalFree(out_blob.pb_data as *mut c_void);
            }
            result
        };
        Ok(protected)
    }

    pub fn unprotect(ciphertext: &[u8]) -> Result<Vec<u8>, String> {
        let mut in_buf = ciphertext.to_vec();
        let in_blob = DataBlob {
            cb_data: u32::try_from(in_buf.len()).map_err(|_| "Encrypted key too long".to_string())?,
            pb_data: if in_buf.is_empty() {
                std::ptr::null_mut()
            } else {
                in_buf.as_mut_ptr()
            },
        };
        let mut out_blob = DataBlob {
            cb_data: 0,
            pb_data: std::ptr::null_mut(),
        };

        let ok = unsafe {
            CryptUnprotectData(
                &in_blob,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out_blob,
            )
        };
        if ok == 0 {
            return Err(format!(
                "DPAPI CryptUnprotectData failed: {}",
                std::io::Error::last_os_error()
            ));
        }

        let plaintext = unsafe {
            let result = if out_blob.pb_data.is_null() || out_blob.cb_data == 0 {
                Vec::new()
            } else {
                std::slice::from_raw_parts(out_blob.pb_data, out_blob.cb_data as usize).to_vec()
            };
            if !out_blob.pb_data.is_null() {
                LocalFree(out_blob.pb_data as *mut c_void);
            }
            result
        };
        Ok(plaintext)
    }
}

#[cfg(windows)]
fn protect_api_key(plaintext: &str) -> Result<String, String> {
    if plaintext.is_empty() {
        return Ok(String::new());
    }
    let encrypted = dpapi::protect(plaintext.as_bytes())?;
    Ok(format!("{DPAPI_PREFIX}{}", base64_encode(&encrypted)))
}

#[cfg(not(windows))]
fn store_api_key_in_keyring(plaintext: &str) -> Result<String, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| format!("Failed to access OS credential store: {e}"))?;
    entry
        .set_password(plaintext)
        .map_err(|e| format!("Failed to store API key in OS credential store: {e}"))?;
    Ok(format!("{KEYRING_PREFIX}{KEYRING_ACCOUNT}"))
}

#[cfg(not(windows))]
fn load_api_key_from_keyring(account: &str) -> Result<String, String> {
    let target_account = if account.trim().is_empty() {
        KEYRING_ACCOUNT
    } else {
        account.trim()
    };
    let entry = keyring::Entry::new(KEYRING_SERVICE, target_account)
        .map_err(|e| format!("Failed to access OS credential store: {e}"))?;
    match entry.get_password() {
        Ok(secret) => Ok(secret),
        Err(keyring::Error::NoEntry) => Ok(String::new()),
        Err(e) => Err(format!("Failed to read API key from OS credential store: {e}")),
    }
}

#[cfg(not(windows))]
fn delete_api_key_from_keyring() {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT) {
        let _ = entry.delete_credential();
    }
}

#[cfg(not(windows))]
fn protect_api_key(plaintext: &str) -> Result<String, String> {
    if plaintext.is_empty() {
        return Ok(String::new());
    }
    match store_api_key_in_keyring(plaintext) {
        Ok(keyring_ref) => Ok(keyring_ref),
        Err(err) => {
            log::warn!("OS credential store unavailable, falling back to b64 storage: {err}");
            Ok(format!("{FALLBACK_ENC_PREFIX}{}", base64_encode(plaintext.as_bytes())))
        }
    }
}

fn unprotect_api_key(encoded: &str) -> Result<String, String> {
    let trimmed = encoded.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if let Some(payload) = trimmed.strip_prefix(DPAPI_PREFIX) {
        #[cfg(windows)]
        {
            let bytes = base64_decode(payload)?;
            let plain = dpapi::unprotect(&bytes)?;
            return String::from_utf8(plain)
                .map_err(|e| format!("Decrypted API key is not valid UTF-8: {e}"));
        }
        #[cfg(not(windows))]
        {
            let _ = payload;
            return Err("DPAPI encrypted key cannot be decrypted on non-Windows platform".to_string());
        }
    }
    #[cfg(not(windows))]
    if let Some(account) = trimmed.strip_prefix(KEYRING_PREFIX) {
        return load_api_key_from_keyring(account);
    }
    if let Some(payload) = trimmed.strip_prefix(FALLBACK_ENC_PREFIX) {
        let bytes = base64_decode(payload)?;
        return String::from_utf8(bytes)
            .map_err(|e| format!("Decoded API key is not valid UTF-8: {e}"));
    }
    Ok(trimmed.to_string())
}

fn write_ai_secrets_disk(path: &Path, disk: &AiSecretsDisk) -> Result<(), String> {
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create AI config directory ({}): {e}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(disk)
        .map_err(|e| format!("Failed to serialize AI config: {e}"))?;
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(AI_SECRETS_FILENAME);
    let tmp_path = path.with_file_name(format!("{file_name}.tmp.{}", std::process::id()));
    fs::write(&tmp_path, json)
        .map_err(|e| format!("Failed to write temporary AI config ({}): {e}", tmp_path.display()))?;
    if let Err(e) = fs::rename(&tmp_path, path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("Failed to replace AI config ({}): {e}", path.display()));
    }
    Ok(())
}

pub fn load_ai_config(path: &Path) -> Result<AiConfig, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(AiConfig::default()),
        Err(e) => return Err(format!("Failed to read AI config ({}): {e}", path.display())),
    };
    let mut disk: AiSecretsDisk = serde_json::from_slice(&bytes)
        .map_err(|e| format!("Invalid AI config JSON ({}): {e}", path.display()))?;

    let enc_trimmed = disk.api_key_enc.trim();
    let legacy_trimmed = disk.api_key.trim();
    let api_key = if !enc_trimmed.is_empty() {
        unprotect_api_key(enc_trimmed)?
    } else if !legacy_trimmed.is_empty() {
        legacy_trimmed.to_string()
    } else {
        String::new()
    };

    #[cfg(not(windows))]
    if !api_key.is_empty() && !enc_trimmed.starts_with(KEYRING_PREFIX) {
        if let Ok(keyring_ref) = store_api_key_in_keyring(&api_key) {
            disk.api_key = String::new();
            disk.api_key_enc = keyring_ref;
            if let Err(err) = write_ai_secrets_disk(path, &disk) {
                log::warn!("Failed to persist migrated keyring reference to {}: {err}", path.display());
            }
        }
    }

    Ok(AiConfig {
        provider: disk.provider,
        api_key,
        base_url: disk.base_url,
        model: disk.model,
        prompts: disk.prompts,
    })
}

pub fn save_ai_config(path: &Path, config: &AiConfig) -> Result<(), String> {
    let trimmed_key = config.api_key.trim();
    let api_key_enc = if trimmed_key.is_empty() {
        #[cfg(not(windows))]
        delete_api_key_from_keyring();
        String::new()
    } else {
        protect_api_key(trimmed_key)?
    };
    let disk = AiSecretsDisk {
        provider: config.provider,
        api_key: String::new(),
        api_key_enc,
        base_url: config.base_url.clone(),
        model: config.model.clone(),
        prompts: config.prompts.clone(),
    };
    write_ai_secrets_disk(path, &disk)
}

pub fn build_weekly_report_prompt(
    config: &AiConfig,
    report_text: &str,
    language: &str,
) -> (String, String) {
    let system_prompt = config.prompts.weekly_report.trim().to_string();
    let user_prompt = format!(
        "Target language: {language}\n\nCompleted tasks / raw report:\n{report_text}"
    );
    (system_prompt, user_prompt)
}

pub fn build_task_breakdown_prompt(
    config: &AiConfig,
    task_content: &str,
    task_notes: Option<&str>,
    instruction: Option<&str>,
    max_subtasks_depth: usize,
    language: &str,
) -> (String, String) {
    let editable = config.prompts.task_breakdown.trim();
    let system_prompt = format!("{editable}\n{TASK_JSON_SCHEMA_LOCK}");
    let notes_section = task_notes
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("(none)");
    let instruction_section = instruction
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("(none)");
    let today = chrono::Local::now().format("%Y-%m-%d (%A)").to_string();
    let user_prompt = format!(
        "Current local date: {today}\nTarget language: {language}\nMax nesting depth: {max_subtasks_depth}\nTask: {task_content}\nNotes: {notes_section}\nExtra instruction: {instruction_section}"
    );
    (system_prompt, user_prompt)
}

pub fn build_notes_to_tasks_prompt(
    config: &AiConfig,
    note_content: &str,
    language: &str,
) -> (String, String) {
    let editable = config.prompts.notes_to_tasks.trim();
    let system_prompt = format!("{editable}\n{TASK_JSON_SCHEMA_LOCK}");
    let today = chrono::Local::now().format("%Y-%m-%d (%A)").to_string();
    let user_prompt = format!("Current local date: {today}\nTarget language: {language}\n\nNote content:\n{note_content}");
    (system_prompt, user_prompt)
}

pub fn extract_json_str(raw: &str) -> &str {
    let trimmed = raw.trim();
    if let Some(after_open) = strip_markdown_fence(trimmed) {
        return after_open;
    }
    let Some(start) = trimmed.find(|c| c == '{' || c == '[') else {
        return trimmed;
    };
    let mut depth: usize = 0;
    let mut in_string = false;
    let mut escaped = false;
    for (rel_idx, ch) in trimmed[start..].char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '{' | '[' => depth += 1,
            '}' | ']' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    let end = start + rel_idx + ch.len_utf8();
                    return trimmed[start..end].trim();
                }
            }
            _ => {}
        }
    }
    trimmed[start..].trim()
}

fn strip_markdown_fence(input: &str) -> Option<&str> {
    let fence_start = input.find("```")?;
    let after_ticks = &input[fence_start + 3..];
    let header_end = after_ticks.find('\n')?;
    let body = &after_ticks[header_end + 1..];
    let fence_end = body.find("```")?;
    Some(body[..fence_end].trim())
}

pub fn parse_generated_tasks(raw: &str) -> Result<Vec<GeneratedTaskItem>, String> {
    let json_str = extract_json_str(raw);
    let value: Value = serde_json::from_str(json_str)
        .map_err(|e| format!("Failed to parse AI task JSON: {e}"))?;

    let items: Vec<GeneratedTaskItem> = if value.is_array() {
        serde_json::from_value(value)
            .map_err(|e| format!("Invalid task array structure: {e}"))?
    } else if let Some(tasks_val) = value.get("tasks").filter(|v| v.is_array()) {
        serde_json::from_value(tasks_val.clone())
            .map_err(|e| format!("Invalid tasks field structure: {e}"))?
    } else {
        return Err("AI response JSON must be an array or an object with a 'tasks' array".to_string());
    };

    Ok(sanitize_tasks(items))
}

fn sanitize_tasks(items: Vec<GeneratedTaskItem>) -> Vec<GeneratedTaskItem> {
    items
        .into_iter()
        .filter_map(|mut item| {
            let trimmed = item.content.trim().to_string();
            if trimmed.is_empty() {
                return None;
            }
            item.content = trimmed;
            item.children = sanitize_tasks(item.children);
            Some(item)
        })
        .collect()
}

static HTTP_CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();

fn shared_http_client() -> Result<&'static Client, String> {
    HTTP_CLIENT
        .get_or_init(|| {
            Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
                .build()
                .map_err(|e| format!("Failed to build HTTP client: {e}"))
        })
        .as_ref()
        .map_err(Clone::clone)
}

fn validate_prompt_size(system_prompt: &str, user_prompt: &str) -> Result<(), String> {
    let total_chars = system_prompt.chars().count() + user_prompt.chars().count();
    if total_chars > MAX_AI_PROMPT_CHARS {
        return Err(format!(
            "ERR_INPUT_TOO_LARGE ({total_chars} chars > {MAX_AI_PROMPT_CHARS} max)"
        ));
    }
    Ok(())
}

fn sanitize_error_message(msg: &str, api_key: &str) -> String {
    let mut sanitized = msg.to_string();
    let trimmed = api_key.trim();
    if !trimmed.is_empty() {
        sanitized = sanitized.replace(trimmed, "[REDACTED]");
    }
    for param in ["?key=", "&key=", "?api_key=", "&api_key="] {
        let mut search_from = 0;
        while let Some(rel_idx) = sanitized[search_from..].find(param) {
            let value_start = search_from + rel_idx + param.len();
            let value_end = sanitized[value_start..]
                .find(|c: char| c == '&' || c.is_whitespace() || matches!(c, '"' | '\'' | ')' | ']'))
                .map(|rel| value_start + rel)
                .unwrap_or(sanitized.len());
            sanitized.replace_range(value_start..value_end, "[REDACTED]");
            search_from = value_start + "[REDACTED]".len();
        }
    }
    sanitized
}

fn validate_model_name(provider: AiProvider, model: &str) -> Result<(), String> {
    if model.is_empty()
        || model.contains('?')
        || model.contains('#')
        || model.contains('\\')
        || model.contains("..")
        || (provider == AiProvider::Gemini && model.contains('/'))
    {
        return Err("Invalid model name".to_string());
    }
    Ok(())
}

fn require_api_key_and_base_url<'a>(config: &'a AiConfig) -> Result<(&'a str, String), String> {
    let api_key = config.api_key.trim();
    if api_key.is_empty() && !matches!(config.provider, AiProvider::Ollama | AiProvider::Custom) {
        return Err("ERR_API_KEY_MISSING".to_string());
    }
    let base_url = config.effective_base_url();
    if base_url.is_empty() {
        return Err("Base URL is required".to_string());
    }
    let parsed = reqwest::Url::parse(&base_url)
        .map_err(|e| format!("Invalid Base URL: {e}"))?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err("Base URL must use http or https".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Base URL must not contain embedded credentials".to_string());
    }
    let is_loopback = matches!(
        parsed.host_str(),
        Some("localhost" | "127.0.0.1" | "::1" | "[::1]")
    );
    if !api_key.is_empty() && scheme != "https" && !is_loopback {
        return Err("API key requires HTTPS Base URL (except localhost/loopback)".to_string());
    }
    Ok((api_key, base_url))
}

async fn call_llm(
    config: &AiConfig,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<String, String> {
    let (api_key, base_url) = require_api_key_and_base_url(config)?;
    let client = shared_http_client()?;
    let model = config.effective_model();
    validate_model_name(config.provider, &model)?;

    match config.provider {
        AiProvider::Gemini => {
            let url = format!("{base_url}/models/{model}:generateContent");
            let body = json!({
                "systemInstruction": {
                    "parts": [{ "text": system_prompt }]
                },
                "contents": [
                    {
                        "role": "user",
                        "parts": [{ "text": user_prompt }]
                    }
                ],
                "generationConfig": {
                    "temperature": 0.3
                }
            });

            let resp = client
                .post(&url)
                .header("x-goog-api-key", api_key)
                .json(&body)
                .send()
                .await
                .map_err(|e| sanitize_error_message(&format!("Gemini request failed: {e}"), api_key))?;

            let payload = read_json_response(resp, "Gemini", api_key).await?;

            let parts = payload
                .pointer("/candidates/0/content/parts")
                .and_then(Value::as_array)
                .ok_or_else(|| "Gemini response missing candidates[0].content.parts".to_string())?;

            let text: String = parts
                .iter()
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("");

            let trimmed = text.trim().to_string();
            if trimmed.is_empty() {
                return Err("Gemini response returned empty text".to_string());
            }
            Ok(trimmed)
        }
        AiProvider::Anthropic => {
            let url = format!("{base_url}/messages");
            let body = json!({
                "model": model,
                "max_tokens": 4096,
                "system": system_prompt,
                "messages": [
                    { "role": "user", "content": user_prompt }
                ],
                "temperature": 0.3
            });

            let resp = client
                .post(&url)
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01")
                .json(&body)
                .send()
                .await
                .map_err(|e| sanitize_error_message(&format!("Anthropic request failed: {e}"), api_key))?;

            let payload = read_json_response(resp, "Anthropic", api_key).await?;

            let parts = payload
                .get("content")
                .and_then(Value::as_array)
                .ok_or_else(|| "Anthropic response missing content".to_string())?;

            let text: String = parts
                .iter()
                .filter(|p| p.get("type").and_then(Value::as_str) != Some("thinking"))
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("");

            let trimmed = text.trim().to_string();
            if trimmed.is_empty() {
                return Err("Anthropic response returned empty text".to_string());
            }
            Ok(trimmed)
        }
        AiProvider::Openai
        | AiProvider::Deepseek
        | AiProvider::Siliconflow
        | AiProvider::Qwen
        | AiProvider::Moonshot
        | AiProvider::Zhipu
        | AiProvider::Ollama
        | AiProvider::Custom => {
            let url = format!("{base_url}/chat/completions");
            let body = json!({
                "model": model,
                "messages": [
                    { "role": "system", "content": system_prompt },
                    { "role": "user", "content": user_prompt }
                ],
                "temperature": 0.3
            });

            let mut req = client.post(&url).json(&body);
            if !api_key.is_empty() {
                req = req.bearer_auth(api_key);
            }

            let resp = req
                .send()
                .await
                .map_err(|e| sanitize_error_message(&format!("AI request failed: {e}"), api_key))?;

            let payload = read_json_response(resp, "AI", api_key).await?;

            payload
                .pointer("/choices/0/message/content")
                .and_then(Value::as_str)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "AI response missing choices[0].message.content".to_string())
        }
    }
}

pub async fn list_models(config: &AiConfig) -> Result<Vec<String>, String> {
    let (api_key, base_url) = require_api_key_and_base_url(config)?;
    let client = shared_http_client()?;
    let url = format!("{base_url}/models");

    let mut req = client.get(&url);
    match config.provider {
        AiProvider::Gemini => {
            req = req.header("x-goog-api-key", api_key);
        }
        AiProvider::Anthropic => {
            req = req
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01");
        }
        _ => {
            if !api_key.is_empty() {
                req = req.bearer_auth(api_key);
            }
        }
    }

    let resp = req
        .send()
        .await
        .map_err(|e| sanitize_error_message(&format!("Failed to fetch models: {e}"), api_key))?;

    let payload = read_json_response(resp, "models", api_key).await?;

    let mut models: Vec<String> = match config.provider {
        AiProvider::Gemini => payload
            .get("models")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| m.get("name").and_then(Value::as_str))
                    .map(|name| name.strip_prefix("models/").unwrap_or(name).trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default(),
        _ => {
            if let Some(arr) = payload.get("data").and_then(Value::as_array) {
                arr.iter()
                    .filter_map(|m| m.get("id").and_then(Value::as_str))
                    .map(|id| id.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            } else if let Some(arr) = payload.get("models").and_then(Value::as_array) {
                arr.iter()
                    .filter_map(|m| {
                        m.get("id")
                            .or_else(|| m.get("name"))
                            .and_then(Value::as_str)
                    })
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            } else {
                Vec::new()
            }
        }
    };

    models.sort();
    models.dedup();
    Ok(models)
}

async fn read_json_response(
    resp: reqwest::Response,
    label: &str,
    api_key: &str,
) -> Result<Value, String> {
    let status = resp.status();
    if !status.is_success() {
        let body_text = match resp.text().await {
            Ok(text) => text,
            Err(e) => {
                let err_msg = sanitize_error_message(&format!("{e}"), api_key);
                let truncated: String = err_msg.chars().take(300).collect();
                return Err(format!(
                    "AI API error (HTTP {}): <failed to read response body: {}>",
                    status.as_u16(),
                    truncated
                ));
            }
        };
        return Err(format_api_error_text(status.as_u16(), &body_text, api_key));
    }

    resp.json()
        .await
        .map_err(|e| sanitize_error_message(&format!("Failed to read {label} response ({status}): {e}"), api_key))
}

fn format_api_error_text(status: u16, body_text: &str, api_key: &str) -> String {
    let extracted = serde_json::from_str::<Value>(body_text)
        .ok()
        .and_then(|payload| {
            payload
                .pointer("/error/message")
                .and_then(Value::as_str)
                .or_else(|| payload.get("error").and_then(Value::as_str))
                .or_else(|| payload.get("message").and_then(Value::as_str))
                .or_else(|| payload.get("detail").and_then(Value::as_str))
                .or_else(|| payload.pointer("/0/error/message").and_then(Value::as_str))
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        });
    let raw_msg = extracted.unwrap_or_else(|| {
        let trimmed = body_text.trim();
        if trimmed.is_empty() {
            "<empty response body>".to_string()
        } else {
            trimmed.to_string()
        }
    });
    let sanitized = sanitize_error_message(&raw_msg, api_key);
    let truncated: String = sanitized.chars().take(300).collect();
    format!("AI API error (HTTP {status}): {truncated}")
}

pub async fn test_connection(config: &AiConfig) -> Result<String, String> {
    call_llm(
        config,
        "You are a connectivity check assistant. Reply briefly with OK.",
        "Ping",
    )
    .await
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BreakdownResult {
    pub items: Vec<GeneratedTaskItem>,
    pub total_before_cap: usize,
    pub dropped_count: usize,
}

fn count_generated_tasks(items: &[GeneratedTaskItem]) -> usize {
    items
        .iter()
        .map(|item| 1 + count_generated_tasks(&item.children))
        .sum()
}

pub async fn generate_weekly_report(
    config: &AiConfig,
    report_text: &str,
    language: &str,
) -> Result<String, String> {
    let (system_prompt, user_prompt) = build_weekly_report_prompt(config, report_text, language);
    validate_prompt_size(&system_prompt, &user_prompt)?;
    call_llm(config, &system_prompt, &user_prompt).await
}

pub async fn breakdown_task(
    config: &AiConfig,
    task_content: &str,
    task_notes: Option<&str>,
    instruction: Option<&str>,
    max_subtasks_depth: usize,
    max_tasks: usize,
    language: &str,
) -> Result<BreakdownResult, String> {
    let limit = max_tasks.clamp(1, 20);
    let (system_prompt, mut user_prompt) = build_task_breakdown_prompt(
        config,
        task_content,
        task_notes,
        instruction,
        max_subtasks_depth,
        language,
    );
    user_prompt.push_str(&format!(
        "\nMaximum total subtasks (strictly <= {limit}, or 0 / [] if no breakdown is meaningful): {limit}"
    ));
    validate_prompt_size(&system_prompt, &user_prompt)?;
    let raw = call_llm(config, &system_prompt, &user_prompt).await?;
    let mut items = parse_generated_tasks(&raw)?;
    unwrap_and_dedup_parent(&mut items, task_content);
    let total_before_cap = count_generated_tasks(&items);
    cap_generated_tasks(&mut items, limit);
    let total_after_cap = count_generated_tasks(&items);
    let dropped_count = total_before_cap.saturating_sub(total_after_cap);
    Ok(BreakdownResult {
        items,
        total_before_cap,
        dropped_count,
    })
}

fn unwrap_and_dedup_parent(items: &mut Vec<GeneratedTaskItem>, task_content: &str) {
    let target = task_content.trim();
    if target.is_empty() {
        return;
    }
    if items.len() == 1
        && items[0].content.trim().eq_ignore_ascii_case(target)
        && !items[0].children.is_empty()
    {
        let parent = items.remove(0);
        *items = parent.children;
    }
    items.retain(|item| {
        !(item.children.is_empty() && item.content.trim().eq_ignore_ascii_case(target))
    });
}

fn cap_generated_tasks(items: &mut Vec<GeneratedTaskItem>, limit: usize) {
    fn take_budget(list: &mut Vec<GeneratedTaskItem>, remaining: &mut usize) {
        let mut kept = Vec::new();
        for mut item in list.drain(..) {
            if *remaining == 0 {
                break;
            }
            *remaining -= 1;
            if !item.children.is_empty() {
                take_budget(&mut item.children, remaining);
            }
            kept.push(item);
        }
        *list = kept;
    }
    let mut remaining = limit;
    take_budget(items, &mut remaining);
}

pub async fn notes_to_tasks(
    config: &AiConfig,
    note_content: &str,
    language: &str,
) -> Result<Vec<GeneratedTaskItem>, String> {
    let (system_prompt, user_prompt) = build_notes_to_tasks_prompt(config, note_content, language);
    validate_prompt_size(&system_prompt, &user_prompt)?;
    let raw = call_llm(config, &system_prompt, &user_prompt).await?;
    parse_generated_tasks(&raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::AppData;
    use uuid::Uuid;

    #[test]
    fn secrets_file_is_isolated_from_app_data() {
        let dir = std::env::temp_dir().join(format!("module-ai-test-{}", Uuid::new_v4()));
        let data_path = dir.join("tasks-data.json");
        let secrets_path = secrets_path_for_data_path(&data_path);

        assert_eq!(secrets_path, dir.join(AI_SECRETS_FILENAME));
        assert_ne!(secrets_path, data_path);

        let config = AiConfig {
            provider: AiProvider::Deepseek,
            api_key: "sk-secret-value-9876".to_string(),
            base_url: String::new(),
            model: String::new(),
            prompts: AiPrompts::default(),
        };
        save_ai_config(&secrets_path, &config).expect("save ai config");

        let disk_json = fs::read_to_string(&secrets_path).expect("read secrets json");
        assert!(!disk_json.contains("sk-secret-value-9876"));
        assert!(disk_json.contains("apiKeyEnc"));
        #[cfg(windows)]
        assert!(disk_json.contains("dpapi:"));

        let loaded = load_ai_config(&secrets_path).expect("load ai config");
        assert_eq!(loaded, config);

        let app_data_json = serde_json::to_string(&AppData::default()).expect("serialize AppData");
        assert!(!app_data_json.contains("sk-secret-value-9876"));
        assert!(!app_data_json.contains("apiKey"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn api_key_protection_roundtrip_and_legacy_migration() {
        let secret = "sk-live-test-key-0123456789-中文";
        let protected = protect_api_key(secret).expect("protect key");
        assert!(!protected.contains(secret));
        let unprotected = unprotect_api_key(&protected).expect("unprotect key");
        assert_eq!(unprotected, secret);

        // Legacy plaintext migration on next save
        let dir = std::env::temp_dir().join(format!("module-ai-legacy-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create temp dir");
        let secrets_path = dir.join(AI_SECRETS_FILENAME);
        let legacy_json = serde_json::json!({
            "provider": "openai",
            "apiKey": "sk-legacy-plaintext-9999",
            "baseUrl": "",
            "model": ""
        });
        fs::write(&secrets_path, serde_json::to_string(&legacy_json).unwrap()).expect("write legacy");

        let loaded = load_ai_config(&secrets_path).expect("load legacy");
        assert_eq!(loaded.api_key, "sk-legacy-plaintext-9999");

        save_ai_config(&secrets_path, &loaded).expect("resave migrated");
        let migrated_disk = fs::read_to_string(&secrets_path).expect("read migrated");
        assert!(!migrated_disk.contains("sk-legacy-plaintext-9999"));
        assert!(migrated_disk.contains("apiKeyEnc"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn error_sanitization_and_missing_key_check() {
        let leaked = "error sending request for url (https://generativelanguage.googleapis.com/v1beta/models?key=AIzaSecret123&alt=json) with sk-abc123";
        let sanitized = sanitize_error_message(leaked, "sk-abc123");
        assert!(!sanitized.contains("AIzaSecret123"));
        assert!(!sanitized.contains("sk-abc123"));
        assert!(sanitized.contains("[REDACTED]"));

        let missing_openai = AiConfig {
            provider: AiProvider::Openai,
            api_key: String::new(),
            ..AiConfig::default()
        };
        assert_eq!(
            require_api_key_and_base_url(&missing_openai).unwrap_err(),
            "ERR_API_KEY_MISSING"
        );

        let ollama_no_key = AiConfig {
            provider: AiProvider::Ollama,
            api_key: String::new(),
            ..AiConfig::default()
        };
        assert!(require_api_key_and_base_url(&ollama_no_key).is_ok());

        let custom_no_key = AiConfig {
            provider: AiProvider::Custom,
            api_key: String::new(),
            base_url: "http://localhost:1234/v1".to_string(),
            ..AiConfig::default()
        };
        assert!(require_api_key_and_base_url(&custom_no_key).is_ok());

        let unknown_provider: AiProvider = serde_json::from_str("\"some_unknown_provider\"").unwrap();
        assert_eq!(unknown_provider, AiProvider::Custom);
    }

    #[test]
    fn public_config_masks_api_key_and_preserves_on_empty_input() {
        let mut config = AiConfig {
            provider: AiProvider::Openai,
            api_key: "sk-1234567890abcdef".to_string(),
            base_url: String::new(),
            model: String::new(),
            prompts: AiPrompts::default(),
        };

        let public = config.to_public();
        assert!(public.has_api_key);
        assert_eq!(public.api_key_masked, "sk-1****cdef");
        assert_eq!(public.effective_base_url, "https://api.openai.com/v1");
        assert_eq!(public.effective_model, "gpt-4o-mini");

        let public_json = serde_json::to_string(&public).expect("serialize public config");
        assert!(!public_json.contains("sk-1234567890abcdef"));

        // Empty / None api_key with clear_api_key=false preserves existing key.
        config.apply_input(AiConfigInput {
            provider: AiProvider::Gemini,
            api_key: Some("   ".to_string()),
            clear_api_key: false,
            base_url: "https://example.com/v1beta/".to_string(),
            model: "gemini-2.5-pro".to_string(),
            prompts: None,
        });
        assert_eq!(config.api_key, "sk-1234567890abcdef");
        assert_eq!(config.provider, AiProvider::Gemini);

        // clear_api_key=true clears the key.
        config.apply_input(AiConfigInput {
            provider: AiProvider::Gemini,
            api_key: None,
            clear_api_key: true,
            base_url: String::new(),
            model: String::new(),
            prompts: None,
        });
        assert!(config.api_key.is_empty());
        assert!(!config.to_public().has_api_key);
        assert_eq!(mask_api_key("short"), "****");
    }

    #[test]
    fn two_layer_prompt_appends_non_editable_json_schema() {
        let config = AiConfig {
            prompts: AiPrompts {
                weekly_report: "Custom weekly".to_string(),
                task_breakdown: "Custom breakdown prompt".to_string(),
                notes_to_tasks: "Custom notes prompt".to_string(),
            },
            ..AiConfig::default()
        };

        let (breakdown_sys, _) =
            build_task_breakdown_prompt(&config, "Build feature", None, None, 2, "zh");
        assert!(breakdown_sys.starts_with("Custom breakdown prompt"));
        assert!(breakdown_sys.ends_with(TASK_JSON_SCHEMA_LOCK.trim_end()));
        assert!(breakdown_sys.contains("\"startDate\""));
        assert!(breakdown_sys.contains("\"children\""));

        let (notes_sys, _) = build_notes_to_tasks_prompt(&config, "Buy milk tomorrow", "en");
        assert!(notes_sys.starts_with("Custom notes prompt"));
        assert!(notes_sys.ends_with(TASK_JSON_SCHEMA_LOCK.trim_end()));
    }

    #[test]
    fn json_fence_stripping_and_task_parsing() {
        let fenced = r#"Here is the plan:
```json
[
  {
    "content": "Design API",
    "priority": "high",
    "startDate": "2026-11-26",
    "deadline": "2026-11-28",
    "children": [
      {
        "content": "Define endpoints",
        "priority": "medium",
        "startDate": null,
        "deadline": null,
        "children": []
      }
    ]
  }
]
```
Hope this helps!"#;

        let tasks = parse_generated_tasks(fenced).expect("parse fenced json");
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].content, "Design API");
        assert_eq!(tasks[0].priority.as_deref(), Some("high"));
        assert_eq!(tasks[0].start_date.as_deref(), Some("2026-11-26"));
        assert_eq!(tasks[0].children.len(), 1);
        assert_eq!(tasks[0].children[0].content, "Define endpoints");

        let wrapped = r#"```
{"tasks": [{"content": "Single task"}]}
```"#;
        let wrapped_tasks = parse_generated_tasks(wrapped).expect("parse wrapped tasks");
        assert_eq!(wrapped_tasks.len(), 1);
        assert_eq!(wrapped_tasks[0].content, "Single task");
    }

    #[test]
    fn unwrap_and_dedup_parent_handles_wrapped_and_duplicate_parent() {
        let make_item = |content: &str, children: Vec<GeneratedTaskItem>| GeneratedTaskItem {
            content: content.to_string(),
            priority: None,
            start_date: None,
            deadline: None,
            children,
        };

        // Case 1: Single wrapper node matching parent (case-insensitive & trimmed) with children -> unwrapped
        let mut wrapped = vec![make_item(
            "  build feature ",
            vec![make_item("Step 1", vec![]), make_item("Step 2", vec![])],
        )];
        unwrap_and_dedup_parent(&mut wrapped, "Build Feature");
        assert_eq!(wrapped.len(), 2);
        assert_eq!(wrapped[0].content, "Step 1");
        assert_eq!(wrapped[1].content, "Step 2");

        // Case 2: Top-level duplicate leaf matching parent -> removed, other items preserved
        let mut with_dup = vec![
            make_item("Build Feature", vec![]),
            make_item("Step 1", vec![]),
            make_item("  Build Feature ", vec![]),
        ];
        unwrap_and_dedup_parent(&mut with_dup, "Build Feature");
        assert_eq!(with_dup.len(), 1);
        assert_eq!(with_dup[0].content, "Step 1");

        // Case 3: Single node not matching parent -> untouched
        let mut unrelated = vec![make_item("Other task", vec![make_item("Sub", vec![])])];
        unwrap_and_dedup_parent(&mut unrelated, "Build Feature");
        assert_eq!(unrelated.len(), 1);
        assert_eq!(unrelated[0].content, "Other task");
    }

    #[test]
    fn unfenced_object_with_brackets_in_string_field_parses_correctly() {
        let raw = r#"Here are the tasks: {"tasks":[{"content":"Check item [1]","priority":"p1"}]}"#;
        let tasks = parse_generated_tasks(raw).expect("parse unfenced object with [1]");
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].content, "Check item [1]");
        assert_eq!(tasks[0].priority.as_deref(), Some("p1"));
    }

    #[test]
    fn multiple_fences_and_trailing_annotations_parse_correctly() {
        let multi_fence = r#"Here is the plan:
```json
[{"content": "First block task"}]
```
Notes:
```json
[{"content": "Second block task"}]
```"#;
        let tasks = parse_generated_tasks(multi_fence).expect("parse first fenced block");
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].content, "First block task");

        let trailing_footnote = r#"Here are the tasks:
[{"content": "Item with \"quoted [braces]\" and \\ slash", "priority": "high"}] [1]
[1] Reference note."#;
        let footnote_tasks =
            parse_generated_tasks(trailing_footnote).expect("parse json with trailing footnote");
        assert_eq!(footnote_tasks.len(), 1);
        assert_eq!(
            footnote_tasks[0].content,
            r#"Item with "quoted [braces]" and \ slash"#
        );
    }

    #[test]
    fn null_children_and_null_content_are_tolerated() {
        let raw = r#"[
            {"content": "Task A", "priority": null, "startDate": null, "deadline": null, "children": null},
            {"content": null, "children": null}
        ]"#;
        let tasks = parse_generated_tasks(raw).expect("parse tasks with null children");
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].content, "Task A");
        assert!(tasks[0].children.is_empty());
    }

    #[test]
    fn format_api_error_text_handles_html_json_and_redaction() {
        let json_err = format_api_error_text(401, r#"{"error":{"message":"Invalid key sk-secret-123"}}"#, "sk-secret-123");
        assert_eq!(json_err, "AI API error (HTTP 401): Invalid key [REDACTED]");

        let html_body = format!("<html><body>502 Bad Gateway {}</body></html>", "x".repeat(400));
        let html_err = format_api_error_text(502, &html_body, "sk-secret-123");
        assert!(html_err.starts_with("AI API error (HTTP 502): <html><body>502 Bad Gateway "));
        let prefix = "AI API error (HTTP 502): ";
        assert_eq!(html_err[prefix.len()..].chars().count(), 300);

        let empty_err = format_api_error_text(503, "   ", "");
        assert_eq!(empty_err, "AI API error (HTTP 503): <empty response body>");
    }

    #[test]
    fn url_and_model_validation_rejects_unsafe_inputs() {
        let non_https = AiConfig {
            provider: AiProvider::Custom,
            api_key: "sk-secret".to_string(),
            base_url: "http://api.example.com/v1".to_string(),
            ..AiConfig::default()
        };
        assert!(require_api_key_and_base_url(&non_https).is_err());

        let loopback_http = AiConfig {
            provider: AiProvider::Custom,
            api_key: "sk-secret".to_string(),
            base_url: "http://127.0.0.1:8080/v1".to_string(),
            ..AiConfig::default()
        };
        assert!(require_api_key_and_base_url(&loopback_http).is_ok());

        let embedded_creds = AiConfig {
            provider: AiProvider::Custom,
            api_key: "sk-secret".to_string(),
            base_url: "https://user:pass@api.example.com/v1".to_string(),
            ..AiConfig::default()
        };
        assert!(require_api_key_and_base_url(&embedded_creds).is_err());

        assert!(validate_model_name(AiProvider::Openai, "gpt-4o-mini?foo=1").is_err());
        assert!(validate_model_name(AiProvider::Openai, "gpt-4o-mini#frag").is_err());
        assert!(validate_model_name(AiProvider::Openai, "../secret").is_err());
        assert!(validate_model_name(AiProvider::Gemini, "models/gemini-2.5-flash").is_err());
        assert!(validate_model_name(AiProvider::Siliconflow, "Qwen/Qwen2.5-72B-Instruct").is_ok());
    }

    #[test]
    #[ignore]
    fn live_deepseek_smoke() {
        tauri::async_runtime::block_on(async {
            let path = resolve_secrets_path();
            let cfg = load_ai_config(&path).expect("load_ai_config");
            assert!(!cfg.api_key.is_empty(), "No API key configured in {:?}", path);

            let conn = test_connection(&cfg).await.expect("test_connection");
            println!("[1] test_connection OK: {}", conn);

            let models = list_models(&cfg).await.expect("list_models");
            println!("[2] list_models OK ({}): {:?}", models.len(), models);

            let rep = generate_weekly_report(
                &cfg,
                "Week: 2026-W41 (2026-10-05 ~ 2026-10-11)\nCompleted tasks: 3\n- 组管 (2026-10-08)\n- 喷洒枪变速箱问题处理 (2026-10-08)\n- 静电防护报告撰写 (2026-10-08)",
                "zh-CN",
            ).await.expect("generate_weekly_report");
            println!("[3] generate_weekly_report OK ({} chars)", rep.chars().count());

            let n2t = notes_to_tasks(
                &cfg,
                "周五前完成静电防护报告终稿，明天上午联系供应商确认喷洒枪变速箱配件交期。",
                "zh-CN",
            ).await.expect("notes_to_tasks");
            println!("[4] notes_to_tasks OK ({} tasks): {:?}", n2t.len(), n2t.iter().map(|t| &t.content).collect::<Vec<_>>());
            assert!(!n2t.is_empty());

            let bd = breakdown_task(
                &cfg,
                "喷洒枪变速箱问题处理",
                Some("排查异响并给出整改方案"),
                Some("拆分为3个可执行子任务"),
                2,
                3,
                "zh-CN",
            ).await.expect("breakdown_task");
            println!(
                "[5] breakdown_task OK ({} subtasks, dropped {}): {:?}",
                bd.items.len(),
                bd.dropped_count,
                bd.items.iter().map(|t| &t.content).collect::<Vec<_>>()
            );
            assert!(!bd.items.is_empty());
        });
    }

    #[test]
    fn b64_secrets_load_backward_compatible() {
        let dir = std::env::temp_dir().join(format!("module-ai-b64-compat-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create temp dir");
        let secrets_path = dir.join(AI_SECRETS_FILENAME);
        let secret = "sk-legacy-b64-compat-1234";
        let b64_enc = format!("{FALLBACK_ENC_PREFIX}{}", base64_encode(secret.as_bytes()));
        let json = serde_json::json!({
            "provider": "openai",
            "apiKeyEnc": b64_enc,
            "baseUrl": "",
            "model": ""
        });
        fs::write(&secrets_path, serde_json::to_string(&json).unwrap()).expect("write b64 json");

        let loaded = load_ai_config(&secrets_path).expect("load b64 config");
        assert_eq!(loaded.api_key, secret);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn prompt_size_guard_rejects_oversized_input() {
        let ok_res = validate_prompt_size("sys", "user");
        assert!(ok_res.is_ok());

        let oversized = "x".repeat(MAX_AI_PROMPT_CHARS + 1);
        let err = validate_prompt_size("sys", &oversized).unwrap_err();
        assert!(err.starts_with("ERR_INPUT_TOO_LARGE"), "got: {err}");
    }

    #[test]
    fn breakdown_cap_tracks_dropped_count_accurately() {
        let make_item = |name: &str| GeneratedTaskItem {
            content: name.to_string(),
            priority: None,
            start_date: None,
            deadline: None,
            children: Vec::new(),
        };

        let mut exact = vec![make_item("a"), make_item("b"), make_item("c")];
        let before_exact = count_generated_tasks(&exact);
        cap_generated_tasks(&mut exact, 3);
        let dropped_exact = before_exact.saturating_sub(count_generated_tasks(&exact));
        assert_eq!(dropped_exact, 0);

        let mut over = vec![
            make_item("a"),
            make_item("b"),
            make_item("c"),
            make_item("d"),
            make_item("e"),
        ];
        let before_over = count_generated_tasks(&over);
        cap_generated_tasks(&mut over, 3);
        let dropped_over = before_over.saturating_sub(count_generated_tasks(&over));
        assert_eq!(dropped_over, 2);
    }
}
