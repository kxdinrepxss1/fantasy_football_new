import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAsync } from '../lib/session';
import { ErrorNote, SectionTitle, Spinner } from '../components/ui';

interface ScoringTier {
  min: number;
  max: number | null;
  points: number;
}

interface LeagueSettings {
  teamCount: number;
  scoring: {
    perUnit: Record<string, number>;
    defPointsAllowedTiers: ScoringTier[];
    defYardsAllowedTiers: ScoringTier[];
  };
  roster: { slots: Record<string, number>; benchSize: number; irSlots: number };
  waivers: { type: string; faabBudget: number; waiverPeriodDays: number };
  playoffs: { teams: number; startWeek: number; weeksPerRound: number; tiebreakers: string[] };
  dynastyWeight: number;
}

interface LeagueResponse {
  league: { id: string; name: string; settings: LeagueSettings; current_week: number };
  isCommissioner: boolean;
}

/** Stat labels grouped the way a commissioner thinks about them. */
const STAT_GROUPS: Array<{ title: string; stats: Array<[string, string]> }> = [
  {
    title: 'Passing',
    stats: [
      ['pass_yd', 'Per passing yard'],
      ['pass_td', 'Passing TD'],
      ['pass_int', 'Interception thrown'],
      ['pass_2pt', 'Passing 2-pt conversion'],
    ],
  },
  {
    title: 'Rushing',
    stats: [
      ['rush_yd', 'Per rushing yard'],
      ['rush_td', 'Rushing TD'],
      ['rush_2pt', 'Rushing 2-pt conversion'],
    ],
  },
  {
    title: 'Receiving',
    stats: [
      ['rec', 'Per reception'],
      ['rec_yd', 'Per receiving yard'],
      ['rec_td', 'Receiving TD'],
      ['rec_2pt', 'Receiving 2-pt conversion'],
    ],
  },
  { title: 'Turnovers', stats: [['fum_lost', 'Fumble lost']] },
  {
    title: 'Kicking',
    stats: [
      ['fg_made_0_19', 'FG 0-19 yards'],
      ['fg_made_20_29', 'FG 20-29 yards'],
      ['fg_made_30_39', 'FG 30-39 yards'],
      ['fg_made_40_49', 'FG 40-49 yards'],
      ['fg_made_50_plus', 'FG 50+ yards'],
      ['fg_miss', 'Missed FG'],
      ['xp_made', 'Extra point'],
      ['xp_miss', 'Missed extra point'],
    ],
  },
  {
    title: 'Defense / special teams',
    stats: [
      ['def_sack', 'Sack'],
      ['def_int', 'Interception'],
      ['def_fum_rec', 'Fumble recovery'],
      ['def_td', 'Defensive TD'],
      ['def_safety', 'Safety'],
      ['def_blk_kick', 'Blocked kick'],
      ['st_td', 'Special teams TD'],
    ],
  },
];

const SLOT_LABELS: Array<[string, string]> = [
  ['QB', 'QB'],
  ['RB', 'RB'],
  ['WR', 'WR'],
  ['TE', 'TE'],
  ['FLEX', 'FLEX (RB/WR/TE)'],
  ['SUPERFLEX', 'SUPERFLEX (QB too)'],
  ['REC_FLEX', 'REC FLEX (WR/TE)'],
  ['K', 'K'],
  ['DST', 'DST'],
];

