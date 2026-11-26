use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

struct Grant {
    owner: String,
    path: PathBuf,
    expires: Instant,
}

#[derive(Default)]
struct Registry(HashMap<String, Grant>);

impl Registry {
    fn authorize(&mut self, owner: &str, path: PathBuf) -> String {
        let now = Instant::now();
        // One pending export per window; abandoned or expired grants cannot accumulate.
        self.0.retain(|_, grant| grant.expires > now && grant.owner != owner);
        let token = uuid::Uuid::new_v4().to_string();
        self.0.insert(token.clone(), Grant {
            owner: owner.to_string(), path, expires: now + Duration::from_secs(600),
        });
        token
    }

    fn write(&mut self, owner: &str, path: &Path, data: &[u8], token: Option<&str>) -> Result<(), String> {
        let token = token.ok_or("缺少图片保存授权，请重新选择保存路径")?;
        let grant = self.0.get(token).ok_or("图片保存授权无效或已使用，请重新选择保存路径")?;
        if grant.expires <= Instant::now() || grant.owner != owner || grant.path != path {
            return Err("图片保存路径或窗口与授权不符，或授权已过期".into());
        }
        self.0.remove(token); // Consume before I/O: even failed exports cannot replay a token.
        std::fs::write(path, data).map_err(|e| e.to_string())
    }
}

static REGISTRY: LazyLock<Mutex<Registry>> = LazyLock::new(|| Mutex::new(Registry::default()));

pub fn authorize(owner: &str, path: PathBuf) -> Result<String, String> {
    Ok(REGISTRY.lock().map_err(|_| "图片保存授权不可用")?.authorize(owner, path))
}

pub fn write(owner: &str, path: &str, data: &[u8], token: Option<&str>) -> Result<(), String> {
    REGISTRY.lock().map_err(|_| "图片保存授权不可用")?.write(owner, Path::new(path), data, token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_requires_matching_window_path_and_single_use_token() {
        let dir = std::env::temp_dir().join(format!("module-image-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let selected = dir.join("selected.png");
        let other = dir.join("other.txt");
        let mut registry = Registry::default();
        let token = registry.authorize("main", selected.clone());
        assert!(registry.write("main", &other, b"bad", Some(&token)).is_err());
        assert!(registry.write("widget", &selected, b"bad", Some(&token)).is_err());
        assert!(registry.write("main", &selected, b"bad", None).is_err());
        assert!(!selected.exists() && !other.exists());
        registry.write("main", &selected, b"image", Some(&token)).unwrap();
        assert_eq!(std::fs::read(&selected).unwrap(), b"image");
        assert!(registry.write("main", &selected, b"replay", Some(&token)).is_err());
        assert_eq!(std::fs::read(&selected).unwrap(), b"image");
        std::fs::remove_file(&selected).unwrap();
        std::fs::remove_dir(&dir).unwrap();
    }

    #[test]
    fn expired_or_replaced_grants_never_write() {
        let mut registry = Registry::default();
        let path = std::env::temp_dir().join(format!("module-image-{}.png", uuid::Uuid::new_v4()));
        let token = registry.authorize("main", path.clone());
        registry.0.get_mut(&token).unwrap().expires = Instant::now() - Duration::from_secs(1);
        assert!(registry.write("main", &path, b"bad", Some(&token)).is_err());
        let token = registry.authorize("main", path.clone());
        registry.authorize("main", path.clone());
        assert!(registry.write("main", &path, b"bad", Some(&token)).is_err());
        assert!(!path.exists());
    }
}
