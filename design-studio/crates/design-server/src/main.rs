mod documents;
mod validation;
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use documents::{Change, Document, Edit, EditReceipt, Save, Summary};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::{net::SocketAddr, sync::Arc};
use tower_http::services::{ServeDir, ServeFile};
use utoipa::{OpenApi, ToSchema};
use utoipa_swagger_ui::SwaggerUi;

#[derive(Clone)]
struct AppState {
    pool: PgPool,
    token_hash: Arc<[u8; 32]>,
    compute: Arc<tokio::sync::Semaphore>,
    render_slots: Arc<tokio::sync::Semaphore>,
    font: Arc<futureox_design_kernel::font::Fonts>,
}
#[derive(Debug)]
struct ApiError(StatusCode, String);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        tracing::error!(%error,"design persistence error");
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Persistence operation failed".into(),
        )
    }
}
type Result<T> = std::result::Result<T, ApiError>;
#[derive(Deserialize, ToSchema)]
struct RenderRequest {
    document: Value,
    options: Value,
}

#[utoipa::path(post,path="/api/design/render",request_body=RenderRequest,responses((status=200,description="PNG rendered by the portable self-developed Rust kernel",content_type="image/png"),(status=422),(status=429)),security(("workspace_token"=[])))]
async fn render_image(
    State(state): State<AppState>,
    Json(request): Json<RenderRequest>,
) -> Result<Response> {
    let permit = state
        .render_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| {
            ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "Render capacity exceeded".into(),
            )
        })?;
    let font = state.font.clone();
    let bytes = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let mut engine = futureox_design_kernel::Engine::with_fonts((*font).clone());
        engine.load_document(&request.document.to_string())?;
        let color_output = request
            .options
            .get("colorOutput")
            .cloned()
            .map(serde_json::from_value::<futureox_design_kernel::color::ColorOutput>)
            .transpose()
            .map_err(|e| e.to_string())?;
        let options = engine.parse_options(request.options)?;
        if let Some(output) = color_output {
            engine.render_color_png(&options, output)
        } else {
            engine.render_png(&options)
        }
    })
    .await
    .map_err(|_| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Render task failed".into(),
        )
    })?
    .map_err(|e| ApiError(StatusCode::UNPROCESSABLE_ENTITY, e))?;
    Ok((
        [
            ("content-type", "image/png"),
            ("x-design-renderer", "rust-cpu-v1"),
            ("cache-control", "no-store"),
        ],
        bytes,
    )
        .into_response())
}

async fn authenticate(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let token = request
        .headers()
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    let hash: [u8; 32] = Sha256::digest(token.as_bytes()).into();
    let different = hash
        .iter()
        .zip(state.token_hash.iter())
        .fold(0_u8, |a, (x, y)| a | (x ^ y));
    if different != 0 {
        return ApiError(
            StatusCode::UNAUTHORIZED,
            "A valid design workspace token is required".into(),
        )
        .into_response();
    }
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}
async fn health(State(state): State<AppState>) -> Result<Json<Value>> {
    sqlx::query("SELECT 1").execute(&state.pool).await?;
    Ok(Json(json!({"status":"ok","service":"design-studio"})))
}
#[derive(OpenApi)]
#[openapi(
    paths(documents::list, documents::read, documents::save, documents::edit, documents::changes, documents::read_version, render_image),
    components(schemas(Save, Document, Summary, Edit, EditReceipt, Change, RenderRequest)),
    modifiers(&Security)
)]
struct Api;
struct Security;
impl utoipa::Modify for Security {
    fn modify(&self, api: &mut utoipa::openapi::OpenApi) {
        if let Some(c) = api.components.as_mut() {
            c.add_security_scheme(
                "workspace_token",
                utoipa::openapi::security::SecurityScheme::Http(
                    utoipa::openapi::security::Http::new(
                        utoipa::openapi::security::HttpAuthScheme::Bearer,
                    ),
                ),
            );
        }
    }
}
fn web_base(value: String) -> std::result::Result<String, &'static str> {
    if value == "/" || value.is_empty() {
        return Ok(String::new());
    }
    let base = value.strip_suffix('/').unwrap_or(&value);
    if base.len() > 128
        || !base.strip_prefix('/').is_some_and(|path| {
            path.split('/').all(|part| {
                !part.is_empty()
                    && part
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
            })
        })
    {
        return Err("DESIGN_WEB_BASE must be an absolute URL path such as /desgin");
    }
    Ok(base.to_owned())
}

