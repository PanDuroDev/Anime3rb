use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const BASE: &str = "https://anime3rb.com";

#[derive(Serialize, Clone, Debug)]
pub struct Card {
    pub name: String,
    pub url: String,
    pub image: String,
    pub episode: Option<u32>,
}

#[derive(Serialize)]
pub struct Rail {
    pub title: String,
    pub items: Vec<Card>,
}

#[derive(Serialize)]
pub struct Home {
    pub rails: Vec<Rail>,
}

#[derive(Serialize)]
pub struct Episode {
    pub number: u32,
    pub name: String,
    pub url: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FillerInfo {
    pub status: String,
    pub sources: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Serialize)]
pub struct Anime {
    pub name: String,
    pub url: String,
    pub image: String,
    pub description: String,
    pub genres: Vec<String>,
    pub episodes: Vec<Episode>,
}

#[derive(Serialize)]
pub struct Source {
    pub label: String,
    pub res: String,
    pub premium: bool,
    pub src: String,
}

#[derive(Serialize)]
pub struct EpisodeData {
    pub sources: Vec<Source>,
    pub poster: String,
    pub thumbs: String,
    pub thumbnail_page: String,
}

#[derive(Serialize)]
pub struct ThumbnailData {
    pub poster: String,
    pub thumbs: String,
}

#[derive(Clone)]
struct ArtworkCacheEntry {
    value: String,
    expires_at: Instant,
}

static ARTWORK_CACHE: OnceLock<Mutex<HashMap<String, ArtworkCacheEntry>>> = OnceLock::new();
static EPISODE_ARTWORK_SEMAPHORE: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
static KITSU_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static ANIZIP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static FILLER_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static NOGITSU_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static NOGITSU_RATE_LOCK: OnceLock<tokio::sync::Mutex<Option<Instant>>> = OnceLock::new();

const KITSU_API: &str = "https://kitsu.io/api/edge";
const ANIZIP_API: &str = "https://api.ani.zip";
const NOGITSU_API: &str = "https://api.nogitsu.com/v1";
const ARTWORK_CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const KITSU_PAGE_SIZE: u32 = 20;
const NOGITSU_PAGE_SIZE: u32 = 24;
const NOGITSU_MIN_REQUEST_INTERVAL: Duration = Duration::from_millis(650);

fn artwork_cache_get(key: &str) -> Option<String> {
    let mut cache = ARTWORK_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .ok()?;
    let now = Instant::now();
    let value = cache
        .get(key)
        .filter(|entry| entry.expires_at > now)
        .map(|entry| entry.value.clone());
    if value.is_none() {
        cache.remove(key);
    }
    value
}

fn artwork_cache_put(key: String, value: String) {
    if let Ok(mut cache) = ARTWORK_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    {
        let now = Instant::now();
        cache.retain(|_, entry| entry.expires_at > now);
        if cache.len() >= 1_000 {
            cache.clear();
        }
        cache.insert(
            key,
            ArtworkCacheEntry {
                value,
                expires_at: now + ARTWORK_CACHE_TTL,
            },
        );
    }
}

fn kitsu_client() -> &'static reqwest::Client {
    KITSU_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("Anime3rb/0.1.5")
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

async fn kitsu_json(url: &str) -> Result<Value, String> {
    let mut last_error = String::from("Kitsu API request failed");
    for attempt in 0..3 {
        let response = match kitsu_client()
            .get(url)
            .header(reqwest::header::ACCEPT, "application/vnd.api+json")
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                last_error = error.to_string();
                if attempt < 2 {
                    tokio::time::sleep(Duration::from_millis(300 * (1 << attempt))).await;
                    continue;
                }
                break;
            }
        };

        let status = response.status();
        if status.as_u16() == 429 {
            last_error = "Kitsu rate limit reached (HTTP 429)".to_string();
            if attempt < 2 {
                let retry_after = response
                    .headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.parse::<u64>().ok())
                    .unwrap_or(1)
                    .clamp(1, 30);
                tokio::time::sleep(Duration::from_secs(retry_after)).await;
                continue;
            }
            break;
        }

        if status.is_server_error() && attempt < 2 {
            last_error = format!("Kitsu API returned HTTP {status}");
            tokio::time::sleep(Duration::from_millis(300 * (1 << attempt))).await;
            continue;
        }

        let response = response.error_for_status().map_err(|error| error.to_string())?;
        return response
            .json::<Value>()
            .await
            .map_err(|error| format!("Invalid Kitsu API response: {error}"));
    }

    Err(last_error)
}

fn normalize_kitsu_title(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn kitsu_match_score(item: &Value, wanted_name: &str, wanted_slug: &str) -> u8 {
    let attributes = match item.get("attributes") {
        Some(attributes) => attributes,
        None => return 0,
    };
    let slug = s(attributes.get("slug"));
    if !wanted_slug.is_empty() && normalize_kitsu_title(&slug) == wanted_slug {
        return 3;
    }

    let canonical = s(attributes.get("canonicalTitle"));
    if !wanted_name.is_empty() && normalize_kitsu_title(&canonical) == wanted_name {
        return 2;
    }

    attributes
        .get("titles")
        .and_then(Value::as_object)
        .map(|titles| {
            titles
                .values()
                .filter_map(Value::as_str)
                .any(|title| normalize_kitsu_title(title) == wanted_name)
        })
        .unwrap_or(false)
        .then_some(2)
        .unwrap_or(0)
}

fn valid_kitsu_image_url(value: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    url.scheme() == "https"
        && matches!(url.host_str(), Some("media.kitsu.app" | "media.kitsu.io"))
}

fn kitsu_episode_page_offset(episode_number: u32) -> u32 {
    episode_number.saturating_sub(1) / KITSU_PAGE_SIZE * KITSU_PAGE_SIZE
}

fn anime3rb_title_slug(anime_url: &str) -> Result<String, String> {
    let parsed = reqwest::Url::parse(anime_url).map_err(|error| error.to_string())?;
    let host = parsed.host_str().unwrap_or_default();
    if parsed.scheme() != "https"
        || !(host == "anime3rb.com" || host == "www.anime3rb.com")
    {
        return Err("Unsupported anime page URL".to_string());
    }

    let slug = parsed
        .path()
        .strip_prefix("/titles/")
        .and_then(|path| path.split('/').next())
        .unwrap_or_default();
    if slug.is_empty() || !slug.chars().all(|character| character.is_ascii_alphanumeric() || character == '-') {
        return Err("Invalid anime page URL".to_string());
    }
    Ok(slug.to_string())
}

async fn resolve_kitsu_anime_id(anime_url: &str, anime_name: &str) -> Result<String, String> {
    let slug = anime3rb_title_slug(anime_url)?;
    let wanted_name = normalize_kitsu_title(anime_name);
    let wanted_slug = normalize_kitsu_title(&slug);
    let cache_key = format!("anime-id:{slug}:{wanted_name}");
    if let Some(cached) = artwork_cache_get(&cache_key) {
        return if cached == "!" {
            Err("No exact Kitsu match was found for this anime".to_string())
        } else {
            Ok(cached)
        };
    }

    let fallback_name = slug.replace('-', " ");
    let search = urlencoding::encode(if anime_name.trim().is_empty() {
        &fallback_name
    } else {
        anime_name
    });
    let endpoint = format!(
        "{KITSU_API}/anime?filter%5Btext%5D={search}&page%5Blimit%5D=10"
    );
    let payload = kitsu_json(&endpoint).await?;
    let records = payload
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| "Kitsu returned no anime results".to_string())?;

    let best = records
        .iter()
        .map(|record| (kitsu_match_score(record, &wanted_name, &wanted_slug), record))
        .filter(|(score, _)| *score > 0)
        .max_by_key(|(score, _)| *score)
        .map(|(_, record)| s(record.get("id")))
        .filter(|id| !id.is_empty());

    match best {
        Some(id) => {
            artwork_cache_put(cache_key, id.clone());
            Ok(id)
        }
        None => {
            artwork_cache_put(cache_key, "!".to_string());
            Err("No exact Kitsu match was found for this anime".to_string())
        }
    }
}

fn parse_kitsu_episode_images(payload: &Value) -> HashMap<u32, String> {
    let mut images = HashMap::new();
    if let Some(records) = payload.get("data").and_then(Value::as_array) {
        for record in records {
            let Some(attributes) = record.get("attributes") else {
                continue;
            };
            let number = attributes
                .get("number")
                .and_then(Value::as_u64)
                .or_else(|| attributes.get("relativeNumber").and_then(Value::as_u64))
                .and_then(|number| u32::try_from(number).ok());
            let image = attributes
                .pointer("/thumbnail/original")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if let Some(number) = number {
                if !image.is_empty() && valid_kitsu_image_url(image) {
                    images.insert(number, image.to_string());
                }
            }
        }
    }
    images
}

