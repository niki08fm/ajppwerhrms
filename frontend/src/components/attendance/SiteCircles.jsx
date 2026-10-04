import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TONE } from './dayVocab';

const GAP = 22;
const R_MIN = 96;
const R_MAX = 150;

/** Which ring segment a person's day falls in. One segment per person. */
function segmentOf(p, isToday) {
  if (isToday) {
    if (p.open_now) return p.ot_min > 0 ? 'ot' : 'work';
    return p.early_min > 0 ? 'early' : 'done';
  }
  if (p.status === 'MISSING_PUNCH' && !p.corrected) return 'nopunch';
  if (p.early_min > 0) return 'early';
  if (p.ot_min > 0) return 'ot';
  return 'done';
}

export function segmentDefs(isToday) {
  return isToday
    ? [
        { key: 'work', view: 'onsite', label: 'On site, normal hours', colour: TONE.ok },
        { key: 'ot', view: 'ot', label: 'In overtime', colour: TONE.warn },
        { key: 'done', view: 'in', label: 'Done for the day', colour: TONE.soft },
        { key: 'early', view: 'early', label: 'Left early', colour: TONE.bad },
      ]
    : [
        { key: 'nopunch', view: 'nopunch', label: 'No punch-out', colour: 'color-mix(in srgb, var(--muted-foreground) 55%, var(--card))' },
        { key: 'ot', view: 'ot', label: 'Did overtime', colour: TONE.warn },
        { key: 'done', view: 'in', label: 'Done for the day', colour: TONE.soft },
        { key: 'early', view: 'early', label: 'Left early', colour: TONE.bad },
      ];
}

export function countSegments(people, isToday) {
  const out = {};
  for (const p of people) {
    const s = segmentOf(p, isToday);
    out[s] = (out[s] ?? 0) + 1;
  }
  return out;
}

/** Greedy circle packing: biggest first, each next one as close to the middle as it fits. */
function pack(items) {
  const placed = [];
  for (const it of [...items].sort((a, b) => b.R - a.R)) {
    if (!placed.length) {
      placed.push({ ...it, x: 0, y: 0 });
      continue;
    }
    let best = null;
    for (const p of placed) {
      for (let a = 0; a < 360; a += 8) {
        const t = (a * Math.PI) / 180;
        const d = p.R + it.R + GAP;
        const x = p.x + d * Math.cos(t);
        const y = p.y + d * Math.sin(t);
        if (placed.some((q) => Math.hypot(q.x - x, q.y - y) < q.R + it.R + GAP - 0.5)) continue;
        const cost = x * x * 0.45 + y * y * 1.7; // wide rather than tall
        if (!best || cost < best.cost) best = { x, y, cost };
      }
    }
    placed.push({ ...it, x: best.x, y: best.y });
  }
  const minX = Math.min(...placed.map((p) => p.x - p.R));
  const maxX = Math.max(...placed.map((p) => p.x + p.R));
  const minY = Math.min(...placed.map((p) => p.y - p.R - 34));
  const maxY = Math.max(...placed.map((p) => p.y + p.R));
  const pad = 12;
  return {
    circles: placed.map((p) => ({ ...p, x: p.x - minX + pad, y: p.y - minY + pad })),
    width: maxX - minX + pad * 2,
    height: maxY - minY + pad * 2,
  };
}

/**
 * Sites as circles. Size follows how many punched in; the ring shows how their day is going;
 * inside, four counts open those people in Attendance. Counts, never names, so it reads the
 * same with 20 people or 200.
 */
