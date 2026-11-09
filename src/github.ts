/**
 * GitHub at a glance, from one shared read: a GraphQL query for you, your
 * pull requests and the ones waiting for your review (plus, when no repos
 * are configured, your most recently pushed repos), one REST call per repo
 * for its Actions runs and one for the notifications count.
 *
 * REST calls carry `If-None-Match`: a 304 doesn't count against the rate
 * limit, so polling every couple of minutes is nearly free. When GitHub
 * says we're rate-limited, nothing is called until the reset and the last
 * good data is kept, flagged so the cards can show a hint.
 *
 * Credentials: the `token` option, or else `gh auth token` (the gh CLI's
 * login). Neither: a `not configured` state the cards explain, never a crash.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Localized } from '@kiosko/sdk';

const execFileAsync = promisify(execFile);

export type RunStatus = 'queued' | 'in_progress' | 'success' | 'failure' | 'cancelled' | 'skipped' | 'action_required';

export interface Run {
  /** `owner/repo`. */
  repo: string;
  id: number;
  workflow: string;
  /** Commit message or PR title the run is about. */
  title: string;
  branch: string;
  actor: string;
  event: string;
  status: RunStatus;
  /** When it started running (or was created, if still queued). */
  startedAt: string;
  updatedAt: string;
}

export type ReviewState = 'approved' | 'changes_requested' | 'review_required' | null;
export type ChecksState = 'failure' | 'pending' | 'success' | null;

export interface PullRequest {
  repo: string;
  number: number;
  title: string;
  /** Mentions can be issues too. */
  kind: 'pr' | 'issue';
  draft: boolean;
  createdAt: string;
  updatedAt: string;
  author: string;
  review: ReviewState;
  checks: ChecksState;
}

export interface GitHubData {
  /** `unconfigured`: no token and no logged-in gh. */
  state: 'ok' | 'unconfigured';
  me: string;
  runs: Run[];
  authored: PullRequest[];
  toReview: PullRequest[];
  mentions: PullRequest[];
  /** Unread notifications; null when the token can't read them (fine-grained PATs can't). */
  notifications: number | null;
  /** Set while GitHub rate-limits us: when it lifts (epoch ms). The rest is the last good data. */
  rateLimitedUntil?: number;
  /** Repos whose runs couldn't be read, and why. */
  problems?: string[];
}

export interface Connection {
  /** GitHub host: empty or github.com, or a GitHub Enterprise Server host. */
  host: string;
  /** Personal access token. Empty = ask `gh auth token`. */
  token: string;
  /** The `gh` command. */
  bin: string;
  /** `owner/repo` list; empty = your most recently pushed repos. */
  repos: string[];
  /** Runs read per repo. */
  runsPerRepo: number;
  /** Also search open issues and PRs that mention you. */
  mentions: boolean;
}

export interface Deps {
  fetch: typeof fetch;
  /** Runs a command, resolves with its stdout. */
  exec: (bin: string, args: string[], signal: AbortSignal) => Promise<string>;
  now: () => number;
}

const defaultDeps: Deps = {
  fetch: (...a) => fetch(...a),
  exec: async (bin, args, signal) => (await execFileAsync(bin, args, { timeout: 10_000, signal })).stdout,
  now: () => Date.now(),
};

/** Bare host name: '' and api.github.com mean github.com. */
export function hostName(host: string): string {
  const h = host.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
  return !h || h === 'api.github.com' ? 'github.com' : h;
}

/** REST and GraphQL roots: api.github.com for github.com, `/api/v3` and `/api/graphql` on Enterprise. */
export function endpoints(host: string): { rest: string; graphql: string } {
  const raw = host.trim().replace(/\/+$/, '');
  const h = hostName(host);
  if (h === 'github.com') return { rest: 'https://api.github.com', graphql: 'https://api.github.com/graphql' };
  const base = /^http:\/\//.test(raw) ? `http://${h}` : `https://${h}`;
  return { rest: `${base}/api/v3`, graphql: `${base}/api/graphql` };
}

const PR_FIELDS = `__typename
  ... on PullRequest { number title isDraft createdAt updatedAt repository { nameWithOwner } author { login } reviewDecision
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }
  ... on Issue { number title createdAt updatedAt repository { nameWithOwner } author { login } }`;