async fn resolve_kitsu_anilist_id(kitsu_id: &str) -> Result<String, String> {
    let cache_key = format!("anilist-id:{kitsu_id}");
    if let Some(cached) = artwork_cache_get(&cache_key) {
        return if cached == "!" {
            Err("Kitsu has no AniList mapping for this anime".to_string())
        } else {
            Ok(cached)
        };
    }

    let endpoint = format!("{KITSU_API}/anime/{kitsu_id}/mappings?page%5Blimit%5D=20");
    let payload = kitsu_json(&endpoint).await?;
    let id = payload
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|record| s(record.pointer("/attributes/externalSite")) == "anilist/anime")
        .map(|record| s(record.pointer("/attributes/externalId")))
        .filter(|value| !value.is_empty() && value.chars().all(|character| character.is_ascii_digit()));

    match id {
        Some(id) => {
            artwork_cache_put(cache_key, id.clone());
            Ok(id)
        }
        None => {
            artwork_cache_put(cache_key, "!".to_string());
            Err("Kitsu has no AniList mapping for this anime".to_string())
        }
    }
}


#[derive(Serialize, Deserialize, Clone, Debug)]
struct FillerSourceRecord {
    status: String,
    #[serde(default)]
    source_count: Option<u32>,
    #[serde(default)]
    note: Option<String>,
}

const ANIFILLERPEDIA_API: &str = "https://anifillerpedia.wiki/api/v1";
const FILLERLISTS_API: &str = "https://fillerlists.com/api/v1";

fn filler_client() -> &'static reqwest::Client {
    FILLER_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("Anime3rb/0.1.8 (episode filler metadata)")
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

async fn filler_json(url: &str) -> Result<Value, String> {
    let response = filler_client()
        .get(url)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?;
    response
        .json::<Value>()
        .await
        .map_err(|error| format!("Invalid filler metadata response: {error}"))
}

fn json_records(payload: &Value) -> Option<&Vec<Value>> {
    payload
        .as_array()
        .or_else(|| payload.get("items").and_then(Value::as_array))
}

fn json_id(value: Option<&Value>) -> Option<String> {
    value.and_then(|item| {
        item.as_u64()
            .map(|number| number.to_string())
            .or_else(|| item.as_str().map(str::to_string))
    })
}

fn normalized_filler_status(value: &str) -> Option<String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "filler" => Some("filler".to_string()),
        "mixed" => Some("mixed".to_string()),
        "anime-canon" => Some("anime-canon".to_string()),
        "canon" => Some("canon".to_string()),
        _ => None,
    }
}

async fn anifillerpedia_episodes(
    anilist_id: &str,
) -> Result<HashMap<u32, FillerSourceRecord>, String> {
    let cache_key = format!("anifillerpedia-episodes:{anilist_id}");
    if let Some(cached) = artwork_cache_get(&cache_key) {
        if cached == "!" {
            return Ok(HashMap::new());
        }
        if let Ok(records) = serde_json::from_str::<HashMap<u32, FillerSourceRecord>>(&cached) {
            return Ok(records);
        }
    }

    let search_url = format!("{ANIFILLERPEDIA_API}/series?anilist_id={anilist_id}&limit=10");
    let payload = filler_json(&search_url).await?;
    let series_id = json_records(&payload)
        .and_then(|items| {
            items.iter().find(|item| {
                json_id(item.get("anilist_id")).as_deref() == Some(anilist_id)
            })
        })
        .and_then(|item| json_id(item.get("id")));

    let Some(series_id) = series_id else {
        artwork_cache_put(cache_key, "!".to_string());
        return Ok(HashMap::new());
    };

    let episodes_url = format!("{ANIFILLERPEDIA_API}/series/{series_id}/episodes");
    let payload = filler_json(&episodes_url).await?;
    let mut records = HashMap::new();
    if let Some(episodes) = json_records(&payload) {
        for episode in episodes {
            let Some(number) = episode
                .get("episode_number")
                .and_then(Value::as_u64)
                .and_then(|number| u32::try_from(number).ok())
            else {
                continue;
            };
            let Some(status) = episode
                .get("status")
                .and_then(Value::as_str)
                .and_then(normalized_filler_status)
            else {
                continue;
            };
            records.insert(
                number,
                FillerSourceRecord {
                    status,
                    source_count: episode
                        .pointer("/citation/source_count")
                        .and_then(Value::as_u64)
                        .and_then(|count| u32::try_from(count).ok()),
                    note: episode
                        .pointer("/citation/methodology_note")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                },
            );
        }
    }

    if let Ok(serialized) = serde_json::to_string(&records) {
        artwork_cache_put(cache_key, serialized);
    }
    Ok(records)
}

async fn anizip_tvdb_id(anilist_id: &str) -> Result<Option<u64>, String> {
    let cache_key = format!("anizip-tvdb-id:{anilist_id}");
    if let Some(cached) = artwork_cache_get(&cache_key) {
        return Ok(cached.parse::<u64>().ok());
    }

    let url = format!("{ANIZIP_API}/mappings?anilist_id={anilist_id}");
    let payload = filler_json(&url).await?;
    let id = payload
        .pointer("/mappings/thetvdb_id")
        .and_then(Value::as_u64)
        .or_else(|| payload.pointer("/mappings/thetvdb_id").and_then(Value::as_str).and_then(|value| value.parse().ok()))
        .or_else(|| payload.pointer("/mappings/thetvdbId").and_then(Value::as_u64));

    artwork_cache_put(
        cache_key,
        id.map(|value| value.to_string()).unwrap_or_else(|| "!".to_string()),
    );
    Ok(id)
}

