import { invoke } from "@tauri-apps/api/core";

export type Card = { name: string; url: string; image: string; episode?: number };
export type Rail = { title: string; items: Card[] };
export type Home = { rails: Rail[] };
export type Episode = { number: number; name: string; url: string };
export type Anime = {
  name: string;
  url: string;
  image: string;
  description: string;
  genres: string[];
  episodes: Episode[];
};
export type Source = { label: string; res: string; premium: boolean; src: string };
export type EpisodeData = { sources: Source[]; poster: string; thumbs: string; thumbnail_page: string };
export type ThumbnailData = { poster: string; thumbs: string };
export type Skips = { ranges: { start: number; end: number }[]; content_end: number };

export const home = () => invoke<Home>("home");
export const search = (query: string) => invoke<Card[]>("search", { query });
export const browse = (page: number) => invoke<Card[]>("browse", { page });
const animeCache = new Map<string, { data: Anime; expiresAt: number }>();
const animeRequests = new Map<string, Promise<Anime>>();
const ANIME_CACHE_TTL = 15 * 60 * 1000;

export function anime(url: string): Promise<Anime> {
  const cached = animeCache.get(url);
  if (cached && cached.expiresAt > Date.now()) {
    return Promise.resolve(cached.data);
  }
  if (cached) animeCache.delete(url);

  const pending = animeRequests.get(url);
  if (pending) return pending;

  const request = invoke<Anime>("anime", { url })
    .then((data) => {
      if (animeCache.size >= 40) {
        const oldest = animeCache.keys().next().value;
        if (oldest) animeCache.delete(oldest);
      }
      animeCache.set(url, { data, expiresAt: Date.now() + ANIME_CACHE_TTL });
      return data;
    })
    .finally(() => animeRequests.delete(url));

  animeRequests.set(url, request);
  return request;
}
export const episode = (url: string) => invoke<EpisodeData>("episode", { url });
export const thumbnailInfo = (url: string) => invoke<ThumbnailData>("thumbnail_info", { url });
const episodeArtworkCache = new Map<string, string>();
const episodeArtworkRequests = new Map<string, Promise<string>>();

export function episodeCatalogThumbnail(
  animeUrl: string,
  animeName: string,
  episodeNumber: number
): Promise<string> {
  const key = `${animeUrl}#${episodeNumber}`;
  if (episodeArtworkCache.has(key)) {
    return Promise.resolve(episodeArtworkCache.get(key) ?? "");
  }

  const pending = episodeArtworkRequests.get(key);
  if (pending) return pending;

  const request = invoke<string>("episode_catalog_thumbnail", {
    animeUrl,
    animeName,
    episodeNumber,
  })
    .then((image) => {
      // Cache empty results too, so a missing upstream image does not trigger another lookup
      // every time the user scrolls away and back.
      if (episodeArtworkCache.size >= 600) episodeArtworkCache.clear();
      episodeArtworkCache.set(key, image || "");
      return image || "";
    })
    .finally(() => episodeArtworkRequests.delete(key));

  episodeArtworkRequests.set(key, request);
  return request;
}
export const skips = (title: string, episode: number, length: number) =>
  invoke<Skips>("skips", { title, episode, length });

export const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
};

export type Cue = { start: number; end: number; file: string; x: number; y: number; w: number; h: number };

/** Parse WebVTT sprite references in the form `file#xywh=x,y,w,h`. */
export function parseCueVtt(text: string, sourceUrl: string): Cue[] {
  const cues: Cue[] = [];
  const timestamp = /^(\d{1,}:\d{2}(?::\d{2})?\.\d{3})\s*-->\s*(\d{1,}:\d{2}(?::\d{2})?\.\d{3})/;
  for (const block of text.replace(/^\uFEFF/, "").split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const timeLine = lines.find((line) => timestamp.test(line));
    if (!timeLine) continue;
    const times = timeLine.match(timestamp);
    const reference = lines.find((line) => line.includes("#xywh="));
    if (!times || !reference) continue;
    const [file, coordinates] = reference.split("#xywh=");
    const values = coordinates?.split(",").map(Number);
    if (!file || !values || values.length !== 4 || values.some((value) => !Number.isFinite(value))) continue;
    const [x, y, w, h] = values;
    if (w <= 0 || h <= 0) continue;
    try {
      cues.push({ start: toSeconds(times[1]), end: toSeconds(times[2]), file: new URL(file, sourceUrl).toString(), x, y, w, h });
    } catch { continue; }
  }
  return cues.sort((a, b) => a.start - b.start);
}

const cueCache = new Map<string, Cue[]>();
const cueRequests = new Map<string, Promise<Cue[]>>();
const wait = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

export async function loadCues(url: string): Promise<Cue[]> {
  if (!url) return [];
  const cached = cueCache.get(url);
  if (cached) return cached;
  const pending = cueRequests.get(url);
  if (pending) return pending;

  const request = (async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const text = await invoke<string>("thumbnail_vtt", { url });
        const cues = parseCueVtt(text, url);
        if (cues.length) {
          // Keep only a small number of episode sheets in memory.
          if (cueCache.size >= 30) {
            const oldest = cueCache.keys().next().value;
            if (oldest) cueCache.delete(oldest);
          }
          cueCache.set(url, cues);
          return cues;
        }
      } catch {
        // The CDN can briefly fail; retry below instead of permanently disabling previews.
      }
      if (attempt < 2) await wait(attempt === 0 ? 250 : 700);
    }
    return [];
  })().finally(() => {
    cueRequests.delete(url);
  });

  cueRequests.set(url, request);
  return request;
}

const toSeconds = (stamp: string) => {
  const parts = stamp.split(":").map(Number);
  return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
};

export type Progress = { url: string; name: string; anime: string; image: string; time: number; duration: number; at: number };

const KEY = "a3:progress";

export const readProgress = (): Progress[] => {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
};

export const saveProgress = (entry: Progress) => {
  const list = readProgress().filter((item) => item.url !== entry.url);
  list.unshift(entry);
  localStorage.setItem(KEY, JSON.stringify(list.slice(0, 30)));
};

export const progressFor = (url: string) => readProgress().find((item) => item.url === url)?.time || 0;
