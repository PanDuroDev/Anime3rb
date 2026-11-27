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

/** The player ships a sprite sheet of frames as a VTT: `file#xywh=x,y,w,h`. */
export async function loadCues(url: string): Promise<Cue[]> {
  if (!url) return [];
  try {
    const text = await (await fetch(url)).text();
    const base = url.slice(0, url.lastIndexOf("/") + 1);
    const cues: Cue[] = [];
    for (const block of text.split(/\r?\n\r?\n/)) {
      const match = block.match(/(\d+(?::\d+){1,2}\.\d{3})\s*-->\s*(\d+(?::\d+){1,2}\.\d{3})[\s\S]*?([\w.-]+\.jpe?g)#xywh=(\d+),(\d+),(\d+),(\d+)/);
      if (!match) continue;
      const [, from, to, file, x, y, w, h] = match;
      cues.push({
        start: toSeconds(from),
        end: toSeconds(to),
        file: base + file,
        x: Number(x),
        y: Number(y),
        w: Number(w),
        h: Number(h),
      });
    }
    return cues;
  } catch {
    return [];
  }
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
