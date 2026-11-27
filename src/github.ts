/**
 * GitHub at a glance, from one shared read: a GraphQL query for you, your
 * pull requests and the ones waiting for your review (plus, when no repos
 * are configured, your most recently pushed repos), one REST call per repo
 * for its Actions runs and one or two for the notifications count.
 *
 * REST calls carry `If-None-Match`: a 304 doesn't count against the rate
 * limit, so polling every couple of minutes is nearly free. When GitHub
 * says we're rate-limited, nothing is called until the reset and the last
 * good data is kept, flagged so the cards can show a hint. All of that is
 * kept for each source profile apart (two accounts, an Enterprise host).
 *
 * Credentials: the `token` option, or else `gh auth token` (the gh CLI's
 * login). Neither: a `not configured` state the cards explain, never a crash.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { localize, matchFilter, PluginError, type Filter, type Localized } from '@kiosko/sdk';

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
  /** Unread notifications, up to `MAX_NOTIFICATIONS`; null when the token can't read them (fine-grained PATs can't). */
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
  /** `owner/repo` list; empty = your `recentRepos` most recently pushed repos. */
  repos: string[];
  /** Without `repos`: how many of your most recently pushed repos. */
  recentRepos: number;
  /** Runs read per repo. */
  runsPerRepo: number;
  /** Open issues and PRs that mention you, at most; 0 = don't look. */
  maxMentions: number;
  /** Search qualifiers added to every pull request search (`org:acme`, `-repo:acme/old`). */
  query: string;
}

export interface Deps {
  fetch: typeof fetch;
  /** Runs a command, resolves with its stdout. */
  exec: (bin: string, args: string[], signal: AbortSignal) => Promise<string>;
  now: () => number;
}

const defaultDeps: Deps = {
  fetch: (...a) => fetch(...a),
  exec: async (bin, args, signal) => (await execFileAsync(bin, args, { signal })).stdout,
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

export const QUERY = `query($recent: Boolean!, $recentCount: Int!, $withMentions: Boolean!, $mentionsCount: Int!, $reviewQ: String!, $authoredQ: String!, $mentionsQ: String!) {
  viewer { login
    repositories(first: $recentCount, orderBy: { field: PUSHED_AT, direction: DESC }, ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], isArchived: false) @include(if: $recent) { nodes { nameWithOwner } } }
  toReview: search(type: ISSUE, first: 30, query: $reviewQ) { nodes { ${PR_FIELDS} } }
  authored: search(type: ISSUE, first: 30, query: $authoredQ) { nodes { ${PR_FIELDS} } }
  mentions: search(type: ISSUE, first: $mentionsCount, query: $mentionsQ) @include(if: $withMentions) { nodes { ${PR_FIELDS} } }
}`;

/** The GraphQL variables of one read: the three searches, with the user's qualifiers added. */
export function queryVariables(c: Pick<Connection, 'repos' | 'recentRepos' | 'maxMentions' | 'query'>, hasRepos: boolean): Record<string, unknown> {
  const extra = c.query.trim().replace(/\s+/g, ' ');
  const q = (base: string) => (extra ? `${base} ${extra}` : base);
  const mentions = Math.max(0, Math.min(50, Math.round(c.maxMentions) || 0));
  return {
    recent: !hasRepos,
    recentCount: Math.max(1, Math.min(20, Math.round(c.recentRepos) || 5)),
    withMentions: mentions > 0,
    mentionsCount: Math.max(1, mentions),
    reviewQ: q('is:open is:pr archived:false review-requested:@me sort:created-asc'),
    authoredQ: q('is:open is:pr archived:false author:@me sort:updated-desc'),
    mentionsQ: q('is:open archived:false mentions:@me sort:updated-desc'),
  };
}

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

interface Cached { etag: string; body: string; link: string | null }

/**
 * What a read remembers between reads, kept apart for each source profile
 * (Kiosko 0.2.12 on: two accounts, an Enterprise host): one account's rate
 * limit, notifications poll interval or last good data never leak into
 * another's. The default profile is `''`.
 */
interface ReadState {
  /** ETag cache: `credential tail + url` → last 200 body (and its Link header). */
  etags: Map<string, Cached>;
  /** Earliest time the notifications endpoint may be polled again (X-Poll-Interval). */
  notificationsNotBefore: number;
  lastNotifications: number | null;
  rateLimitedUntil: number;
  lastGood: GitHubData | undefined;
}

/** Module-wide, it lives as long as the plugin: one state per profile. */
const states = new Map<string, ReadState>();

/** The state of a profile (undefined or '' for the default one), made on first use. */
function stateOf(profile = ''): ReadState {
  let st = states.get(profile);
  if (!st) {
    st = { etags: new Map(), notificationsNotBefore: 0, lastNotifications: null, rateLimitedUntil: 0, lastGood: undefined };
    states.set(profile, st);
  }
  return st;
}

/** Forgets every cache, of every profile (tests). */
export function resetState(): void {
  states.clear();
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

async function getJson(deps: Deps, st: ReadState, token: string, url: string, signal: AbortSignal): Promise<{ status: number; body: string; headers: Headers; link: string | null }> {
  const key = `${token.slice(-8)} ${url}`;
  const cached = st.etags.get(key);
  const res = await deps.fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'kiosko-plugin-github',
      ...(cached ? { 'If-None-Match': cached.etag } : {}),
    },
    signal,
  });
  const until = rateLimit(res, deps.now());
  if (until) throw new RateLimited(until);
  if (res.status === 304 && cached) return { status: 200, body: cached.body, headers: res.headers, link: cached.link };
  const body = await res.text();
  const link = res.headers.get('link');
  if (res.ok) {
    const etag = res.headers.get('etag');
    if (etag) st.etags.set(key, { etag, body, link });
  }
  return { status: res.status, body, headers: res.headers, link };
}

