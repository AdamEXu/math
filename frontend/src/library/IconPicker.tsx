import { Search } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { LucideIcon } from "../icons/LucideIcon";
import { type IconSet, loadIconSet, loadedIconSet } from "../icons/registry";
import { iconItems } from "../icons/search";
import { useLatest } from "../components/overlay/focus";

const ICON_CHUNK = 120;
const PRELOAD_PX = 200;

type IconPickerProps = { selected: string; onSelect: (name: string) => void };

export function IconPicker({ selected, onSelect }: IconPickerProps) {
  const [query, setQuery] = useState("");
  const [iconSet, setIconSet] = useState<IconSet | null>(loadedIconSet);
  const [failed, setFailed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const trimmed = query.trim();

  useEffect(() => {
    if (iconSet) return;
    let alive = true;
    setFailed(false);
    loadIconSet().then(
      (loaded) => alive && setIconSet(loaded),
      (error: unknown) => {
        console.error(error);
        if (alive) setFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [iconSet, trimmed]);

  const items = useMemo(() => (iconSet ? iconItems(iconSet, trimmed) : []), [iconSet, trimmed]);
  const [shown, setShown] = useState({ items, count: ICON_CHUNK });
  const count = shown.items === items ? shown.count : ICON_CHUNK;
  const showMore = useLatest(() => {
    if (count < items.length) setShown({ items, count: count + ICON_CHUNK });
  });

  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [items]);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (scroll && scroll.scrollHeight <= scroll.clientHeight + PRELOAD_PX) showMore.current();
  });

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) showMore.current();
      },
      { root: scrollRef.current, rootMargin: `${PRELOAD_PX}px` },
    );
    if (sentinelRef.current) observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [showMore]);

  let status: string | null = null;
  if (failed) status = "Couldn't load icons.";
  else if (!iconSet) status = "Loading icons...";
  else if (!items.length) status = "No icons match.";

  return (
    <>
      <div className="icon-search">
        <Search />
        <input
          className="icon-search-input"
          type="search"
          placeholder="Search icons"
          autoComplete="off"
          spellCheck={false}
          aria-label="Search icons"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.preventDefault();
          }}
        />
      </div>
      <div className="icon-scroll" id="icon-scroll" ref={scrollRef}>
        <div className="icon-grid" id="icon-grid" role="listbox" aria-label="Icons">
          {items.slice(0, count).map((item, index) => {
            if (typeof item !== "string") {
              return (
                <div className="icon-section" key={`section-${item.label}`}>
                  {item.label}
                </div>
              );
            }
            const label = item.replaceAll("-", " ");
            return (
              <button
                key={`${index}-${item}`}
                className="icon-choice"
                type="button"
                role="option"
                data-icon={item}
                aria-label={label}
                title={label}
                aria-pressed={item === selected}
                onClick={() => onSelect(item)}
              >
                <LucideIcon name={item} />
              </button>
            );
          })}
        </div>
        <div className="icon-sentinel" ref={sentinelRef} />
        <p className="icon-status" hidden={!status}>
          {status}
        </p>
      </div>
    </>
  );
}