async fn fillerlists_episodes(
    tvdb_id: u64,
) -> Result<HashMap<u32, FillerSourceRecord>, String> {
    let cache_key = format!("fillerlists-episodes:{tvdb_id}");
    if let Some(cached) = artwork_cache_get(&cache_key) {
        if cached == "!" {
            return Ok(HashMap::new());
        }
        if let Ok(records) = serde_json::from_str::<HashMap<u32, FillerSourceRecord>>(&cached) {
            return Ok(records);
        }
    }

    let lookup_url = format!("{FILLERLISTS_API}/shows?tvdb={tvdb_id}");
    let payload = filler_json(&lookup_url).await?;
    let show = payload
        .get("shows")
        .and_then(Value::as_array)
        .and_then(|shows| {
            shows.iter().find(|show| {
                show.pointer("/ids/tvdb")
                    .and_then(Value::as_u64)
                    .map(|id| id == tvdb_id)
                    .unwrap_or(false)
            })
        });
    let slug = show
        .and_then(|show| show.get("show").and_then(Value::as_str))
        .filter(|slug| {
            !slug.is_empty()
                && slug
                    .chars()
                    .all(|character| character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-')
        });

    let Some(slug) = slug else {
        artwork_cache_put(cache_key, "!".to_string());
        return Ok(HashMap::new());
    };

    let data_url = format!("https://fillerlists.com/data/{slug}.json");
    let payload = filler_json(&data_url).await?;
    let mut records = HashMap::new();
    if let Some(episodes) = payload.get("episodes").and_then(Value::as_array) {
        for episode in episodes {
            let Some(number) = episode
                .get("n")
                .and_then(Value::as_u64)
                .and_then(|number| u32::try_from(number).ok())
            else {
                continue;
            };
            let Some(status) = episode
                .get("type")
                .and_then(Value::as_str)
                .and_then(normalized_filler_status)
            else {
                // FillerLists uses "unknown" when its own reference sources disagree or are missing.
                continue;
            };
            records.insert(
                number,
                FillerSourceRecord {
                    status,
                    source_count: None,
                    note: None,
                },
            );
        }
    }

    if let Ok(serialized) = serde_json::to_string(&records) {
        artwork_cache_put(cache_key, serialized);
    }
    Ok(records)
}

fn combine_filler_records(
    anifillerpedia: Option<&FillerSourceRecord>,
    fillerlists: Option<&FillerSourceRecord>,
) -> Option<FillerInfo> {
    let (status, sources, note, source_count) = match (anifillerpedia, fillerlists) {
        (Some(first), Some(second)) if first.status == second.status => (
            first.status.clone(),
            vec!["AniFillerPedia".to_string(), "FillerLists".to_string()],
            first.note.clone(),
            first.source_count,
        ),
        (Some(first), Some(second)) => (
            "disputed".to_string(),
            vec!["AniFillerPedia".to_string(), "FillerLists".to_string()],
            Some(format!(
                "AniFillerPedia: {}; FillerLists: {}",
                first.status, second.status
            )),
            first.source_count,
        ),
        (Some(record), None) => (
            record.status.clone(),
            vec!["AniFillerPedia".to_string()],
            record.note.clone(),
            record.source_count,
        ),
        (None, Some(record)) => (
            record.status.clone(),
            vec!["FillerLists".to_string()],
            None,
            None,
        ),
        (None, None) => return None,
    };

    Some(FillerInfo {
        status,
        sources,
        source_count,
        note,
    })
}

async fn anime_filler_classifications(
    anime_url: &str,
    anime_name: &str,
) -> HashMap<u32, FillerInfo> {
    let Ok(kitsu_id) = resolve_kitsu_anime_id(anime_url, anime_name).await else {
        return HashMap::new();
    };
    let Ok(anilist_id) = resolve_kitsu_anilist_id(&kitsu_id).await else {
        return HashMap::new();
    };

    // Look up both independent references concurrently, then use TVDB only for the FillerLists fallback.
    let (anifiller_result, tvdb_result) = tokio::join!(
        anifillerpedia_episodes(&anilist_id),
        anizip_tvdb_id(&anilist_id)
    );
    let anifillerpedia = anifiller_result.unwrap_or_default();
    let fillerlists = match tvdb_result.ok().flatten() {
        Some(tvdb_id) => fillerlists_episodes(tvdb_id).await.unwrap_or_default(),
        None => HashMap::new(),
    };

    let mut classifications = HashMap::new();
    for (number, record) in &anifillerpedia {
        if let Some(info) = combine_filler_records(
            Some(record),
            fillerlists.get(number),
        ) {
            classifications.insert(*number, info);
        }
    }
    for (number, record) in &fillerlists {
        if !classifications.contains_key(number) {
            if let Some(info) = combine_filler_records(None, Some(record)) {
                classifications.insert(*number, info);
            }
        }
    }
    classifications
}

fn valid_episode_artwork_url(value: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    if url.scheme() != "https" {
        return false;
    }
    matches!(
        url.host_str(),
        Some(
            "media.kitsu.app"
                | "media.kitsu.io"
                | "artworks.thetvdb.com"
                | "image.tmdb.org"
                | "cdn.anidb.net"
                | "cdn.nogitsu.com"
        )
    )
}

fn parse_anizip_episode_images(payload: &Value) -> HashMap<u32, String> {
    let mut images = HashMap::new();
    let Some(episodes) = payload.get("episodes").and_then(Value::as_object) else {
        return images;
    };

    for (key, episode) in episodes {
        let number = episode
            .get("absoluteEpisodeNumber")
            .and_then(Value::as_u64)
            .or_else(|| key.parse::<u64>().ok())
            .or_else(|| episode.get("episodeNumber").and_then(Value::as_u64))
            .and_then(|number| u32::try_from(number).ok());
        let image = s(episode.get("image"));
        if let Some(number) = number {
            if number > 0 && !image.is_empty() && valid_episode_artwork_url(&image) {
                images.insert(number, image);
            }
        }
    }
    images
}

async fn anizip_episode_images(anilist_id: &str) -> Result<HashMap<u32, String>, String> {
    let cache_key = format!("anizip-episodes:{anilist_id}");
    if let Some(cached) = artwork_cache_get(&cache_key) {
        if let Ok(images) = serde_json::from_str::<HashMap<u32, String>>(&cached) {
            return Ok(images);
        }
    }

    let endpoint = format!("{ANIZIP_API}/mappings?anilist_id={anilist_id}");
    let response = ANIZIP_CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .user_agent("Anime3rb/0.1.5")
                .build()
                .unwrap_or_else(|_| reqwest::Client::new())
        })
        .get(&endpoint)
        .send()
        .await
        .map_err(|error| format!("AniZip request failed: {error}"))?;

    if response.status().as_u16() == 404 {
        artwork_cache_put(cache_key, "{}".to_string());
        return Ok(HashMap::new());
    }
    if response.status().as_u16() == 429 {
        let delay = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(2)
            .clamp(1, 30);
        tokio::time::sleep(Duration::from_secs(delay)).await;
        return Err("AniZip rate limit reached (HTTP 429)".to_string());
    }

    let response = response.error_for_status().map_err(|error| error.to_string())?;
    let payload = response
        .json::<Value>()
        .await
        .map_err(|error| format!("Invalid AniZip response: {error}"))?;
    let images = parse_anizip_episode_images(&payload);
    if let Ok(serialized) = serde_json::to_string(&images) {
        artwork_cache_put(cache_key, serialized);
    }
    Ok(images)
}

fn normalize_artwork_title(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn nogitsu_match_score(item: &Value, wanted_name: &str, wanted_slug: &str) -> u8 {
    let slug = s(item.get("slug"));
    if !wanted_slug.is_empty() && normalize_artwork_title(&slug) == wanted_slug {
        return 3;
    }

    ["title", "romanizedTitle", "nativeTitle"]
        .iter()
        .map(|field| s(item.get(*field)))
        .any(|title| !wanted_name.is_empty() && normalize_artwork_title(&title) == wanted_name)
        .then_some(2)
        .unwrap_or(0)
}

async fn wait_for_nogitsu_slot() {
    let limiter = NOGITSU_RATE_LOCK.get_or_init(|| tokio::sync::Mutex::new(None));
    let mut last_request = limiter.lock().await;
    if let Some(previous) = *last_request {
        let elapsed = previous.elapsed();
        if elapsed < NOGITSU_MIN_REQUEST_INTERVAL {
            tokio::time::sleep(NOGITSU_MIN_REQUEST_INTERVAL - elapsed).await;
        }
    }
    *last_request = Some(Instant::now());
}

async fn nogitsu_json(url: &str) -> Result<Value, String> {
    let client = NOGITSU_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("Anime3rb/0.1.5 (episode artwork)")
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    });

    let mut last_error = String::from("Nogitsu API request failed");
    for attempt in 0..3 {
        wait_for_nogitsu_slot().await;
        let response = match client.get(url).send().await {
            Ok(response) => response,
            Err(error) => {
                last_error = error.to_string();
                if attempt < 2 {
                    tokio::time::sleep(Duration::from_millis(400 * (attempt + 1))).await;
                    continue;
                }
                break;
            }
        };

        let status = response.status();
        if status.as_u16() == 429 {
            last_error = "Nogitsu rate limit reached (HTTP 429)".to_string();
            if attempt < 2 {
                let delay = response
                    .headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.parse::<u64>().ok())
                    .or_else(|| {
                        response
                            .headers()
                            .get("RateLimit-Reset")
                            .and_then(|value| value.to_str().ok())
                            .and_then(|value| value.parse::<u64>().ok())
                    })
                    .unwrap_or(2)
                    .clamp(1, 60);
                tokio::time::sleep(Duration::from_secs(delay)).await;
                continue;
            }
            break;
        }

        if status.is_server_error() && attempt < 2 {
            last_error = format!("Nogitsu API returned HTTP {status}");
            tokio::time::sleep(Duration::from_millis(400 * (attempt + 1))).await;
            continue;
        }

        let response = response.error_for_status().map_err(|error| error.to_string())?;
        return response
            .json::<Value>()
            .await
            .map_err(|error| format!("Invalid Nogitsu response: {error}"));
    }
    Err(last_error)
}

async fn resolve_nogitsu_work_id(
    anime_url: &str,
    anime_name: &str,
) -> Result<String, String> {
    let slug = anime3rb_title_slug(anime_url)?;
    let wanted_name = normalize_artwork_title(anime_name);
    let wanted_slug = normalize_artwork_title(&slug);
    let cache_key = format!("nogitsu-work:{slug}:{wanted_name}");
    if let Some(cached) = artwork_cache_get(&cache_key) {
        return if cached == "!" {
            Err("No exact Nogitsu anime match was found".to_string())
        } else {
            Ok(cached)
        };
    }

    let fallback_name = slug.replace('-', " ");
    let query = urlencoding::encode(if anime_name.trim().is_empty() {
        &fallback_name
    } else {
        anime_name
    });
    let endpoint = format!("{NOGITSU_API}/search/works?q={query}&medium=anime&limit=10");
    let payload = nogitsu_json(&endpoint).await?;
    let best = payload
        .get("hits")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|item| (nogitsu_match_score(item, &wanted_name, &wanted_slug), item))
        .filter(|(score, _)| *score > 0)
        .max_by_key(|(score, _)| *score)
        .map(|(_, item)| s(item.get("id")))
        .filter(|id| !id.is_empty());

    match best {
        Some(id) => {
            artwork_cache_put(cache_key, id.clone());
            Ok(id)
        }
        None => {
            artwork_cache_put(cache_key, "!".to_string());
            Err("No exact Nogitsu anime match was found".to_string())
        }
    }
}

