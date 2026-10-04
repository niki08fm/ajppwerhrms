import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/form';

/** Pages by number, with 20, 50 or 100 rows a page. */
export function NumberPager({ page, pages, total, limit, onPage, onLimit, hint = 'tap any row for the full day' }) {
  const from = total ? (page - 1) * limit + 1 : 0;
  const to = Math.min(total, page * limit);
  const nums = [];
  for (let i = 1; i <= pages; i++) if (i === 1 || i === pages || Math.abs(i - page) <= 2) nums.push(i);
  return (
    <div className="no-print flex flex-wrap items-center gap-2.5 border-t bg-muted/30 px-3.5 py-2.5 text-[13px] text-muted-foreground">
      <span>
        Showing <b className="text-foreground num">{from.toLocaleString('en-IN')}–{to.toLocaleString('en-IN')}</b> of <b className="text-foreground num">{total.toLocaleString('en-IN')}</b> people{hint ? ` · ${hint}` : ''}
      </span>
      <span className="flex-1" />
      <span>Rows per page</span>
      <Segmented value={limit} onChange={onLimit} label="Rows per page" options={[20, 50, 100].map((n) => ({ value: n, label: String(n) }))} />
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" className="px-2" onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label="Previous page">
          <ChevronLeft />
        </Button>
        {nums.map((n, i) => (
          <span key={n} className="flex items-center gap-1">
            {i > 0 && n - nums[i - 1] > 1 && <span className="px-0.5">…</span>}
            <Button variant={n === page ? 'default' : 'outline'} size="sm" className="min-w-8 px-2 num" aria-current={n === page ? 'page' : undefined} onClick={() => onPage(n)}>
              {n}
            </Button>
          </span>
        ))}
        <Button variant="outline" size="sm" className="px-2" onClick={() => onPage(page + 1)} disabled={page >= pages} aria-label="Next page">
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}
