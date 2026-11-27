import { useEffect, useMemo, useRef, useState } from "react";
import Player, { Icon } from "./components/Player";
import { Img } from "./components/Img";
import {
  Anime,
  Card,
  Episode,
  Home,
  Progress,
  anime as fetchAnime,
  browse,
  formatTime,
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
          <span className="brand-dot">▶</span> Anime<b>3rb</b>
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
            type="button"
            onClick={() => go({ kind: "home" })}
          >
            Home
          </button>
          <button
            className={`nav-link${view.kind === "browse" ? " is-active" : ""}`}
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

function CardGrid({ items, open }: { items: Card[]; open: (url: string) => void }) {
  return (
    <div className="grid">
      {items.map((item) => (
        <button className="card" key={item.url} type="button" onClick={() => open(item.url)}>
          <span className="poster">
            <Img src={item.image} />
            {item.episode ? <span className="badge">EP {item.episode}</span> : null}
          </span>
          <span className="card-name">{item.name}</span>
        </button>
      ))}
    </div>
  );
}

function Rail({ title, items, open }: { title: string; items: Card[]; open: (url: string) => void }) {
  return (
    <section className="rail">
      <div className="section-head">
        <h2>{title}</h2>
      </div>
      <div className="rail-scroll">
        {items.map((item) => (
          <button className="rail-card" key={item.url} type="button" onClick={() => open(item.url)}>
            <span className="poster">
              <Img src={item.image} />
              {item.episode ? <span className="badge">EP {item.episode}</span> : null}
            </span>
            <span className="card-name">{item.name}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function HomeView({ open, resume }: { open: (url: string) => void; resume: (url: string, play: number) => void }) {
  const [data, setData] = useState<Home | null>(null);
  const [error, setError] = useState("");
  const history = useMemo<Progress[]>(() => readProgress().filter((item) => item.time > 5), []);

  useEffect(() => {
    fetchHome()
      .then(setData)
      .catch((reason) => setError(String(reason)));
  }, []);

  if (error) return <p className="notice">{error}</p>;
  if (!data) return <p className="notice">Loading…</p>;

  return (
    <>
      {history.length > 0 && (
        <section className="rail">
          <div className="section-head">
            <h2>Continue watching</h2>
          </div>
          <div className="rail-scroll">
            {history.map((item) => (
              <button
                className="rail-card"
                key={item.url}
                type="button"
                onClick={() => resume(animeUrlFor(item.url), episodeNumber(item.url))}
              >
                <span className="poster">
                  <Img src={item.image} />
                  <span className="resume">{formatTime(item.time)}</span>
                </span>
                <span className="card-name">
                  {item.anime}
                  <span className="ep-tag">EP {episodeNumber(item.url)}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
      {data.rails.map((rail) => (
        <Rail key={rail.title} title={rail.title} items={rail.items} open={open} />
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

  if (error) return <p className="notice">{error}</p>;
  if (!items) return <p className="notice">Searching…</p>;
  if (!items.length) return <p className="notice">No results for “{query}”</p>;

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

  if (error) return <p className="notice">{error}</p>;

  return (
    <section className="results">
      <div className="section-head">
        <h2>All anime</h2>
        <span className="count">Page {page}</span>
      </div>
      {!items ? (
        <p className="notice">Loading…</p>
      ) : items.length ? (
        <CardGrid items={items} open={open} />
      ) : (
        <p className="notice">No more titles.</p>
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

  if (error) return <p className="notice">{error}</p>;
  if (!data) return <p className="notice">Loading…</p>;

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
            <EpisodeCard key={item.number} image={data.image} item={item} current={false} onPlay={play} />
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

  if (error) return <p className="notice">{error}</p>;
  if (!data) return <p className="notice">Loading…</p>;

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
  onPlay,
}: {
  image: string;
  item: Episode;
  current: boolean;
  onPlay: (number: number) => void;
}) {
  const title = episodeTitle(item.name, item.number);
  return (
    <button
      className={`ep-card${current ? " is-current" : ""}`}
      type="button"
      onClick={() => onPlay(item.number)}
      title={item.name}
    >
      <span className="ep-thumb">
        <Img src={image} />
      </span>
      <span className="ep-text">
        <span className="ep-num">Episode {item.number}</span>
        {title && <span className="ep-name">{title}</span>}
      </span>
    </button>
  );
}