#[tokio::main]
async fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let token = std::env::var("DESIGN_API_TOKEN")
        .map_err(|_| "DESIGN_API_TOKEN is required (at least 32 characters)")?;
    if token.len() < 32 {
        return Err("DESIGN_API_TOKEN must contain at least 32 characters".into());
    }
    let url =
        std::env::var("DESIGN_DATABASE_URL").map_err(|_| "DESIGN_DATABASE_URL is required")?;
    let bind: SocketAddr = std::env::var("DESIGN_BIND")
        .unwrap_or_else(|_| "127.0.0.1:9430".into())
        .parse()?;
    // This service owns its capacity policy independently of Electron.
    let memory_mib: u64 = std::env::var("DESIGN_DOCUMENT_MEMORY_MIB")
        .unwrap_or_else(|_| "1024".into())
        .parse()?;
    if !(256..=4096).contains(&memory_mib) {
        return Err("DESIGN_DOCUMENT_MEMORY_MIB must be between 256 and 4096".into());
    }
    futureox_design_kernel::capacity::configure(memory_mib * 1024 * 1024)?;
    let body_limit = futureox_design_kernel::capacity::document_byte_limit() + 4096;
    let base = web_base(std::env::var("DESIGN_WEB_BASE").unwrap_or_default())?;
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .connect(&url)
        .await?;
    sqlx::migrate!().run(&pool).await?;
    let font_path = std::env::var("DESIGN_FONT_PATH")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../frontend/design-client/public/fonts/NotoSansSC.ttf")
        });
    let font = tokio::fs::read(font_path).await?;
    let mut fonts = futureox_design_kernel::font::Fonts::new();
    fonts.load(&font)?;
    let state = AppState {
        pool: pool.clone(),
        token_hash: Arc::new(Sha256::digest(token.as_bytes()).into()),
        compute: Arc::new(tokio::sync::Semaphore::new(2)),
        render_slots: Arc::new(tokio::sync::Semaphore::new(2)),
        font: Arc::new(fonts),
    };
    let protected = Router::new()
        .route("/render", axum::routing::post(render_image))
        .route("/documents", get(documents::list))
        .route(
            "/documents/{id}",
            get(documents::read)
                .put(documents::save)
                .patch(documents::edit),
        )
        .route("/documents/{id}/changes", get(documents::changes))
        .route(
            "/documents/{id}/versions/{revision}",
            get(documents::read_version),
        )
        .layer(middleware::from_fn_with_state(state.clone(), authenticate));
    let mut app = Router::new()
        .route("/health", get(health))
        .nest("/api/design", protected)
        .layer(DefaultBodyLimit::max(body_limit))
        .with_state(state);
    let web_root = std::env::var_os("DESIGN_WEB_ROOT").map(std::path::PathBuf::from);
    if let Some(root) = &web_root {
        for file in ["index.html", "kernel/design_kernel_bg.wasm"] {
            if !tokio::fs::metadata(root.join(file)).await?.is_file() {
                return Err(format!("DESIGN_WEB_ROOT requires {file}").into());
            }
        }
        app = app.fallback_service(ServeDir::new(root));
    }
    let mut openapi = Api::openapi();
    if !base.is_empty() {
        app = Router::new().nest(&base, app);
        if let Some(root) = &web_root {
            app = app.route_service(&format!("{base}/"), ServeFile::new(root.join("index.html")));
        }
        openapi.servers = Some(vec![utoipa::openapi::Server::new(&base)]);
    }
    let app = app.merge(
        SwaggerUi::new(format!("{base}/swagger-ui"))
            .url(format!("{base}/api-doc/openapi.json"), openapi),
    );
    let listener = tokio::net::TcpListener::bind(bind).await?;
    tracing::info!(%bind,"design studio ready");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    pool.close().await;
    Ok(())
}