fn parse_nogitsu_unit_images(payload: &Value) -> HashMap<u32, String> {
    let mut images = HashMap::new();
    if let Some(items) = payload.get("items").and_then(Value::as_array) {
        for item in items {
            let number = item
                .get("number")
                .and_then(Value::as_u64)
                .and_then(|number| u32::try_from(number).ok());
            let image = s(item.pointer("/image/url"));
            let trusted = reqwest::Url::parse(&image)
                .map(|url| {
                    url.scheme() == "https" && url.host_str() == Some("cdn.nogitsu.com")
                })
                .unwrap_or(false);
            if let Some(number) = number {
                if number > 0 && !image.is_empty() && trusted {
                    images.insert(number, image);
                }
            }
        }
    }
    images
}

async fn nogitsu_episode_page(
    work_id: &str,
    episode_number: u32,
) -> Result<HashMap<u32, String>, String> {
    let first = (episode_number.saturating_sub(1) / NOGITSU_PAGE_SIZE) * NOGITSU_PAGE_SIZE + 1;
    let last = first + NOGITSU_PAGE_SIZE - 1;
    let cache_key = format!("nogitsu-unit-images:{work_id}:{first}-{last}");
    if let Some(cached) = artwork_cache_get(&cache_key) {
        if let Ok(images) = serde_json::from_str::<HashMap<u32, String>>(&cached) {
            return Ok(images);
        }
    }

    let endpoint = format!("{NOGITSU_API}/works/{work_id}/unit-images?from={first}&to={last}");
    let payload = nogitsu_json(&endpoint).await?;
    let images = parse_nogitsu_unit_images(&payload);
    if let Ok(serialized) = serde_json::to_string(&images) {
        artwork_cache_put(cache_key, serialized);
    }
    Ok(images)
}

async fn kitsu_episode_page(
    anime_id: &str,
    episode_number: u32,
) -> Result<HashMap<u32, String>, String> {
    let offset = kitsu_episode_page_offset(episode_number);
    let cache_key = format!("episode-page:{anime_id}:{offset}");
    if let Some(cached) = artwork_cache_get(&cache_key) {
        if let Ok(images) = serde_json::from_str::<HashMap<u32, String>>(&cached) {
            return Ok(images);
        }
    }

    let endpoint = format!(
        "{KITSU_API}/anime/{anime_id}/episodes?page%5Blimit%5D={KITSU_PAGE_SIZE}&page%5Boffset%5D={offset}"
    );
    let payload = kitsu_json(&endpoint).await?;
    let images = parse_kitsu_episode_images(&payload);

    if let Ok(serialized) = serde_json::to_string(&images) {
        artwork_cache_put(cache_key, serialized);
    }
    Ok(images)
}

#[tauri::command]
pub async fn episode_catalog_thumbnail(
    anime_url: String,
    anime_name: String,
    episode_number: u32,
) -> Result<String, String> {
    if episode_number == 0 {
        return Ok(String::new());
    }

    // One shared permit prevents scroll bursts from multiplying metadata API traffic.
    let semaphore = Arc::clone(
        EPISODE_ARTWORK_SEMAPHORE.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(1))),
    );
    let _permit = semaphore
        .acquire_owned()
        .await
        .map_err(|error| error.to_string())?;

    // 1) Kitsu: public episode thumbnails, fetched 20 at a time.
    if let Ok(kitsu_id) = resolve_kitsu_anime_id(&anime_url, &anime_name).await {
        if let Ok(images) = kitsu_episode_page(&kitsu_id, episode_number).await {
            if let Some(image) = images.get(&episode_number) {
                return Ok(image.clone());
            }
        }

        // 2) AniZip: one cached AniList mapping supplies episode stills from TVDB/AniDB.
        if let Ok(anilist_id) = resolve_kitsu_anilist_id(&kitsu_id).await {
            if let Ok(images) = anizip_episode_images(&anilist_id).await {
                if let Some(image) = images.get(&episode_number) {
                    return Ok(image.clone());
                }
            }
        }
    }

    // 3) Nogitsu: aggregate stills from independent providers such as TVDB and TMDB.
    if let Ok(work_id) = resolve_nogitsu_work_id(&anime_url, &anime_name).await {
        if let Ok(images) = nogitsu_episode_page(&work_id, episode_number).await {
            if let Some(image) = images.get(&episode_number) {
                return Ok(image.clone());
            }
        }
    }

    // Keep the placeholder when every provider lacks a still. Never query Anime3rb here.
    Ok(String::new())
}

fn thumbnail_data(page: &str) -> ThumbnailData {
    let poster = regex::Regex::new(r#"https://thumbnails\.vid3rb\.com/[^'"\\]+/thumbnail\.001\.jpeg"#).unwrap();
    let thumbs = regex::Regex::new(r#"https://thumbnails\.vid3rb\.com/[^'"\\]+/thumbnails\.vtt"#).unwrap();
    ThumbnailData {
        poster: poster.find(page).map(|m| m.as_str().to_string()).unwrap_or_default(),
        thumbs: thumbs.find(page).map(|m| m.as_str().to_string()).unwrap_or_default(),
    }
}

async fn get(url: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent(UA)
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    // The CDN occasionally drops a connection; one retry is enough.
    let mut last = String::new();
    for _ in 0..2 {
        match client
            .get(url)
            .header("accept-language", "ar,en;q=0.8")
            .header("referer", BASE)
            .send()
            .await
        {
            Ok(res) if res.status().is_success() => return res.text().await.map_err(|e| e.to_string()),
            Ok(res) => last = format!("HTTP {}", res.status()),
            Err(err) => last = err.to_string(),
        }
    }
    Err(last)
}

fn unescape(s: &str) -> String {
    s.replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// Every page carries its content as schema.org JSON-LD, so no HTML parsing is needed.
fn ld_nodes(html: &str) -> Vec<Value> {
    let re = regex::Regex::new(r#"(?s)<script type="application/ld\+json">(.*?)</script>"#).unwrap();
    let mut nodes = Vec::new();
    for cap in re.captures_iter(html) {
        let Ok(value) = serde_json::from_str::<Value>(&cap[1]) else { continue };
        match value.get("@graph") {
            Some(Value::Array(items)) => nodes.extend(items.iter().cloned()),
            _ => nodes.push(value),
        }
    }
    nodes
}

fn s(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).unwrap_or_default().to_string()
}

/// JSON-LD allows an image to be a URL string, an ImageObject, or an array of either.
fn image_url(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(url)) => url.trim().to_string(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| image_url(Some(item)))
            .find(|url| !url.is_empty())
            .unwrap_or_default(),
        Some(Value::Object(object)) => {
            for key in ["url", "contentUrl", "thumbnailUrl", "image"] {
                let url = image_url(object.get(key));
                if !url.is_empty() {
                    return url;
                }
            }
            String::new()
        }
        _ => String::new(),
    }
}

fn episode_number(url: &str) -> Option<u32> {
    url.rsplit('/').next()?.parse().ok()
}

fn card(value: &Value) -> Card {
    let url = s(value.get("url"));
    let mut name = s(value.get("name"));
    // Episode titles carry an Arabic suffix ("… الحلقة 8") that the card already shows as a badge.
    if url.contains("/episode/") {
        if let Some(cut) = name.rfind("الحلقة") {
            name.truncate(cut);
            name = name.trim().to_string();
        }
    }
    Card {
        name,
        image: image_url(value.get("image")),
        episode: episode_number(&url),
        url,
    }
}

fn list_items(node: &Value) -> Vec<Card> {
    node.get("itemListElement")
        .and_then(Value::as_array)
        .map(|items| items.iter().map(card).collect())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn home() -> Result<Home, String> {
    let html = get(&format!("{BASE}/")).await?;
    let lists: Vec<Value> = ld_nodes(&html)
        .into_iter()
        .filter(|node| node.get("@type").and_then(Value::as_str) == Some("ItemList"))
        .collect();

    let mut episodes = lists
        .iter()
        .max_by_key(|list| list_items(list).len())
        .map(list_items)
        .unwrap_or_default();
    episodes.truncate(30);

    // The home page only lists 8 new titles; the catalog has 20 per page, so take a few pages.
    let mut titles = Vec::new();
    for page in 1..=3 {
        titles.extend(browse_page(page).await.unwrap_or_default());
    }
    titles.truncate(60);

    let mut rails = Vec::new();
    if !episodes.is_empty() {
        rails.push(Rail { title: "Latest episodes".into(), items: episodes });
    }
    if !titles.is_empty() {
        rails.push(Rail { title: "Recently added".into(), items: titles });
    }
    Ok(Home { rails })
}

/// Posters only load from a page whose referer is anime3rb itself, so the webview proxies them.
/// Fetch the thumbnail WebVTT through Rust so the player is not blocked by CDN CORS rules.
#[tauri::command]
pub async fn thumbnail_info(url: String) -> Result<ThumbnailData, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|error| error.to_string())?;
    let host = parsed.host_str().unwrap_or_default();
    if parsed.scheme() != "https" || !(host == "vid3rb.com" || host.ends_with(".vid3rb.com")) {
        return Err("Unsupported player page URL".to_string());
    }

    let mut latest = ThumbnailData { poster: String::new(), thumbs: String::new() };
    let mut last_error = String::from("Thumbnail metadata was not available");
    for _ in 0..3 {
        match get(&url).await {
            Ok(page) => {
                latest = thumbnail_data(&page);
                if !latest.thumbs.is_empty() {
                    return Ok(latest);
                }
            }
            Err(error) => last_error = error,
        }
    }

    if !latest.poster.is_empty() || !latest.thumbs.is_empty() {
        Ok(latest)
    } else {
        Err(last_error)
    }
}