export function SiteCircles({ sites, people, isToday, site, highlightIds, focus, onPickSite, onOpen }) {
  const box = useRef(null);
  const [scale, setScale] = useState(1);
  const defs = segmentDefs(isToday);

  const layout = useMemo(() => {
    const per = sites.map((s) => ({ site: s, here: people.filter((p) => p.sites.includes(s.id)) }));
    const max = Math.max(1, ...per.map((x) => x.here.length));
    const items = per.map((x) => ({ ...x, id: x.site.id, R: Math.round(R_MIN + (R_MAX - R_MIN) * Math.sqrt(x.here.length / max)) }));
    return items.length ? pack(items) : { circles: [], width: 0, height: 0 };
  }, [sites, people]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const fit = () => setScale(Math.min(1, el.clientWidth / Math.max(1, layout.width)));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [layout.width]);

  if (!layout.circles.length) return <p className="py-16 text-center text-sm text-muted-foreground">No sites yet. Add one under Sites.</p>;

  return (
    <div ref={box} className="w-full overflow-hidden">
      <div className="relative mx-auto origin-top-left" style={{ width: layout.width, height: layout.height, transform: `scale(${scale})`, marginBottom: (scale - 1) * layout.height }}>
        {layout.circles.map((c) => {
          const here = c.here;
          const r = c.R - 7;
          const circ = 2 * Math.PI * r;
          const tot = Math.max(1, here.length);
          const seg = countSegments(here, isToday);
          let acc = 0;
          const arcs = defs
            .filter((d) => seg[d.key])
            .map((d) => {
              const len = (circ * seg[d.key]) / tot;
              const vis = Math.max(1, len - (here.length > 1 ? 3 : 0));
              const a = { key: d.key, colour: d.colour, dash: `${vis} ${circ - vis}`, off: -acc };
              acc += len;
              return a;
            });
          const waiting = highlightIds ? here.filter((p) => highlightIds.has(p.id)).length : 0;
          const dim = (site && site !== c.id) || (focus && !waiting);
          const stat = (view, label, n, colour) => ({ view, label, n, colour });
          const stats = [
            isToday ? stat('onsite', 'on site', here.filter((p) => p.open_now).length, TONE.ok) : stat('nopunch', 'no out', here.filter((p) => p.views.includes('nopunch')).length, TONE.bad),
            stat('ot', isToday ? 'in OT' : 'did OT', here.filter((p) => p.ot_min > 0).length, TONE.warn),
            stat('late', 'late in', here.filter((p) => p.late_min > 0).length, TONE.warn),
            stat('early', 'left early', here.filter((p) => p.early_min > 0).length, TONE.bad),
          ];
          const big = c.R > 120;
          return (
            <div key={c.id}>
              <div
                className="absolute rounded-full bg-muted/50 transition-opacity"
                style={{ left: c.x - c.R, top: c.y - c.R, width: c.R * 2, height: c.R * 2, opacity: dim ? 0.25 : 1 }}
              >
                <svg width={c.R * 2} height={c.R * 2} viewBox={`0 0 ${c.R * 2} ${c.R * 2}`} className="absolute inset-0" aria-hidden>
                  <circle cx={c.R} cy={c.R} r={r} fill="none" stroke="var(--border)" strokeWidth="10" />
                  {arcs.map((a) => (
                    <circle key={a.key} cx={c.R} cy={c.R} r={r} fill="none" stroke={a.colour} strokeWidth="10" strokeDasharray={a.dash} strokeDashoffset={a.off} transform={`rotate(-90 ${c.R} ${c.R})`} />
                  ))}
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
                  <button type="button" onClick={() => onOpen('in', c.id)} className="flex flex-col items-center leading-none">
                    <span className={`${big ? 'text-[40px]' : 'text-[32px]'} font-semibold num`}>{here.length}</span>
                    <span className="mt-1 text-[12px] text-muted-foreground">punched in</span>
                  </button>
                  <div className="grid grid-cols-2 gap-1" style={{ width: big ? 170 : 150 }}>
                    {stats.map((s) => (
                      <button
                        key={s.view}
                        type="button"
                        onClick={() => onOpen(s.view, c.id)}
                        className="flex h-7 items-center justify-center gap-1 rounded-md border bg-card px-1 text-[11px] font-medium whitespace-nowrap transition-colors hover:border-primary/50"
                        style={{ color: s.n ? s.colour : 'var(--muted-foreground)', opacity: s.n ? 1 : 0.7 }}
                      >
                        <b className="text-[13px] num">{s.n}</b>
                        <span className={s.n ? '' : 'text-muted-foreground'}>{s.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => onPickSite(site === c.id ? null : c.id)}
                className="absolute flex -translate-x-1/2 items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-[13px] font-semibold whitespace-nowrap shadow-sm transition-opacity hover:border-primary/50"
                style={{ left: c.x, top: c.y - c.R - 16, opacity: dim ? 0.3 : 1 }}
                aria-pressed={site === c.id}
              >
                <span className="size-2 rounded-full bg-muted-foreground/60" />
                {c.site.name}
                {waiting > 0 && (
                  <span title="Waiting on you" className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-destructive px-1.5 text-[11px] text-destructive-foreground num">
                    {waiting}
                  </span>
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
