use serde::Serialize;
use serde_json::{json, Value};

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

#[derive(Serialize, Clone)]
pub struct Skip {
    pub start: f64,
    pub end: f64,
}

#[derive(Serialize)]
pub struct Skips {
    pub ranges: Vec<Skip>,
    pub content_end: f64,
}

async fn mal_id(title: &str) -> Option<u64> {
    let res = reqwest::Client::new()
        .post("https://graphql.anilist.co")
        .json(&json!({
            "query": "query($s:String){Media(search:$s,type:ANIME){idMal}}",
            "variables": { "s": title }
        }))
        .send()
        .await
        .ok()?;
    let body: Value = res.json().await.ok()?;
    body.pointer("/data/Media/idMal")?.as_u64()
}

/// AniSkip only answers for a length close to the upload it knows, so try the neighbours too.
async fn fetch_ranges(mal: u64, episode: u32, length: u32) -> Vec<Value> {
    let url = format!(
        "https://api.aniskip.com/v2/skip-times/{mal}/{episode}?types[]=op&types[]=ed&types[]=recap&types[]=mixed-op&types[]=mixed-ed&episodeLength={length}"
    );
    let Ok(res) = reqwest::Client::new().get(&url).header("user-agent", UA).send().await else {
        return Vec::new();
    };
    if !res.status().is_success() {
        return Vec::new();
    }
    let Ok(body) = res.json::<Value>().await else { return Vec::new() };
    if body.get("found").and_then(Value::as_bool) != Some(true) {
        return Vec::new();
    }
    body.get("results")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

#[tauri::command]
pub async fn skips(title: String, episode: u32, length: f64) -> Result<Skips, String> {
    let Some(mal) = mal_id(&title).await else {
        return Ok(Skips { ranges: Vec::new(), content_end: 0.0 });
    };
    let size = length.round().max(0.0) as u32;

    let mut results = Vec::new();
    for probe in [size, size.saturating_sub(2), size + 2] {
        results = fetch_ranges(mal, episode, probe).await;
        if !results.is_empty() {
            break;
        }
    }

    let mut ranges: Vec<Skip> = Vec::new();
    let mut endings: Vec<f64> = Vec::new();
    for item in &results {
        let kind = item.pointer("/skipType").and_then(Value::as_str).unwrap_or("");
        let start = item.pointer("/interval/startTime").and_then(Value::as_f64);
        let end = item.pointer("/interval/endTime").and_then(Value::as_f64);
        let (Some(start), Some(end)) = (start, end) else { continue };
        let start = start.max(0.0);
        let end = end.min(length);
        if end <= start {
            continue;
        }
        if matches!(kind, "ed" | "mixed-ed") {
            // The ending normally runs into the next-episode preview; cap it so the Next pill
            // still lands near the real content end.
            endings.push((start + 90.0).min(end));
        }
        ranges.push(Skip { start, end });
    }

    ranges.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap_or(std::cmp::Ordering::Equal));
    let mut merged: Vec<Skip> = Vec::new();
    for range in ranges {
        match merged.last_mut() {
            Some(last) if range.start <= last.end => last.end = last.end.max(range.end),
            _ => merged.push(range),
        }
    }

    endings.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let content_end = endings
        .get(endings.len().saturating_sub(1) / 2)
        .copied()
        .filter(|end| *end > 0.0 && *end < length - 3.0)
        .unwrap_or(0.0);

    Ok(Skips { ranges: merged, content_end })
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn finds_one_piece_1071_opening() {
        let result = super::skips("One Piece".into(), 1071, 1434.87).await.unwrap();
        assert!(result.ranges.iter().any(|r| r.start < 5.0 && r.end > 60.0), "no opening found");
    }
}