export const QUERY = `query($recent: Boolean!, $withMentions: Boolean!) {
  viewer { login
    repositories(first: 5, orderBy: { field: PUSHED_AT, direction: DESC }, ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], isArchived: false) @include(if: $recent) { nodes { nameWithOwner } } }
  toReview: search(type: ISSUE, first: 30, query: "is:open is:pr archived:false review-requested:@me sort:created-asc") { nodes { ${PR_FIELDS} } }
  authored: search(type: ISSUE, first: 30, query: "is:open is:pr archived:false author:@me sort:updated-desc") { nodes { ${PR_FIELDS} } }
  mentions: search(type: ISSUE, first: 10, query: "is:open archived:false mentions:@me sort:updated-desc") @include(if: $withMentions) { nodes { ${PR_FIELDS} } }
}`;

interface SearchNode {
  __typename?: string;
  number?: number;
  title?: string;
  isDraft?: boolean;
  createdAt?: string;
  updatedAt?: string;
  repository?: { nameWithOwner?: string };
  author?: { login?: string } | null;
  reviewDecision?: string | null;
  commits?: { nodes?: { commit?: { statusCheckRollup?: { state?: string } | null } }[] };
}

const REVIEW: Record<string, ReviewState> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes_requested', REVIEW_REQUIRED: 'review_required' };
const CHECKS: Record<string, ChecksState> = { SUCCESS: 'success', FAILURE: 'failure', ERROR: 'failure', PENDING: 'pending', EXPECTED: 'pending' };

function toPullRequest(n: SearchNode): PullRequest | null {
  if (n.__typename !== 'PullRequest' && n.__typename !== 'Issue') return null;
  const rollup = n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  return {
    repo: n.repository?.nameWithOwner ?? '',
    number: n.number ?? 0,
    title: n.title ?? '',
    kind: n.__typename === 'Issue' ? 'issue' : 'pr',
    draft: Boolean(n.isDraft),
    createdAt: n.createdAt ?? '',
    updatedAt: n.updatedAt ?? '',
    author: n.author?.login ?? 'ghost',
    review: REVIEW[n.reviewDecision ?? ''] ?? null,
    checks: rollup ? (CHECKS[rollup] ?? null) : null,
  };
}

export interface Viewer {
  me: string;
  recentRepos: string[];
  authored: PullRequest[];
  toReview: PullRequest[];
  mentions: PullRequest[];
}

export class RateLimited extends Error {
  readonly until: number;
  constructor(until: number) {
    super(`GitHub rate limit, resets at ${new Date(until).toISOString()}`);
    this.until = until;
  }
}

export function parseViewer(json: string, now = Date.now()): Viewer {
  const d = JSON.parse(json) as {
    errors?: { type?: string; message?: string }[];
    data?: { viewer?: { login: string; repositories?: { nodes: { nameWithOwner: string }[] } } | null; toReview?: { nodes: SearchNode[] }; authored?: { nodes: SearchNode[] }; mentions?: { nodes: SearchNode[] } };
  };
  if (d.errors?.some((e) => e.type === 'RATE_LIMITED')) throw new RateLimited(now + 15 * 60_000);
  if (!d.data?.viewer) throw new Error(d.errors?.[0]?.message ?? 'GitHub GraphQL: no viewer (bad token?)');
  const list = (c?: { nodes: SearchNode[] }) => (c?.nodes ?? []).map(toPullRequest).filter((p): p is PullRequest => p !== null);
  return {
    me: d.data.viewer.login,
    recentRepos: (d.data.viewer.repositories?.nodes ?? []).map((r) => r.nameWithOwner),
    toReview: list(d.data.toReview),
    authored: list(d.data.authored),
    mentions: list(d.data.mentions),
  };
}

interface ApiRun {
  id: number;
  name?: string | null;
  display_title?: string;
  head_branch?: string | null;
  status?: string | null;
  conclusion?: string | null;
  event?: string;
  actor?: { login?: string } | null;
  triggering_actor?: { login?: string } | null;
  run_started_at?: string;
  created_at?: string;
  updated_at?: string;
}

/** GitHub's status + conclusion pair folded into one status. */
export function runStatus(status?: string | null, conclusion?: string | null): RunStatus {
  if (status !== 'completed') return status === 'in_progress' ? 'in_progress' : 'queued';
  switch (conclusion) {
    case 'success': return 'success';
    case 'failure': case 'timed_out': case 'startup_failure': return 'failure';
    case 'cancelled': return 'cancelled';
    case 'action_required': return 'action_required';
    default: return 'skipped';
  }
}

