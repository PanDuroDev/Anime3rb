import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

// images.anime3rb.com rejects any referer but its own, and the webview sends tauri://localhost,
// so every poster goes through the Rust side once and is cached as a data URL.
const cache = new Map<string, string>();

export function useImage(src?: string) {
  const [url, setUrl] = useState(() => (src ? cache.get(src) : undefined));

  useEffect(() => {
    if (!src) return;
    const hit = cache.get(src);
    if (hit) {
      setUrl(hit);
      return;
    }
    let live = true;
    invoke<string>("image", { url: src })
      .then((data) => {
        cache.set(src, data);
        if (live) setUrl(data);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [src]);

  return url;
}

export function Img({ src, alt = "", className }: { src?: string; alt?: string; className?: string }) {
  const url = useImage(src);
  if (!url) return null;
  return <img className={className} src={url} alt={alt} loading="lazy" />;
}
