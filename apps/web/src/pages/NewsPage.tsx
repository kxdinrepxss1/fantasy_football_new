import { useState } from 'react';
import { api } from '../lib/api';
import { useAsync } from '../lib/session';
import { EmptyNote, ErrorNote, InjuryBadge, Spinner, Tabs } from '../components/ui';

interface NewsItem {
  id: string;
  headline: string;
  body: string | null;
  source: string | null;
  url: string | null;
  injury_status: string | null;
  published_at: string;
  full_name: string | null;
  position: string | null;
  nfl_team: string | null;
}

const FILTERS = ['All', 'Injuries'] as const;

export default function NewsPage() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('All');

  const { data, error, loading, reload } = useAsync(
    () =>
      api.get<{ news: NewsItem[] }>(
        `/api/players/news/feed?limit=40${filter === 'Injuries' ? '&injuriesOnly=1' : ''}`,
      ),
    [filter],
  );

  if (loading) return <Spinner label="Loading news" />;
  if (error) return <ErrorNote message={error} onRetry={reload} />;

  const news = data?.news ?? [];

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold">News & injuries</h1>
      <Tabs options={FILTERS} value={filter} onChange={setFilter} />

      {news.length === 0 ? (
        <EmptyNote>
          Nothing yet. News arrives with the data sync — run <code>npm run sync</code> to pull it in.
        </EmptyNote>
      ) : (
        <ul className="space-y-2">
          {news.map((item) => (
            <li key={item.id} className="card">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">{item.headline}</p>
                  {item.full_name && (
                    <p className="mt-0.5 text-[11px] text-slate-400">
                      {item.full_name}
                      {item.position ? ` · ${item.position}` : ''}
                      {item.nfl_team ? ` · ${item.nfl_team}` : ''}
                    </p>
                  )}
                </div>
                {item.injury_status && <InjuryBadge status={item.injury_status} />}
              </div>

              {item.body && <p className="mt-2 text-xs text-slate-300">{item.body}</p>}

              <p className="mt-2 text-[11px] text-slate-500">
                {new Date(item.published_at).toLocaleString()}
                {item.source ? ` · ${item.source}` : ''}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
