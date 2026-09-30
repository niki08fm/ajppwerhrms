import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bookmark, Download, Filter, Search, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, download, errorMessage } from '@/lib/api';
import { useDebounced } from '@/lib/hooks';
import { Button } from './ui/button';
import { Input, Select } from './ui/form';
import { Dialog, Menu, Popover } from './ui/overlay';

export interface FilterDef {
  key: string;
  label: string;
  options?: { value: string; label: string }[];
  /** date input instead of options */
  type?: 'date';
}

interface Props {
  q: string;
  onQ: (q: string) => void;
  placeholder: string;
  searching?: string;
  filters: FilterDef[];
  values: Record<string, string>;
  onFilter: (key: string, value: string | null) => void;
  onClear: () => void;
  /** List name for saved views, e.g. "people" */
  list?: string;
  searchParams?: URLSearchParams;
  onApplyView?: (query: string) => void;
  exportPath?: string;
  exportName?: string;
  total?: number;
  children?: ReactNode;
}

/**
 * One search box per list (debounced 250ms, says what it searches), filters as
 * removable chips, saved views, and an export of what is currently filtered.
 */
export function ListToolbar({ q, onQ, placeholder, searching, filters, values, onFilter, onClear, list, searchParams, onApplyView, exportPath, exportName, total, children }: Props) {
  const [text, setText] = useState(q);
  const debounced = useDebounced(text, 250);
  useEffect(() => {
    if (debounced !== q) onQ(debounced);
  }, [debounced]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setText(q), [q]);

  const active = filters.filter((f) => values[f.key]);
  const [confirmExport, setConfirmExport] = useState(false);
  const [exporting, setExporting] = useState(false);

  const label = (f: FilterDef, v: string) =>
    v
      .split(',')
      .map((x) => f.options?.find((o) => o.value === x)?.label ?? x)
      .join(', ');

  return (
    <div className="no-print flex flex-col gap-2 border-b px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} className="pl-8" aria-label={placeholder} />
          {text && (
            <button className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground" onClick={() => setText('')} aria-label="Clear search">
              <X className="size-3.5" />
            </button>
          )}
        </div>
        {filters.length > 0 && (
          <Popover
            trigger={
              <Button variant="outline" size="sm">
                <Filter /> Filter
              </Button>
            }
          >
            <div className="flex flex-col gap-3">
              {filters.map((f) => (
                <label key={f.key} className="flex flex-col gap-1 text-[12px] font-medium">
                  {f.label}
                  {f.type === 'date' ? (
                    <Input type="date" value={values[f.key] ?? ''} onChange={(e) => onFilter(f.key, e.target.value || null)} />
                  ) : (
                    <Select value={values[f.key] ?? ''} onChange={(e) => onFilter(f.key, e.target.value || null)}>
                      <option value="">Any</option>
                      {f.options?.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  )}
                </label>
              ))}
            </div>
          </Popover>
        )}
        {list && searchParams && onApplyView && <SavedViews list={list} searchParams={searchParams} onApply={onApplyView} />}
        {children}
        <div className="flex-1" />
        {exportPath && (
          <Button variant="outline" size="sm" onClick={() => setConfirmExport(true)}>
            <Download /> Export
          </Button>
        )}
      </div>
      {(active.length > 0 || q) && (
        <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
          {q && searching && <span className="text-muted-foreground">Searching {searching} for “{q}”.</span>}
          {active.map((f) => (
            <span key={f.key} className="inline-flex items-center gap-1 rounded-full border bg-secondary px-2 py-0.5">
              <span className="text-muted-foreground">{f.label}:</span> {label(f, values[f.key])}
              <button onClick={() => onFilter(f.key, null)} aria-label={`Remove ${f.label} filter`} className="rounded-full p-0.5 hover:bg-accent">
                <X className="size-3" />
              </button>
            </span>
          ))}
          {active.length > 1 && (
            <button className="text-primary hover:underline" onClick={onClear}>
              Clear all
            </button>
          )}
        </div>
      )}
      {exportPath && (
        <Dialog
          open={confirmExport}
          onOpenChange={setConfirmExport}
          title="Export this list"
          description={
            active.length || q
              ? `Exports the ${total?.toLocaleString('en-IN') ?? ''} rows matching the current search and filters — not everything.`
              : `Exports all ${total?.toLocaleString('en-IN') ?? ''} rows (no filters are applied).`
          }
          footer={
            <>
              <Button variant="outline" onClick={() => setConfirmExport(false)}>
                Cancel
              </Button>
              <Button
                loading={exporting}
                onClick={async () => {
                  setExporting(true);
                  try {
                    await download(exportPath, exportName ?? 'export.csv');
                    setConfirmExport(false);
                  } catch (e) {
                    toast.error(errorMessage(e));
                  } finally {
                    setExporting(false);
                  }
                }}
              >
                <Download /> Download CSV
              </Button>
            </>
          }
        />
      )}
    </div>
  );
}

interface View {
  id: string;
  name: string;
  query: string;
}

/** A named filter-and-sort combination, stored per user. */
function SavedViews({ list, searchParams, onApply }: { list: string; searchParams: URLSearchParams; onApply: (q: string) => void }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['saved-views', list], queryFn: () => api.get<{ data: View[] }>('/saved-views', { list }).then((r) => r.data) });
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const save = useMutation({
    mutationFn: () => {
      const p = new URLSearchParams(searchParams);
      p.delete('tab');
      return api.post('/saved-views', { list, name, query: p.toString() });
    },
    onSuccess: () => {
      toast.success('View saved');
      setNaming(false);
      setName('');
      qc.invalidateQueries({ queryKey: ['saved-views', list] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/saved-views/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['saved-views', list] }),
  });
  return (
    <>
      <Menu
        align="start"
        trigger={
          <Button variant="outline" size="sm">
            <Bookmark /> Views{data?.length ? ` (${data.length})` : ''}
          </Button>
        }
        items={[
          ...(data ?? []).map((v) => ({
            label: (
              <span className="flex w-full items-center justify-between gap-3">
                {v.name}
                <Trash2
                  className="size-3.5 text-muted-foreground hover:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    del.mutate(v.id);
                  }}
                />
              </span>
            ),
            onSelect: () => onApply(v.query),
          })),
          ...(data?.length ? (['sep'] as const) : []),
          { label: 'Save current filters as a view…', onSelect: () => setNaming(true) },
        ]}
      />
      <Dialog
        open={naming}
        onOpenChange={setNaming}
        title="Save this view"
        description="Name the current search, filters and sort. It appears beside the search box."
        footer={
          <>
            <Button variant="outline" onClick={() => setNaming(false)}>
              Cancel
            </Button>
            <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!name.trim()}>
              Save view
            </Button>
          </>
        }
      >
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. People with no UAN" aria-label="View name" />
      </Dialog>
    </>
  );
}
