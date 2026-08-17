import { NavLink, Outlet, useParams } from 'react-router-dom';
import { useSession } from '../lib/session';

/**
 * App shell: a compact top bar and a thumb-reachable bottom nav.
 *
 * The five most-used destinations live in the bottom bar because this is used
 * on phones; everything else is reachable from the league home screen.
 */
const NAV = [
  { to: '', label: 'Home', icon: '🏈', end: true },
  { to: 'roster', label: 'Roster', icon: '📋' },
  { to: 'trade', label: 'Trade', icon: '⇄' },
  { to: 'waivers', label: 'Waivers', icon: '➕' },
  { to: 'scoreboard', label: 'Scores', icon: '📊' },
];

export default function Layout() {
  const { leagueId } = useParams();
  const { leagues } = useSession();
  const league = leagues.find((l) => l.id === leagueId);

  return (
    <div className="mx-auto min-h-screen w-full max-w-2xl">
      <header className="sticky top-0 z-10 border-b border-ink-700 bg-ink-900/95 backdrop-blur">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <NavLink to="/" className="text-xs text-slate-400 hover:text-slate-200">
            ← Leagues
          </NavLink>
          <span className="truncate text-sm font-semibold">{league?.name ?? 'League'}</span>
          <NavLink
            to={`/leagues/${leagueId}/settings`}
            className="text-xs text-slate-400 hover:text-slate-200"
          >
            Settings
          </NavLink>
        </div>
      </header>

      <main className="px-4 py-4">
        <Outlet />
      </main>

      <nav
        className="fixed inset-x-0 bottom-0 z-20 border-t border-ink-700 bg-ink-800/95 backdrop-blur"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="mx-auto flex max-w-2xl">
          {NAV.map((item) => (
            <NavLink
              key={item.label}
              to={`/leagues/${leagueId}/${item.to}`}
              end={item.end}
              className={({ isActive }) =>
                `flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] ${
                  isActive ? 'text-accent' : 'text-slate-400'
                }`
              }
            >
              <span aria-hidden className="text-lg leading-none">
                {item.icon}
              </span>
              {item.label}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}
