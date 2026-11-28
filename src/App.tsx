import { useEffect, useMemo, useRef, useState } from "react";
import Player from "./components/Player";
import UpdateBanner from "./components/UpdateBanner";
import { Icon } from "./components/Icon";
import { Img } from "./components/Img";
import {
  Anime,
  Card,
  Episode,
  episodeCatalogThumbnail,
  fillerClassifications as fetchFillerClassifications,
  Home,
  Progress,
  anime as fetchAnime,
  browse,
  home as fetchHome,
  readProgress,
  removeProgress,
  search as searchTitles,
} from "./lib/api";

type View =
  | { kind: "home" }
  | { kind: "search"; query: string }
  | { kind: "browse"; page: number }
  | { kind: "anime"; url: string }
  | { kind: "watch"; url: string; number: number };

const animeUrlFor = (episodeUrl: string) => episodeUrl.replace("/episode/", "/titles/").replace(/\/[^/]+$/, "");
const episodeNumber = (url: string) => Number(url.split("/").pop() || 0);
const normalizeEpisodeNumberQuery = (query: string) =>
  query
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .trim();

/** "الحلقة 1071 - قمة لوفي" reads better as just "قمة لوفي" next to the episode label. */
const episodeTitle = (name: string, number: number) =>
  name.replace(new RegExp(`^الحلقة\\s*${number}\\s*[-–—:]?\\s*`), "").trim();

const EPISODES_PER_PAGE = 24;

const FILLER_LABELS: Record<import("./lib/api").FillerStatus, string> = {
  filler: "Filler",
  mixed: "Mixed",
  "anime-canon": "Anime Canon",
  canon: "Manga Canon",
  disputed: "Disputed",
};

export default function App() {
  const [view, setView] = useState<View>({ kind: "home" });
  const [query, setQuery] = useState("");

  const go = (next: View) => {
    setView(next);
    window.scrollTo({ top: 0 });
  };

  // Home rails mix episodes and titles: an episode card goes straight to the watch page.
  const openCard = (url: string) => {
    if (url.includes("/episode/")) go({ kind: "watch", url: animeUrlFor(url), number: episodeNumber(url) });
    else go({ kind: "anime", url });
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const text = query.trim();
    if (text) go({ kind: "search", query: text });
  };

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" type="button" onClick={() => go({ kind: "home" })}>
          <span className="brand-dot"><Icon name="play" size={15} /></span> Anime<b>3rb</b>
        </button>
        <form className="searchbox" onSubmit={submit}>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search anime…"
            aria-label="Search"
          />
          <button type="submit" aria-label="Search">
            <Icon name="arrowRight" size={18} />
          </button>
        </form>
        <nav className="topnav">
          <button
            className={`nav-link${view.kind === "home" ? " is-active" : ""}`}
            aria-current={view.kind === "home" ? "page" : undefined}
            type="button"
            onClick={() => go({ kind: "home" })}
          >
            Home
          </button>
          <button
            className={`nav-link${view.kind === "browse" ? " is-active" : ""}`}
            aria-current={view.kind === "browse" ? "page" : undefined}
            type="button"
            onClick={() => go({ kind: "browse", page: 1 })}
          >
            Browse
          </button>
        </nav>
      </header>

      <main>
        {view.kind === "home" && (
          <HomeView open={openCard} resume={(url, play) => go({ kind: "watch", url, number: play })} />
        )}
        {view.kind === "search" && <SearchView query={view.query} open={openCard} />}
        {view.kind === "browse" && (
          <BrowseView page={view.page} open={openCard} onPage={(page) => go({ kind: "browse", page })} />
        )}
        {view.kind === "anime" && (
          <AnimeView url={view.url} play={(number) => go({ kind: "watch", url: view.url, number })} />
        )}
        {view.kind === "watch" && (
          <WatchView
            url={view.url}
            number={view.number}
            open={(number) => go({ kind: "watch", url: view.url, number })}
            back={() => go({ kind: "anime", url: view.url })}
          />
        )}
      </main>
      <footer className="source-credits">
        Episode artwork: <a href="https://kitsu.io" target="_blank" rel="noreferrer">Kitsu</a>
        {" · "}
        <a href="https://api.ani.zip" target="_blank" rel="noreferrer">AniZip</a>
        {" · "}
        <a href="https://nogitsu.com" target="_blank" rel="noreferrer">Nogitsu</a>
        {" · "}
        <a href="https://anifillerpedia.wiki/docs/guide" target="_blank" rel="noreferrer">AniFillerPedia</a>
        {" · "}
        <a href="https://fillerlists.com/data" target="_blank" rel="noreferrer">FillerLists</a>
      </footer>
      <UpdateBanner />
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="empty-state state-error" role="alert">
      <h2>Unable to load this content</h2>
      <p>{message}</p>
    </div>
  );
}

