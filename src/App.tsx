import { useEffect, useMemo, useRef, useState } from "react";
import Player from "./components/Player";
import { Icon } from "./components/Icon";
import { Img } from "./components/Img";
import {
  Anime,
  Card,
  Episode,
  Home,
  Progress,
  anime as fetchAnime,
  browse,
  home as fetchHome,
  readProgress,
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

/** "الحلقة 1071 - قمة لوفي" reads better as just "قمة لوفي" next to the episode label. */
const episodeTitle = (name: string, number: number) =>
  name.replace(new RegExp(`^الحلقة\\s*${number}\\s*[-–—:]?\\s*`), "").trim();

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
          {Array.from({ length: 8 }, (_, index) => <div className="episode-skeleton" key={index}><i /><span /></div>)}
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
}: {
  title: string;
  items: Card[];
  open: (item: Card) => void;
  progress?: Map<string, Progress>;
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
              <button className="rail-card" key={item.url} type="button" onClick={() => open(item)}>
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
  const history = useMemo<Progress[]>(
    () => readProgress().filter((item) => item.time > 5 && !(item.duration > 0 && item.time / item.duration >= 0.92)),
    []
  );
  const seen = useMemo(() => new Map(history.map((item) => [item.url, item])), [history]);
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

  useEffect(() => {
    fetchAnime(url)
      .then(setData)
      .catch((reason) => setError(String(reason)));
  }, [url]);

  const seen = useMemo(() => new Map(readProgress().map((item) => [item.url, item])), [data]);

  if (error) return <ErrorState message={error} />;
  if (!data) return <AnimeSkeleton />;

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
        <div className="section-head">
          <h2>Episodes</h2>
          <span className="count">{data.episodes.length}</span>
        </div>
        <div className="ep-grid">
          {data.episodes.map((item) => (
            <EpisodeCard
              key={item.number}
              image={data.image}
              item={item}
              current={false}
              progress={seen.get(item.url)}
              onPlay={play}
            />
          ))}
        </div>
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
  const side = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchAnime(url)
      .then(setData)
      .catch((reason) => setError(String(reason)));
  }, [url]);

  // Keep the active episode visible in the sidebar without scrolling the page.
  useEffect(() => {
    const box = side.current;
    const card = box?.querySelector<HTMLElement>(".is-current");
    if (box && card) box.scrollTop = card.offsetTop - box.clientHeight / 2 + card.clientHeight / 2;
  }, [number, data]);

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
          </div>
          <div className="side-list" ref={side}>
            {data.episodes.map((item) => (
              <EpisodeCard
                key={item.number}
                image={data.image}
                item={item}
                current={item.number === current.number}
                progress={seen.get(item.url)}
                onPlay={open}
              />
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

function EpisodeCard({
  image,
  item,
  current,
  progress,
  onPlay,
}: {
  image: string;
  item: Episode;
  current: boolean;
  progress?: Progress;
  onPlay: (number: number) => void;
}) {
  const title = episodeTitle(item.name, item.number);
  const percent = progress?.duration ? Math.min(100, (progress.time / progress.duration) * 100) : 0;
  const watched = percent >= 92;
  return (
    <button
      className={`ep-card${current ? " is-current" : ""}`}
      type="button"
      onClick={() => onPlay(item.number)}
      title={item.name}
    >
      <span className="ep-thumb">
        <Img src={image} />
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
        </span>
        {title && <span className="ep-name">{title}</span>}
      </span>
    </button>
  );
}
