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
export type EpisodeData = { sources: Source[]; poster: string; thumbs: string };
export type Skips = { ranges: { start: number; end: number }[]; content_end: number };

export const home = () => invoke<Home>("home");
export const search = (query: string) => invoke<Card[]>("search", { query });
export const browse = (page: number) => invoke<Card[]>("browse", { page });
export const anime = (url: string) => invoke<Anime>("anime", { url });
export const episode = (url: string) => invoke<EpisodeData>("episode", { url });
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

export async function loadCues(url: string): Promise<Cue[]> {
  if (!url) return [];
  try {
    const response = await fetch(url, { cache: "force-cache" });
    if (!response.ok) return [];
    return parseCueVtt(await response.text(), url);
  } catch { return []; }
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