/** The `rel="next"` URL of a Link header, if any. */
export function nextLink(link: string | null): string | null {
  for (const part of (link ?? '').split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
    if (m) return m[1]!;
  }
  return null;
}

/** GitHub serves at most 50 notifications a page; two pages tell a count from "99+". */
export const MAX_NOTIFICATIONS = 100;

/**
 * Unread notifications, counted over up to two pages (`MAX_NOTIFICATIONS`):
 * enough for the inbox's "99+". Null when the token can't read them.
 */
async function countNotifications(deps: Deps, st: ReadState, token: string, rest: string, signal: AbortSignal): Promise<{ count: number | null; poll: number }> {
  let url: string | null = `${rest}/notifications?per_page=50`;
  let count = 0;
  let poll = 0;
  for (let page = 0; url && page * 50 < MAX_NOTIFICATIONS; page++) {
    const r = await getJson(deps, st, token, url, signal);
    if (page === 0) poll = Number(r.headers.get('x-poll-interval'));
    if (r.status !== 200) return { count: page === 0 ? null : count, poll };
    count += (JSON.parse(r.body) as unknown[]).length;
    url = nextLink(r.link);
  }
  return { count: Math.min(count, MAX_NOTIFICATIONS), poll };
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

/**
 * One read of everything the cards show. `signal` aborts it (Kiosko aborts
 * it after the source's `timeoutMs`). `profile`: the source profile being
 * read (`ctx.profile`), whose caches and rate limit it uses.
 */
export async function readGitHub(c: Connection, signal: AbortSignal, deps: Deps = defaultDeps, profile?: string): Promise<GitHubData> {
  const st = stateOf(profile);
  const now = deps.now();
  if (now < st.rateLimitedUntil) return { ...(st.lastGood ?? empty('ok')), rateLimitedUntil: st.rateLimitedUntil };
  const token = await resolveToken(c, deps, signal);
  if (!token) return empty('unconfigured');
  const api = endpoints(c.host);
  const repos = c.repos.map((r) => r.trim().replace(/^https?:\/\/[^/]+\//, '').replace(/\/+$/, '')).filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r));
  try {
    const gq = await deps.fetch(api.graphql, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': 'kiosko-plugin-github' },
      body: JSON.stringify({ query: QUERY, variables: queryVariables(c, repos.length > 0) }),
      signal,
    });
    const until = rateLimit(gq, now);
    if (until) throw new RateLimited(until);
    if (gq.status === 401) {
      throw new PluginError({
        en: 'GitHub: bad credentials (401): check the access token in this source, or run gh auth login',
        es: 'GitHub: credenciales incorrectas (401): revisa el token de acceso de esta fuente o ejecuta gh auth login',
        de: 'GitHub: ungültige Anmeldedaten (401): Prüfe das Zugriffstoken in dieser Datenquelle oder führe gh auth login aus',
        'zh-Hant': 'GitHub：憑證錯誤（401）：請檢查此資料來源的存取權杖，或執行 gh auth login',
        'zh-Hans': 'GitHub：凭据错误（401）：请检查此数据源的访问令牌，或运行 gh auth login',
      });
    }
    if (!gq.ok) throw new Error(`GitHub GraphQL HTTP ${gq.status}`);
    const viewer = parseViewer(await gq.text(), now);

    const problems: string[] = [];
    const perPage = Math.max(1, Math.min(30, Math.round(c.runsPerRepo) || 10));
    const runLists = await Promise.all((repos.length ? repos : viewer.recentRepos).map(async (repo) => {
      const r = await getJson(deps, st, token, `${api.rest}/repos/${repo}/actions/runs?per_page=${perPage}&exclude_pull_requests=true`, signal);
      if (r.status !== 200) {
        problems.push(`${repo}: HTTP ${r.status}`);
        return [];
      }
      return parseRuns(r.body, repo);
    }));

    if (now >= st.notificationsNotBefore) {
      const { count, poll } = await countNotifications(deps, st, token, api.rest, signal);
      st.notificationsNotBefore = now + (poll > 0 ? poll * 1000 : 60_000);
      st.lastNotifications = count;
    }

    st.lastGood = {
      state: 'ok',
      me: viewer.me,
      runs: runLists.flat(),
      authored: viewer.authored,
      toReview: viewer.toReview,
      mentions: viewer.mentions,
      notifications: st.lastNotifications,
      ...(problems.length ? { problems } : {}),
    };
    return st.lastGood;
  } catch (e) {
    if (e instanceof RateLimited) {
      st.rateLimitedUntil = e.until;
      return { ...(st.lastGood ?? empty('ok')), rateLimitedUntil: st.rateLimitedUntil };
    }
    throw e;
  }
}

/* ---------- presentation helpers ---------- */

/** The alias of a repo (by name or full name), if it has one. */
export function aliasOf(repo: string, aliases: Record<string, string> = {}): string | undefined {
  return aliases[repo] ?? aliases[repo.split('/').pop() ?? repo];
}

/** `octo-org/web-app#412` → `web-app#412`; aliases (by repo name or full name) win; long names are cut. */
export function shortRef(repo: string, number?: number, aliases: Record<string, string> = {}): string {
  const name = aliasOf(repo, aliases) ?? repo.split('/').pop() ?? repo;
  const cut = name.length > 10 ? `${name.slice(0, 9)}…` : name;
  return number === undefined ? cut : `${cut}#${number}`;
}

/** Whether a repo passes a `repos` filter: by its full name, its name or its alias. */
export function inRepos(repo: string, repos: Filter, aliases: Record<string, string> = {}): boolean {
  const alias = aliasOf(repo, aliases);
  return matchFilter(alias ? [repo, alias] : repo, repos);
}

/** How long a run has taken, in ms: running ones up to `now`; null while queued. */
export function runMs(run: Pick<Run, 'status' | 'startedAt' | 'updatedAt'>, now: number): number | null {
  if (run.status === 'queued') return null;
  const end = run.status === 'in_progress' ? now : Date.parse(run.updatedAt);
  return Math.max(0, end - Date.parse(run.startedAt));
}

export interface Look {
  label: Localized;
  color: string;
  /** Sort order: broken first. */
  rank: number;
}

type Colors = { alert: string; warn: string; info: string; ok: string; inkDim: string };
const PLAIN: Colors = { alert: '', warn: '', info: '', ok: '', inkDim: '' };

/** How each run status is called and coloured, as gitlab's pipelines. */
export function runLook(status: RunStatus, colors: Colors): Look {
  switch (status) {
    case 'failure': return { label: { en: 'failed', es: 'falla', de: 'Fehler', 'zh-Hant': '失敗', 'zh-Hans': '失败' }, color: colors.alert, rank: 0 };
    case 'in_progress': return { label: { en: 'running', es: 'en curso', de: 'läuft', 'zh-Hant': '執行中', 'zh-Hans': '运行中' }, color: colors.info, rank: 1 };
    case 'queued': return { label: { en: 'queued', es: 'en cola', de: 'eingereiht', 'zh-Hant': '排隊中', 'zh-Hans': '排队中' }, color: colors.warn, rank: 2 };
    case 'action_required': return { label: { en: 'waiting', es: 'espera', de: 'wartet', 'zh-Hant': '等待中', 'zh-Hans': '等待中' }, color: colors.warn, rank: 3 };
    case 'success': return { label: { en: 'passed', es: 'ok', de: 'ok', 'zh-Hant': '通過', 'zh-Hans': '通过' }, color: colors.ok, rank: 4 };
    case 'cancelled': return { label: { en: 'canceled', es: 'cancelado', de: 'abgebrochen', 'zh-Hant': '已取消', 'zh-Hans': '已取消' }, color: colors.inkDim, rank: 5 };
    default: return { label: { en: 'skipped', es: 'saltado', de: 'übersprungen', 'zh-Hant': '已略過', 'zh-Hans': '已跳过' }, color: colors.inkDim, rank: 5 };
  }
}

/** A pull request's state in one word: what blocks it first (failing checks, changes asked), else where it is. */
export function prLook(pr: PullRequest, colors: Colors): Look {
  if (pr.kind === 'issue') return { label: { en: 'issue', es: 'issue', de: 'Issue', 'zh-Hant': '問題', 'zh-Hans': '议题' }, color: colors.inkDim, rank: 5 };
  if (pr.checks === 'failure') return { label: { en: 'checks fail', es: 'checks fallan', de: 'Checks rot', 'zh-Hant': '檢查失敗', 'zh-Hans': '检查失败' }, color: colors.alert, rank: 0 };
  if (pr.review === 'changes_requested') return { label: { en: 'changes', es: 'cambios', de: 'Änderungen', 'zh-Hant': '需修改', 'zh-Hans': '需修改' }, color: colors.warn, rank: 1 };
  if (pr.checks === 'pending') return { label: { en: 'running', es: 'en curso', de: 'läuft', 'zh-Hant': '執行中', 'zh-Hans': '运行中' }, color: colors.info, rank: 2 };
  if (pr.review === 'approved') return { label: { en: 'approved', es: 'aprobada', de: 'genehmigt', 'zh-Hant': '已核准', 'zh-Hans': '已批准' }, color: colors.ok, rank: 4 };
  if (pr.checks === 'success') return { label: { en: 'passed', es: 'ok', de: 'ok', 'zh-Hant': '通過', 'zh-Hans': '通过' }, color: colors.ok, rank: 3 };
  return { label: { en: 'no CI', es: 'sin CI', de: 'kein CI', 'zh-Hant': '無 CI', 'zh-Hans': '无 CI' }, color: colors.inkDim, rank: 3 };
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

/** Options of `github/actions` that choose which runs it lists. */
export interface RunFilter {
  onlyLatest: boolean;
  hidePassing: boolean;
  repos: Filter;
  branches: Filter;
  aliases: Record<string, string>;
}

/** The runs `github/actions` lists: broken first, then the most recently started. */
export function runItems(runs: Run[], o: RunFilter): Run[] {
  return (o.onlyLatest ? latestRuns(runs) : runs)
    .filter((r) => !(o.hidePassing && r.status === 'success') && inRepos(r.repo, o.repos, o.aliases) && matchFilter(r.branch, o.branches))
    .map((r) => ({ r, rank: runLook(r.status, PLAIN).rank }))
    .sort((a, b) => a.rank - b.rank || b.r.startedAt.localeCompare(a.r.startedAt))
    .map((x) => x.r);
}

/** Options of `github/reviews` that choose which pull requests it lists. */
export interface PullFilter {
  includeMine: boolean;
  includeMentions: boolean;
  includeDrafts: boolean;
  hideApproved: boolean;
  repos: Filter;
  aliases: Record<string, string>;
}

/**
 * The pull requests `github/reviews` lists, each once: waiting for you
 * (oldest first), then yours (most blocked first), then mentions. `mine`
 * marks yours.
 */
export function pullItems(data: Pick<GitHubData, 'me' | 'toReview' | 'authored' | 'mentions'>, o: PullFilter): { p: PullRequest; mine: boolean }[] {
  const ok = (p: PullRequest) => (o.includeDrafts || !p.draft) && !(o.hideApproved && p.review === 'approved') && inRepos(p.repo, o.repos, o.aliases);
  const seen = new Set<string>();
  const once = (p: PullRequest) => {
    const k = `${p.repo}#${p.number}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  };
  return [
    ...data.toReview.filter(ok).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((p) => ({ p, mine: false })),
    ...(o.includeMine ? data.authored.filter(ok).sort((a, b) => prLook(a, PLAIN).rank - prLook(b, PLAIN).rank || b.updatedAt.localeCompare(a.updatedAt)).map((p) => ({ p, mine: true })) : []),
    ...(o.includeMentions ? data.mentions.filter((p) => p.author !== data.me && ok(p)).map((p) => ({ p, mine: false })) : []),
  ].filter(({ p }) => once(p));
}

/** Sample data for the gallery: made-up repos and people. */
export function demoGitHub(now: number, locale = 'en'): GitHubData {
  // Titles a team writes in its own language: localized like any other text (scripts/i18n-gaps.ts).
  const T = {
    router: { en: 'Bump the router to v7', es: 'Subir el router a v7', de: 'Router auf v7 anheben', 'zh-Hant': '路由升級到 v7', 'zh-Hans': '路由升级到 v7' },
    flaky: { en: 'Fix the flaky login test', es: 'Arreglar el test de login inestable', de: 'Wackeligen Login-Test reparieren', 'zh-Hant': '修正不穩定的登入測試', 'zh-Hans': '修复不稳定的登录测试' },
    rateLimit: { en: 'Rate-limit the public endpoints', es: 'Limitar peticiones a endpoints públicos', de: 'Öffentliche Endpunkte drosseln', 'zh-Hant': '公開端點加上速率限制', 'zh-Hans': '公开接口加上限流' },
    aliases: { en: 'Tidy the shell aliases', es: 'Ordenar los alias de la shell', de: 'Shell-Aliase aufräumen', 'zh-Hant': '整理 shell 別名', 'zh-Hans': '整理 shell 别名' },
    onboarding: { en: 'Update the onboarding guide', es: 'Actualizar la guía de bienvenida', de: 'Onboarding-Leitfaden aktualisieren', 'zh-Hant': '更新新人入門指南', 'zh-Hans': '更新新人入职指南' },
    darkMode: { en: 'Dark mode toggle in settings', es: 'Interruptor de modo oscuro en ajustes', de: 'Dunkelmodus-Schalter in den Einstellungen', 'zh-Hant': '在設定中加入深色模式開關', 'zh-Hans': '设置中加入深色模式开关' },
    offline: { en: 'Offline sync for drafts', es: 'Sincronizar borradores sin conexión', de: 'Offline-Sync für Entwürfe', 'zh-Hant': '草稿離線同步', 'zh-Hans': '草稿离线同步' },
    certs: { en: 'Rotate the staging certificates', es: 'Rotar los certificados de staging', de: 'Staging-Zertifikate rotieren', 'zh-Hant': '更換測試環境憑證', 'zh-Hans': '轮换预发环境证书' },
    perms: { en: 'Cache user permissions per request', es: 'Cachear permisos de usuario por petición', de: 'Benutzerrechte pro Anfrage cachen', 'zh-Hant': '每個請求快取使用者權限', 'zh-Hans': '按请求缓存用户权限' },
    charts: { en: 'Move the charts to the new library', es: 'Pasar las gráficas a la nueva librería', de: 'Diagramme auf neue Bibliothek umstellen', 'zh-Hant': '圖表改用新的函式庫', 'zh-Hans': '图表迁移到新库' },
    blank: { en: 'Login page is blank on Safari 17', es: 'Login en blanco en Safari 17', de: 'Login-Seite leer in Safari 17', 'zh-Hant': 'Safari 17 登入頁一片空白', 'zh-Hans': 'Safari 17 登录页一片空白' },
  } satisfies Record<string, Localized>;
  const n = (key: keyof typeof T) => localize(T[key], locale);

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
      run('octo-org/web-app', 9001, 'CI', 'main', 'sam', 'failure', 25, 6, n('router')),
      run('octo-org/web-app', 9002, 'CI', 'fix/login-flake', 'you', 'in_progress', 3, 0, n('flaky')),
      run('octo-org/api', 9003, 'Deploy', 'main', 'jordan', 'queued', 1, 0, n('rateLimit')),
      run('octo-org/api', 9004, 'Tests', 'main', 'jordan', 'success', 40, 4, n('rateLimit')),
      run('you/dotfiles', 9005, 'Lint', 'main', 'you', 'success', 300, 1, n('aliases')),
      run('octo-org/docs', 9006, 'Pages', 'main', 'alex', 'cancelled', 600, 2, n('onboarding')),
    ],
    authored: [
      pr('octo-org/web-app', 412, n('flaky'), 'you', 30 * 60, 'review_required', 'failure'),
      pr('octo-org/api', 88, n('rateLimit'), 'you', 6 * 60, 'changes_requested', 'success'),
      pr('octo-org/web-app', 405, n('darkMode'), 'you', 120 * 60, 'approved', 'success'),
      pr('octo-org/mobile', 17, n('offline'), 'you', 200 * 60, null, 'pending', { draft: true }),
    ],
    toReview: [
      pr('octo-org/infra', 12, n('certs'), 'jordan', 50 * 60, 'review_required', 'failure'),
      pr('octo-org/api', 91, n('perms'), 'sam', 26 * 60, 'review_required', 'pending'),
      pr('octo-org/web-app', 398, n('charts'), 'alex', 3 * 60, 'review_required', 'success'),
    ],
    mentions: [
      pr('octo-org/web-app', 377, n('blank'), 'riley', 48 * 60, null, null, { kind: 'issue' }),
    ],
    notifications: 7,
  };
}
