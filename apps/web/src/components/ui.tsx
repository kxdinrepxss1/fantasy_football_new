import type { ReactNode } from 'react';
import type { Position } from '../lib/api';

/** Position colours, consistent everywhere a player appears. */
const POSITION_STYLES: Record<Position, string> = {
  QB: 'bg-rose-500/20 text-rose-300',
  RB: 'bg-emerald-500/20 text-emerald-300',
  WR: 'bg-sky-500/20 text-sky-300',
  TE: 'bg-amber-500/20 text-amber-300',
  K: 'bg-violet-500/20 text-violet-300',
  DST: 'bg-slate-500/20 text-slate-300',
};

export function PositionBadge({ position, rank }: { position: Position; rank?: number }) {
  return (
    <span className={`pill ${POSITION_STYLES[position] ?? 'bg-slate-500/20 text-slate-300'}`}>
      {position}
      {rank ? rank : ''}
    </span>
  );
}

const INJURY_STYLES: Record<string, string> = {
  QUESTIONABLE: 'bg-amber-500/20 text-amber-300',
  DOUBTFUL: 'bg-orange-500/20 text-orange-300',
  OUT: 'bg-red-500/20 text-red-300',
  IR: 'bg-red-500/25 text-red-200',
  PUP: 'bg-red-500/20 text-red-300',
  SUSPENDED: 'bg-red-500/20 text-red-300',
};

export function InjuryBadge({ status }: { status: string }) {
  if (status === 'ACTIVE') return null;
  return (
    <span className={`pill ${INJURY_STYLES[status] ?? 'bg-slate-500/20 text-slate-300'}`}>
      {status === 'QUESTIONABLE' ? 'Q' : status === 'DOUBTFUL' ? 'D' : status}
    </span>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-12 text-slate-400" role="status">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-ink-500 border-t-accent" />
      <span className="text-sm">{label}…</span>
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="card border-red-500/40 bg-red-500/10">
      <p className="text-sm text-red-200">{message}</p>
      {onRetry && (
        <button className="btn-ghost mt-3" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="py-8 text-center text-sm text-slate-400">{children}</p>;
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">{children}</h2>
      {action}
    </div>
  );
}

/** Horizontal, scrollable tab strip — works well with a thumb. */
export function Tabs<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly T[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className="scroll-x mb-4 flex gap-2 pb-1">
      {options.map((option) => (
        <button
          key={option}
          onClick={() => onChange(option)}
          className={`btn shrink-0 px-3 text-xs ${
            option === value ? 'bg-accent-dim text-ink-900' : 'border border-ink-600 text-slate-300'
          }`}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

const SEVERITY_STYLES: Record<string, string> = {
  critical: 'bg-red-500/20 text-red-300',
  thin: 'bg-amber-500/20 text-amber-300',
  ok: 'bg-ink-700 text-slate-400',
  surplus: 'bg-sky-500/20 text-sky-300',
};

export function NeedBadge({ severity }: { severity: string }) {
  return <span className={`pill ${SEVERITY_STYLES[severity] ?? 'bg-ink-700'}`}>{severity}</span>;
}

export function formatSigned(n: number, digits = 1): string {
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}`;
}