function AnimeSkeleton() {
  return (
    <div className="anime-page" role="status" aria-label="Loading anime details">
      <section className="anime-head">
        <span className="skeleton-detail-poster" />
        <div className="anime-info">
          <span className="skeleton-heading wide" />
          <span className="skeleton-meta" />
          <span className="skeleton-copy" />
          <span className="skeleton-action" />
        </div>
      </section>
      <section className="episodes">
        <div className="section-head"><span className="skeleton-heading" /></div>
        <div className="ep-grid">
          {Array.from({ length: 8 }, (_, index) => <div className="episode-grid-skeleton" key={index} />)}
        </div>
      </section>
    </div>
  );
}

function WatchSkeleton() {
  return (
    <div className="watch-page" role="status" aria-label="Loading episode">
      <div className="watch-bar"><span className="skeleton-line watch-back-skeleton" /><span className="skeleton-heading" /></div>
      <div className="watch-layout">
        <div className="watch-player-skeleton" />
        <aside className="watch-side">
          <div className="section-head"><span className="skeleton-heading" /></div>
          <div className="side-list">
            {Array.from({ length: 7 }, (_, index) => <div className="episode-skeleton" key={index}><i /><span /></div>)}
          </div>
        </aside>
      </div>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="card-skeleton" aria-hidden="true">
      <span className="skeleton-poster" />
      <span className="skeleton-line" />
    </div>
  );
}

function CardSkeletonGrid({ count }: { count: number }) {
  return (
    <div className="grid skeleton-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => <SkeletonCard key={index} />)}
    </div>
  );
}

function HomeSkeleton() {
  return (
    <div className="home-skeleton" role="status" aria-label="Loading home page">
      {[0, 1, 2].map((row) => (
        <section className="rail" key={row} aria-hidden="true">
          <div className="section-head"><span className="skeleton-heading" /></div>
          <div className="skeleton-row">{Array.from({ length: 7 }, (_, index) => <SkeletonCard key={index} />)}</div>
        </section>
      ))}
    </div>
  );
}

