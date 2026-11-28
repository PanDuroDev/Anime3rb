import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

// Anime3rb's image CDN requires its own referer, so image bytes are proxied through Rust.
// Defer that proxy request until the poster approaches the viewport.
const cache = new Map<string, string>();
const requests = new Map<string, Promise<string>>();
const posterTargets = new Map<Element, () => void>();
let posterObserver: IntersectionObserver | null = null;

function observePoster(target: Element, onVisible: () => void) {
  if (typeof IntersectionObserver === "undefined") {
    onVisible();
    return () => {};
  }

  if (!posterObserver) {
    posterObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const callback = posterTargets.get(entry.target);
          if (!callback) continue;
          posterTargets.delete(entry.target);
          posterObserver?.unobserve(entry.target);
          callback();
        }
        if (!posterTargets.size) {
          posterObserver?.disconnect();
          posterObserver = null;
        }
      },
      { root: null, rootMargin: "200px 0px" }
    );
  }

  posterTargets.set(target, onVisible);
  posterObserver.observe(target);

  return () => {
    posterTargets.delete(target);
    posterObserver?.unobserve(target);
    if (!posterTargets.size) {
      posterObserver?.disconnect();
      posterObserver = null;
    }
  };
}

export function useImage(src?: string, target?: Element | null) {
  const [url, setUrl] = useState(() => (src ? cache.get(src) : undefined));

  useEffect(() => {
    if (!src) {
      setUrl(undefined);
      return;
    }

    const hit = cache.get(src);
    if (hit) {
      setUrl(hit);
      return;
    }

    setUrl(undefined);
    if (!target) return;

    let live = true;
    const stopObserving = observePoster(target, () => {
      const cached = cache.get(src);
      if (cached) {
        if (live) setUrl(cached);
        return;
      }

      const pending = requests.get(src);
      if (pending) {
        pending.then((image) => live && setUrl(image)).catch(() => {});
        return;
      }

      const request = invoke<string>("image", { url: src });
      requests.set(src, request);
      request
        .then((data) => {
          if (cache.size >= 500) {
            const oldest = cache.keys().next().value;
            if (oldest) cache.delete(oldest);
          }
          cache.set(src, data);
          if (live) setUrl(data);
        })
        .catch(() => {})
        .finally(() => requests.delete(src));
    });

    return () => {
      live = false;
      stopObserving();
    };
  }, [src, target]);

  return url;
}

export function Img({ src, alt = "", className }: { src?: string; alt?: string; className?: string }) {
  const [target, setTarget] = useState<HTMLSpanElement | null>(null);
  const url = useImage(src, target);

  if (!url) {
    return (
      <span
        ref={setTarget}
        className={`image-placeholder${className ? ` ${className}` : ""}`}
        aria-hidden="true"
      />
    );
  }

  return <img className={className} src={url} alt={alt} loading="lazy" decoding="async" />;
}
