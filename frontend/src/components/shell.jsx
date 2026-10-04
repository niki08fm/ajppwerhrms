import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Command } from 'cmdk';
import {
  BarChart3,
  Banknote,
  CalendarClock,
  CalendarDays,
  ChevronDown,
  ChevronRight,
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
  PanelLeftClose,
  PanelLeftOpen,
  PauseCircle,
  Plus,
  Scale,
  ScrollText,
  Search,
  Settings2,
  Sun,
  UserMinus,
  UserPlus,
  Users,
  Workflow,
  X,
} from 'lucide-react';
import { api } from '@/services/api';
import { useOnline } from '@/hooks';
import { useSession } from '@/context/SessionContext';
import { cn, initials } from '@/utils';
import { OfflineBanner } from './states';
import { Button } from './ui/button';
import { Menu, Tooltip } from './ui/overlay';

/** Navigation follows the job HR is doing. Settings are folded away until needed. */
const NAV = [
  {
    group: null,
    items: [
      { to: '/', label: 'Today', icon: <Gauge />, end: true },
      { to: '/analytics', label: 'Analytics', icon: <BarChart3 /> },
    ],
  },
  {
    group: 'People',
    items: [
      { to: '/people', label: 'Employees', icon: <Users /> },
      { to: '/offers', label: 'Hiring and onboarding', icon: <UserPlus /> },
      { to: '/exits', label: 'Exits and settlement', icon: <UserMinus /> },
    ],
  },
  {
    group: 'Time',
    items: [
      { to: '/attendance', label: 'Attendance', icon: <CalendarClock /> },
      { to: '/leave', label: 'Leave', icon: <CalendarDays /> },
      { to: '/overtime', label: 'Overtime', icon: <Clock3 /> },
      { to: '/approvals', label: 'Approvals', icon: <ClipboardCheck />, badge: 'approvals' },
    ],
  },
  {
    group: 'Payroll',
    items: [
      { to: '/payroll', label: 'Run payroll', icon: <Banknote /> },
      { to: '/held-salaries', label: 'Held salaries', icon: <PauseCircle /> },
      { to: '/money', label: 'Loans and advances', icon: <HandCoins /> },
    ],
  },
  {
    group: 'Sites and records',
    items: [
      { to: '/sites', label: 'Sites', icon: <MapPin /> },
      { to: '/documents', label: 'Documents', icon: <FileCheck2 /> },
      { to: '/audit', label: 'Audit log', icon: <ScrollText /> },
    ],
  },
];

const SETTINGS = [
  { to: '/setup/pay-groups', label: 'Pay groups', icon: <Workflow /> },
  { to: '/setup/structures', label: 'Salary structures', icon: <Layers /> },
  { to: '/setup/policies', label: 'Policies', icon: <Scale /> },
  { to: '/setup/statutory', label: 'Statutory rules', icon: <Landmark /> },
  { to: '/setup/calendar', label: 'Shifts and holidays', icon: <FileClock /> },
  { to: '/setup/projects', label: 'Projects', icon: <FolderKanban /> },
];

/** The things HR starts most often, from anywhere. */
const NEW_ACTIONS = [
  { to: '/leave?new=1', label: 'Record leave', icon: <CalendarDays /> },
  { to: '/exits?new=1', label: 'Record an exit', icon: <UserMinus /> },
  { to: '/held-salaries?new=1', label: 'Hold a salary', icon: <PauseCircle /> },
  { to: '/offers?new=1', label: 'Issue an offer', icon: <UserPlus /> },
  { to: '/people?new=1', label: 'Add an existing employee', icon: <Users /> },
  { to: '/attendance', label: 'Correct attendance', icon: <CalendarClock /> },
];

function remember(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}
function store(key, value) {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // a private window: the choice lasts until reload
  }
}