function CardGrid({ items, open }: { items: Card[]; open: (url: string) => void }) {
  return (
    <div className="grid">
      {items.map((item) => (
        <button className="card" key={item.url} type="button" onClick={() => open(item.url)}>
          <span className="poster">
            <Img src={item.image} />
            {item.episode ? <span className="badge">EP {item.episode}</span> : null}
          </span>
          <span className="card-name" title={item.name}>
            {item.name}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Horizontal shelf with arrow buttons and a hidden scrollbar. */
function Rail({
  title,
  items,
  open,
  progress,
  onRemove,
}: {
  title: string;
  items: Card[];
  open: (item: Card) => void;
  progress?: Map<string, Progress>;
  onRemove?: (item: Card) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });

  const measure = () => {
    const box = scroller.current;
    if (!box) return;
    setEdges({
      start: box.scrollLeft <= 4,
      end: box.scrollLeft + box.clientWidth >= box.scrollWidth - 4,
    });
  };

  useEffect(() => {
    const box = scroller.current;
    if (!box) return;

    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(box);
    window.addEventListener("resize", measure);

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [items]);

  const page = (direction: number) => {
    const box = scroller.current;
    if (!box) return;
    box.scrollBy({ left: direction * box.clientWidth * 0.9, behavior: "smooth" });
  };

  return (
    <section className="rail">
      <div className="section-head">
        <h2>{title}</h2>
      </div>
      <div className="rail-wrap">
        <button
          className="rail-arrow start"
          type="button"
          aria-label="Scroll left"
          disabled={edges.start}
          onClick={() => page(-1)}
        >
          <Icon name="arrowRight" size={18} />
        </button>
        <div className="rail-scroll" ref={scroller} onScroll={measure}>
          {items.map((item) => {
            const seen = progress?.get(item.url);
            const percent = seen && seen.duration ? Math.min(100, (seen.time / seen.duration) * 100) : 0;
            return (
              <div className="rail-item" key={item.url}>
                <button className="rail-card" type="button" onClick={() => open(item)}>
                  <span className="poster">
                    <Img src={item.image} />
                    {item.episode ? <span className="badge">EP {item.episode}</span> : null}
                    {percent > 0 && (
                      <span className="pbar">
                        <i style={{ width: `${percent}%` }} />
                      </span>
                    )}
                  </span>
                  <span className="card-name" title={item.name}>
                    {item.name}
                  </span>
                </button>
                {onRemove && (
                  <button
                    className="rail-remove"
                    type="button"
                    aria-label={`Remove ${item.name} from Continue watching`}
                    title="Remove from Continue watching"
                    onClick={() => onRemove(item)}
                  >
                    <Icon name="delete" size={18} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <button
          className="rail-arrow end"
          type="button"
          aria-label="Scroll right"
          disabled={edges.end}
          onClick={() => page(1)}
        >
          <Icon name="arrowRight" size={18} />
        </button>
      </div>
    </section>
  );
}

function HomeView({ open, resume }: { open: (url: string) => void; resume: (url: string, play: number) => void }) {
  const [data, setData] = useState<Home | null>(null);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<Progress[]>(() =>
    readProgress().filter((item) => item.time > 5 && !(item.duration > 0 && item.time / item.duration >= 0.92))
  );
  const seen = useMemo(() => new Map(history.map((item) => [item.url, item])), [history]);
  const removeFromHistory = (item: Card) => {
    removeProgress(item.url);
    setHistory((current) => current.filter((entry) => entry.url !== item.url));
  };
  const watching = useMemo<Card[]>(
    () =>
      history.map((item) => ({
        name: item.anime,
        url: item.url,
        image: item.image,
        episode: episodeNumber(item.url),
      })),
    [history]
  );

  useEffect(() => {
    fetchHome()
      .then(setData)
      .catch((reason) => setError(String(reason)));
  }, []);

  if (error) return <ErrorState message={error} />;
  if (!data) return <HomeSkeleton />;

  return (
    <>
      {watching.length > 0 && (
        <Rail
          title="Continue watching"
          items={watching}
          progress={seen}
          open={(item) => resume(animeUrlFor(item.url), episodeNumber(item.url))}
          onRemove={removeFromHistory}
        />
      )}
      {data.rails.map((rail) => (
        <Rail key={rail.title} title={rail.title} items={rail.items} open={(item) => open(item.url)} />
      ))}
    </>
  );
}

function SearchView({ query, open }: { query: string; open: (url: string) => void }) {
  const [items, setItems] = useState<Card[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setItems(null);
    searchTitles(query)
      .then(setItems)
      .catch((reason) => setError(String(reason)));
  }, [query]);

  if (error) return <ErrorState message={error} />;
  if (!items) return <section className="results"><div className="section-head"><h2>Results for “{query}”</h2></div><CardSkeletonGrid count={10} /></section>;
  if (!items.length) return <div className="empty-state"><h2>No results found</h2><p>Try another title or check the spelling.</p></div>;

  return (
    <section className="results">
      <div className="section-head">
        <h2>Results for “{query}”</h2>
        <span className="count">{items.length}</span>
      </div>
      <CardGrid items={items} open={open} />
    </section>
  );
}

function BrowseView({
  page,
  open,
  onPage,
}: {
  page: number;
  open: (url: string) => void;
  onPage: (page: number) => void;
}) {
  const [items, setItems] = useState<Card[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setItems(null);
    browse(page)
      .then(setItems)
      .catch((reason) => setError(String(reason)));
  }, [page]);

  if (error) return <ErrorState message={error} />;

  return (
    <section className="results">
      <div className="section-head">
        <h2>All anime</h2>
        <span className="count">Page {page}</span>
      </div>
      {!items ? (
        <CardSkeletonGrid count={12} />
      ) : items.length ? (
        <CardGrid items={items} open={open} />
      ) : (
        <div className="empty-state compact"><h2>No more titles</h2><p>There are no additional results on this page.</p></div>
      )}
      <div className="pager">
        <button className="ghost" type="button" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </button>
        <button className="ghost" type="button" disabled={!items?.length} onClick={() => onPage(page + 1)}>
          Next
        </button>
      </div>
    </section>
  );
}

function AnimeView({ url, play }: { url: string; play: (number: number) => void }) {
  const [data, setData] = useState<Anime | null>(null);
  const [error, setError] = useState("");
  const [episodeQuery, setEpisodeQuery] = useState("");
  const [episodePage, setEpisodePage] = useState(1);

  useEffect(() => {
    let live = true;
    setData(null);
    setError("");
    setEpisodeQuery("");
    setEpisodePage(1);
    fetchAnime(url)
      .then((result) => {
        if (!live) return;
        setData(result);
        // Classification is fetched separately so provider latency never blocks the page.
        fetchFillerClassifications(url, result.name)
          .then((classifications) => {
            if (!live) return;
            setData((current) => current && current.url === url
              ? {
                  ...current,
                  episodes: current.episodes.map((item) => ({
                    ...item,
                    filler: classifications[item.number],
                  })),
                }
              : current);
          })
          .catch(() => {});
      })
      .catch((reason) => live && setError(String(reason)));
    return () => {
      live = false;
    };
  }, [url]);

  const seen = useMemo(() => new Map(readProgress().map((item) => [item.url, item])), [data]);
  const normalizedQuery = episodeQuery.trim().toLocaleLowerCase();
  const filteredEpisodes = useMemo(() => {
    const episodes = data?.episodes ?? [];
    return normalizedQuery
      ? episodes.filter((item) =>
          `${item.number} episode ${item.number} الحلقة ${item.number} ${item.name}`
            .toLocaleLowerCase()
            .includes(normalizedQuery)
        )
      : episodes;
  }, [data, normalizedQuery]);
  const pageCount = Math.max(1, Math.ceil(filteredEpisodes.length / EPISODES_PER_PAGE));
  const activePage = Math.min(episodePage, pageCount);
  const startIndex = (activePage - 1) * EPISODES_PER_PAGE;
  const visibleEpisodes = useMemo(
    () => filteredEpisodes.slice(startIndex, startIndex + EPISODES_PER_PAGE),
    [filteredEpisodes, startIndex]
  );
  const firstVisible = filteredEpisodes.length ? startIndex + 1 : 0;
  const lastVisible = Math.min(startIndex + EPISODES_PER_PAGE, filteredEpisodes.length);

  if (!data || data.url !== url) {
    return error ? <ErrorState message={error} /> : <AnimeSkeleton />;
  }

  const first = data.episodes[0]?.number ?? 1;

  return (
    <div className="anime-page">
      <section className="anime-head">
        <Img className="poster-lg" src={data.image} />
        <div className="anime-info">
          <h1>{data.name}</h1>
          <div className="meta">
            <span>{data.episodes.length} episodes</span>
            {data.genres.map((genre) => (
              <span className="genre" key={genre}>
                {genre}
              </span>
            ))}
          </div>
          <p className="desc">{data.description}</p>
          <div className="anime-actions">
            <button className="primary" type="button" onClick={() => play(first)} disabled={!data.episodes.length}>
              <Icon name="play" size={18} />
              Play episode {first}
            </button>
          </div>
        </div>
      </section>

      <section className="episodes">
        <div className="episodes-toolbar">
          <div className="section-head">
            <h2>Episodes</h2>
            <span className="count">{data.episodes.length}</span>
          </div>
          <label className="episode-search">
            <input
              type="search"
              value={episodeQuery}
              onChange={(event) => {
                setEpisodeQuery(event.currentTarget.value);
                setEpisodePage(1);
              }}
              placeholder="Search by episode number or title…"
              aria-label="Search episodes by number or title"
            />
          </label>
        </div>

        {visibleEpisodes.length ? (
          <div className="ep-grid">
            {visibleEpisodes.map((item) => (
              <EpisodeCard
                key={item.number}
                animeUrl={url}
                animeName={data.name}
                fallbackImage={data.image}
                item={item}
                current={false}
                progress={seen.get(item.url)}
                onPlay={play}
                layout="grid"
              />
            ))}
          </div>
        ) : (
          <div className="empty-state compact">
            <h2>No episodes found</h2>
            <p>Try another episode number or title.</p>
          </div>
        )}

        {filteredEpisodes.length > EPISODES_PER_PAGE && (
          <nav className="episode-pagination" aria-label="Episode pages">
            <button
              className="ghost episode-page-arrow is-previous"
              type="button"
              aria-label="Previous episodes"
              disabled={activePage <= 1}
              onClick={() => setEpisodePage((page) => Math.max(1, page - 1))}
            >
              <Icon name="arrowRight" size={18} />
            </button>
            <span aria-live="polite">
              Showing {firstVisible}–{lastVisible} of {filteredEpisodes.length} episodes
              <span className="episode-page-number"> · Page {activePage} of {pageCount}</span>
            </span>
            <button
              className="ghost episode-page-arrow"
              type="button"
              aria-label="Next episodes"
              disabled={activePage >= pageCount}
              onClick={() => setEpisodePage((page) => Math.min(pageCount, page + 1))}
            >
              <Icon name="arrowRight" size={18} />
            </button>
          </nav>
        )}
      </section>
    </div>
  );
}

function WatchView({
  url,
  number,
  open,
  back,
}: {
  url: string;
  number: number;
  open: (number: number) => void;
  back: () => void;
}) {
  const [data, setData] = useState<Anime | null>(null);
  const [error, setError] = useState("");
  const [side, setSide] = useState<HTMLDivElement | null>(null);
  const [episodeQuery, setEpisodeQuery] = useState("");

  const filteredEpisodes = useMemo(() => {
    const query = normalizeEpisodeNumberQuery(episodeQuery);
    if (!query) return data?.episodes ?? [];
    if (!/^\d+$/.test(query)) return [];
    return (data?.episodes ?? []).filter((item) => String(item.number).includes(query));
  }, [data, episodeQuery]);

  useEffect(() => {
    let live = true;
    setData(null);
    setError("");
    setEpisodeQuery("");
    fetchAnime(url)
      .then((result) => {
        if (!live) return;
        setData(result);
        // Classification is fetched separately so provider latency never blocks the page.
        fetchFillerClassifications(url, result.name)
          .then((classifications) => {
            if (!live) return;
            setData((current) => current && current.url === url
              ? {
                  ...current,
                  episodes: current.episodes.map((item) => ({
                    ...item,
                    filler: classifications[item.number],
                  })),
                }
              : current);
          })
          .catch(() => {});
      })
      .catch((reason) => live && setError(String(reason)));
    return () => {
      live = false;
    };
  }, [url]);

  // Keep the active episode visible in the sidebar without scrolling the page.
  useEffect(() => {
    if (!side) return;
    const card = side.querySelector<HTMLElement>(".is-current");
    side.scrollTop = card
      ? card.offsetTop - side.clientHeight / 2 + card.clientHeight / 2
      : 0;
  }, [number, data, side, filteredEpisodes]);

  const seen = useMemo(() => new Map(readProgress().map((item) => [item.url, item])), [data, number]);

  if (error) return <ErrorState message={error} />;
  if (!data) return <WatchSkeleton />;

  const index = data.episodes.findIndex((item) => item.number === number);
  const current = data.episodes[index];
  if (!current) return <p className="notice">Episode not found.</p>;

  const previous = data.episodes[index - 1];
  const next = data.episodes[index + 1];

  return (
    <div className="watch-page">
      <div className="watch-bar">
        <button className="ghost back" type="button" onClick={back} title={data.name}>
          <Icon name="arrowRight" size={16} /> {data.name}
        </button>
        <div className="watch-title">
          <h1>Episode {current.number}</h1>
          <span>{episodeTitle(current.name, current.number)}</span>
        </div>
        <div className="watch-nav">
          <button className="ghost" type="button" disabled={!previous} onClick={() => previous && open(previous.number)}>
            Previous
          </button>
          <button className="ghost" type="button" disabled={!next} onClick={() => next && open(next.number)}>
            Next
          </button>
        </div>
      </div>

      <div className="watch-layout">
        <div className="watch-main">
          <Player
            url={current.url}
            animeName={data.name}
            animeImage={data.image}
            episode={current}
            next={next}
            onNext={(item) => open(item.number)}
          />
        </div>
        <aside className="watch-side">
          <div className="section-head">
            <h2>Episodes</h2>
            <span className="count">{data.episodes.length}</span>
            <label className="side-episode-search">
              <input
                type="search"
                inputMode="numeric"
                value={episodeQuery}
                onChange={(event) => setEpisodeQuery(event.currentTarget.value)}
                placeholder="Episode #"
                aria-label="Search episodes by number"
              />
            </label>
          </div>
          <div className="side-list" ref={setSide}>
            {filteredEpisodes.length ? filteredEpisodes.map((item) => (
              <EpisodeCard
                key={item.number}
                animeUrl={url}
                animeName={data.name}
                fallbackImage={data.image}
                item={item}
                current={item.number === current.number}
                progress={seen.get(item.url)}
                onPlay={open}
                layout="sidebar"
                thumbnailRoot={side}
              />
            )) : (
              <div className="side-episode-empty" role="status">
                No episodes found
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

type ArtworkObserverGroup = {
  observer: IntersectionObserver;
  callbacks: Map<Element, () => void>;
};

// Share one observer per scroll root instead of creating hundreds of observers in long lists.
const artworkObservers = new Map<Element | null, ArtworkObserverGroup>();

function observeArtwork(target: Element, root: Element | null, onVisible: () => void) {
  if (typeof IntersectionObserver === "undefined") {
    onVisible();
    return () => {};
  }

  let group = artworkObservers.get(root);
  if (!group) {
    const callbacks = new Map<Element, () => void>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const callback = callbacks.get(entry.target);
          if (!callback) continue;
          callbacks.delete(entry.target);
          observer.unobserve(entry.target);
          callback();
        }
        if (!callbacks.size) {
          observer.disconnect();
          artworkObservers.delete(root);
        }
      },
      { root, rootMargin: "180px 0px" }
    );
    group = { observer, callbacks };
    artworkObservers.set(root, group);
  }

  group.callbacks.set(target, onVisible);
  group.observer.observe(target);

  return () => {
    const current = artworkObservers.get(root);
    if (!current) return;
    current.callbacks.delete(target);
    current.observer.unobserve(target);
    if (!current.callbacks.size) {
      current.observer.disconnect();
      artworkObservers.delete(root);
    }
  };
}

function EpisodeArtwork({
  animeUrl,
  animeName,
  episodeNumber,
  fallbackImage,
  root,
}: {
  animeUrl: string;
  animeName: string;
  episodeNumber: number;
  fallbackImage: string;
  root?: Element | null;
}) {
  const target = useRef<HTMLSpanElement>(null);
  const [image, setImage] = useState("");
  const [imageLoaded, setImageLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setImage("");
    setImageLoaded(false);
    setFailed(false);
    const node = target.current;
    if (!node) return;

    let live = true;
    const stopObserving = observeArtwork(node, root ?? null, () => {
      episodeCatalogThumbnail(animeUrl, animeName, episodeNumber)
        .then((result) => {
          if (!live) return;
          if (result) setImage(result);
          else setFailed(true);
        })
        .catch(() => {
          if (live) setFailed(true);
        });
    });

    return () => {
      live = false;
      stopObserving();
    };
  }, [animeUrl, animeName, episodeNumber, root]);

  return (
    <span ref={target} className="ep-artwork" aria-hidden="true">
      <Img src={fallbackImage} className="ep-artwork-fallback" />
      {image && !failed && (
        <img
          className={`ep-artwork-image${imageLoaded ? " is-loaded" : ""}`}
          src={image}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={() => setImageLoaded(true)}
          onError={() => {
            setImageLoaded(false);
            setFailed(true);
            setImage("");
          }}
        />
      )}
    </span>
  );
}

function EpisodeCard({
  animeUrl,
  animeName,
  fallbackImage,
  item,
  current,
  progress,
  onPlay,
  layout = "grid",
  thumbnailRoot,
}: {
  animeUrl: string;
  animeName: string;
  fallbackImage: string;
  item: Episode;
  current: boolean;
  progress?: Progress;
  onPlay: (number: number) => void;
  layout?: "grid" | "sidebar";
  thumbnailRoot?: Element | null;
}) {
  const title = episodeTitle(item.name, item.number);
  const percent = progress?.duration ? Math.min(100, (progress.time / progress.duration) * 100) : 0;
  const watched = percent >= 92;
  return (
    <button
      className={`ep-card${current ? " is-current" : ""}${layout === "grid" ? " is-grid" : ""}${layout === "sidebar" ? " is-sidebar" : ""}`}
      type="button"
      onClick={() => onPlay(item.number)}
    >
      <span className="ep-thumb">
        <EpisodeArtwork
          animeUrl={animeUrl}
          animeName={animeName}
          episodeNumber={item.number}
          fallbackImage={fallbackImage}
          root={thumbnailRoot}
        />
        {percent > 0 && (
          <span className="ep-bar">
            <i style={{ width: `${percent}%` }} />
          </span>
        )}
      </span>
      <span className="ep-text">
        <span className="ep-num">
          Episode {item.number}
          {watched && <span className="ep-done">Watched</span>}
          {item.filler && (
            <span
              className={`filler-tag is-${item.filler.status}`}
              title={`Source: ${item.filler.sources.join(", ")}${item.filler.sourceCount ? ` · ${item.filler.sourceCount} references` : ""}${item.filler.note ? `\n${item.filler.note}` : ""}`}
              aria-label={`Filler classification: ${FILLER_LABELS[item.filler.status]}`}
            >
              {FILLER_LABELS[item.filler.status]}
            </span>
          )}
        </span>
        {title && <span className="ep-name">{title}</span>}
      </span>
    </button>
  );
}
