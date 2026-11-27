import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Cue,
  Episode,
  EpisodeData,
  Progress,
  formatTime,
  loadCues,
  episode as fetchEpisode,
  progressFor,
  saveProgress,
  skips as fetchSkips,
} from "../lib/api";
import { iconPaths } from "../lib/icons";

export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const glyph = iconPaths[name];
  if (!glyph) return null;
  return (
    <svg
      viewBox={glyph.viewBox}
      width={size}
      height={size}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: glyph.body }}
    />
  );
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
  const idle = useRef<number | null>(null);
  const lastTouch = useRef<{ at: number; side: "left" | "right" } | null>(null);
  const touchGesture = useRef<{ pointerId: number; startY: number; startVolume: number; active: boolean } | null>(null);
  const pointerType = useRef("");
  const latestLocked = useRef(false);

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
  const [locked, setLocked] = useState(false);
  const [pipSupported, setPipSupported] = useState(false);
  const [theater, setTheater] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [cues, setCues] = useState<Cue[]>([]);
  const [hover, setHover] = useState<{ x: number; time: number } | null>(null);
  const [ranges, setRanges] = useState<{ start: number; end: number }[]>([]);
  const [contentEnd, setContentEnd] = useState(0);

  const current = data?.sources[source];
  latestLocked.current = locked;

  useEffect(() => {
    let live = true;
    setData(null);
    setError("");
    setSource(0);
    setCues([]);
    setRanges([]);
    setContentEnd(0);
    fetchEpisode(url)
      .then((result) => {
        if (!live) return;
        setData(result);
        const freeSources = result.sources
          .map((item, index) => ({ item, index }))
          .filter(({ item }) => !item.premium);
        const candidates = freeSources.length
          ? freeSources
          : result.sources.map((item, index) => ({ item, index }));
        const best = candidates.reduce(
          (pick, entry) => Number(entry.item.res) > Number(result.sources[pick].res) ? entry.index : pick,
          candidates[0]?.index ?? 0
        );
        setSource(best);
        loadCues(result.thumbs).then((list) => live && setCues(list));
      })
      .catch((reason) => live && setError(String(reason)));
    return () => {
      live = false;
    };
  }, [url]);

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
    const wasPlaying = !node.paused;
    const at = node.currentTime;
    node.src = current.src;
    node.load();
    if (at > 0) {
      node.currentTime = at;
      if (wasPlaying) node.play().catch(() => {});
    }
  }, [current]);

  useEffect(() => {
    const node = video.current;
    if (!node) return;
    const onMeta = () => {
      const total = node.duration || 0;
      setDuration(total);
      const resume = progressFor(url);
      if (resume > 5 && resume < total - 15) node.currentTime = resume;
    };
    const onTime = () => {
      setTime(node.currentTime);
      const total = node.duration || 0;
      if (total && Math.floor(node.currentTime) % 5 === 0) {
        save({ url, name: "", anime: "", image: "", time: node.currentTime, duration: total, at: Date.now() });
      }
    };
    const onProgress = () => setBuffered(node.buffered.length ? node.buffered.end(node.buffered.length - 1) : 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onWait = () => setBuffering(true);
    const onReady = () => setBuffering(false);
    const onEnd = () => {
      setPlaying(false);
      save({ url, name: "", anime: "", image: "", time: 0, duration: node.duration || 0, at: Date.now() });
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

  // Keep the auto-hide timer independent from React's hidden state.
  const wake = useCallback((force = false) => {
    if (latestLocked.current && !force) return;
    if (idle.current !== null) window.clearTimeout(idle.current);
    idle.current = null;
    setHidden(false);
    if (!video.current?.paused) {
      idle.current = window.setTimeout(() => {
        idle.current = null;
        if (!video.current?.paused && !latestLocked.current) setHidden(true);
      }, 2800);
    }
  }, []);

  const lockControls = () => {
    if (idle.current !== null) window.clearTimeout(idle.current);
    idle.current = null;
    latestLocked.current = true;
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
      idle.current = null;
      setHidden(false);
    }
    return () => {
      if (idle.current !== null) window.clearTimeout(idle.current);
      idle.current = null;
    };
  }, [playing, wake]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
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

  const hoverCue = useMemo(() => {
    if (!hover || !cues.length) return null;
    return cues.find((cue) => hover.time >= cue.start && hover.time < cue.end) || cues[cues.length - 1];
  }, [hover, cues]);

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

  const seekTo = (clientX: number) => {
    const node = video.current;
    const track = bar.current;
    if (!node || !track) return;
    const rect = track.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    node.currentTime = Math.min(Math.max(0, ratio), 1) * (node.duration || 0);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    pointerType.current = event.pointerType;
    wake();
    if (event.pointerType !== "touch" || locked) return;

    const target = event.target as HTMLElement;
    if (target.closest("button, input")) {
      touchGesture.current = null;
      return;
    }

    const rect = wrap.current?.getBoundingClientRect();
    if (!rect) return;
    const side = event.clientX < rect.left + rect.width / 2 ? "left" : "right";
    const now = Date.now();
    const previous = lastTouch.current;
    if (previous && now - previous.at <= 320 && previous.side === side) {
      seekBy(side === "left" ? -10 : 10);
      lastTouch.current = null;
      touchGesture.current = null;
      return;
    }

    lastTouch.current = { at: now, side };
    touchGesture.current = side === "right"
      ? { pointerId: event.pointerId, startY: event.clientY, startVolume: video.current?.volume ?? volume, active: false }
      : null;
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = touchGesture.current;
    if (event.pointerType === "touch" && gesture?.pointerId === event.pointerId && !locked) {
      const delta = gesture.startY - event.clientY;
      if (Math.abs(delta) > 8) gesture.active = true;
      if (gesture.active && wrap.current) {
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

  const handlePointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (touchGesture.current?.pointerId === event.pointerId) touchGesture.current = null;
  };

  return (
    <div
      ref={wrap}
      className={`player${playing ? " is-playing" : ""}${hidden ? " hide" : ""}${buffering ? " is-buffering" : ""}${theater ? " theater" : ""}${locked ? " is-locked" : ""}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
    >
      <video
        ref={video}
        playsInline
        poster={data?.poster}
        onClick={() => {
          if (pointerType.current !== "touch") toggle();
        }}
      />

      {error && <div className="player-error">{error}</div>}
      {!data && !error && <div className="spinner" />}
      {data && buffering && <div className="spinner" />}

      <button className="center" type="button" onClick={toggle} aria-label="Play">
        <Icon name={playing ? "pause" : "play"} size={26} />
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
          className="seek"
          dir="ltr"
          ref={bar}
          onPointerMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const ratio = Math.min(Math.max(0, (event.clientX - rect.left) / rect.width), 1);
            setHover({ x: ratio * rect.width, time: ratio * duration });
          }}
          onPointerLeave={() => setHover(null)}
          onPointerDown={(event) => {
            seekTo(event.clientX);
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
        >
          <div className="track">
            <i style={{ width: `${duration ? (time / duration) * 100 : 0}%` }} />
            <b style={{ width: `${duration ? (buffered / duration) * 100 : 0}%` }} />
          </div>
          {hover && hoverCue && (
            <div className="hover-frame" style={{ left: hover.x }} aria-hidden="true">
              <div className="crop">
                <i style={frameStyle(hoverCue, 172, 96)} />
              </div>
              <span>{formatTime(hover.time)}</span>
            </div>
          )}
          {hover && !hoverCue && (
            <div className="hover-time" style={{ left: hover.x }}>
              {formatTime(hover.time)}
            </div>
          )}
        </div>

        <div className="row" dir="ltr">
          <button className="btn" type="button" onClick={toggle} aria-label="Play">
            <Icon name={playing ? "pause" : "play"} />
          </button>
          <button className="btn" type="button" onClick={() => seekBy(-10)} aria-label="Back 10 seconds">
            <Icon name="rewind-back-10" />
          </button>
          <button className="btn" type="button" onClick={() => seekBy(10)} aria-label="Forward 10 seconds">
            <Icon name="rewind-forward-10" />
          </button>
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
            min="0"
            max="1"
            step="0.01"
            value={muted ? 0 : volume}
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
          <span className="time">
            {formatTime(time)} / {formatTime(duration)}
          </span>
          <span className="grow" />
          <button
            className="btn"
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
          <div className="settings">
            <button
              className="btn"
              type="button"
              onClick={() => setMenu(!menu)}
              aria-label="Settings"
              aria-expanded={menu}
            >
              <Icon name="settings" />
            </button>
            <div className="panel" hidden={!menu}>
              <div className="panel-label">Quality</div>
              {data?.sources.map((item, index) => (
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
                  <span>{item.label}</span>
                  {item.premium && <span className="premium-label">Premium</span>}
                  <Icon name="check" size={16} />
                </button>
              ))}
            </div>
          </div>
          <button className="btn" type="button" onClick={lockControls} aria-label="Lock controls" title="Lock controls">
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