/** One link. The current page gets a teal bar at its edge, like a lit indicator on a panel. */
function NavItem({ it, collapsed, onNavigate, badge }) {
  const link = (
    <NavLink
      to={it.to}
      end={it.end}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          'relative flex h-9 items-center gap-3 rounded-md text-sm text-sidebar-foreground/75 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground [&_svg]:size-[18px] [&_svg]:shrink-0',
          collapsed ? 'justify-center px-0' : 'px-3',
          isActive &&
            'bg-sidebar-accent font-medium text-sidebar-accent-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-full before:bg-sidebar-primary [&_svg]:text-sidebar-primary',
        )
      }
    >
      {it.icon}
      {!collapsed && <span className="flex-1 truncate">{it.label}</span>}
      {badge > 0 &&
        (collapsed ? (
          <span className="absolute top-1 right-1 size-2 rounded-full bg-destructive" aria-label={`${badge} waiting`} />
        ) : (
          <span className="rounded-full bg-destructive px-1.5 text-[12px] leading-5 font-semibold text-destructive-foreground num">{badge}</span>
        ))}
    </NavLink>
  );
  return collapsed ? <Tooltip content={it.label}>{link}</Tooltip> : link;
}

function Sidebar({ onNavigate, collapsed, onToggleCollapsed }) {
  const { data } = useQuery({ queryKey: ['dashboard', 'people'], queryFn: () => api.get('/dashboard/people').then((r) => r.data), staleTime: 60_000 });
  const pending = data?.approvals.total ?? (data?.approvals.face ?? 0) + (data?.approvals.leave ?? 0);
  const { pathname } = useLocation();
  const nav = useNavigate();
  const inSettings = SETTINGS.some((x) => pathname.startsWith(x.to));
  const [settingsOpen, setSettingsOpen] = useState(() => remember('nav.settings', false));
  const showSettings = settingsOpen || inSettings;
  return (
    <nav aria-label="Main" className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className={cn('flex h-14 shrink-0 items-center gap-2.5 border-b border-sidebar-border', collapsed ? 'justify-center px-2' : 'px-4')}>
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
          <svg viewBox="0 0 32 32" className="size-5" aria-hidden>
            <path d="M17.5 5 9 18h6l-1.5 9L23 13h-6.2L17.5 5z" fill="currentColor" />
          </svg>
        </div>
        {!collapsed && (
          <div className="leading-tight">
            <div className="font-display text-[17px] font-semibold text-sidebar-accent-foreground">AJPWER</div>
            <div className="text-[12px] text-sidebar-foreground/60">Workforce</div>
          </div>
        )}
      </div>
      <div className={cn('shrink-0 pt-4 pb-2', collapsed ? 'px-2' : 'px-3')}>
        <Menu
          align="start"
          trigger={
            <Button className={cn('w-full bg-sidebar-primary text-sidebar-primary-foreground hover:bg-sidebar-primary/90', collapsed && 'px-0')} aria-label="Start something new">
              <Plus /> {!collapsed && <span className="flex-1 text-left">New</span>}
              {!collapsed && <ChevronDown className="opacity-70" />}
            </Button>
          }
          items={NEW_ACTIONS.map((a) => ({
            label: (
              <>
                <span className="text-muted-foreground [&_svg]:size-4">{a.icon}</span> {a.label}
              </>
            ),
            onSelect: () => {
              onNavigate?.();
              nav(a.to);
            },
          }))}
        />
      </div>
      <div className={cn('flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto py-3 scrollbar-thin', collapsed ? 'px-2' : 'px-3')}>
        {NAV.map((g, gi) => (
          <div key={gi}>
            {g.group && !collapsed && <div className="px-3 pb-1.5 text-[12px] font-semibold tracking-wider text-sidebar-foreground/50 uppercase">{g.group}</div>}
            {g.group && collapsed && <div className="mx-2 mb-2 border-t border-sidebar-border" />}
            <ul className="flex flex-col gap-0.5">
              {g.items.map((it) => (
                <li key={it.to}>
                  <NavItem it={it} collapsed={collapsed} onNavigate={onNavigate} badge={it.badge === 'approvals' ? pending : 0} />
                </li>
              ))}
            </ul>
          </div>
        ))}
        <div>
          <button
            onClick={() => {
              setSettingsOpen(!showSettings);
              store('nav.settings', !showSettings);
            }}
            aria-expanded={showSettings}
            className={cn(
              'flex h-9 w-full items-center gap-3 rounded-md text-sm text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground [&_svg]:size-[18px]',
              collapsed ? 'justify-center' : 'px-3',
            )}
            title={collapsed ? 'Settings' : undefined}
          >
            <Settings2 />
            {!collapsed && (
              <>
                <span className="flex-1 text-left">Settings</span>
                <ChevronRight className={cn('size-4 transition-transform', showSettings && 'rotate-90')} />
              </>
            )}
          </button>
          {showSettings && (
            <ul className={cn('mt-0.5 flex flex-col gap-0.5', !collapsed && 'ml-3 border-l border-sidebar-border pl-2')}>
              {SETTINGS.map((it) => (
                <li key={it.to}>
                  <NavItem it={it} collapsed={collapsed} onNavigate={onNavigate} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {onToggleCollapsed && (
        <div className={cn('shrink-0 border-t border-sidebar-border py-2', collapsed ? 'px-2' : 'px-3')}>
          <button
            onClick={onToggleCollapsed}
            className={cn('flex h-9 w-full items-center gap-3 rounded-md text-[13px] text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground', collapsed ? 'justify-center' : 'px-3')}
            aria-label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
          >
            {collapsed ? <PanelLeftOpen className="size-[18px]" /> : <PanelLeftClose className="size-[18px]" />}
            {!collapsed && 'Collapse'}
          </button>
        </div>
      )}
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
        className="flex h-9 w-full max-w-md items-center gap-2 rounded-md border bg-background px-3 text-sm text-muted-foreground transition-colors hover:border-primary/40"
        aria-label="Search people"
      >
        <Search className="size-4" />
        <span className="flex-1 text-left">Find a person…</span>
        <kbd className="rounded border bg-muted px-1.5 font-mono text-[11px]">/</kbd>
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh]" onClick={() => setOpen(false)}>
          <Command shouldFilter={false} className="w-[min(560px,calc(100vw-2rem))] overflow-hidden rounded-lg border bg-popover shadow-2xl" onClick={(e) => e.stopPropagation()} label="Find a person">
            <div className="flex items-center gap-2 border-b px-3">
              <Search className="size-4 text-muted-foreground" />
              <Command.Input autoFocus value={q} onValueChange={setQ} placeholder="Name, employee code or phone" className="h-11 flex-1 bg-transparent text-[15px] outline-none" />
              <button onClick={() => setOpen(false)} aria-label="Close search">
                <X className="size-4 text-muted-foreground" />
              </button>
            </div>
            <Command.List className="max-h-80 overflow-y-auto p-1">
              {q && !isFetching && <Command.Empty className="px-3 py-6 text-center text-[14px] text-muted-foreground">No one found for “{q}”.</Command.Empty>}
              {!q && <div className="px-3 py-6 text-center text-[14px] text-muted-foreground">Type a name or code. Enter opens the profile.</div>}
              {data?.map((p) => (
                <Command.Item
                  key={p.id}
                  value={p.id}
                  onSelect={() => {
                    setOpen(false);
                    setQ('');
                    nav(`/people/${p.id}`);
                  }}
                  className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-[14px] data-[selected=true]:bg-accent"
                >
                  <span className="flex size-7 items-center justify-center rounded-full bg-secondary text-[12px] font-semibold">{initials(p.name)}</span>
                  <span className="flex-1">
                    <span className="font-medium">{p.name}</span> <span className="font-mono text-[12px] text-muted-foreground">{p.code}</span>
                    <span className="block text-[13px] text-muted-foreground">
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
  const [collapsed, setCollapsed] = useState(() => remember('nav.collapsed', false));
  const qc = useQueryClient();
  const nav = useNavigate();
  return (
    <div className="flex h-screen overflow-hidden">
      <aside className={cn('hidden shrink-0 transition-[width] duration-200 lg:block', collapsed ? 'w-16' : 'w-64')}>
        <Sidebar
          collapsed={collapsed}
          onToggleCollapsed={() => {
            setCollapsed(!collapsed);
            store('nav.collapsed', !collapsed);
          }}
        />
      </aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setMobileOpen(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <aside className="absolute inset-y-0 left-0 w-72" onClick={(e) => e.stopPropagation()}>
            <Sidebar onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        {!online && <OfflineBanner />}
        <header className="app-header flex h-14 shrink-0 items-center gap-3 border-b bg-card px-4 lg:px-6">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
            <MenuIcon />
          </Button>
          <GlobalSearch />
          <div className="flex-1" />
          <ThemeToggle />
          <Menu
            trigger={
              <button className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-accent" aria-label="Account">
                <span className="flex size-8 items-center justify-center rounded-full bg-sidebar text-[13px] font-semibold text-sidebar-foreground">{initials(me?.name ?? 'HR')}</span>
                <span className="hidden text-left text-[13px] leading-tight sm:block">
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
        <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 lg:px-8">
          <div className="mx-auto max-w-[1600px]">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
