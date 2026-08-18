/**
 * Runtime configuration.
 *
 * Reads from a plain object so the same code works under Node (process.env) and
 * Cloudflare Workers (the env binding passed to fetch).
 */
export interface AppEnv {
  DATABASE_URL: string;
  JWT_SECRET: string;
  /** Public origin of the web app, used to build invite and magic links. */
  APP_URL: string;
  /**
   * Comma-separated origins allowed to call the API. Defaults to APP_URL.
   * Set this when the web app is served from more than one hostname — a Pages
   * preview deployment alongside the production domain, for instance.
   */
  ALLOWED_ORIGINS?: string;
  /** Current NFL season the app defaults to. */
  SEASON: number;
  /** Set to '1' to log magic links to the console instead of emailing them. */
  DEV_EMAIL_TO_CONSOLE: boolean;
  /**
   * True when the database is reached through a Cloudflare Hyperdrive binding
   * rather than a plain connection string. Reported by the database health
   * check so a deployment can be confirmed to be wired up as intended.
   */
  VIA_HYPERDRIVE: boolean;
}

export function readEnv(source: Record<string, unknown>): AppEnv {
  const databaseUrl = str(source.DATABASE_URL);
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required. Copy .env.example to .env and fill it in.');
  }

  const jwtSecret = str(source.JWT_SECRET);
  if (!jwtSecret || jwtSecret.length < 32) {
    throw new Error('JWT_SECRET is required and must be at least 32 characters.');
  }

  return {
    DATABASE_URL: databaseUrl,
    JWT_SECRET: jwtSecret,
    APP_URL: str(source.APP_URL) ?? 'http://localhost:5173',
    ALLOWED_ORIGINS: str(source.ALLOWED_ORIGINS),
    SEASON: Number(str(source.SEASON) ?? new Date().getFullYear()),
    DEV_EMAIL_TO_CONSOLE: str(source.DEV_EMAIL_TO_CONSOLE) !== '0',
    VIA_HYPERDRIVE: str(source.VIA_HYPERDRIVE) === '1',
  };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
