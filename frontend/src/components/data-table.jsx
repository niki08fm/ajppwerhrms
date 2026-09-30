import { useMemo, useRef } from 'react';
import { flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/utils';
import { Button } from './ui/button';
import { Checkbox } from './ui/overlay';
import { Select } from './ui/form';

export function DataTable({
  columns,
  rows,
  rowId,
  sort,
  onSort,
  onRowClick,
  selectable,
  selected,
  onSelectedChange,
  fetching,
  virtualiseAbove = 200,
  maxHeight = 'calc(100vh - 290px)',
  footer,
  rowClassName,
  caption,
}) {
  const defs = useMemo(() => {
    const cs = columns.map((c) => ({ id: c.id, header: () => c.header, cell: (ctx) => c.cell(ctx.row.original), meta: c }));
    if (selectable) {
      cs.unshift({
        id: '__select',
        header: () => {
          const ids = rows.map(rowId);
          const all = ids.length > 0 && ids.every((id) => selected?.has(id));
          const some = ids.some((id) => selected?.has(id));
          return (
            <Checkbox
              label="Select all on this page"
              checked={all ? true : some ? 'indeterminate' : false}
              onCheckedChange={(v) => {
                const next = new Set(selected);
                for (const id of ids) v ? next.add(id) : next.delete(id);
                onSelectedChange?.(next);
              }}
            />
          );
        },
        cell: (ctx) => {
          const id = rowId(ctx.row.original);
          return (
            <span onClick={(e) => e.stopPropagation()}>
              <Checkbox
                label="Select row"
                checked={!!selected?.has(id)}
                onCheckedChange={(v) => {
                  const next = new Set(selected);
                  v ? next.add(id) : next.delete(id);
                  onSelectedChange?.(next);
                }}
              />
            </span>
          );
        },
        meta: { id: '__select', width: 36, sticky: true },
      });
    }
    return cs;
  }, [columns, selectable, selected, rows, rowId, onSelectedChange]);

  const table = useReactTable({ data: rows, columns: defs, getCoreRowModel: getCoreRowModel(), manualSorting: true, getRowId: (r) => rowId(r) });
  const scrollRef = useRef(null);
  const virtual = rows.length > virtualiseAbove;
  const rowModel = table.getRowModel().rows;
  const virtualizer = useVirtualizer({ count: rowModel.length, getScrollElement: () => scrollRef.current, estimateSize: () => 36, overscan: 12, enabled: virtual });
  const items = virtual ? virtualizer.getVirtualItems() : null;
  const padTop = items && items.length ? items[0].start : 0;
  const padBottom = items && items.length ? virtualizer.getTotalSize() - items[items.length - 1].end : 0;
  const visible = items ? items.map((i) => rowModel[i.index]) : rowModel;

  // Tables are navigable by arrow keys.
  const onKey = (e, r) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const el = e.currentTarget[e.key === 'ArrowDown' ? 'nextElementSibling' : 'previousElementSibling'];
      el?.focus();
    } else if (e.key === 'Enter' && onRowClick) onRowClick(r);
  };

  let stickyOffset = 0;
  const stickyLeft = {};
  for (const h of table.getHeaderGroups()[0]?.headers ?? []) {
    const m = h.column.columnDef.meta;
    if (m?.sticky) {
      stickyLeft[h.id] = stickyOffset;
      stickyOffset += m.width ?? 200;
    }
  }

  return (
    <div className={cn('relative transition-opacity', fetching && 'opacity-60')}>
      {fetching && <div className="absolute inset-x-0 top-0 z-20 h-0.5 animate-pulse bg-primary" aria-hidden />}
      <div ref={scrollRef} className="overflow-auto scrollbar-thin" style={{ maxHeight }}>
        <table className="data-table w-full border-separate border-spacing-0">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead className="sticky top-0 z-10">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => {
                  const m = h.column.columnDef.meta;
                  const active = m.sortKey && sort?.replace(/^-/, '') === m.sortKey;
                  const desc = sort?.startsWith('-');
                  return (
                    <th
                      key={h.id}
                      scope="col"
                      style={{ width: m.width, minWidth: m.width, left: m.sticky ? stickyLeft[h.id] : undefined }}
                      className={cn('border-b', m.sticky && 'sticky z-20', m.align === 'right' && 'text-right', m.align === 'center' && 'text-center')}
                      aria-sort={active ? (desc ? 'descending' : 'ascending') : undefined}
                    >
                      {m.sortKey && onSort ? (
                        <button className={cn('inline-flex items-center gap-1 hover:text-foreground', m.align === 'right' && 'flex-row-reverse')} onClick={() => onSort(m.sortKey)}>
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          {active ? desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" /> : <ArrowUpDown className="size-3 opacity-40" />}
                        </button>
                      ) : (
                        flexRender(h.column.columnDef.header, h.getContext())
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {padTop > 0 && (
              <tr>
                <td style={{ height: padTop }} colSpan={defs.length} />
              </tr>
            )}
            {visible.map((row) => (
              <tr
                key={row.id}
                tabIndex={0}
                onKeyDown={(e) => onKey(e, row.original)}
                onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                className={cn('group focus:outline-none focus-visible:bg-accent', onRowClick && 'cursor-pointer', rowClassName?.(row.original))}
              >
                {row.getVisibleCells().map((cell) => {
                  const m = cell.column.columnDef.meta;
                  return (
                    <td
                      key={cell.id}
                      style={{ width: m.width, minWidth: m.width, maxWidth: m.width ? m.width + 80 : undefined, left: m.sticky ? stickyLeft[cell.column.id] : undefined }}
                      className={cn(
                        'border-b bg-card group-hover:bg-accent/60 group-focus-visible:bg-accent',
                        m.sticky && 'sticky z-[5]',
                        m.align === 'right' && 'text-right num',
                        m.align === 'center' && 'text-center',
                        m.className,
                      )}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  );
                })}
              </tr>
            ))}
            {padBottom > 0 && (
              <tr>
                <td style={{ height: padBottom }} colSpan={defs.length} />
              </tr>
            )}
          </tbody>
          {footer && <tfoot className="sticky bottom-0 z-10 bg-card font-medium">{footer}</tfoot>}
        </table>
      </div>
    </div>
  );
}

/** "Showing 50 of 1,284" with previous/next keyset paging and page size. */
export function Pager({ shown, total, page, hasPrev, hasNext, onPrev, onNext, limit, onLimit }) {
  const from = shown === 0 ? 0 : (page - 1) * (limit ?? 50) + 1;
  return (
    <div className="no-print flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-[12px] text-muted-foreground">
      <span className="num">
        Showing {shown === 0 ? 0 : `${from.toLocaleString('en-IN')}–${(from + shown - 1).toLocaleString('en-IN')}`} of {total.toLocaleString('en-IN')}
      </span>
      <div className="flex items-center gap-2">
        {onLimit && (
          <label className="flex items-center gap-1">
            Rows
            <Select value={limit} onChange={(e) => onLimit(Number(e.target.value))} className="h-7 w-[70px]">
              {[50, 100, 200].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </label>
        )}
        <Button variant="outline" size="sm" onClick={onPrev} disabled={!hasPrev} aria-label="Previous page">
          <ChevronLeft />
        </Button>
        <span className="num">Page {page}</span>
        <Button variant="outline" size="sm" onClick={onNext} disabled={!hasNext} aria-label="Next page">
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}
