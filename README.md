# Anime3rb

A desktop and mobile client for [anime3rb.com](https://anime3rb.com), built with **Tauri 2 + React 19 + TypeScript**.
Scraping follows the approach of [animeiat_cli](https://github.com/PanDuroDev/animeiat_cli), and the player uses the
HackerTube-style control bar from [Anime3rb-Skin](https://github.com/PanDuroDev/Anime3rb-Skin).

## Features

- **Home** — latest episodes, recently added titles, and a Continue watching row.
- **Search** — full title search against the site's own search component.
- **Browse** — page through the entire catalogue (~500 pages, 20 titles each).
- **Anime page** — poster, genres, synopsis, and every episode.
- **Player** — play/pause, ±10s, mute, quality, fullscreen, picture-in-picture, cinema mode,
  hover previews on the progress bar, and auto-hiding controls.
- **Skip / Next** — opening and ending ranges from AniSkip, plus a Next pill with a frame thumbnail.
- **Progress** — resume position is stored locally.

## How it works

Every page on Anime3rb embeds its content as schema.org JSON-LD, so nothing is scraped from brittle HTML:

| Data | Source |
| --- | --- |
| Latest episodes / new titles | `ItemList` on the home page |
| Catalogue pages | `CollectionPage.mainEntity` on `/titles/list?page=N` |
| Search | Livewire `search` component on `/titles/list` |
| Anime + episode list | `TVSeries` node with `episode[]` (15-minute in-memory cache) |
| Home / search / catalogue | Anime3rb, cached for 5 minutes (home/search) or 15 minutes (catalogue pages) |
| Episode still images | Kitsu → AniZip → Nogitsu; fetched only near the viewport and cached by 20/24-episode range |
| Series/catalogue posters | Anime3rb image CDN, proxied only when a poster approaches the viewport |
| Player + video sources | `video_url` on the episode page, then `video_sources` on the player page |
| Skip times | AniSkip, after mapping the title to MAL through AniList |

Metadata and player-source requests run in Rust to avoid CORS restrictions. Episode stills are loaded
directly from the external providers' image CDNs. Series/catalogue posters that still come from
Anime3rb are proxied through Rust because its image CDN blocks foreign referers, but their proxy
requests are lazy-loaded and deduplicated. Streams play directly from the signed `video.vid3rb.com` URLs.

Episode artwork is deliberately independent from Anime3rb's image endpoints:

1. [Kitsu](https://hummingbird-me.github.io/api-docs/) supplies per-episode thumbnails.
2. [AniZip](https://api.ani.zip) supplies a cached AniList mapping with TVDB/AniDB episode stills.
3. [Nogitsu](https://nogitsu.com/developers) supplies a range of stills aggregated from providers such as TVDB and TMDB.

The first provider with an exact episode-number match wins. No series-cover fallback is used.
Provider metadata is cached in memory for 24 hours, requests are deduplicated and serialized, and Nogitsu
calls are paced below its published 120-requests-per-minute limit. Anime3rb remains responsible
for its catalogue, episode URLs and playback; its episode pages and player pages are never fetched
to obtain episode artwork. Catalogue calls are also cached in the client: home/search for 5 minutes
and browse/anime details for 15 minutes.

Nogitsu's public API is free for non-commercial use with attribution. Episode artwork rights remain
with their respective source providers and are used only to identify the corresponding episode.
The app credits Kitsu, AniZip and Nogitsu in its footer.

## Development

```bash
npm install
npm run tauri dev      # desktop
npm run tauri build    # desktop bundles (NSIS + MSI on Windows)
```

Android needs the Android SDK and NDK, plus the Rust Android targets:

```bash
npm run tauri android init
npm run tauri android dev
```

## Prebuilt downloads

Version **0.1.6** is built through GitHub Actions when its version metadata reaches `main`, when a
`v*` tag is pushed, or when you manually run **Actions → Build Anime3rb → Run workflow**.

Each successful run uploads two downloadable artifacts to its run page:

- **Windows:** NSIS `.exe` installer and `.msi` installer.
- **Android:** per-ABI debug APKs. The APKs are signed with the Android debug key; `arm64-v8a`
  is the usual choice for modern phones.

Artifacts are retained for **30 days**. A `v*` tag also publishes a GitHub Release with the same
files attached. To publish a signed Android release APK later, configure a release keystore in
`src-tauri/gen/android/app/build.gradle.kts`.

### Releasing without the CLI

Run **Actions → Build Anime3rb → Run workflow** on `main` and fill in `version` (for example
`0.1.6`) and optionally `notes`. The workflow bumps `package.json`, `src-tauri/Cargo.toml`, and
`src-tauri/tauri.conf.json`, commits, tags `v0.1.6`, builds both platforms, and publishes the
release. Leave `version` empty to build without releasing.

The same run can be started from a GitHub MCP client such as ChatGPT with the GitHub connector,
using the `actions_run_trigger` tool with `workflow_id: build.yml` and those inputs.

## Notes

- Personal, unofficial project. Not affiliated with Anime3rb or HackerTube.
- No downloading and no paywall bypass: the app only exposes the same sources the site offers.
- Skip times are community-contributed, so some episodes have none.
