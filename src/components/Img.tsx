import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

// Anime3rb's image CDN requires its own referer, so image bytes are proxied through Rust.
// Defer that proxy request until the poster approaches the viewport.
const cache = new Map<string, string>();
const requests = new Map<string, Promise<string>>();
const posterTargets = new Map<Element, () => void>();
let posterObserver: IntersectionObserver | null = null;

const wait = (milliseconds: number) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

async function loadImage(src: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const data = await invoke<string>("image", { url: src });
      // A proxy can occasionally return an HTML error page with HTTP 200.
      if (!data.startsWith("data:image/")) {
        throw new Error("The image server returned an invalid image.");
      }
      return data;
    } catch (error) {
      lastError = error;
      if (attempt === 0) await wait(350);
    }
  }
  throw lastError;
}

function requestImage(src: string) {
  const pending = requests.get(src);
  if (pending) return pending;

  const request = loadImage(src)
    .then((data) => {
      if (cache.size >= 500) {
        const oldest = cache.keys().next().value;
        if (oldest) cache.delete(oldest);
      }
      cache.set(src, data);
      return data;
    })
    .finally(() => requests.delete(src));

  requests.set(src, request);
  return request;
}

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

export function useImage(src?: string, target?: Element | null, retry = 0) {
  const [result, setResult] = useState<{ url?: string; failed: boolean }>(() => ({
    url: src ? cache.get(src) : undefined,
    failed: !src,
  }));

  useEffect(() => {
    if (!src) {
      setResult({ failed: true });
      return;
    }

    const hit = cache.get(src);
    if (hit) {
      setResult({ url: hit, failed: false });
      return;
    }

    setResult({ failed: false });
    if (!target) return;

    let live = true;
    const stopObserving = observePoster(target, () => {
      requestImage(src)
        .then((image) => {
          if (live) setResult({ url: image, failed: false });
        })
        .catch(() => {
          if (live) setResult({ failed: true });
        });
    });

    return () => {
      live = false;
      stopObserving();
    };
  }, [src, target, retry]);

  return result;
}

export function Img({ src, alt = "", className }: { src?: string; alt?: string; className?: string }) {
  const [target, setTarget] = useState<HTMLSpanElement | null>(null);
  const [decodeRetry, setDecodeRetry] = useState(0);
  const [decodeFailed, setDecodeFailed] = useState(false);
  const { url, failed } = useImage(src, target, decodeRetry);

  useEffect(() => {
    setDecodeRetry(0);
    setDecodeFailed(false);
  }, [src]);

  const handleImageError = () => {
    if (src && decodeRetry < 1) {
      cache.delete(src);
      setDecodeRetry((current) => current + 1);
      return;
    }
    setDecodeFailed(true);
  };

  if (!src || failed || decodeFailed) {
    return (
      <span className={`image-fallback${className ? ` ${className}` : ""}`} aria-hidden="true">
        <span className="image-fallback-mark">A3</span>
        <span className="image-fallback-label">ANIME3RB</span>
      </span>
    );
  }

  if (!url) {
    return (
      <span
        ref={setTarget}
        className={`image-placeholder${className ? ` ${className}` : ""}`}
        aria-hidden="true"
      />
    );
  }

  return <img className={className} src={url} alt={alt} loading="lazy" decoding="async" onError={handleImageError} />;
}