#[tauri::command]
pub async fn thumbnail_vtt(url: String) -> Result<String, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|error| error.to_string())?;
    if parsed.scheme() != "https" || parsed.host_str() != Some("thumbnails.vid3rb.com") {
        return Err("Unsupported thumbnail URL".to_string());
    }
    get(&url).await
}

#[tauri::command]
pub async fn image(url: String) -> Result<String, String> {
    if !url.starts_with("https://images.anime3rb.com/") {
        return Err("Unsupported image URL".to_string());
    }
    let res = reqwest::Client::builder()
        .user_agent(UA)
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?
        .get(&url)
        .header("referer", BASE)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    let mime = res
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();
    if !mime.to_ascii_lowercase().starts_with("image/") {
        return Err(format!("Unexpected image content type: {mime}"));
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    if bytes.is_empty() {
        return Err("The image response was empty".to_string());
    }
    use base64::Engine;
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

#[tauri::command]
pub async fn browse(page: u32) -> Result<Vec<Card>, String> {
    browse_page(page).await
}

/// The catalog is paginated server-side at 20 titles per page; an empty page means the end.
async fn browse_page(page: u32) -> Result<Vec<Card>, String> {
    let html = get(&format!("{BASE}/titles/list?page={page}")).await?;
    for node in ld_nodes(&html) {
        if node.get("@type").and_then(Value::as_str) == Some("CollectionPage") {
            if let Some(list) = node.get("mainEntity") {
                return Ok(list_items(list));
            }
        }
    }
    Ok(Vec::new())
}

/// The site's `?q=` is ignored server-side: search is a Livewire component, so the query is
/// pushed through its update endpoint with the snapshot taken from the catalog page.
#[tauri::command]
pub async fn search(query: String) -> Result<Vec<Card>, String> {
    let client = reqwest::Client::builder().user_agent(UA).build().map_err(|e| e.to_string())?;
    let res = client
        .get(format!("{BASE}/titles/list"))
        .header("accept-language", "ar,en;q=0.8")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }

    let mut cookies = Vec::new();
    let mut xsrf = String::new();
    for value in res.headers().get_all(reqwest::header::SET_COOKIE) {
        let Ok(raw) = value.to_str() else { continue };
        let Some(pair) = raw.split(';').next() else { continue };
        cookies.push(pair.to_string());
        if let Some(token) = pair.strip_prefix("XSRF-TOKEN=") {
            xsrf = urlencoding::decode(token).map(|v| v.into_owned()).unwrap_or_else(|_| token.to_string());
        }
    }

    let html = res.text().await.map_err(|e| e.to_string())?;
    let csrf = regex::Regex::new(r#"name="csrf-token" content="([^"]+)""#)
        .unwrap()
        .captures(&html)
        .and_then(|cap| cap.get(1))
        .map(|m| m.as_str().to_string())
        .unwrap_or_default();
    let snapshot = regex::Regex::new(r#"wire:snapshot="([^"]*)""#)
        .unwrap()
        .captures_iter(&html)
        .map(|cap| unescape(&cap[1]))
        .find(|value| value.contains(r#""name":"search""#))
        .ok_or_else(|| "Search component not found".to_string())?;
    let endpoint = regex::Regex::new(r"livewire-[a-z0-9]+/update")
        .unwrap()
        .find(&html)
        .map(|m| m.as_str().to_string())
        .ok_or_else(|| "Search endpoint not found".to_string())?;

    let payload = serde_json::json!({
        "_token": csrf,
        "components": [{
            "snapshot": snapshot,
            "updates": { "query": query, "ready": true },
            "calls": [{ "path": "", "method": "$refresh", "params": [] }]
        }]
    });
    let res = client
        .post(format!("{BASE}/{endpoint}"))
        .header("accept-language", "ar,en;q=0.8")
        .header("x-livewire", "1")
        .header("x-csrf-token", &csrf)
        .header("x-xsrf-token", &xsrf)
        .header("cookie", cookies.join("; "))
        .header("referer", format!("{BASE}/titles/list"))
        .header("origin", BASE)
        .json(&payload)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    let body: Value = res.json().await.map_err(|e| e.to_string())?;
    let html = body
        .pointer("/components/0/effects/html")
        .and_then(Value::as_str)
        .unwrap_or_default();

    let card = regex::Regex::new(
        r#"(?s)<a\s+href="https://anime3rb\.com/titles/([^"]+)"[^>]*>\s*<img\s+src="([^"]+)"[^>]*>\s*<div[^>]*>\s*<h4[^>]*>([^<]*)</h4>"#,
    )
    .unwrap();
    Ok(card
        .captures_iter(html)
        .map(|cap| Card {
            name: unescape(&cap[3]).trim().to_string(),
            url: format!("{BASE}/titles/{}", &cap[1]),
            image: unescape(&cap[2]),
            episode: None,
        })
        .collect())
}

#[tauri::command]
pub async fn anime(url: String) -> Result<Anime, String> {
    let html = get(&url).await?;
    let series = ld_nodes(&html)
        .into_iter()
        .find(|node| node.get("@type").and_then(Value::as_str) == Some("TVSeries"))
        .ok_or_else(|| "No series data on this page".to_string())?;

    let mut episodes: Vec<Episode> = series
        .get("episode")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| Episode {
                    number: s(item.get("episodeNumber")).parse().unwrap_or_default(),
                    name: s(item.get("name")),
                    url: s(item.get("url")),
                })
                .collect()
        })
        .unwrap_or_default();
    episodes.sort_by_key(|episode| episode.number);

    Ok(Anime {
        name: s(series.get("name")),
        url: url.clone(),
        image: image_url(series.get("image")),
        description: s(series.get("description")),
        genres: series
            .get("genre")
            .and_then(Value::as_array)
            .map(|items| items.iter().map(|g| s(Some(g))).collect())
            .unwrap_or_default(),
        episodes,
    })
}

#[tauri::command]
pub async fn filler_classifications(
    anime_url: String,
    anime_name: String,
) -> Result<HashMap<u32, FillerInfo>, String> {
    Ok(anime_filler_classifications(&anime_url, &anime_name).await)
}
fn extract_episode_player_url(html: &str) -> Option<String> {
    let player = regex::Regex::new(r#""video_url":"(https:[^"]+)""#).ok()?;
    player
        .captures(html)
        .and_then(|cap| cap.get(1))
        .map(|value| value.as_str().replace("\\/", "/"))
}

#[tauri::command]
pub async fn episode(app: AppHandle, url: String) -> Result<EpisodeData, String> {
    let html = unescape(&get(&url).await?);
    let player_url = extract_episode_player_url(&html)
        .ok_or_else(|| "This episode has no player".to_string())?;

    // Some player responses already contain the populated source array. Use it first to
    // avoid opening a capture WebView when the server-rendered page has everything we need.
    let page = get(&player_url).await.unwrap_or_default();
    let parsed = match extract_video_sources_from_page(&page) {
        Some(sources) => sources,
        None => browser_sources(&app, &player_url).await?,
    };
    let sources = parsed
        .iter()
        .filter_map(|item| {
            let src = s(item.get("src"));
            if src.is_empty() {
                return None;
            }
            Some(Source {
                label: s(item.get("label")),
                res: s(item.get("res")),
                premium: item.get("premium").and_then(Value::as_bool).unwrap_or(false),
                src,
            })
        })
        .collect();

    let thumbnails = thumbnail_data(&page);

    Ok(EpisodeData {
        sources,
        poster: thumbnails.poster,
        thumbs: thumbnails.thumbs,
        thumbnail_page: player_url,
    })
}

/// The player page asks Cloudflare for a Turnstile token before it requests the sources, so a
/// plain HTTP client gets nothing. A hidden webview runs the real challenge and its XHR is
/// forwarded to a loopback listener started here.
static WINDOW_ID: AtomicU64 = AtomicU64::new(0);

const SOURCE_HOOK: &str = r#"(function () {
  var captured = false;
  var sending = false;
  var sourceFound = false;
  var pendingBody = null;
  var visible = __VISIBLE__;
  var androidRuntime = /Android/i.test(navigator.userAgent || "");

  function loopbackPermission() {
    if (!navigator.permissions || !navigator.permissions.query) {
      return Promise.resolve("unsupported");
    }
    return navigator.permissions.query({ name: "loopback-network" })
      .then(function (status) { return status.state; })
      // Older WebViews do not know this permission name; there is no LNA gate to wait for.
      .catch(function () { return "unsupported"; });
  }

  function send(text) {
    if (captured || sending || !text) return;
    sending = true;
    fetch("http://127.0.0.1:__PORT__/capture", {
      method: "POST",
      mode: "cors",
      cache: "no-store",
      targetAddressSpace: "loopback",
      body: text
    }).then(function () {
      captured = true;
      sending = false;
      pendingBody = null;
    }).catch(function () {
      sending = false;
      if (visible) {
        if (androidRuntime) {
          loopbackPermission().then(function (permission) {
            showStatus(permission);
          });
        } else {
          showStatus("prompt");
        }
      }
    });
  }

  function isSources(url) {
    return String(url || "").indexOf("/sources") !== -1;
  }

  function sendResponse(status, body) {
    if (sourceFound || status < 200 || status >= 300 || !body) return;
    sourceFound = true;
    pendingBody = body;

    if (androidRuntime) {
      // Local Network Access wants the first loopback request to come from a user gesture
      // when the permission is still "prompt". WebViews without LNA report "unsupported"
      // and can send immediately, so hidden capture keeps working there.
      loopbackPermission().then(function (permission) {
        if (permission === "granted" || permission === "unsupported") {
          send(body);
        } else if (visible) {
          showStatus(permission);
        }
      });
      return;
    }

    // Preserve the existing quiet capture path on desktop WebViews.
    send(body);
  }

  function showStatus(permission) {
    if (!visible || !document.body) return;
    var banner = document.getElementById("a3-checking");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "a3-checking";
      banner.dir = "rtl";
      banner.setAttribute("role", "status");
      banner.setAttribute("aria-live", "polite");
      banner.style.cssText =
        "position:fixed;top:12px;left:12px;z-index:2147483647;" +
        "display:flex;align-items:center;gap:10px;padding:9px 12px;" +
        "border:1px solid rgba(255,255,255,.18);border-radius:10px;" +
        "background:rgba(15,15,15,.94);color:#fff;" +
        "font:14px Segoe UI,Tahoma,sans-serif;box-shadow:0 4px 18px #0008;" +
        "pointer-events:auto";
      var label = document.createElement("span");
      label.id = "a3-checking-label";
      label.textContent = "جارٍ التحقق من مصدر الفيديو...";
      banner.appendChild(label);
      var button = document.createElement("button");
      button.id = "a3-checking-continue";
      button.type = "button";
      button.textContent = "متابعة";
      button.disabled = true;
      button.style.cssText =
        "border:0;border-radius:7px;padding:6px 10px;" +
        "background:#2563eb;color:#fff;font:inherit;cursor:pointer";
      button.addEventListener("click", function () {
        if (pendingBody) send(pendingBody);
      });
      banner.appendChild(button);
      document.body.appendChild(banner);
    }

    if (pendingBody) {
      var status = document.getElementById("a3-checking-label");
      var button = document.getElementById("a3-checking-continue");
      if (status) {
        status.textContent = permission === "denied"
          ? "الوصول المحلي محظور. فعّل إذن الشبكة المحلية من إعدادات الموقع."
          : "تم تجهيز المصادر. اضغط للسماح بإرسالها إلى التطبيق.";
      }
      if (button) {
        button.disabled = false;
        button.textContent = permission === "denied" ? "حاول مجدداً" : "السماح والمتابعة";
      }
    }
  }

  if (visible) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () {
        showStatus("prompt");
      });
    } else {
      showStatus("prompt");
    }
  }

  var xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__a3url = url;
    return xhrOpen.apply(this, arguments);
  };

  var xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    if (isSources(xhr.__a3url)) {
      xhr.addEventListener("load", function () {
        sendResponse(xhr.status, xhr.responseText);
      });
    }
    return xhrSend.apply(this, arguments);
  };

  var nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = function (input) {
      var url = typeof input === "string" ? input : input && input.url;
      var request = nativeFetch.apply(this, arguments);
      if (!isSources(url)) return request;
      return request.then(function (response) {
        response.clone().text().then(function (body) {
          sendResponse(response.status, body);
        }).catch(function () {});
        return response;
      });
    };
  }

  // The player writes its source array into a script inside player.ready(), so read it from
  // the rendered HTML; that works even when the request never passes through XHR/fetch.
  // Pick the largest valid assignment: the page may declare an empty array first.
  var checkInlineSources = function () {
    try {
      var html = document.documentElement.innerHTML;
      var pattern = /\bvideo_sources\s*=\s*\[/g;
      var best = null;
      var match;
      while ((match = pattern.exec(html))) {
        var start = match.index + match[0].length - 1;
        var depth = 0;
        var inString = false;
        var escaped = false;
        for (var i = start; i < html.length; i++) {
          var ch = html.charAt(i);
          if (inString) {
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === '"') inString = false;
            continue;
          }
          if (ch === '"') inString = true;
          else if (ch === "[") depth++;
          else if (ch === "]") {
            depth--;
            if (depth === 0) {
              try {
                var parsed = JSON.parse(html.slice(start, i + 1));
                if (parsed.length &&
                    parsed.some(function (item) {
                      return item && typeof item.src === "string" && item.src;
                    }) &&
                    (!best || parsed.length > best.length)) {
                  best = parsed;
                }
              } catch (e) {}
              break;
            }
          }
        }
      }
      if (best) sendResponse(200, JSON.stringify(best));
    } catch (e) {}
  };
  checkInlineSources();
  setInterval(checkInlineSources, 400);

  var checkExistingSources = function () {
    try {
      if (typeof video_sources !== "undefined" &&
          Array.isArray(video_sources) &&
          video_sources.length) {
        sendResponse(200, JSON.stringify(video_sources));
      }
    } catch (e) {}
  };
  checkExistingSources();
  // Android can inject initialization scripts after remote-page scripts have run.
  // Keep checking the page's populated global array so a missed XHR/fetch is recoverable.
  setInterval(checkExistingSources, 300);

  // Prevent a player preview from producing audio in either capture window.
  document.addEventListener("play", function (event) {
    if (event.target && typeof event.target.muted === "boolean") {
      event.target.muted = true;
      event.target.pause();
    }
  }, true);
})();"#;

