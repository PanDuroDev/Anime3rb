mod scrape;
mod skips;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            scrape::home,
            scrape::search,
            scrape::browse,
            scrape::anime,
            scrape::episode,
            scrape::episode_catalog_thumbnail,
            scrape::thumbnail_info,
            scrape::thumbnail_vtt,
            scrape::image,
            skips::skips
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
