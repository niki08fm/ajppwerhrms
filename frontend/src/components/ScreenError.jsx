import { Component } from 'react';
import { AlertTriangle, ArrowLeft, RefreshCw } from 'lucide-react';
import { Button } from './ui/button';

const RELOADED_KEY = 'app.reloadedForUpdate';

/** A screen's code file is missing: the app was updated after this window opened. */
export function isStaleBuildError(error) {
  const m = String(error?.message ?? error ?? '');
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Failed to fetch dynamically imported|Unable to preload CSS/i.test(m);
}

/**
 * Load the updated app once. Returns false when it already reloaded in the last minute, so a
 * real fault does not reload forever.
 */
export function reloadForUpdate() {
  try {
    const last = Number(sessionStorage.getItem(RELOADED_KEY) || 0);
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem(RELOADED_KEY, String(Date.now()));
  } catch {
    // no storage: reload anyway, once per page
    if (window.__reloadedForUpdate) return false;
    window.__reloadedForUpdate = true;
  }
  window.location.reload();
  return true;
}

/**
 * Catches a screen that fails while showing, so the window is never left blank. An app update
 * reloads by itself; anything else shows what went wrong with Reload and Back.
 */
export class ScreenError extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    if (isStaleBuildError(error) && reloadForUpdate()) return;
    console.error('Screen failed:', error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const stale = isStaleBuildError(error);
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 px-6 py-14 text-center" role="alert">
        <div className="rounded-full bg-destructive/10 p-3 text-destructive">
          <AlertTriangle className="size-6" />
        </div>
        <h2 className="font-display text-lg font-semibold">{stale ? 'The app was updated' : 'This screen could not be shown'}</h2>
        <p className="max-w-md text-[14px] text-muted-foreground">
          {stale ? 'Reload to open the latest version.' : 'Reload to try again. If it keeps happening, take a screenshot of this message for whoever supports the app.'}
        </p>
        {!stale && <code className="max-w-xl break-words rounded bg-muted px-2 py-1 text-[12px] text-muted-foreground">{String(error?.message ?? error)}</code>}
        <div className="mt-1 flex gap-2">
          {window.history.length > 1 && (
            <Button variant="outline" onClick={() => window.history.back()}>
              <ArrowLeft /> Back
            </Button>
          )}
          <Button onClick={() => window.location.reload()}>
            <RefreshCw /> Reload
          </Button>
        </div>
      </div>
    );
  }
}
