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
| Anime + episodes | `TVSeries` node with `episode[]` |
| Player + video sources | `video_url` on the episode page, then `video_sources` on the player page |
| Skip times | AniSkip, after mapping the title to MAL through AniList |

All requests run in Rust, so there is no CORS restriction. Streams play directly from the signed
`video.vid3rb.com` URLs, and posters are proxied through Rust because the image CDN blocks foreign referers.

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

GitHub Actions builds both platforms on every push to a `v*` tag and on manual runs
(`Actions → build → Run workflow`). Download the artifacts from the run page, or the installers from
the release page:

- Windows: `.exe` (NSIS) and `.msi`
- Android: universal debug APK (signed with the debug key, installable for testing)

For a signed release APK, add a keystore to the Android project and configure it in
`src-tauri/gen/android/app/build.gradle.kts`.

## Notes

- Personal, unofficial project. Not affiliated with Anime3rb or HackerTube.
- No downloading and no paywall bypass: the app only exposes the same sources the site offers.
- Skip times are community-contributed, so some episodes have none.