export default function SettingsPage() {
  const { leagueId } = useParams();
  const { data, error, loading, reload } = useAsync(
    () => api.get<LeagueResponse>(`/api/leagues/${leagueId}`),
    [leagueId],
  );

  const [draft, setDraft] = useState<LeagueSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  useEffect(() => {
    if (data?.league.settings) setDraft(structuredClone(data.league.settings));
  }, [data]);

  if (loading) return <Spinner label="Loading settings" />;
  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (!data || !draft) return null;

  const readOnly = !data.isCommissioner;

  function update(fn: (next: LeagueSettings) => void) {
    setDraft((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      fn(next);
      return next;
    });
    setSaved(false);
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.patch(`/api/leagues/${leagueId}/settings`, draft);
      setSaved(true);
      reload();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  async function invite() {
    try {
      const result = await api.post<{ inviteUrl: string }>(`/api/leagues/${leagueId}/invites`, {});
      setInviteUrl(result.inviteUrl);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not create an invite');
    }
  }

  return (
    <div className="space-y-6 pb-8">
      <div>
        <h1 className="text-lg font-bold">League settings</h1>
        <p className="text-sm text-slate-400">
          {readOnly
            ? 'Only the commissioner can change these.'
            : 'Changes apply immediately, including to weeks already played.'}
        </p>
      </div>

      {data.isCommissioner && (
        <section>
          <SectionTitle>Invite owners</SectionTitle>
          <button className="btn-ghost w-full" onClick={invite}>
            Create an invite link
          </button>
          {inviteUrl && (
            <div className="card mt-2">
              <p className="break-all text-xs text-slate-300">{inviteUrl}</p>
              <button
                className="btn-ghost mt-2 h-8 min-h-0 px-3 text-xs"
                onClick={() => navigator.clipboard?.writeText(inviteUrl)}
              >
                Copy
              </button>
            </div>
          )}
        </section>
      )}

      <section>
        <SectionTitle>Scoring</SectionTitle>
        <div className="space-y-4">
          {STAT_GROUPS.map((group) => (
            <div key={group.title} className="card">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                {group.title}
              </p>
              <div className="space-y-2">
                {group.stats.map(([key, label]) => (
                  <label key={key} className="flex items-center justify-between gap-3">
                    <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
                    <input
                      type="number"
                      step="0.01"
                      disabled={readOnly}
                      className="field w-24 py-1.5 text-right"
                      value={draft.scoring.perUnit[key] ?? 0}
                      onChange={(e) =>
                        update((next) => {
                          next.scoring.perUnit[key] = Number(e.target.value);
                        })
                      }
                    />
                  </label>
                ))}
              </div>
            </div>
          ))}

          <div className="card">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
              Defensive points allowed
            </p>
            <div className="space-y-2">
              {draft.scoring.defPointsAllowedTiers.map((tier, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="flex-1 text-sm">
                    {tier.min}
                    {tier.max === null ? '+' : `–${tier.max}`} points
                  </span>
                  <input
                    type="number"
                    step="0.5"
                    disabled={readOnly}
                    className="field w-24 py-1.5 text-right"
                    value={tier.points}
                    onChange={(e) =>
                      update((next) => {
                        next.scoring.defPointsAllowedTiers[i]!.points = Number(e.target.value);
                      })
                    }
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section>
        <SectionTitle>Starting lineup</SectionTitle>
        <div className="card space-y-2">
          {SLOT_LABELS.map(([slot, label]) => (
            <label key={slot} className="flex items-center justify-between gap-3">
              <span className="flex-1 text-sm">{label}</span>
              <input
                type="number"
                min={0}
                max={6}
                disabled={readOnly}
                className="field w-20 py-1.5 text-right"
                value={draft.roster.slots[slot] ?? 0}
                onChange={(e) =>
                  update((next) => {
                    next.roster.slots[slot] = Number(e.target.value);
                  })
                }
              />
            </label>
          ))}
          <label className="flex items-center justify-between gap-3 border-t border-ink-700 pt-2">
            <span className="flex-1 text-sm">Bench</span>
            <input
              type="number"
              min={0}
              max={30}
              disabled={readOnly}
              className="field w-20 py-1.5 text-right"
              value={draft.roster.benchSize}
              onChange={(e) =>
                update((next) => {
                  next.roster.benchSize = Number(e.target.value);
                })
              }
            />
          </label>
          <label className="flex items-center justify-between gap-3">
            <span className="flex-1 text-sm">IR slots</span>
            <input
              type="number"
              min={0}
              max={10}
              disabled={readOnly}
              className="field w-20 py-1.5 text-right"
              value={draft.roster.irSlots}
              onChange={(e) =>
                update((next) => {
                  next.roster.irSlots = Number(e.target.value);
                })
              }
            />
          </label>
        </div>
      </section>

      <section>
        <SectionTitle>Waivers & playoffs</SectionTitle>
        <div className="card space-y-3">
          <label className="flex items-center justify-between gap-3">
            <span className="flex-1 text-sm">Waiver type</span>
            <select
              disabled={readOnly}
              className="field w-40 py-1.5"
              value={draft.waivers.type}
              onChange={(e) =>
                update((next) => {
                  next.waivers.type = e.target.value;
                })
              }
            >
              <option value="FAAB">FAAB budget</option>
              <option value="ROLLING">Rolling priority</option>
              <option value="REVERSE_STANDINGS">Reverse standings</option>
            </select>
          </label>

          <label className="flex items-center justify-between gap-3">
            <span className="flex-1 text-sm">FAAB budget</span>
            <input
              type="number"
              min={0}
              disabled={readOnly}
              className="field w-24 py-1.5 text-right"
              value={draft.waivers.faabBudget}
              onChange={(e) =>
                update((next) => {
                  next.waivers.faabBudget = Number(e.target.value);
                })
              }
            />
          </label>

          <label className="flex items-center justify-between gap-3">
            <span className="flex-1 text-sm">Playoff teams</span>
            <input
              type="number"
              min={2}
              max={draft.teamCount}
              disabled={readOnly}
              className="field w-24 py-1.5 text-right"
              value={draft.playoffs.teams}
              onChange={(e) =>
                update((next) => {
                  next.playoffs.teams = Number(e.target.value);
                })
              }
            />
          </label>

          <label className="flex items-center justify-between gap-3">
            <span className="flex-1 text-sm">Playoffs start week</span>
            <input
              type="number"
              min={2}
              max={18}
              disabled={readOnly}
              className="field w-24 py-1.5 text-right"
              value={draft.playoffs.startWeek}
              onChange={(e) =>
                update((next) => {
                  next.playoffs.startWeek = Number(e.target.value);
                })
              }
            />
          </label>
        </div>
      </section>

      <section>
        <SectionTitle>Valuation</SectionTitle>
        <div className="card">
          <label className="block">
            <span className="mb-1 block text-sm">
              How much the future matters: {(draft.dynastyWeight * 100).toFixed(0)}%
            </span>
            <input
              type="range"
              min={0}
              max={100}
              disabled={readOnly}
              value={draft.dynastyWeight * 100}
              onChange={(e) =>
                update((next) => {
                  next.dynastyWeight = Number(e.target.value) / 100;
                })
              }
              className="w-full accent-emerald-500"
            />
            <span className="mt-1 block text-xs text-slate-400">
              0% is pure redraft, where a player's age barely affects his value. 100% is full
              dynasty, where aging curves apply at full strength and a 31-year-old running back is
              worth a fraction of a 23-year-old with the same projection.
            </span>
          </label>
        </div>
      </section>

      {!readOnly && (
        <div className="sticky bottom-20 space-y-2">
          {saveError && <ErrorNote message={saveError} />}
          <button className="btn-primary w-full shadow-lg" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save settings'}
          </button>
        </div>
      )}
    </div>
  );
}