fn read_callback_request(stream: &mut std::net::TcpStream) -> Option<(String, String)> {
    const MAX_BODY: usize = 2 * 1024 * 1024;
    let mut buffer = Vec::new();
    let mut method = String::new();
    let mut expected = None;

    loop {
        if buffer.len() > MAX_BODY + 16 * 1024 {
            return None;
        }

        let mut chunk = [0u8; 4096];
        let read = match stream.read(&mut chunk) {
            Ok(0) | Err(_) => return None,
            Ok(read) => read,
        };
        buffer.extend_from_slice(&chunk[..read]);

        if expected.is_none() {
            let Some(end) = buffer.windows(4).position(|part| part == b"\r\n\r\n") else {
                continue;
            };
            let headers = String::from_utf8_lossy(&buffer[..end]);
            method = headers
                .lines()
                .next()?
                .split_whitespace()
                .next()?
                .to_ascii_uppercase();
            expected = Some(
                headers
                    .lines()
                    .filter_map(|line| line.split_once(':'))
                    .find(|(name, _)| name.trim().eq_ignore_ascii_case("content-length"))
                    .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                    .unwrap_or(0),
            );
            buffer.drain(..end + 4);
            if expected.is_some_and(|length| length > MAX_BODY) {
                return None;
            }
        }

        if let Some(length) = expected {
            if buffer.len() >= length {
                return Some((
                    method,
                    String::from_utf8_lossy(&buffer[..length]).to_string(),
                ));
            }
        }
    }
}

