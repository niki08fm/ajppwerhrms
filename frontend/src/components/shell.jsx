import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Command } from 'cmdk';
import {
  BarChart3,
  Banknote,
  CalendarClock,
  CalendarDays,
  ClipboardCheck,
  Clock3,
  FileCheck2,
  FileClock,
  FolderKanban,
  Gauge,
  HandCoins,
  Landmark,
  Layers,
  LogOut,
  MapPin,
  Menu as MenuIcon,
  Moon,
  Scale,
  ScrollText,
  Search,
  Sun,
  UserMinus,
  UserPlus,
  Users,
  Workflow,
  X,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useOnline } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { cn, initials } from '@/lib/utils';
import { OfflineBanner } from './states';
import { Button } from './ui/button';
import { Menu } from './ui/overlay';

const NAV = [
  {
    group: 'Overview',
    items: [
      { to: '/', label: 'Dashboard', icon: <Gauge />, end: true },
      { to: '/sites', label: 'Sites', icon: <MapPin /> },
      { to: '/analytics', label: 'Analytics', icon: <BarChart3 /> },
    ],
  },
  {
    group: 'Payroll',
    items: [
      { to: '/payroll', label: 'Run payroll', icon: <Banknote /> },
      { to: '/money', label: 'Advances and loans', icon: <HandCoins /> },
    ],
  },
  {
    group: 'People',
    items: [
      { to: '/people', label: 'People', icon: <Users /> },
      { to: '/offers', label: 'Offers and onboarding', icon: <UserPlus /> },
      { to: '/exits', label: 'Exits and settlement', icon: <UserMinus /> },
    ],
  },
  {
    group: 'Daily',
    items: [
      { to: '/attendance', label: 'Attendance', icon: <CalendarClock /> },
      { to: '/overtime', label: 'Overtime', icon: <Clock3 /> },
      { to: '/leave', label: 'Leave', icon: <CalendarDays /> },
      { to: '/approvals', label: 'Approvals', icon: <ClipboardCheck /> },
      { to: '/documents', label: 'Documents', icon: <FileCheck2 /> },
    ],
  },
  {
    group: 'Setup',
    items: [
      { to: '/setup/pay-groups', label: 'Pay groups', icon: <Workflow /> },
      { to: '/setup/structures', label: 'Salary structures', icon: <Layers /> },
      { to: '/setup/policies', label: 'Policies', icon: <Scale /> },
      { to: '/setup/statutory', label: 'Statutory rules', icon: <Landmark /> },
      { to: '/setup/calendar', label: 'Shifts and holidays', icon: <FileClock /> },
      { to: '/setup/projects', label: 'Projects', icon: <FolderKanban /> },
      { to: '/audit', label: 'Audit log', icon: <ScrollText /> },
    ],
  },
];

