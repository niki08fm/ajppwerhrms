import { useState } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { dateSpan, istTime, mins } from '@/utils';

/** A quiet summary; chart colours carry the visual detail below it. */
export default function SiteLiveSummary({ today, date, fetching, failed, updatedAt, onViewPeople }) {
  const [details, setDetails] = useState(false);
  return (
    <Card className="px-5 py-4" aria-label="Today's site attendance">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted-foreground">
        <span>Today · {dateSpan(date)}</span>
        <span className="flex items-center gap-1.5" role="status">{fetching ? <><Loader2 className="size-3 animate-spin" aria-hidden="true" /> Updating</> : failed ? 'Showing the last loaded headcount' : <><span className="size-1.5 rounded-full bg-success" /> Live · updated {istTime(new Date(updatedAt).toISOString())}</>}</span>
      </div>
      <div className="grid grid-cols-2 items-center gap-x-6 gap-y-4 sm:grid-cols-[1.5fr_1fr_1fr]">
        <button type="button" onClick={onViewPeople} className="col-span-2 flex items-baseline gap-3 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring sm:col-span-1" aria-label={`View ${today.on_site_now} current people`}>
          <span className="num text-[42px] font-semibold leading-none text-primary">{today.on_site_now}</span><span className="text-[13px] text-muted-foreground">On site now</span>
        </button>
        {[['In today', today.punched_in], ['OT hours', mins(today.ot_min)]].map(([label, value]) => <div key={label} className="min-w-0 sm:border-l sm:pl-6"><div className="num text-[24px] font-semibold leading-none">{value}</div><div className="mt-1.5 text-[12px] text-muted-foreground">{label}</div></div>)}
      </div>
      <div className="mt-4 border-t pt-2">
        <Button size="sm" variant="ghost" className="-ml-3 text-muted-foreground" aria-expanded={details} aria-controls="site-today-details" onClick={() => setDetails(!details)}>{details ? 'Less detail' : 'More today'}<ChevronDown className={details ? 'rotate-180' : ''} /></Button>
        {details && <dl id="site-today-details" className="grid grid-cols-2 gap-x-5 gap-y-3 pb-1 pt-2 sm:grid-cols-4">
          {[['Signed out', today.signed_out], ['Late in', today.late_in], ['Left early', today.early_out], ['Completed hours', mins(today.worked_min)]].map(([label, value]) => <div key={label}><dt className="text-[12px] text-muted-foreground">{label}</dt><dd className="num mt-0.5 text-[17px] font-semibold">{value}</dd></div>)}
        </dl>}
      </div>
    </Card>
  );
}
