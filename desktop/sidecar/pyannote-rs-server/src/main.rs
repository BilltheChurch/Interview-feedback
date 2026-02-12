use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use clap::{Args, Parser, Subcommand};
use pyannote_rs::{EmbeddingExtractor, EmbeddingManager, Segment};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

#[derive(Parser)]
#[command(name = "pyannote-rs")]
#[command(about = "pyannote-rs HTTP sidecar for speaker diarization", long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Serve(ServeArgs),
}

#[derive(Args, Clone)]
struct ServeArgs {
    #[arg(long, default_value = "127.0.0.1")]
    host: String,

    #[arg(long, default_value_t = 9705)]
    port: u16,

    #[arg(long)]
    segmentation_model: Option<PathBuf>,

    #[arg(long)]
    embedding_model: Option<PathBuf>,

    #[arg(long, default_value_t = 8)]
    max_speakers: usize,

    #[arg(long, default_value_t = 0.52)]
    threshold: f32,

    #[arg(long, default_value_t = 3600)]
    session_ttl_sec: u64,
}

#[derive(Debug, Clone)]
struct Config {
    segmentation_model: PathBuf,
    embedding_model: PathBuf,
    max_speakers: usize,
    threshold: f32,
    session_ttl_ms: i64,
}

#[derive(Debug)]
struct SessionState {
    manager: EmbeddingManager,
    last_seen_ms: i64,
}

#[derive(Debug)]
struct ServerState {
    config: Config,
    started_at: Instant,
    extractor: Mutex<EmbeddingExtractor>,
    sessions: Mutex<HashMap<String, SessionState>>,
}

#[derive(Debug)]
struct AppError {
    status: StatusCode,
    message: String,
}

impl AppError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: message.into(),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let payload = serde_json::json!({ "detail": self.message });
        (self.status, Json(payload)).into_response()
    }
}

#[derive(Debug, Deserialize)]
struct DiarizeRequest {
    session_id: String,
    content_b64: String,
    sample_rate: Option<u32>,
    start_end_ms: Option<[i64; 2]>,
    threshold: Option<f32>,
    max_speakers: Option<usize>,
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: &'static str,
    uptime_ms: u128,
    segmentation_model: String,
    embedding_model: String,
}

#[derive(Debug, Serialize)]
struct DiarizeResponse {
    session_id: String,
    tracks: Vec<Track>,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
struct Track {
    speaker_id: String,
    start_ms: i64,
    end_ms: i64,
    duration_ms: i64,
    local_start_ms: i64,
    local_end_ms: i64,
}

fn current_epoch_ms() -> i64 {
    let now = std::time::SystemTime::now();
    match now.duration_since(std::time::UNIX_EPOCH) {
        Ok(duration) => duration.as_millis() as i64,
        Err(_) => 0,
    }
}

fn decode_pcm_s16le(content_b64: &str) -> Result<Vec<i16>, AppError> {
    let bytes = BASE64_STANDARD
        .decode(content_b64.as_bytes())
        .map_err(|error| AppError::bad_request(format!("invalid base64 pcm payload: {error}")))?;

    if bytes.is_empty() {
        return Err(AppError::bad_request("content_b64 decoded to empty payload"));
    }
    if bytes.len() % 2 != 0 {
        return Err(AppError::bad_request("pcm payload must contain even number of bytes"));
    }

    let mut samples = Vec::with_capacity(bytes.len() / 2);
    for chunk in bytes.chunks_exact(2) {
        samples.push(i16::from_le_bytes([chunk[0], chunk[1]]));
    }
    Ok(samples)
}

fn resolve_model_path(explicit: Option<PathBuf>, exe_dir: &Path, filename: &str) -> PathBuf {
    explicit.unwrap_or_else(|| exe_dir.join("models").join(filename))
}

fn merge_adjacent_tracks(mut tracks: Vec<Track>) -> Vec<Track> {
    if tracks.len() <= 1 {
        return tracks;
    }

    tracks.sort_by(|a, b| a.start_ms.cmp(&b.start_ms).then(a.end_ms.cmp(&b.end_ms)));
    let mut merged: Vec<Track> = Vec::with_capacity(tracks.len());

    for current in tracks {
        if let Some(last) = merged.last_mut() {
            let same_speaker = last.speaker_id == current.speaker_id;
            let gap = current.start_ms - last.end_ms;
            if same_speaker && gap <= 250 {
                last.end_ms = last.end_ms.max(current.end_ms);
                last.local_end_ms = last.local_end_ms.max(current.local_end_ms);
                last.duration_ms = (last.end_ms - last.start_ms).max(0);
                continue;
            }
        }
        merged.push(current);
    }

    merged
}

fn map_segment_to_track(segment: &Segment, window_start_ms: i64, window_end_ms: i64, speaker_id: usize) -> Track {
    let mut local_start_ms = (segment.start * 1000.0).round() as i64;
    let mut local_end_ms = (segment.end * 1000.0).round() as i64;

    if local_end_ms < local_start_ms {
        std::mem::swap(&mut local_start_ms, &mut local_end_ms);
    }

    let mut start_ms = window_start_ms + local_start_ms;
    let mut end_ms = window_start_ms + local_end_ms;

    if end_ms < start_ms {
        std::mem::swap(&mut start_ms, &mut end_ms);
    }

    start_ms = start_ms.max(window_start_ms);
    end_ms = end_ms.min(window_end_ms).max(start_ms);

    Track {
        speaker_id: format!("edge_spk_{speaker_id}"),
        start_ms,
        end_ms,
        duration_ms: (end_ms - start_ms).max(0),
        local_start_ms: local_start_ms.max(0),
        local_end_ms: local_end_ms.max(local_start_ms.max(0)),
    }
}

async fn health(State(state): State<Arc<ServerState>>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        uptime_ms: state.started_at.elapsed().as_millis(),
        segmentation_model: state.config.segmentation_model.to_string_lossy().to_string(),
        embedding_model: state.config.embedding_model.to_string_lossy().to_string(),
    })
}

