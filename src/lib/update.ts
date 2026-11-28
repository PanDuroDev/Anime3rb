import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

const RELEASE_API = "https://api.github.com/repos/PanDuroDev/Anime3rb/releases/latest";
const ANDROID = /Android/i.test(navigator.userAgent);

export type PendingUpdate = {
  version: string;
  /** True when the update is an APK that installs through the system browser. */
  external?: boolean;
  install: (onProgress: (fraction: number | null) => void) => Promise<void>;
};

type Release = {
  tag_name?: string;
  assets?: { name: string; browser_download_url: string }[];
};

export async function findUpdate(): Promise<PendingUpdate | null> {
  if (ANDROID) return androidUpdate();

  const update = await check();
  if (!update) return null;
  return {
    version: update.version,
    install: async (onProgress) => {
      let total = 0;
      let done = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
          onProgress(0);
        } else if (event.event === "Progress") {
          done += event.data.chunkLength;
          onProgress(total ? done / total : null);
        } else {
          onProgress(1);
        }
      });
      await relaunch();
    },
  };
}

// The updater plugin is desktop-only, so Android compares the release tag and opens the APK.
async function androidUpdate(): Promise<PendingUpdate | null> {
  const [current, response] = await Promise.all([
    getVersion(),
    fetch(RELEASE_API, { headers: { accept: "application/vnd.github+json" } }),
  ]);
  if (!response.ok) return null;

  const release = (await response.json()) as Release;
  const version = (release.tag_name || "").replace(/^v/, "");
  if (!version || !isNewer(version, current)) return null;

  const assets = release.assets || [];
  const apk =
    assets.find((asset) => /arm64.*\.apk$/i.test(asset.name)) ??
    assets.find((asset) => /\.apk$/i.test(asset.name));
  if (!apk) return null;

  return {
    version,
    external: true,
    install: async () => {
      await openUrl(apk.browser_download_url);
    },
  };
}

const isNewer = (candidate: string, current: string) => {
  const next = candidate.split(".").map(Number);
  const now = current.split(".").map(Number);
  for (let i = 0; i < Math.max(next.length, now.length); i++) {
    const diff = (next[i] || 0) - (now[i] || 0);
    if (diff) return diff > 0;
  }
  return false;
};