export function parseRuns(json: string, repo: string): Run[] {
  const d = JSON.parse(json) as { workflow_runs?: ApiRun[] };
  return (d.workflow_runs ?? []).map((r) => ({
    repo,
    id: r.id,
    workflow: r.name ?? '',
    title: r.display_title ?? '',
    branch: r.head_branch ?? '',
    actor: r.triggering_actor?.login ?? r.actor?.login ?? '',
    event: r.event ?? '',
    status: runStatus(r.status, r.conclusion),
    startedAt: r.run_started_at ?? r.created_at ?? '',
    updatedAt: r.updated_at ?? r.run_started_at ?? '',
  }));
}

/* ---------- HTTP with ETags and rate limits ---------- */

interface Cached { etag: string; body: string }
/** ETag cache: `credential tail + url` → last 200 body. Module-wide, it lives as long as the plugin. */
const etags = new Map<string, Cached>();
/** Earliest time the notifications endpoint may be polled again (X-Poll-Interval). */
let notificationsNotBefore = 0;
let lastNotifications: number | null = null;
let rateLimitedUntil = 0;
let lastGood: GitHubData | undefined;

/** Forgets every cache (tests). */
export function resetState(): void {
  etags.clear();
  notificationsNotBefore = 0;
  lastNotifications = null;
  rateLimitedUntil = 0;
  lastGood = undefined;
}

function rateLimit(res: Response, now: number): number | null {
  if (res.status !== 403 && res.status !== 429) return null;
  const retry = Number(res.headers.get('retry-after'));
  if (retry > 0) return now + retry * 1000;
  if (res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    return reset > 0 ? reset * 1000 : now + 60_000;
  }
  return null;
}

async function getJson(deps: Deps, token: string, url: string, signal: AbortSignal): Promise<{ status: number; body: string; headers: Headers }> {
  const key = `${token.slice(-8)} ${url}`;
  const cached = etags.get(key);
  const res = await deps.fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'kiosko-plugin-github',
      ...(cached ? { 'If-None-Match': cached.etag } : {}),
    },
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
  const until = rateLimit(res, deps.now());
  if (until) throw new RateLimited(until);
  if (res.status === 304 && cached) return { status: 200, body: cached.body, headers: res.headers };
  const body = await res.text();
  if (res.ok) {
    const etag = res.headers.get('etag');
    if (etag) etags.set(key, { etag, body });
  }
  return { status: res.status, body, headers: res.headers };
}

/** The token to use: the option, else gh's login; '' when there's neither. */
export async function resolveToken(c: Connection, deps: Deps, signal: AbortSignal): Promise<string> {
  if (c.token.trim()) return c.token.trim();
  try {
    return (await deps.exec(c.bin.trim() || 'gh', ['auth', 'token', '--hostname', hostName(c.host)], signal)).trim();
  } catch {
    return '';
  }
}

const empty = (state: GitHubData['state']): GitHubData => ({ state, me: '', runs: [], authored: [], toReview: [], mentions: [], notifications: null });

