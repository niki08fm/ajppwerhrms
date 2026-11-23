import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * The bar above a printable page: Back on the left, Print on the right. Print pages open in
 * their own window, which in the installed app has no browser controls. Back closes that
 * window, returning to the one it came from. Reached from another page in the same window, it
 * goes back to it; opened directly from a link, it goes to `backTo`.
 */
export function PrintToolbar({ backTo = '/', note = null }) {
  const navigate = useNavigate();
  const location = useLocation();
  const back = () => {
    // Reached from another page of the app in this window: go back to it.
    if (location.key !== 'default') {
      navigate(-1);
      return;
    }
    window.close();
    // Still here: the window was not one the app opened, so it cannot close itself.
    setTimeout(() => navigate(backTo), 150);
  };
  return (
    <div className="no-print mb-4 flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <Button variant="outline" onClick={back}>
          <ArrowLeft /> Back
        </Button>
        {note && <span className="text-[13px] text-muted-foreground">{note}</span>}
      </div>
      <Button onClick={() => window.print()}>
        <Printer /> Print
      </Button>
    </div>
  );
}
