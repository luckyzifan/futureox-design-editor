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
#[cfg(not(target_arch="wasm32"))]
thread_local! { static SOURCE_STORAGE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }
/// Private native source-storage context, never a document property or launch
/// override. The host already owns the immutable file and the native model;
/// JS/WASM serialized-carrier heuristics do not limit that logical source.
/// Processing buffers, device limits, geometry validity and allocation failure
/// remain separate. Each request restores its predecessor even during unwind.
pub(crate) fn with_source_storage_scope<T>(enabled:bool,work:impl FnOnce()->T)->T {
    #[cfg(not(target_arch="wasm32"))] {
        struct Restore(bool);
        impl Drop for Restore { fn drop(&mut self){SOURCE_STORAGE.with(|scope|scope.set(self.0));} }
        let _restore=Restore(SOURCE_STORAGE.with(|scope|scope.replace(enabled)));
        work()
    }
    #[cfg(target_arch="wasm32")] {let _=enabled;work()}
}
fn source_storage_scope()->bool {
    #[cfg(not(target_arch="wasm32"))] {SOURCE_STORAGE.with(|scope|scope.get())}
    #[cfg(target_arch="wasm32")] {false}
}

#[cfg(any(test, target_os = "macos"))]
fn parse_macos_available_memory(info: &str) -> Option<u64> {
    let header = info.lines().next()?;
    let page_bytes = header.split_once("page size of ")?.1.split_once(" bytes")?.0
        .parse::<u64>().ok().filter(|size| size.is_power_of_two() && *size >= 4096 && *size <= 65536)?;
    let pages = |label: &str| info.lines().find_map(|line| {
        line.strip_prefix(label)?.trim().trim_end_matches('.').parse::<u64>().ok()
    });
    // Count only these available/reclaimable queues, without adding speculative
    // or purgeable counters. Compressed pages are already outside both queues.
    pages("Pages free:")?.checked_add(pages("Pages inactive:")?)?.checked_mul(page_bytes)
}

#[cfg(target_os = "macos")]
fn macos_available_memory_bytes() -> Option<u64> {
    // The kernel forbids unsafe code. Query the fixed OS utility once at process
    // startup without a shell, arguments from a document, or PATH resolution.
    let output = std::process::Command::new("/usr/bin/vm_stat")
        .env("LC_ALL", "C").output().ok()?;
    if !output.status.success() || output.stdout.len() > 16 * 1024 { return None; }
    parse_macos_available_memory(std::str::from_utf8(&output.stdout).ok()?)
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
pub fn document_byte_limit() -> usize { if source_storage_scope(){usize::MAX}else{(memory_budget_bytes() / REPRESENTATION_RESERVE) as usize} }
/// Expanded FD values are separately accounted before allocating references.
pub fn expanded_value_limit() -> usize { (memory_budget_bytes() / 4) as usize }
/// A model node owns considerably more memory than a small JSON field. This is
/// resource admission, not a product node quota; exact serialized bytes are also checked.
pub fn node_limit() -> usize { if source_storage_scope(){usize::MAX}else{(memory_budget_bytes() / 4096) as usize} }
pub fn page_limit() -> usize { if source_storage_scope(){usize::MAX}else{(memory_budget_bytes() / 1024) as usize} }
pub(crate) fn scene_path_limit()->usize {if source_storage_scope(){usize::MAX}else{2_000_000}}
pub(crate) fn native_source_storage()->bool {source_storage_scope()}
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
    #[cfg(not(target_arch="wasm32"))]
    fn native_source_storage_is_scoped_and_never_changes_other_threads_or_validity() {
        let ordinary=document_byte_limit();let nodes=node_limit();
        with_source_storage_scope(true,||{
            assert!(check_document_bytes(ordinary+1).is_ok());
            assert!(check_document_counts(nodes+1,1).is_ok());
            assert!(check_document_counts(0,0).is_err());
            with_source_storage_scope(false,||assert!(check_document_bytes(ordinary+1).is_err()));
            assert!(check_document_bytes(ordinary+1).is_ok());
            std::thread::spawn(move||assert_eq!(document_byte_limit(),ordinary)).join().unwrap();
        });
        assert_eq!(document_byte_limit(),ordinary);assert_eq!(node_limit(),nodes);
        let result=std::panic::catch_unwind(||with_source_storage_scope(true,||panic!("scoped probe")));
        assert!(result.is_err());assert_eq!(document_byte_limit(),ordinary);
    }
    #[test]
    fn detected_capacity_keeps_headroom_and_address_ceiling() {
        assert_eq!(available_memory_budget(0), REPRESENTATION_RESERVE);
        assert_eq!(available_memory_budget(512 * 1024 * 1024), 256 * 1024 * 1024);
        assert_eq!(available_memory_budget(4 * 1024 * 1024 * 1024), 2 * 1024 * 1024 * 1024);
        assert_eq!(available_memory_budget(u64::MAX), WASM_ADDRESS_BYTES);
    }
    #[test]
    fn macos_counts_available_queues_without_subtracting_compressor_again() {
        let reading = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 100.\nPages inactive: 200.\nPages speculative: 75.\nPages occupied by compressor: 999999.\n";
        assert_eq!(parse_macos_available_memory(reading), Some(300 * 16384));
        assert_eq!(parse_macos_available_memory(&reading.replace("16384", "4096")), Some(300 * 4096));
        assert_eq!(parse_macos_available_memory(&reading.replace("200.", "0.")), Some(100 * 16384));
        assert_eq!(parse_macos_available_memory(&reading.replace("200.", "18446744073709551615.")), None);
        assert_eq!(parse_macos_available_memory(&reading.replace("Pages inactive:", "missing:")), None);
        assert_eq!(parse_macos_available_memory(&reading.replace("16384", "0")), None);
        assert_eq!(parse_macos_available_memory("unavailable"), None);
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_queries_actual_available_memory_without_launch_override() {
        let available = macos_available_memory_bytes().expect("Mach memory statistics");
        assert!(available > 0);
        println!("macOS available={available} working={} document={}", available_memory_budget(available), available_memory_budget(available) / REPRESENTATION_RESERVE);
        // Run this native test in a fresh process to exercise automatic startup.
        if std::env::var_os("CORE_DOCUMENT_MEMORY_BYTES").is_none() {
            assert!((REPRESENTATION_RESERVE..=WASM_ADDRESS_BYTES).contains(&memory_budget_bytes()));
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