/** One read of everything the cards show. */
export async function readGitHub(c: Connection, signal: AbortSignal, deps: Deps = defaultDeps): Promise<GitHubData> {
  const now = deps.now();
  if (now < rateLimitedUntil) return { ...(lastGood ?? empty('ok')), rateLimitedUntil };
  const token = await resolveToken(c, deps, signal);
  if (!token) return empty('unconfigured');
  const api = endpoints(c.host);
  const repos = c.repos.map((r) => r.trim().replace(/^https?:\/\/[^/]+\//, '').replace(/\/+$/, '')).filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r));
  try {
    const gq = await deps.fetch(api.graphql, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': 'kiosko-plugin-github' },
      body: JSON.stringify({ query: QUERY, variables: { recent: repos.length === 0, withMentions: c.mentions } }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
    const until = rateLimit(gq, now);
    if (until) throw new RateLimited(until);
    if (gq.status === 401) throw new Error('GitHub: bad credentials (401)');
    if (!gq.ok) throw new Error(`GitHub GraphQL HTTP ${gq.status}`);
    const viewer = parseViewer(await gq.text(), now);

    const problems: string[] = [];
    const perPage = Math.max(1, Math.min(30, Math.round(c.runsPerRepo) || 10));
    const runLists = await Promise.all((repos.length ? repos : viewer.recentRepos).map(async (repo) => {
      const r = await getJson(deps, token, `${api.rest}/repos/${repo}/actions/runs?per_page=${perPage}&exclude_pull_requests=true`, signal);
      if (r.status !== 200) {
        problems.push(`${repo}: HTTP ${r.status}`);
        return [];
      }
      return parseRuns(r.body, repo);
    }));

    if (now >= notificationsNotBefore) {
      const r = await getJson(deps, token, `${api.rest}/notifications?per_page=50`, signal);
      const poll = Number(r.headers.get('x-poll-interval'));
      notificationsNotBefore = now + (poll > 0 ? poll * 1000 : 60_000);
      lastNotifications = r.status === 200 ? (JSON.parse(r.body) as unknown[]).length : null;
    }

    lastGood = {
      state: 'ok',
      me: viewer.me,
      runs: runLists.flat(),
      authored: viewer.authored,
      toReview: viewer.toReview,
      mentions: viewer.mentions,
      notifications: lastNotifications,
      ...(problems.length ? { problems } : {}),
    };
    return lastGood;
  } catch (e) {
    if (e instanceof RateLimited) {
      rateLimitedUntil = e.until;
      return { ...(lastGood ?? empty('ok')), rateLimitedUntil };
    }
    throw e;
  }
}

/* ---------- presentation helpers ---------- */

/** `octo-org/web-app#412` → `web-app#412`; aliases (by repo name or full name) win; long names are cut. */
export function shortRef(repo: string, number?: number, aliases: Record<string, string> = {}): string {
  const name0 = repo.split('/').pop() ?? repo;
  const name = aliases[repo] ?? aliases[name0] ?? name0;
  const cut = name.length > 10 ? `${name.slice(0, 9)}…` : name;
  return number === undefined ? cut : `${cut}#${number}`;
}

/** "3 h", "2 d", "5 wk", "1 y" (Spanish: "5 sem", "1 a"). */
export function age(iso: string, now: number, locale = 'en'): string {
  const es = /^es(?:$|[-_])/i.test(locale);
  const h = Math.max(0, (now - Date.parse(iso)) / 3_600_000);
  if (h < 24) return `${Math.max(1, Math.round(h))} h`;
  const d = h / 24;
  if (d < 14) return `${Math.round(d)} d`;
  if (d < 365) return `${Math.round(d / 7)} ${es ? 'sem' : 'wk'}`;
  return `${Math.round(d / 365)} ${es ? 'a' : 'y'}`;
}

/** Run time: "42s", "3:07", "1:02:09". Running runs count up to `now`. */
export function duration(run: Pick<Run, 'status' | 'startedAt' | 'updatedAt'>, now: number): string {
  if (run.status === 'queued') return '';
  const end = run.status === 'in_progress' ? now : Date.parse(run.updatedAt);
  const s = Math.max(0, Math.round((end - Date.parse(run.startedAt)) / 1000));
  if (s < 60) return `${s}s`;
  const two = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}

export interface Look {
  label: Localized;
  color: string;
  /** Sort order: broken first. */
  rank: number;
}

type Colors = { alert: string; warn: string; info: string; ok: string; inkDim: string };

/** How each run status is called and coloured, as gitlab's pipelines. */
export function runLook(status: RunStatus, colors: Colors): Look {
  switch (status) {
    case 'failure': return { label: { en: 'failed', es: 'falla' }, color: colors.alert, rank: 0 };
    case 'in_progress': return { label: { en: 'running', es: 'en curso' }, color: colors.info, rank: 1 };
    case 'queued': return { label: { en: 'queued', es: 'en cola' }, color: colors.warn, rank: 2 };
    case 'action_required': return { label: { en: 'waiting', es: 'espera' }, color: colors.warn, rank: 3 };
    case 'success': return { label: { en: 'passed', es: 'ok' }, color: colors.ok, rank: 4 };
    case 'cancelled': return { label: { en: 'canceled', es: 'cancelado' }, color: colors.inkDim, rank: 5 };
    default: return { label: { en: 'skipped', es: 'saltado' }, color: colors.inkDim, rank: 5 };
  }
}

/** A pull request's state in one word: what blocks it first (failing checks, changes asked), else where it is. */
export function prLook(pr: PullRequest, colors: Colors): Look {
  if (pr.kind === 'issue') return { label: { en: 'issue', es: 'issue' }, color: colors.inkDim, rank: 5 };
  if (pr.checks === 'failure') return { label: { en: 'checks fail', es: 'checks fallan' }, color: colors.alert, rank: 0 };
  if (pr.review === 'changes_requested') return { label: { en: 'changes', es: 'cambios' }, color: colors.warn, rank: 1 };
  if (pr.checks === 'pending') return { label: { en: 'running', es: 'en curso' }, color: colors.info, rank: 2 };
  if (pr.review === 'approved') return { label: { en: 'approved', es: 'aprobada' }, color: colors.ok, rank: 4 };
  if (pr.checks === 'success') return { label: { en: 'passed', es: 'ok' }, color: colors.ok, rank: 3 };
  return { label: { en: 'no CI', es: 'sin CI' }, color: colors.inkDim, rank: 3 };
}

/** Only the newest run of each repo + workflow + branch: what a person means by "how is CI". */
export function latestRuns(runs: Run[]): Run[] {
  const seen = new Set<string>();
  return [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).filter((r) => {
    const k = `${r.repo}\n${r.workflow}\n${r.branch}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** "14:05": when a rate limit lifts. */
export function clock(ms: number, locale = 'en'): string {
  return new Date(ms).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Sample data for the gallery: made-up repos and people. */
export function demoGitHub(now: number): GitHubData {
  const ago = (min: number) => new Date(now - min * 60_000).toISOString();
  const run = (repo: string, id: number, workflow: string, branch: string, actor: string, status: RunStatus, startMin: number, lenMin: number, title = ''): Run => ({
    repo, id, workflow, title, branch, actor, event: 'push', status, startedAt: ago(startMin), updatedAt: ago(Math.max(0, startMin - lenMin)),
  });
  const pr = (repo: string, number: number, title: string, author: string, createdMin: number, review: ReviewState, checks: ChecksState, extra: Partial<PullRequest> = {}): PullRequest => ({
    repo, number, title, kind: 'pr', draft: false, createdAt: ago(createdMin), updatedAt: ago(createdMin / 4), author, review, checks, ...extra,
  });
  return {
    state: 'ok',
    me: 'you',
    runs: [
      run('octo-org/web-app', 9001, 'CI', 'main', 'sam', 'failure', 25, 6, 'Bump the router to v7'),
      run('octo-org/web-app', 9002, 'CI', 'fix/login-flake', 'you', 'in_progress', 3, 0, 'Fix the flaky login test'),
      run('octo-org/api', 9003, 'Deploy', 'main', 'jordan', 'queued', 1, 0, 'Rate-limit the public endpoints'),
      run('octo-org/api', 9004, 'Tests', 'main', 'jordan', 'success', 40, 4, 'Rate-limit the public endpoints'),
      run('you/dotfiles', 9005, 'Lint', 'main', 'you', 'success', 300, 1, 'Tidy the shell aliases'),
      run('octo-org/docs', 9006, 'Pages', 'main', 'alex', 'cancelled', 600, 2, 'Update the onboarding guide'),
    ],
    authored: [
      pr('octo-org/web-app', 412, 'Fix the flaky login test', 'you', 30 * 60, 'review_required', 'failure'),
      pr('octo-org/api', 88, 'Rate-limit the public endpoints', 'you', 6 * 60, 'changes_requested', 'success'),
      pr('octo-org/web-app', 405, 'Dark mode toggle in settings', 'you', 120 * 60, 'approved', 'success'),
      pr('octo-org/mobile', 17, 'Offline sync for drafts', 'you', 200 * 60, null, 'pending', { draft: true }),
    ],
    toReview: [
      pr('octo-org/infra', 12, 'Rotate the staging certificates', 'jordan', 50 * 60, 'review_required', 'failure'),
      pr('octo-org/api', 91, 'Cache user permissions per request', 'sam', 26 * 60, 'review_required', 'pending'),
      pr('octo-org/web-app', 398, 'Move the charts to the new library', 'alex', 3 * 60, 'review_required', 'success'),
    ],
    mentions: [
      pr('octo-org/web-app', 377, 'Login page is blank on Safari 17', 'riley', 48 * 60, null, null, { kind: 'issue' }),
    ],
    notifications: 7,
  };
}
