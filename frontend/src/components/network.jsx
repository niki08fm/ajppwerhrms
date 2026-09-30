import { useNavigate } from 'react-router-dom';

const W = 640;
const H = 380;

function arc(cx, cy, r, a0, a1) {
  const p = (a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const [x0, y0] = p(a0);
  const [x1, y1] = p(a1);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
}

/**
 * Sites as circles, laid out schematically (not geographically — the field sites
 * are ten kilometres apart and head office three hundred away). Size is today's
 * punch-ins; the ring is the department mix; arrows are two-site days over seven days.
 */
export function SiteNetwork({ nodes, edges }) {
  const nav = useNavigate();
  const n = nodes.length;
  const max = Math.max(1, ...nodes.map((x) => x.punched_in));
  const pos = new Map();
  nodes.forEach((node, i) => {
    const angle = n === 1 ? 0 : (i / n) * Math.PI * 2 - Math.PI / 2;
    const rx = n <= 2 ? 170 : 220;
    const ry = n <= 2 ? 0 : 105;
    const r = 22 + 30 * Math.sqrt(node.punched_in / max);
    pos.set(node.id, { x: W / 2 + (n === 1 ? 0 : rx * Math.cos(angle)), y: H / 2 - 12 + (n === 1 ? 0 : ry * Math.sin(angle)), r });
  });
  const maxMoves = Math.max(1, ...edges.map((e) => e.moves));
  if (!n) return <p className="py-10 text-center text-[13px] text-muted-foreground">No active sites yet.</p>;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Site network: ${nodes.map((x) => `${x.name} ${x.punched_in} in today, ${x.on_site_now} on site now`).join('; ')}`}>
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted-foreground)" />
        </marker>
      </defs>
      {edges.map((e, i) => {
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        if (!a || !b) return null;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        // Offset so A→B and B→A do not overlap.
        const ox = -uy * 6;
        const oy = ux * 6;
        const x1 = a.x + ux * (a.r + 6) + ox;
        const y1 = a.y + uy * (a.r + 6) + oy;
        const x2 = b.x - ux * (b.r + 8) + ox;
        const y2 = b.y - uy * (b.r + 8) + oy;
        return (
          <g key={i}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--muted-foreground)" strokeOpacity={0.55} strokeWidth={1 + 4 * (e.moves / maxMoves)} markerEnd="url(#arrow)" />
            <text x={(x1 + x2) / 2 + ox} y={(y1 + y2) / 2 + oy - 4} textAnchor="middle" className="fill-muted-foreground text-[10px]">
              {e.moves}
            </text>
          </g>
        );
      })}
      {nodes.map((node) => {
        const p = pos.get(node.id);
        const total = node.mix.reduce((s, m) => s + m.people, 0);
        let a = -Math.PI / 2;
        return (
          <g
            key={node.id}
            className="cursor-pointer"
            onClick={() => nav(`/sites/${node.id}`)}
            tabIndex={0}
            role="link"
            aria-label={`Open ${node.name}`}
            onKeyDown={(e) => e.key === 'Enter' && nav(`/sites/${node.id}`)}
          >
            <circle cx={p.x} cy={p.y} r={p.r} fill="var(--accent)" stroke="var(--border)" />
            {total > 0 &&
              node.mix.map((m) => {
                const span = (m.people / total) * Math.PI * 2;
                const d = span >= Math.PI * 2 - 0.001 ? null : arc(p.x, p.y, p.r + 4, a, a + span - 0.03);
                const el = d ? (
                  <path key={m.department} d={d} stroke={`var(--${m.colour})`} strokeWidth={5} fill="none">
                    <title>{`${m.department}: ${m.people}`}</title>
                  </path>
                ) : (
                  <circle key={m.department} cx={p.x} cy={p.y} r={p.r + 4} stroke={`var(--${m.colour})`} strokeWidth={5} fill="none" />
                );
                a += span;
                return el;
              })}
            <text x={p.x} y={p.y - 2} textAnchor="middle" className="fill-foreground font-display text-[16px] font-semibold">
              {node.on_site_now}
            </text>
            <text x={p.x} y={p.y + 12} textAnchor="middle" className="fill-muted-foreground text-[9px]">
              on site now
            </text>
            <text x={p.x} y={p.y + p.r + 20} textAnchor="middle" className="fill-foreground text-[12px] font-medium">
              {node.name}
            </text>
            <text x={p.x} y={p.y + p.r + 33} textAnchor="middle" className="fill-muted-foreground text-[10px]">
              {node.punched_in} punched in today
            </text>
          </g>
        );
      })}
    </svg>
  );
}