function Sidebar({ onNavigate }) {
  const { data } = useQuery({ queryKey: ['dashboard', 'people'], queryFn: () => api.get('/dashboard/people').then((r) => r.data), staleTime: 60_000 });
  const pending = (data?.approvals.face ?? 0) + (data?.approvals.leave ?? 0);
  return (
    <nav aria-label="Main" className="flex h-full flex-col gap-4 overflow-y-auto px-3 py-4 scrollbar-thin">
      <div className="flex items-center gap-2 px-2">
        <div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <svg viewBox="0 0 32 32" className="size-5" aria-hidden>
            <path d="M17.5 5 9 18h6l-1.5 9L23 13h-6.2L17.5 5z" fill="currentColor" />
          </svg>
        </div>
        <div className="leading-tight">
          <div className="font-display text-[15px] font-semibold">AJPWER</div>
          <div className="text-[11px] text-muted-foreground">Workforce</div>
        </div>
      </div>
      {NAV.map((g) => (
        <div key={g.group}>
          <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{g.group}</div>
          <ul className="flex flex-col gap-0.5">
            {g.items.map((it) => (
              <li key={it.to}>
                <NavLink
                  to={it.to}
                  end={it.end}
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-sidebar-foreground [&_svg]:size-4 [&_svg]:opacity-70 hover:bg-sidebar-accent',
                      isActive && 'bg-sidebar-accent font-medium text-sidebar-accent-foreground [&_svg]:opacity-100',
                    )
                  }
                >
                  {it.icon}
                  <span className="flex-1">{it.label}</span>
                  {it.to === '/approvals' && pending > 0 && <span className="rounded-full bg-destructive px-1.5 text-[10px] font-semibold text-destructive-foreground">{pending}</span>}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** Global search, reachable with "/" or Cmd-K: people by name and code, straight to a profile. */
function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const nav = useNavigate();
  useEffect(() => {
    const onKey = (e) => {
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target?.tagName) || e.target?.isContentEditable;
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        setOpen(true);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const { data, isFetching } = useQuery({
    queryKey: ['search', q],
    queryFn: () => api.get('/search', { q }).then((r) => r.data),
    enabled: open && q.trim().length > 0,
  });
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex h-8 w-full max-w-sm items-center gap-2 rounded-md border bg-card px-2.5 text-[13px] text-muted-foreground hover:bg-accent"
        aria-label="Search people"
      >
        <Search className="size-4" />
        <span className="flex-1 text-left">Find a person…</span>
        <kbd className="rounded border bg-muted px-1.5 font-mono text-[10px]">/</kbd>
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh]" onClick={() => setOpen(false)}>
          <Command shouldFilter={false} className="w-[min(560px,calc(100vw-2rem))] overflow-hidden rounded-lg border bg-popover shadow-2xl" onClick={(e) => e.stopPropagation()} label="Find a person">
            <div className="flex items-center gap-2 border-b px-3">
              <Search className="size-4 text-muted-foreground" />
              <Command.Input autoFocus value={q} onValueChange={setQ} placeholder="Name, employee code or phone" className="h-11 flex-1 bg-transparent text-[14px] outline-none" />
              <button onClick={() => setOpen(false)} aria-label="Close search">
                <X className="size-4 text-muted-foreground" />
              </button>
            </div>
            <Command.List className="max-h-80 overflow-y-auto p-1">
              {q && !isFetching && <Command.Empty className="px-3 py-6 text-center text-[13px] text-muted-foreground">No one found for “{q}”.</Command.Empty>}
              {!q && <div className="px-3 py-6 text-center text-[13px] text-muted-foreground">Type a name or code. Enter opens the profile.</div>}
              {data?.map((p) => (
                <Command.Item
                  key={p.id}
                  value={p.id}
                  onSelect={() => {
                    setOpen(false);
                    setQ('');
                    nav(`/people/${p.id}`);
                  }}
                  className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-[13px] data-[selected=true]:bg-accent"
                >
                  <span className="flex size-7 items-center justify-center rounded-full bg-secondary text-[11px] font-semibold">{initials(p.name)}</span>
                  <span className="flex-1">
                    <span className="font-medium">{p.name}</span> <span className="font-mono text-[11px] text-muted-foreground">{p.code}</span>
                    <span className="block text-[12px] text-muted-foreground">
                      {p.designation} · {p.department.name} · {p.status.toLowerCase()}
                    </span>
                  </span>
                </Command.Item>
              ))}
            </Command.List>
          </Command>
        </div>
      )}
    </>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      onClick={() => {
        const next = !dark;
        setDark(next);
        document.documentElement.classList.toggle('dark', next);
        try {
          localStorage.setItem('theme', next ? 'dark' : 'light');
        } catch {
          // ignore
        }
      }}
    >
      {dark ? <Sun /> : <Moon />}
    </Button>
  );
}

export function AppShell() {
  const { me } = useSession();
  const online = useOnline();
  const [mobileOpen, setMobileOpen] = useState(false);
  const qc = useQueryClient();
  const nav = useNavigate();
  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="hidden w-60 shrink-0 border-r bg-sidebar lg:block">
        <Sidebar />
      </aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setMobileOpen(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <aside className="absolute inset-y-0 left-0 w-64 border-r bg-sidebar" onClick={(e) => e.stopPropagation()}>
            <Sidebar onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        {!online && <OfflineBanner />}
        <header className="app-header flex h-12 shrink-0 items-center gap-3 border-b bg-card px-4">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
            <MenuIcon />
          </Button>
          <GlobalSearch />
          <div className="flex-1" />
          <ThemeToggle />
          <Menu
            trigger={
              <button className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-accent" aria-label="Account">
                <span className="flex size-7 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">{initials(me?.name ?? 'HR')}</span>
                <span className="hidden text-left text-[12px] leading-tight sm:block">
                  <span className="block font-medium">{me?.name}</span>
                  <span className="block text-muted-foreground">{me?.role}</span>
                </span>
              </button>
            }
            items={[
              { label: me?.email ?? '', onSelect: () => undefined, disabled: true },
              'sep',
              {
                label: (
                  <>
                    <LogOut className="size-4" /> Sign out
                  </>
                ),
                onSelect: async () => {
                  await api.post('/auth/logout').catch(() => undefined);
                  qc.clear();
                  nav('/login');
                },
              },
            ]}
          />
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto px-4 py-5 lg:px-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
