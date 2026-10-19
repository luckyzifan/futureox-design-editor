#![forbid(unsafe_code)]
use futureox_design_desktop_backend::{
    Backend, catalog::Catalog, runtime, workspace::WorkspaceStore,
};
use std::{path::PathBuf, sync::Arc, time::Duration};

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new("--recovery-dir")) {
        return Err("Usage: futureox-design-desktop-backend --recovery-dir <absolute app-owned directory> [--catalog-db <absolute app-owned file>] [--workspace-db <absolute app-owned file>]".into());
    }
    let directory = args
        .next()
        .map(PathBuf::from)
        .ok_or("Missing recovery directory")?;
    let mut catalog_path = None;
    let mut workspace_path = None;
    while let Some(flag) = args.next() {
        let target = if flag == "--catalog-db" && catalog_path.is_none() {
            &mut catalog_path
        } else if flag == "--workspace-db" && workspace_path.is_none() {
            &mut workspace_path
        } else {
            return Err("Unexpected or repeated argument".into());
        };
        *target = Some(
            args.next()
                .map(PathBuf::from)
                .ok_or("Missing database path")?,
        );
    }
    let catalog_path = catalog_path.unwrap_or(
        directory
            .parent()
            .ok_or("Recovery directory has no parent")?
            .join("catalog-v1.sqlite3"),
    );
    if workspace_path
        .as_ref()
        .is_some_and(|path| path == &catalog_path)
    {
        return Err("Workspace and catalog must use different files".into());
    }
    // Startup filesystem work is bounded too; no async worker blocks on fsync.
    let backend = tokio::task::spawn_blocking(move || Backend::new(&directory)).await??;
    let handle = tokio::runtime::Handle::current();
    let catalog =
        tokio::task::spawn_blocking(move || handle.block_on(Catalog::open(&catalog_path))).await;
    let backend = match catalog {
        Ok(Ok(catalog)) => backend.with_catalog(catalog),
        Ok(Err(error)) => backend.with_catalog_unavailable(error.code),
        Err(_) => backend.with_catalog_unavailable("CATALOG_ERROR"),
    };
    let backend = if let Some(path) = workspace_path {
        let handle = tokio::runtime::Handle::current();
        match tokio::task::spawn_blocking(move || handle.block_on(WorkspaceStore::open(&path)))
            .await
        {
            Ok(Ok(workspace)) => backend.with_workspace(workspace),
            Ok(Err(error)) => backend.with_workspace_unavailable(error.code),
            Err(_) => backend.with_workspace_unavailable("WORKSPACE_ERROR"),
        }
    } else {
        backend
    };
    let backend = Arc::new(backend);
    let result = runtime::serve(backend.clone(), tokio::io::stdin(), tokio::io::stdout()).await;
    backend.close_stores().await;
    result?;
    Ok(())
}
fn main() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(3)
        .enable_all()
        .build()
        .expect("Tokio runtime");
    let result = runtime.block_on(run());
    // Tokio's stdin helper cannot cancel an OS read. All mutation workers have
    // already joined in serve; don't hang shutdown on that read after pipe loss.
    runtime.shutdown_timeout(Duration::from_secs(1));
    if let Err(error) = result {
        eprintln!("Desktop backend: {error}");
        std::process::exit(1);
    }
}