fn callback_response(stream: &mut std::net::TcpStream, method: &str) {
    const CORS: &str =
        "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: POST, OPTIONS\r\nAccess-Control-Allow-Headers: content-type\r\nCache-Control: no-store\r\n";
    let response = match method {
        "OPTIONS" => format!(
            "HTTP/1.1 204 No Content\r\n{CORS}Content-Length: 0\r\nConnection: close\r\n\r\n"
        ),
        "POST" => format!(
            "HTTP/1.1 200 OK\r\n{CORS}Content-Type: text/plain; charset=utf-8\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK"
        ),
        _ => "HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
    };
    let _ = stream.write_all(response.as_bytes());
}

fn callback_server(timeout: Duration) -> Result<(u16, std::sync::mpsc::Receiver<String>), String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
    listener.set_nonblocking(true).map_err(|error| error.to_string())?;
    let port = listener.local_addr().map_err(|error| error.to_string())?.port();
    let (sender, receiver) = std::sync::mpsc::channel();

    std::thread::spawn(move || {
        let deadline = Instant::now() + timeout + Duration::from_secs(3);
        while Instant::now() < deadline {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(8)));
                    let Some((method, body)) = read_callback_request(&mut stream) else {
                        continue;
                    };
                    callback_response(&mut stream, &method);
                    if method == "POST" && !body.trim().is_empty() {
                        let _ = sender.send(body);
                        break;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(25));
                }
                Err(_) => break,
            }
        }
    });

    Ok((port, receiver))
}

fn parse_video_sources(body: &str) -> Result<Vec<Value>, String> {
    let value: Value = serde_json::from_str(body)
        .map_err(|error| format!("Could not parse the player source response: {error}"))?;
    let sources = value
        .as_array()
        .cloned()
        .or_else(|| value.get("sources").and_then(Value::as_array).cloned())
        .or_else(|| value.pointer("/data/sources").and_then(Value::as_array).cloned())
        .or_else(|| value.get("data").and_then(Value::as_array).cloned())
        .or_else(|| value.get("results").and_then(Value::as_array).cloned())
        .ok_or_else(|| "The player response did not contain a source list".to_string())?;

    if !sources.iter().any(|item| !s(item.get("src")).is_empty()) {
        return Err("The player returned no usable video sources".to_string());
    }
    Ok(sources)
}

/// Read a populated video_sources assignment from the player HTML without relying on
/// a WebView. Parse balanced brackets so nested arrays and quoted brackets are safe.
fn extract_video_sources_from_page(page: &str) -> Option<Vec<Value>> {
    let assignment = regex::Regex::new(r"\bvideo_sources\s*=\s*\[").ok()?;
    let bytes = page.as_bytes();
    let mut best: Option<Vec<Value>> = None;

    for matched in assignment.find_iter(page) {
        let start = matched.end().checked_sub(1)?;
        let mut depth = 0usize;
        let mut in_string = false;
        let mut escaped = false;

        for index in start..bytes.len() {
            let byte = bytes[index];
            if in_string {
                if escaped {
                    escaped = false;
                } else if byte == b'\\' {
                    escaped = true;
                } else if byte == b'"' {
                    in_string = false;
                }
                continue;
            }

            match byte {
                b'"' => in_string = true,
                b'[' => depth += 1,
                b']' => {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        if let Ok(sources) = parse_video_sources(&page[start..=index]) {
                            if !sources.is_empty()
                                && best.as_ref().map_or(true, |current| sources.len() > current.len())
                            {
                                best = Some(sources);
                            }
                        }
                        break;
                    }
                }
                _ => {}
            }
        }
    }

    best
}

async fn browser_sources_once(
    app: &AppHandle,
    player_url: &str,
    visible: bool,
    timeout: Duration,
) -> Result<Vec<Value>, String> {
    let (port, receiver) = callback_server(timeout)?;
    let label = format!("sources-{}", WINDOW_ID.fetch_add(1, Ordering::Relaxed));
    let script = SOURCE_HOOK
        .replace("__PORT__", &port.to_string())
        .replace("__VISIBLE__", if visible { "true" } else { "false" });
    let url = player_url.parse().map_err(|error| format!("{error}"))?;

    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title(if visible {
            "Anime3rb - جاري التحقق"
        } else {
            "Anime3rb - Source capture"
        })
        .inner_size(
            if visible { 720.0 } else { 1280.0 },
            if visible { 480.0 } else { 820.0 },
        )
        .visible(visible)
        .initialization_script(&script)
        .build()
        .map_err(|error| error.to_string())?;

    let received = tauri::async_runtime::spawn_blocking(move || {
        receiver.recv_timeout(timeout)
    })
    .await;
    // Always close the temporary WebView, including timeout and task-error paths.
    let _ = window.close();

    let body = received
        .map_err(|error| error.to_string())?
        .map_err(|error| match error {
            std::sync::mpsc::RecvTimeoutError::Timeout => {
                "Timed out waiting for the player source response".to_string()
            }
            std::sync::mpsc::RecvTimeoutError::Disconnected => {
                "The player capture listener stopped unexpectedly".to_string()
            }
        })?;

    parse_video_sources(&body)
}

async fn browser_sources(app: &AppHandle, player_url: &str) -> Result<Vec<Value>, String> {
    match browser_sources_once(app, player_url, false, Duration::from_secs(12)).await {
        Ok(sources) => Ok(sources),
        Err(hidden_error) => {
            browser_sources_once(app, player_url, true, Duration::from_secs(60))
                .await
                .map_err(|visible_error| {
                    format!("Hidden capture failed ({hidden_error}); visible verification failed: {visible_error}")
                })
        }
    }
}
#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn scrapes_home_search_and_anime() {
        let home = super::home().await.unwrap();
        assert!(!home.rails.is_empty(), "home has no rails");
        assert!(!home.rails[0].items.is_empty());

        let found = super::search("one piece".into()).await.unwrap();
        assert!(
            found.iter().any(|item| item.url == "https://anime3rb.com/titles/one-piece"),
            "search did not find One Piece: {found:?}"
        );

        let first = super::browse(1).await.unwrap();
        assert_eq!(first.len(), 20, "catalog page 1 should have 20 titles");
        assert!(super::browse(5000).await.unwrap().is_empty(), "catalog should end");

        let show = super::anime("https://anime3rb.com/titles/one-piece".into()).await.unwrap();
        assert_eq!(show.name, "One Piece");
        assert!(show.episodes.len() > 1000);
    }
}


#[cfg(test)]
mod source_parser_tests {
    use serde_json::json;

    #[test]
    fn parses_source_arrays_and_wrapped_payloads() {
        let direct = r#"[{"label":"1080p","res":"1080","src":"https://video.example/1080.m3u8"}]"#;
        let parsed = super::parse_video_sources(direct).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(super::s(parsed[0].get("res")), "1080");

        let wrapped = json!({
            "data": {
                "sources": [
                    {"label":"720p","res":"720","src":"https://video.example/720.m3u8"}
                ]
            }
        });
        let parsed = super::parse_video_sources(&wrapped.to_string()).unwrap();
        assert_eq!(super::s(parsed[0].get("res")), "720");
    }

