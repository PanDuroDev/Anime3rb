import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Cue,
  Episode,
  EpisodeData,
  Progress,
  formatTime,
  loadCues,
  thumbnailInfo,
  episode as fetchEpisode,
  progressFor,
  saveProgress,
  skips as fetchSkips,
} from "../lib/api";
import { Icon } from "./Icon";

declare global {
  interface Window {
    Anime3rbAndroid?: {
      setPlayerUiState: (fullscreen: boolean, controlsHidden: boolean) => void;
    };
  }
}

type Props = {
  url: string;
  animeName: string;
  animeImage: string;
  episode: Episode;
  next?: Episode;
  onNext: (episode: Episode) => void;
};

export default function Player({ url, animeName, animeImage, episode, next, onNext }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const settingsRoot = useRef<HTMLDivElement>(null);
  const idle = useRef<number | null>(null);
  const reveal = useRef<number | null>(null);
  const cursorIdle = useRef<number | null>(null);
  const latestHidden = useRef(false);
  const latestPillsVisible = useRef(false);
  const wakeControls = useRef<(force?: boolean, pointerActivity?: boolean) => void>(() => {});
  const lastTouch = useRef<{ at: number; side: "left" | "right" } | null>(null);
  const tapCandidate = useRef<{ pointerId: number; startX: number; startY: number; side: "left" | "right"; moved: boolean } | null>(null);
  const touchGesture = useRef<{ pointerId: number; startY: number; startVolume: number; active: boolean } | null>(null);
  const seekFeedbackTimer = useRef<number | null>(null);
  const pointerType = useRef("");
  const latestLocked = useRef(false);
  const activeEpisodeUrl = useRef(url);
  const videoEpisodeUrl = useRef("");
  const autoplayEpisodeRef = useRef(false);
  const resumeAppliedForUrl = useRef("");
  const lastProgressSavedTime = useRef(0);
  const lastUiTimeSecond = useRef(-1);
  const dataEpisodeUrl = useRef("");
  const cueLoadingFor = useRef<string | null>(null);
  const cueRetryAt = useRef(0);
  activeEpisodeUrl.current = url;

  const [data, setData] = useState<EpisodeData | null>(null);
  const [error, setError] = useState("");
  const [source, setSource] = useState(0);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [buffered, setBuffered] = useState(0);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(() => {
    try {
      const saved = localStorage.getItem("a3:volume");
      const value = saved === null ? 1 : Number(saved);
      return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
    } catch {
      return 1;
    }
  });
  const [menu, setMenu] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [cursorHidden, setCursorHidden] = useState(false);
  const [locked, setLocked] = useState(false);
  const [pipSupported, setPipSupported] = useState(false);
  const [theater, setTheater] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [seekFeedback, setSeekFeedback] = useState<"left" | "right" | null>(null);
  const [cues, setCues] = useState<Cue[]>([]);
  const [hover, setHover] = useState<{ x: number; time: number } | null>(null);
  const [ranges, setRanges] = useState<{ start: number; end: number }[]>([]);
  const [contentEnd, setContentEnd] = useState(0);

  const current = data?.sources[source];
  const ended = Boolean(video.current?.ended);
  latestLocked.current = locked;

  useEffect(() => {
    let live = true;
    setData(null);
    setError("");
    setSource(0);
    setTime(0);
    setDuration(0);
    setPlaying(false);
    setBuffering(false);
    setBuffered(0);
    videoEpisodeUrl.current = "";
    resumeAppliedForUrl.current = "";
    lastProgressSavedTime.current = 0;
    lastUiTimeSecond.current = -1;
    const videoNode = video.current;
    autoplayEpisodeRef.current = Boolean(videoNode && !videoNode.paused && !videoNode.ended);
    if (videoNode) {
      videoNode.pause();
      videoNode.removeAttribute("src");
      videoNode.load();
    }
    setCues([]);
    dataEpisodeUrl.current = "";
    cueLoadingFor.current = null;
    cueRetryAt.current = 0;
    setRanges([]);
    setContentEnd(0);
    fetchEpisode(url)
      .then((result) => {
        if (!live) return;
        dataEpisodeUrl.current = url;
        setData(result);
        const freeSources = result.sources
          .map((item, index) => ({ item, index }))
          .filter(({ item }) => !item.premium);
        const candidates = freeSources.length
          ? freeSources
          : result.sources.map((item, index) => ({ item, index }));
        const isAndroid = /Android/i.test(navigator.userAgent || "");
        const androidCandidates = isAndroid
          ? candidates.filter(({ item }) => Number(item.res) <= 720)
          : candidates;
        const pool = androidCandidates.length
          ? androidCandidates
          : isAndroid
            ? candidates.slice().sort((a, b) => Number(a.item.res) - Number(b.item.res)).slice(0, 1)
            : candidates;
        const best = pool.reduce(
          (pick, entry) => Number(entry.item.res) > Number(result.sources[pick].res) ? entry.index : pick,
          pool[0]?.index ?? 0
        );
        setSource(best);
      })
      .catch((reason) => live && setError(String(reason)));
    return () => {
      live = false;
    };
  }, [url]);

  const ensureCues = useCallback(async () => {
    const episodeUrl = url;
    const episodeData = data;
    if (
      !episodeData ||
      dataEpisodeUrl.current !== episodeUrl ||
      activeEpisodeUrl.current !== episodeUrl ||
      cueLoadingFor.current === episodeUrl ||
      cues.length > 0 ||
      Date.now() < cueRetryAt.current
    ) return;

    cueLoadingFor.current = episodeUrl;
    try {
      let thumbnailUrl = episodeData.thumbs;
      if (!thumbnailUrl && episodeData.thumbnail_page) {
        const metadata = await thumbnailInfo(episodeData.thumbnail_page);
        if (activeEpisodeUrl.current !== episodeUrl || dataEpisodeUrl.current !== episodeUrl) return;
        if (metadata.poster || metadata.thumbs) {
          setData((currentData) => currentData && dataEpisodeUrl.current === episodeUrl
            ? {
                ...currentData,
                poster: metadata.poster || currentData.poster,
                thumbs: metadata.thumbs || currentData.thumbs,
              }
            : currentData);
        }
        thumbnailUrl = metadata.thumbs;
      }

      if (thumbnailUrl) {
        const list = await loadCues(thumbnailUrl);
        if (activeEpisodeUrl.current !== episodeUrl || dataEpisodeUrl.current !== episodeUrl) return;
        if (list.length) {
          setCues(list);
          cueRetryAt.current = 0;
          return;
        }
      }
      cueRetryAt.current = Date.now() + 8000;
    } catch {
      cueRetryAt.current = Date.now() + 4000;
    } finally {
      if (cueLoadingFor.current === episodeUrl) cueLoadingFor.current = null;
    }
  }, [data, cues.length, url]);

  useEffect(() => {
    if (data && dataEpisodeUrl.current === url) void ensureCues();
  }, [data?.thumbs, data?.thumbnail_page, ensureCues, url]);

  useEffect(() => {
    if (!data) return;
    let live = true;
    fetchSkips(animeName, episode.number, duration)
      .then((result) => {
        if (!live) return;
        setRanges(result.ranges);
        setContentEnd(result.content_end);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [data, animeName, episode.number, duration]);

  const save = useCallback(
    (entry: Progress) => saveProgress({ ...entry, url, anime: animeName, image: animeImage, name: `Episode ${episode.number}` }),
    [url, animeName, animeImage, episode]
  );

  useEffect(() => {
    const node = video.current;
    if (!node || !current) return;

    const episodeChanged = videoEpisodeUrl.current !== url;
    const wasPlaying = episodeChanged ? autoplayEpisodeRef.current : !node.paused;
    const at = episodeChanged ? 0 : node.currentTime;

    if (episodeChanged) {
      node.pause();
      node.removeAttribute("src");
      node.load();
      videoEpisodeUrl.current = url;
    } else {
      node.pause();
    }

    node.src = current.src;
    node.load();

    if (!episodeChanged && at > 0) {
      const restoreQualityPosition = () => {
        node.currentTime = at;
        if (wasPlaying) node.play().catch(() => {});
      };
      node.addEventListener("loadedmetadata", restoreQualityPosition, { once: true });
    } else if (episodeChanged && wasPlaying) {
      const resumeEpisode = () => node.play().catch(() => {});
      node.addEventListener("loadedmetadata", resumeEpisode, { once: true });
    }
  }, [current, url]);

  useEffect(() => {
    const node = video.current;
    if (!node) return;
    const onMeta = () => {
      const total = Number.isFinite(node.duration) ? node.duration : 0;
      setDuration(total);
      if (resumeAppliedForUrl.current !== url) {
        const resume = progressFor(url);
        if (resume > 5 && resume < total - 15) node.currentTime = resume;
        resumeAppliedForUrl.current = url;
        lastProgressSavedTime.current = node.currentTime;
      }
    };
    const onDuration = () => {
      setDuration(Number.isFinite(node.duration) ? node.duration : 0);
    };
    const onTime = () => {
      const second = Math.floor(node.currentTime);
      if (second !== lastUiTimeSecond.current) {
        lastUiTimeSecond.current = second;
        setTime(node.currentTime);
      }
      const total = node.duration || 0;
      if (total && node.currentTime - lastProgressSavedTime.current >= 5) {
        lastProgressSavedTime.current = node.currentTime;
        save({ url, name: "", anime: "", image: "", time: node.currentTime, duration: total, at: Date.now() });
      }
    };
    const onProgress = () => setBuffered(node.buffered.length ? node.buffered.end(node.buffered.length - 1) : 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => {
      setPlaying(false);
      const total = node.duration || 0;
      if (total > 0) {
        lastProgressSavedTime.current = node.currentTime;
        save({ url, name: "", anime: "", image: "", time: node.currentTime, duration: total, at: Date.now() });
      }
    };
    const onWait = () => setBuffering(true);
    const onReady = () => setBuffering(false);
    const onEnd = () => {
      setPlaying(false);
      const total = node.duration || node.currentTime;
      save({ url, name: "", anime: "", image: "", time: total, duration: total, at: Date.now() });
    };
    const onVolume = () => {
      setVolume(node.volume);
      setMuted(node.muted);
      try {
        localStorage.setItem("a3:volume", String(node.volume));
      } catch {
        // Storage can be unavailable in restricted WebView contexts.
      }
    };
    node.addEventListener("loadedmetadata", onMeta);
    node.addEventListener("durationchange", onDuration);
    node.addEventListener("timeupdate", onTime);
    node.addEventListener("progress", onProgress);
    node.addEventListener("play", onPlay);
    node.addEventListener("pause", onPause);
    node.addEventListener("waiting", onWait);
    node.addEventListener("playing", onReady);
    node.addEventListener("canplay", onReady);
    node.addEventListener("ended", onEnd);
    node.addEventListener("volumechange", onVolume);
    return () => {
      node.removeEventListener("loadedmetadata", onMeta);
      node.removeEventListener("durationchange", onDuration);
      node.removeEventListener("timeupdate", onTime);
      node.removeEventListener("progress", onProgress);
      node.removeEventListener("play", onPlay);
      node.removeEventListener("pause", onPause);
      node.removeEventListener("waiting", onWait);
      node.removeEventListener("playing", onReady);
      node.removeEventListener("canplay", onReady);
      node.removeEventListener("ended", onEnd);
      node.removeEventListener("volumechange", onVolume);
    };
  }, [url, save]);

  const toggle = useCallback(() => {
    const node = video.current;
    if (!node) return;
    if (node.ended) {
      node.currentTime = 0;
      node.play().catch(() => {});
    } else if (node.paused) node.play().catch(() => {});
    else node.pause();
  }, []);

  const seekBy = (delta: number) => {
    const node = video.current;
    if (node) node.currentTime = Math.min(Math.max(0, node.currentTime + delta), node.duration || 0);
  };

  const syncVolume = useCallback(() => {
    const node = video.current;
    if (!node) return;
    setVolume(node.volume);
    setMuted(node.muted);
    try {
      localStorage.setItem("a3:volume", String(node.volume));
    } catch {
      // Storage can be unavailable in restricted WebView contexts.
    }
  }, []);

  useEffect(() => {
    const node = video.current;
    if (!node) return;
    node.volume = volume;
    syncVolume();
  }, []);

  useEffect(() => {
    const node = video.current;
    setPipSupported(Boolean(
      document.pictureInPictureEnabled &&
      node &&
      typeof node.requestPictureInPicture === "function"
    ));
  }, []);

  const nextAt = contentEnd > 0 && contentEnd < duration - 3 ? contentEnd : Math.max(0, duration - 20);
  const ready = duration > 30;
  const showNext = Boolean(next) && ready && (time >= nextAt || (!playing && time >= duration - 0.5));
  const skipNow = ranges.find((range) => time >= range.start && time < range.end);
  latestHidden.current = hidden;
  latestPillsVisible.current = Boolean(skipNow || showNext);

  // Match Skin: keep a visible Skip / Next pill clickable before restoring the full bar.
  const wake = useCallback((force = false, pointerActivity = true) => {
    if (latestLocked.current && !force) return;
    if (pointerActivity) {
      setCursorHidden(false);
      if (cursorIdle.current !== null) window.clearTimeout(cursorIdle.current);
      cursorIdle.current = null;
      if (!video.current?.paused) {
        cursorIdle.current = window.setTimeout(() => {
          cursorIdle.current = null;
          if (!video.current?.paused && !latestLocked.current) setCursorHidden(true);
        }, 2500);
      }
    }
    if (!force && latestHidden.current && latestPillsVisible.current) {
      if (reveal.current === null) {
        reveal.current = window.setTimeout(() => {
          reveal.current = null;
          wakeControls.current(true, false);
        }, 1500);
      }
      return;
    }
    if (reveal.current !== null) {
      window.clearTimeout(reveal.current);
      reveal.current = null;
    }
    if (idle.current !== null) window.clearTimeout(idle.current);
    idle.current = null;
    setHidden(false);
    if (!video.current?.paused) {
      idle.current = window.setTimeout(() => {
        idle.current = null;
        if (!video.current?.paused && !latestLocked.current) setHidden(true);
      }, 2500);
    }
  }, []);
  wakeControls.current = wake;

  const lockControls = () => {
    if (idle.current !== null) window.clearTimeout(idle.current);
    if (reveal.current !== null) window.clearTimeout(reveal.current);
    if (cursorIdle.current !== null) window.clearTimeout(cursorIdle.current);
    idle.current = null;
    reveal.current = null;
    cursorIdle.current = null;
    latestLocked.current = true;
    setCursorHidden(false);
    setLocked(true);
    setHidden(true);
    setMenu(false);
  };

  const unlockControls = () => {
    latestLocked.current = false;
    setLocked(false);
    wake(true);
  };

  useEffect(() => {
    if (playing) {
      wake();
    } else {
      if (idle.current !== null) window.clearTimeout(idle.current);
      if (reveal.current !== null) window.clearTimeout(reveal.current);
      if (cursorIdle.current !== null) window.clearTimeout(cursorIdle.current);
      idle.current = null;
      reveal.current = null;
      cursorIdle.current = null;
      setHidden(false);
      setCursorHidden(false);
    }
    return () => {
      if (idle.current !== null) window.clearTimeout(idle.current);
      if (reveal.current !== null) window.clearTimeout(reveal.current);
      if (cursorIdle.current !== null) window.clearTimeout(cursorIdle.current);
      idle.current = null;
      reveal.current = null;
      cursorIdle.current = null;
    };
  }, [playing, wake]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (latestLocked.current) return;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key === " " || event.key === "k") {
        event.preventDefault();
        toggle();
      } else if (event.key === "ArrowLeft") seekBy(-5);
      else if (event.key === "ArrowRight") seekBy(5);
      else if (event.key === "f") {
        if (document.fullscreenElement) document.exitFullscreen();
        else wrap.current?.requestFullscreen().catch(() => {});
      } else if (event.key === "m") {
        if (video.current) video.current.muted = !video.current.muted;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    const onFull = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFull);
    return () => document.removeEventListener("fullscreenchange", onFull);
  }, []);

  // Keep Android's native orientation and status bar in sync with player state.
  // The bridge is only injected by the Android app; browser and desktop builds ignore it.
  useEffect(() => {
    window.Anime3rbAndroid?.setPlayerUiState(fullscreen, fullscreen && hidden);
  }, [fullscreen, hidden]);

  useEffect(() => () => {
    window.Anime3rbAndroid?.setPlayerUiState(false, false);
  }, []);

  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !settingsRoot.current?.contains(event.target)) {
        setMenu(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menu]);

  const hoverCue = useMemo(() => {
    if (!hover || !cues.length) return null;
    return cues.find((cue) => hover.time >= cue.start && hover.time < cue.end) || null;
  }, [hover, cues]);

  const seekWidth = bar.current?.clientWidth ?? 0;
  const playedPercent = duration > 0 ? (time / duration) * 100 : 0;
  const bufferedPercent = duration > 0 && buffered > 0
    ? (buffered / duration) * 100
    : playedPercent;
  const hoverHalfWidth = Math.min((hoverCue?.w ?? 40) / 2, seekWidth / 2);
  const hoverLeft = hover && seekWidth
    ? Math.min(Math.max(hover.x, hoverHalfWidth), seekWidth - hoverHalfWidth)
    : hover?.x ?? 0;
  const nowLeft = seekWidth
    ? Math.min(Math.max((duration ? time / duration : 0) * seekWidth, 20), seekWidth - 20)
    : 0;

  const nextCue = useMemo(() => {
    if (!cues.length || !ready) return null;
    const at = Math.min(duration - 1, nextAt + 3);
    return cues.find((cue) => at >= cue.start && at < cue.end) || cues[cues.length - 1];
  }, [cues, ready, duration, nextAt]);

  const frameStyle = (cue: Cue, width: number, height: number) => {
    const scale = Math.max(width / cue.w, height / cue.h);
    return {
      width: `${cue.w}px`,
      height: `${cue.h}px`,
      backgroundImage: `url("${cue.file}")`,
      backgroundPosition: `-${cue.x}px -${cue.y}px`,
      transform: `translate(${(width - cue.w * scale) / 2}px, ${(height - cue.h * scale) / 2}px) scale(${scale})`,
    } as const;
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (latestLocked.current) return;
    pointerType.current = event.pointerType;
    // Touch users should get the full control bar immediately; the 1.5s
    // deferred reveal is only useful for hover-based desktop interaction.
    wake(event.pointerType === "touch");
    if (event.pointerType !== "touch") return;

    const target = event.target as HTMLElement;
    // Real controls should keep their native button/range behavior and must not
    // count as one half of a video-surface double tap.
    if (target.closest("button, input, .seek, .panel")) {
      tapCandidate.current = null;
      lastTouch.current = null;
      touchGesture.current = null;
      return;
    }

    const rect = wrap.current?.getBoundingClientRect();
    if (!rect) return;
    const side = event.clientX < rect.left + rect.width / 2 ? "left" : "right";
    tapCandidate.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      side,
      moved: false,
    };
    touchGesture.current = side === "right"
      ? { pointerId: event.pointerId, startY: event.clientY, startVolume: video.current?.volume ?? volume, active: false }
      : null;
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (latestLocked.current) return;

    const tap = tapCandidate.current;
    if (tap?.pointerId === event.pointerId &&
        Math.hypot(event.clientX - tap.startX, event.clientY - tap.startY) > 8) {
      tap.moved = true;
    }

    const gesture = touchGesture.current;
    if (event.pointerType === "touch" && gesture?.pointerId === event.pointerId && !locked) {
      const delta = gesture.startY - event.clientY;
      if (Math.abs(delta) > 8) gesture.active = true;
      if (gesture.active && wrap.current) {
        lastTouch.current = null;
        const node = video.current;
        if (node) {
          node.volume = Math.min(1, Math.max(0, gesture.startVolume + delta / wrap.current.clientHeight));
          node.muted = node.volume === 0;
          syncVolume();
        }
        return;
      }
    }
    wake();
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = touchGesture.current;
    if (gesture?.pointerId === event.pointerId) touchGesture.current = null;

    const tap = tapCandidate.current;
    if (!tap || tap.pointerId !== event.pointerId) return;
    tapCandidate.current = null;

    if (tap.moved || latestLocked.current) {
      lastTouch.current = null;
      return;
    }

    const now = Date.now();
    const previous = lastTouch.current;
    if (previous && now - previous.at <= 450 && previous.side === tap.side) {
      seekBy(tap.side === "left" ? -10 : 10);
      setSeekFeedback(tap.side);
      if (seekFeedbackTimer.current !== null) window.clearTimeout(seekFeedbackTimer.current);
      seekFeedbackTimer.current = window.setTimeout(() => {
        seekFeedbackTimer.current = null;
        setSeekFeedback(null);
      }, 650);
      lastTouch.current = null;
    } else {
      lastTouch.current = { at: now, side: tap.side };
    }
  };

  const handlePointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    if (touchGesture.current?.pointerId === event.pointerId) touchGesture.current = null;
    if (tapCandidate.current?.pointerId === event.pointerId) tapCandidate.current = null;
    lastTouch.current = null;
  };

  useEffect(() => () => {
    if (seekFeedbackTimer.current !== null) window.clearTimeout(seekFeedbackTimer.current);
  }, []);

  // Do not force focus onto the entire player after a touch.
  // The window-level keyboard handler already supports player shortcuts,
  // and focusing this large container triggers Android WebView focus feedback.

  return (
    <div
      ref={wrap}
      className={`player${playing ? " is-playing" : ""}${hidden ? " hide" : ""}${cursorHidden ? " cursor-hidden" : ""}${buffering ? " is-buffering" : ""}${theater ? " theater" : ""}${menu ? " has-open-menu" : ""}${locked ? " is-locked" : ""}`}
      tabIndex={-1}
      onFocusCapture={() => wake()}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    >
      <video
        ref={video}
        playsInline
        poster={data?.poster}
        onClick={() => {
          if (!latestLocked.current && pointerType.current !== "touch") toggle();
        }}
      />

      {error && <div className="player-error">{error}</div>}
      {!data && !error && <div className="spinner is-visible" />}
      {data && buffering && <div className="spinner" />}
      {seekFeedback && (
        <div
          className={`seek-feedback is-${seekFeedback}`}
          role="status"
          aria-label={seekFeedback === "left" ? "Back 10 seconds" : "Forward 10 seconds"}
        >
          <Icon name={seekFeedback === "left" ? "rewind-back-10" : "rewind-forward-10"} size={30} />
          <span>{seekFeedback === "left" ? "−10s" : "+10s"}</span>
        </div>
      )}

      <button
        className="center"
        type="button"
        onClick={toggle}
        aria-label={ended ? "Replay" : playing ? "Pause" : "Play"}
      >
        <Icon name={playing ? "pause" : ended ? "refresh" : "play"} size={26} />
      </button>

      <div className="controls" data-bar>
        <div className="pills" dir="ltr">
          <button
            className="pill skip"
            type="button"
            hidden={!skipNow}
            onClick={() => {
              if (skipNow && video.current) video.current.currentTime = skipNow.end;
            }}
          >
            <Icon name="skip-next" size={18} />
            <span>Skip</span>
          </button>
          <button className="pill next" type="button" hidden={!showNext} onClick={() => next && onNext(next)} title={next?.name}>
            {nextCue && (
              <span className="thumb">
                <i style={frameStyle(nextCue, 112, 30)} />
              </span>
            )}
            <Icon name="skip-next" size={18} />
            <span>Next {next?.number}</span>
          </button>
        </div>

        <div
          className="seek-wrap"
          dir="ltr"
          ref={bar}
          onPointerMove={(event) => {
            if (!cues.length) void ensureCues();
            const rect = event.currentTarget.getBoundingClientRect();
            if (!rect.width) return;
            const ratio = Math.min(Math.max(0, (event.clientX - rect.left) / rect.width), 1);
            setHover({ x: ratio * rect.width, time: ratio * duration });
          }}
          onPointerLeave={() => setHover(null)}
        >
          <input
            className="seek"
            type="range"
            dir="ltr"
            min="0"
            max={duration || 0}
            step="0.1"
            value={Math.min(time, duration || 0)}
            aria-label="Seek"
            aria-valuetext={formatTime(time) + " of " + formatTime(duration)}
            onChange={(event) => {
              const node = video.current;
              const targetTime = Number(event.currentTarget.value);
              if (!node || latestLocked.current || !Number.isFinite(targetTime)) return;
              node.currentTime = targetTime;
              setTime(targetTime);
            }}
          />
          <div className="chapters" aria-hidden="true">
            <i
              style={{
                background:
                  "linear-gradient(to right, #2563eb 0 " + playedPercent + "%, " +
                  "rgba(255, 255, 255, .4) " + playedPercent + "% " + bufferedPercent + "%, " +
                  "rgba(255, 255, 255, .18) " + bufferedPercent + "% 100%)",
              }}
            />
          </div>
          {hover && hoverCue && (
            <div className="hover-frame" style={{ left: hoverLeft }} aria-hidden="true">
              <div className="crop" style={{ width: hoverCue.w, height: hoverCue.h }}>
                <i style={frameStyle(hoverCue, hoverCue.w, hoverCue.h)} />
                <span className="preview-time">{formatTime(hover.time)}</span>
              </div>
            </div>
          )}
          {hover && (
            <div className="now-chip" style={{ left: nowLeft }} aria-hidden="true">
              {formatTime(time)}
            </div>
          )}
        </div>

        <div className="row" dir="ltr">
          <button
            className="btn"
            type="button"
            onClick={toggle}
            aria-label={ended ? "Replay" : playing ? "Pause" : "Play"}
          >
            <Icon name={playing ? "pause" : ended ? "refresh" : "play"} />
          </button>
          <button className="btn" type="button" onClick={() => seekBy(-10)} aria-label="Back 10 seconds">
            <Icon name="rewind-back-10" />
          </button>
          <button className="btn" type="button" onClick={() => seekBy(10)} aria-label="Forward 10 seconds">
            <Icon name="rewind-forward-10" />
          </button>
          <div className="volume-wrap">
            <button
              className="btn"
              type="button"
              onClick={() => {
                const node = video.current;
                if (!node) return;
                node.muted = !node.muted;
                syncVolume();
              }}
              aria-label="Mute"
              aria-pressed={muted}
            >
              <Icon name={muted || volume === 0 ? "volume-mute" : "volume"} />
            </button>
            <input
              className="volume"
              type="range"
              dir="ltr"
              min="0"
              max="1"
              step="0.01"
              value={muted ? 0 : volume}
              style={{ "--volume-progress": `${(muted ? 0 : volume) * 100}%` } as React.CSSProperties}
              aria-label="Volume"
              title={`Volume ${Math.round(volume * 100)}%`}
              onChange={(event) => {
                const node = video.current;
                if (!node) return;
                node.volume = Number(event.currentTarget.value);
                node.muted = node.volume === 0;
                syncVolume();
              }}
            />
          </div>
          <span className="time">
            {formatTime(time)} / {formatTime(duration)}
          </span>
          <span className="grow" />
          <button
            className="btn theater-toggle"
            type="button"
            onClick={() => setTheater(!theater)}
            aria-label="Theater mode"
            aria-pressed={theater}
          >
            <Icon name="cinema" />
          </button>
          <button
            className="btn"
            type="button"
            disabled={!pipSupported}
            title={pipSupported ? "Picture in picture" : "Picture-in-picture is unavailable"}
            onClick={async () => {
              const node = video.current;
              if (!node || !pipSupported) return;
              try {
                if (document.pictureInPictureElement) await document.exitPictureInPicture();
                else await node.requestPictureInPicture();
              } catch {
                setMenu(false);
              }
            }}
            aria-label="Picture in picture"
          >
            <Icon name="pip" />
          </button>
          <div className="settings" ref={settingsRoot}>
            <button
              className="btn"
              type="button"
              onClick={() => setMenu(!menu)}
              aria-label="Settings"
              aria-haspopup="dialog"
              aria-expanded={menu}
            >
              <Icon name="settings" />
            </button>
            <div className="panel" role="dialog" aria-label="Player settings" hidden={!menu}>
              <div className="panel-label">Quality</div>
              {data?.sources.length ? data.sources.map((item, index) => (
                <button
                  key={item.src}
                  className={`option${index === source ? " is-selected" : ""}${item.premium ? " is-premium" : ""}`}
                  type="button"
                  onClick={() => {
                    const node = video.current;
                    if (node) {
                      const at = node.currentTime;
                      const paused = node.paused;
                      setSource(index);
                      requestAnimationFrame(() => {
                        if (!video.current) return;
                        video.current.currentTime = at;
                        if (!paused) video.current.play().catch(() => {});
                      });
                    }
                    setMenu(false);
                  }}
                >
                  <span>{item.premium && !/premium/i.test(item.label) ? `${item.label} Premium` : item.label}</span>
                  <Icon name="check" size={16} />
                </button>
              )) : <span className="panel-empty">No quality sources available</span>}
            </div>
          </div>
          <button className="btn" type="button" onClick={lockControls} aria-label="Lock controls" aria-pressed={locked} title="Lock controls">
            <Icon name="lock" />
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => {
              if (document.fullscreenElement) document.exitFullscreen();
              else wrap.current?.requestFullscreen().catch(() => {});
            }}
            aria-label="Fullscreen"
          >
            <Icon name={fullscreen ? "fullscreen-exit" : "fullscreen"} />
          </button>
        </div>
      </div>
      {locked && (
        <button className="unlock" type="button" onClick={unlockControls} aria-label="Unlock controls" title="Unlock controls">
          <Icon name="unlock" size={20} />
          <span>Unlock</span>
        </button>
      )}
    </div>
  );
}
