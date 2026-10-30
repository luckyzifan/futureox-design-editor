mod validation;
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row, postgres::PgPoolOptions};
use std::{net::SocketAddr, sync::Arc};
use utoipa::{OpenApi, ToSchema};
use utoipa_swagger_ui::SwaggerUi;
use uuid::Uuid;

#[derive(Clone)]
struct AppState {
    pool: PgPool,
    token_hash: Arc<[u8; 32]>,
    compute: Arc<tokio::sync::Semaphore>,
    render_slots: Arc<tokio::sync::Semaphore>,
    font: Arc<futureox_design_kernel::font::Fonts>,
}
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Save {
    document: Value,
    revision: i64,
    request_id: Uuid,
}
#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct Document {
    id: String,
    name: String,
    revision: i64,
    document: Value,
    updated_at: String,
}
#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct Summary {
    id: String,
    name: String,
    revision: i64,
    updated_at: String,
}

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
    next.run(request).await
}
async fn health(State(state): State<AppState>) -> Result<Json<Value>> {
    sqlx::query("SELECT 1").execute(&state.pool).await?;
    Ok(Json(json!({"status":"ok","service":"design-studio"})))
}
#[utoipa::path(get,path="/api/design/documents",responses((status=200,body=Vec<Summary>),(status=401)),security(("workspace_token"=[])))]
async fn list(State(state): State<AppState>) -> Result<Json<Vec<Summary>>> {
    let rows=sqlx::query("SELECT id::text,name,revision,updated_at::text FROM design_documents ORDER BY updated_at DESC LIMIT 500").fetch_all(&state.pool).await?;
    Ok(Json(
        rows.into_iter()
            .map(|r| Summary {
                id: r.get("id"),
                name: r.get("name"),
                revision: r.get("revision"),
                updated_at: r.get("updated_at"),
            })
            .collect(),
    ))
}
fn decode(r: sqlx::postgres::PgRow) -> Document {
    Document {
        id: r.get("id"),
        name: r.get("name"),
        revision: r.get("revision"),
        document: r.get("document"),
        updated_at: r.get("updated_at"),
    }
}
#[utoipa::path(get,path="/api/design/documents/{id}",params(("id"=String,Path)),responses((status=200,body=Document),(status=404)),security(("workspace_token"=[])))]
async fn read(State(state): State<AppState>, Path(id): Path<Uuid>) -> Result<Json<Document>> {
    let row = sqlx::query(
        "SELECT id::text,name,revision,document,updated_at::text FROM design_documents WHERE id=$1",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Document not found".into()))?;
    Ok(Json(decode(row)))
}
#[utoipa::path(put,path="/api/design/documents/{id}",params(("id"=String,Path)),request_body=Save,responses((status=200,body=Document),(status=409,description="Stale revision or conflicting idempotency key"),(status=422)),security(("workspace_token"=[])))]
async fn save(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(input): Json<Save>,
) -> Result<Json<Document>> {
    if input.revision < 0 || input.revision == i64::MAX {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Invalid revision".into(),
        ));
    }
    let permit = state.compute.clone().try_acquire_owned().map_err(|_| {
        ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "Document processing capacity exceeded".into(),
        )
    })?;
    let (input, name, digest) = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let name = validation::validate(&input.document, id)
            .map_err(|m| ApiError(StatusCode::UNPROCESSABLE_ENTITY, m.into()))?;
        let digest = Sha256::digest(
            serde_json::to_vec(&json!({"document":input.document,"revision":input.revision}))
                .map_err(|_| {
                    ApiError(StatusCode::UNPROCESSABLE_ENTITY, "Invalid document".into())
                })?,
        )
        .to_vec();
        Ok::<_, ApiError>((input, name, digest))
    })
    .await
    .map_err(|_| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Document processing failed".into(),
        )
    })??;
    let mut tx = state.pool.begin().await?;
    // A transaction-scoped advisory lock also serializes concurrent first saves.
    let lock = i64::from_be_bytes(id.as_bytes()[..8].try_into().unwrap());
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(lock)
        .execute(&mut *tx)
        .await?;
    if let Some(receipt) = sqlx::query(
        "SELECT digest,revision FROM design_write_receipts WHERE document_id=$1 AND request_id=$2",
    )
    .bind(id)
    .bind(input.request_id)
    .fetch_optional(&mut *tx)
    .await?
    {
        if receipt.get::<Vec<u8>, _>("digest") != digest {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "Idempotency key has different content".into(),
            ));
        }
        let revision: i64 = receipt.get("revision");
        let r=sqlx::query("SELECT document_id::text AS id,document->>'name' AS name,revision,document,created_at::text AS updated_at FROM design_versions WHERE document_id=$1 AND revision=$2").bind(id).bind(revision).fetch_one(&mut *tx).await?;
        tx.commit().await?;
        return Ok(Json(decode(r)));
    }
    let revision: Option<i64> =
        sqlx::query_scalar("SELECT revision FROM design_documents WHERE id=$1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    if revision.unwrap_or(0) != input.revision {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Document revision has changed".into(),
        ));
    }
    let next = input.revision + 1;
    let r=sqlx::query("INSERT INTO design_documents(id,name,revision,document) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,revision=EXCLUDED.revision,document=EXCLUDED.document,updated_at=now() RETURNING id::text,name,revision,document,updated_at::text").bind(id).bind(name).bind(next).bind(&input.document).fetch_one(&mut *tx).await?;
    sqlx::query("INSERT INTO design_versions(document_id,revision,document) VALUES($1,$2,$3)")
        .bind(id)
        .bind(next)
        .bind(&input.document)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO design_write_receipts(document_id,request_id,digest,revision) VALUES($1,$2,$3,$4)").bind(id).bind(input.request_id).bind(digest).bind(next).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(decode(r)))
}
#[derive(OpenApi)]
#[openapi(paths(list,read,save,render_image),components(schemas(Save,Document,Summary,RenderRequest)),modifiers(&Security))]
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
        compute: Arc::new(tokio::sync::Semaphore::new(8)),
        render_slots: Arc::new(tokio::sync::Semaphore::new(2)),
        font: Arc::new(fonts),
    };
    let protected = Router::new()
        .route("/render", axum::routing::post(render_image))
        .route("/documents", get(list))
        .route("/documents/{id}", get(read).put(save))
        .layer(middleware::from_fn_with_state(state.clone(), authenticate));
    let app = Router::new()
        .route("/health", get(health))
        .nest("/api/design", protected)
        .merge(SwaggerUi::new("/swagger-ui").url("/api-doc/openapi.json", Api::openapi()))
        .layer(DefaultBodyLimit::max(32 * 1024 * 1024))
        .with_state(state);
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