async fn diarize(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<DiarizeRequest>,
) -> Result<Json<DiarizeResponse>, AppError> {
    let session_id = req.session_id.trim().to_string();
    if session_id.is_empty() {
        return Err(AppError::bad_request("session_id is required"));
    }

    let sample_rate = req.sample_rate.unwrap_or(16_000);
    if sample_rate == 0 {
        return Err(AppError::bad_request("sample_rate must be positive"));
    }

    let threshold = req
        .threshold
        .unwrap_or(state.config.threshold)
        .clamp(0.0, 1.0);

    let samples = decode_pcm_s16le(&req.content_b64)?;
    let window_duration_ms = ((samples.len() as f64 / sample_rate as f64) * 1000.0).round() as i64;

    let (window_start_ms, window_end_ms) = match req.start_end_ms {
        Some([start, end]) if start >= 0 && end >= start => (start, end),
        Some(_) => {
            return Err(AppError::bad_request(
                "start_end_ms must be [start,end] and end >= start",
            ))
        }
        None => (0, window_duration_ms.max(0)),
    };

    let mut warnings = Vec::new();
    let mut tracks = Vec::new();

    let segments_iter = pyannote_rs::get_segments(
        &samples,
        sample_rate,
        &state.config.segmentation_model,
    )
    .map_err(|error| AppError::internal(format!("segmentation failed: {error}")))?;

    for segment_result in segments_iter {
        let segment = match segment_result {
            Ok(segment) => segment,
            Err(error) => {
                warnings.push(format!("segment skipped: {error}"));
                continue;
            }
        };

        if segment.samples.is_empty() {
            continue;
        }

        let embedding: Vec<f32> = {
            let mut extractor = state.extractor.lock().await;
            extractor
                .compute(&segment.samples)
                .map_err(|error| AppError::internal(format!("embedding failed: {error}")))?
                .collect()
        };

        let speaker_id = {
            let now_ms = current_epoch_ms();
            let mut sessions = state.sessions.lock().await;

            sessions.retain(|_, item| now_ms - item.last_seen_ms <= state.config.session_ttl_ms);

            let manager = sessions
                .entry(session_id.clone())
                .or_insert_with(|| SessionState {
                    manager: EmbeddingManager::new(req.max_speakers.unwrap_or(state.config.max_speakers)),
                    last_seen_ms: now_ms,
                });

            manager.last_seen_ms = now_ms;

            if let Some(id) = manager.manager.search_speaker(embedding.clone(), threshold) {
                id
            } else {
                manager
                    .manager
                    .get_best_speaker_match(embedding)
                    .unwrap_or(0)
            }
        };

        if speaker_id == 0 {
            warnings.push("speaker assignment returned 0, segment dropped".to_string());
            continue;
        }

        tracks.push(map_segment_to_track(
            &segment,
            window_start_ms,
            window_end_ms,
            speaker_id,
        ));
    }

    let tracks = merge_adjacent_tracks(tracks);

    Ok(Json(DiarizeResponse {
        session_id,
        tracks,
        warnings,
    }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();

    match cli.command {
        Command::Serve(args) => serve(args).await?,
    }

    Ok(())
}

async fn serve(args: ServeArgs) -> Result<(), Box<dyn std::error::Error>> {
    let exe_path = std::env::current_exe()?;
    let exe_dir = exe_path
        .parent()
        .map(PathBuf::from)
        .ok_or("cannot resolve binary directory")?;

    let segmentation_model = resolve_model_path(
        args.segmentation_model,
        &exe_dir,
        "segmentation-3.0.onnx",
    );
    let embedding_model = resolve_model_path(
        args.embedding_model,
        &exe_dir,
        "wespeaker_en_voxceleb_CAM++.onnx",
    );

    if !segmentation_model.exists() {
        return Err(format!(
            "segmentation model not found: {}",
            segmentation_model.to_string_lossy()
        )
        .into());
    }
    if !embedding_model.exists() {
        return Err(format!(
            "embedding model not found: {}",
            embedding_model.to_string_lossy()
        )
        .into());
    }

    let extractor = EmbeddingExtractor::new(&embedding_model)
        .map_err(|error| format!("failed to initialize embedding extractor: {error}"))?;

    let config = Config {
        segmentation_model,
        embedding_model,
        max_speakers: args.max_speakers.max(1),
        threshold: args.threshold.clamp(0.0, 1.0),
        session_ttl_ms: (Duration::from_secs(args.session_ttl_sec.max(60)).as_millis()) as i64,
    };

    let state = Arc::new(ServerState {
        config,
        started_at: Instant::now(),
        extractor: Mutex::new(extractor),
        sessions: Mutex::new(HashMap::new()),
    });

    let app = Router::new()
        .route("/health", get(health))
        .route("/diarize", post(diarize))
        .with_state(state);

    let bind_addr = format!("{}:{}", args.host, args.port);
    let listener = TcpListener::bind(&bind_addr).await?;
    println!("pyannote-rs sidecar listening on http://{bind_addr}");

    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;

    Ok(())
}