    #[test]
    fn rejects_source_payloads_without_playable_urls() {
        assert!(super::parse_video_sources(r#"[{"label":"1080p","res":"1080"}]"#).is_err());
        assert!(super::parse_video_sources("not json").is_err());
    }
}


#[cfg(test)]
mod image_url_tests {
    use serde_json::json;

    #[test]
    fn supports_string_image_urls() {
        assert_eq!(
            super::image_url(Some(&json!("https://images.anime3rb.com/poster.jpg"))),
            "https://images.anime3rb.com/poster.jpg"
        );
    }

    #[test]
    fn supports_image_objects_and_arrays() {
        let object = json!({
            "@type": "ImageObject",
            "contentUrl": "https://images.anime3rb.com/object.jpg"
        });
        assert_eq!(
            super::image_url(Some(&object)),
            "https://images.anime3rb.com/object.jpg"
        );

        let array = json!([
            {"@type": "ImageObject", "url": "https://images.anime3rb.com/first.jpg"},
            "https://images.anime3rb.com/second.jpg"
        ]);
        assert_eq!(
            super::image_url(Some(&array)),
            "https://images.anime3rb.com/first.jpg"
        );
    }

    #[test]
    fn ignores_empty_or_unsupported_image_values() {
        assert_eq!(super::image_url(None), "");
        assert_eq!(super::image_url(Some(&json!({ "name": "missing" }))), "");
        assert_eq!(super::image_url(Some(&json!("  "))), "");
    }
}

#[cfg(test)]
mod episode_thumbnail_tests {
    #[test]
    fn extracts_player_url_from_episode_page_markup() {
        let html = r#"<script>window.data = {"video_url":"https:\\/\\/vid3rb.com\\/player?id=episode-1"};</script>"#;
        assert_eq!(
            super::extract_episode_player_url(html).as_deref(),
            Some("https://vid3rb.com/player?id=episode-1")
        );
    }

    #[test]
    fn ignores_markup_without_a_player_url() {
        assert!(super::extract_episode_player_url("<html></html>").is_none());
    }
}



#[cfg(test)]
mod kitsu_thumbnail_tests {
    use serde_json::json;

    #[test]
    fn normalizes_titles_and_requires_an_exact_catalog_match() {
        assert_eq!(super::normalize_kitsu_title("One Piece"), "onepiece");
        assert_eq!(super::normalize_kitsu_title("ONE-PIECE!"), "onepiece");

        let one_piece = json!({
            "attributes": {
                "slug": "one-piece",
                "canonicalTitle": "One Piece",
                "titles": { "en": "One Piece", "ja_jp": "ONE PIECE" }
            }
        });
        let film = json!({
            "attributes": {
                "slug": "one-piece-film-z",
                "canonicalTitle": "One Piece Film: Z",
                "titles": { "en": "One Piece Film Z" }
            }
        });

        assert_eq!(super::kitsu_match_score(&one_piece, "onepiece", "onepiece"), 3);
        assert_eq!(super::kitsu_match_score(&one_piece, "onepiece", "different"), 2);
        assert_eq!(super::kitsu_match_score(&film, "onepiece", "onepiece"), 0);
    }

    #[test]
    fn episode_pages_use_twenty_item_offsets() {
        assert_eq!(super::kitsu_episode_page_offset(1), 0);
        assert_eq!(super::kitsu_episode_page_offset(20), 0);
        assert_eq!(super::kitsu_episode_page_offset(21), 20);
        assert_eq!(super::kitsu_episode_page_offset(41), 40);
    }

    #[test]
    fn accepts_only_kitsu_image_hosts_over_https() {
        assert!(super::valid_kitsu_image_url(
            "https://media.kitsu.app/episodes/thumbnails/123/original.jpg"
        ));
        assert!(super::valid_kitsu_image_url(
            "https://media.kitsu.io/episodes/thumbnails/123/original.jpg"
        ));
        assert!(!super::valid_kitsu_image_url("http://media.kitsu.app/image.jpg"));
        assert!(!super::valid_kitsu_image_url("https://evil.example/image.jpg"));
    }

    #[test]
    fn extracts_only_numbered_episode_images_from_a_kitsu_page() {
        let payload = json!({
            "data": [
                {
                    "attributes": {
                        "number": 21,
                        "thumbnail": {
                            "original": "https://media.kitsu.app/episodes/thumbnails/21/original.jpg"
                        }
                    }
                },
                {
                    "attributes": {
                        "number": 22,
                        "thumbnail": { "original": "https://wrong.example/22.jpg" }
                    }
                },
                {
                    "attributes": {
                        "number": 23,
                        "thumbnail": { "original": null }
                    }
                }
            ]
        });

        let images = super::parse_kitsu_episode_images(&payload);
        assert_eq!(
            images.get(&21).map(String::as_str),
            Some("https://media.kitsu.app/episodes/thumbnails/21/original.jpg")
        );
        assert!(!images.contains_key(&22));
        assert!(!images.contains_key(&23));
    }

    #[test]
    fn accepts_only_anime3rb_title_urls_for_mapping() {
        assert_eq!(
            super::anime3rb_title_slug("https://anime3rb.com/titles/one-piece").unwrap(),
            "one-piece"
        );
        assert!(super::anime3rb_title_slug("https://evil.example/titles/one-piece").is_err());
        assert!(super::anime3rb_title_slug("https://anime3rb.com/episode/1").is_err());
    }
}


#[cfg(test)]
mod external_artwork_tests {
    use serde_json::json;

    #[test]
    fn anizip_prefers_absolute_episode_number_and_rejects_untrusted_hosts() {
        let payload = json!({
            "episodes": {
                "1": {
                    "episodeNumber": 1,
                    "absoluteEpisodeNumber": 101,
                    "image": "https://artworks.thetvdb.com/still-101.jpg"
                },
                "2": {
                    "episodeNumber": 2,
                    "image": "https://image.tmdb.org/t/p/w500/still-2.jpg"
                },
                "3": {
                    "episodeNumber": 3,
                    "image": "https://evil.example/still-3.jpg"
                }
            }
        });
        let images = super::parse_anizip_episode_images(&payload);
        assert_eq!(
            images.get(&101).map(String::as_str),
            Some("https://artworks.thetvdb.com/still-101.jpg")
        );
        assert_eq!(
            images.get(&2).map(String::as_str),
            Some("https://image.tmdb.org/t/p/w500/still-2.jpg")
        );
        assert!(!images.contains_key(&3));
    }

    #[test]
    fn exact_nogitsu_matching_does_not_select_a_related_movie() {
        let wanted_name = super::normalize_artwork_title("One Piece");
        let wanted_slug = super::normalize_artwork_title("one-piece");
        let series = json!({ "slug": "one-piece", "title": "ONE PIECE" });
        let film = json!({ "slug": "one-piece-film-z", "title": "One Piece Film: Z" });
        assert_eq!(super::nogitsu_match_score(&series, &wanted_name, &wanted_slug), 3);
        assert_eq!(super::nogitsu_match_score(&film, &wanted_name, &wanted_slug), 0);
    }

    #[test]
    fn parses_only_nogitsu_unit_images_from_their_cdn() {
        let payload = json!({
            "items": [
                {
                    "number": 1,
                    "image": { "url": "https://cdn.nogitsu.com/images/unit/still/one-piece-1.jpg" }
                },
                {
                    "number": 2,
                    "image": { "url": "https://evil.example/image.jpg" }
                },
                {
                    "number": 3,
                    "image": null
                }
            ]
        });
        let images = super::parse_nogitsu_unit_images(&payload);
        assert_eq!(
            images.get(&1).map(String::as_str),
            Some("https://cdn.nogitsu.com/images/unit/still/one-piece-1.jpg")
        );
        assert!(!images.contains_key(&2));
        assert!(!images.contains_key(&3));
    }

    #[test]
    fn validates_episode_still_urls_from_all_three_providers() {
        assert!(super::valid_episode_artwork_url(
            "https://media.kitsu.app/episodes/thumbnails/1/original.jpg"
        ));
        assert!(super::valid_episode_artwork_url(
            "https://artworks.thetvdb.com/banners/v4/episode/1/screencap/still.jpg"
        ));
        assert!(super::valid_episode_artwork_url(
            "https://image.tmdb.org/t/p/w500/still.jpg"
        ));
        assert!(super::valid_episode_artwork_url(
            "https://cdn.nogitsu.com/images/unit/still/one-piece-1.jpg"
        ));
        assert!(!super::valid_episode_artwork_url("https://evil.example/still.jpg"));
        assert!(!super::valid_episode_artwork_url("http://image.tmdb.org/still.jpg"));
    }
}


#[cfg(test)]
mod player_page_source_tests {
    use serde_json::json;

    #[test]
    fn prefers_the_largest_populated_source_assignment() {
        let page = r#"<script>
            var video_sources = [];
            video_sources = [
                {"label":"720p","res":"720","src":"https://video.example/720.m3u8"},
                {"label":"1080p","res":"1080","src":"https://video.example/1080.m3u8"}
            ];
        </script>"#;

        let sources = super::extract_video_sources_from_page(page).unwrap();
        assert_eq!(sources.len(), 2);
        assert_eq!(super::s(sources[1].get("res")), "1080");
    }

    #[test]
    fn parses_nested_arrays_and_ignores_brackets_inside_source_urls() {
        let page = r#"<script>
            video_sources = [{
                "label":"720p",
                "res":"720",
                "metadata":{"tracks":["one","two"]},
                "src":"https://video.example/episode[1].m3u8"
            }];
        </script>"#;

        let sources = super::extract_video_sources_from_page(page).unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(super::s(sources[0].get("res")), "720");
    }

    #[test]
    fn ignores_empty_or_invalid_player_assignments() {
        assert!(super::extract_video_sources_from_page(
            "video_sources = []; video_sources = not_json;"
        ).is_none());

        let page = format!(
            "video_sources = {};",
            json!([{"label":"missing src","res":"720"}])
        );
        assert!(super::extract_video_sources_from_page(&page).is_none());
    }
}
