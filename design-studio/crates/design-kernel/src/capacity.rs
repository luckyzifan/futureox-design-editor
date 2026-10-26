//! Trusted process resource admission, independent of document business size.
//!
//! The reserve is a heuristic for simultaneous JSON, model, staging and history
//! representations, NOT an RSS promise. Documents and RPC parameters cannot set
//! policy. The desktop pins the same startup budget in every child and WASM VM.
use std::sync::OnceLock;

pub const REPRESENTATION_RESERVE: u64 = 16;
/// wasm32 linear addressability is a physical ceiling, not available RAM.
pub const WASM_ADDRESS_BYTES: u64 = 1u64 << 32;
/// Fail-safe only when the host exposes no resource information.
pub const UNKNOWN_RUNTIME_MEMORY_BYTES: u64 = 512 * 1024 * 1024;
static MEMORY_BYTES: OnceLock<u64> = OnceLock::new();

#[cfg(target_os = "macos")]
fn macos_available_memory_bytes() -> Option<u64> {
    // Use the safe platform adapter; the kernel keeps forbid(unsafe_code).
    // Refresh only memory, once at startup, never enumerate processes or spawn
    // vm_stat. The adapter uses Mach available/reclaimable memory, not total RAM.
    let system = sysinfo::System::new_with_specifics(
        sysinfo::RefreshKind::nothing().with_memory(sysinfo::MemoryRefreshKind::nothing().with_ram()),
    );
    (system.total_memory() > 0).then(|| system.available_memory())
}

#[cfg(any(test, target_os = "macos", target_os = "linux"))]
fn available_memory_budget(available: u64) -> u64 {
    (available / 2).clamp(REPRESENTATION_RESERVE, WASM_ADDRESS_BYTES)
}

pub fn configure(memory_bytes: u64) -> Result<(), String> {
    if memory_bytes < REPRESENTATION_RESERVE || memory_bytes > WASM_ADDRESS_BYTES {
        return Err("Invalid trusted document memory budget".into());
    }
    match MEMORY_BYTES.set(memory_bytes) {
        Ok(()) => Ok(()),
        Err(_) if MEMORY_BYTES.get() == Some(&memory_bytes) => Ok(()),
        Err(_) => Err("Document capacity is already pinned for this process".into()),
    }
}

fn detected_memory_bytes() -> u64 {
    #[cfg(not(target_arch = "wasm32"))]
    {
        if let Ok(value) = std::env::var("CORE_DOCUMENT_MEMORY_BYTES") {
            // Invalid trusted launch configuration fails closed. Never silently
            // promote a misspelled override to a more permissive machine policy.
            return value.parse::<u64>().ok().filter(|v| *v >= REPRESENTATION_RESERVE && *v <= WASM_ADDRESS_BYTES)
                .unwrap_or(REPRESENTATION_RESERVE);
        }
        #[cfg(target_os = "linux")]
        if let Ok(info) = std::fs::read_to_string("/proc/meminfo") {
            if let Some(bytes) = info.lines().find_map(|line| line.strip_prefix("MemAvailable:")
                .and_then(|v| v.split_whitespace().next()).and_then(|v| v.parse::<u64>().ok())
                .and_then(|v| v.checked_mul(1024))) {
                let mut available = bytes;
                // Standard cgroup v2 and v1 roots; the desktop supplies an exact
                // host reading for nested/container layouts and other platforms.
                for (limit, used) in [("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory.current"),
                    ("/sys/fs/cgroup/memory/memory.limit_in_bytes", "/sys/fs/cgroup/memory/memory.usage_in_bytes")] {
                    if let (Some(limit), Some(used)) = (std::fs::read_to_string(limit).ok().and_then(|v| v.trim().parse::<u64>().ok()),
                        std::fs::read_to_string(used).ok().and_then(|v| v.trim().parse::<u64>().ok())) {
                        available = available.min(limit.saturating_sub(used));
                    }
                }
                return available_memory_budget(available);
            }
        }
        #[cfg(target_os = "macos")]
        if let Some(available) = macos_available_memory_bytes() {
            return available_memory_budget(available);
        }
    }
    UNKNOWN_RUNTIME_MEMORY_BYTES
}

pub fn memory_budget_bytes() -> u64 { *MEMORY_BYTES.get_or_init(detected_memory_bytes) }
pub fn document_byte_limit() -> usize { (memory_budget_bytes() / REPRESENTATION_RESERVE) as usize }
/// Expanded FD values are separately accounted before allocating references.
pub fn expanded_value_limit() -> usize { (memory_budget_bytes() / 4) as usize }
/// A model node owns considerably more memory than a small JSON field. This is
/// resource admission, not a product node quota; exact serialized bytes are also checked.
pub fn node_limit() -> usize { (memory_budget_bytes() / 4096) as usize }
pub fn page_limit() -> usize { (memory_budget_bytes() / 1024) as usize }
pub fn check_document_counts(nodes: usize, pages: usize) -> Result<(), String> {
    if pages == 0 || pages > page_limit() || nodes > node_limit() {
        Err(format!("DOCUMENT_RESOURCE_LIMIT: document structure exceeds this session's allowance ({} nodes, {} pages; {}-byte working-memory budget)", node_limit(), page_limit(), memory_budget_bytes()))
    } else { Ok(()) }
}
pub fn check_document_bytes(bytes: usize) -> Result<(), String> {
    let limit = document_byte_limit();
    if bytes > limit {
        Err(format!("DOCUMENT_RESOURCE_LIMIT: {bytes} serialized bytes exceed this session's {limit}-byte document allowance ({}-byte working-memory budget; {REPRESENTATION_RESERVE}x heuristic reserve)", memory_budget_bytes()))
    } else { Ok(()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detected_capacity_keeps_headroom_and_address_ceiling() {
        assert_eq!(available_memory_budget(0), REPRESENTATION_RESERVE);
        assert_eq!(available_memory_budget(512 * 1024 * 1024), 256 * 1024 * 1024);
        assert_eq!(available_memory_budget(4 * 1024 * 1024 * 1024), 2 * 1024 * 1024 * 1024);
        assert_eq!(available_memory_budget(u64::MAX), WASM_ADDRESS_BYTES);
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_queries_actual_available_memory_without_launch_override() {
        let available = macos_available_memory_bytes().expect("Mach memory statistics");
        assert!(available > 0);
        println!("macOS available={available} working={} document={}", available_memory_budget(available), available_memory_budget(available) / REPRESENTATION_RESERVE);
        // Run this native test in a fresh process to exercise automatic startup.
        if std::env::var_os("CORE_DOCUMENT_MEMORY_BYTES").is_none() {
            assert_ne!(memory_budget_bytes(), UNKNOWN_RUNTIME_MEMORY_BYTES);
        }
    }
    #[test]
    fn resource_allowance_has_exact_boundary_and_explains_its_source() {
        let limit = document_byte_limit();
        assert_eq!(limit, (memory_budget_bytes() / REPRESENTATION_RESERVE) as usize);
        assert!(check_document_bytes(limit).is_ok());
        let error = check_document_bytes(limit + 1).unwrap_err();
        assert!(error.contains("DOCUMENT_RESOURCE_LIMIT"));
        assert!(error.contains(&limit.to_string()));
    }
}
