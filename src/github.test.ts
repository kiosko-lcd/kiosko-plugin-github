import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import * as kit from '@loksly/lcd-canvas-kit';
import { createBaseContext, DEFAULT_THEME, validate, type WidgetDefinition } from '@kiosko/sdk';
import {
  demoGitHub, endpoints, hostName, inRepos, latestRuns, MAX_NOTIFICATIONS, nextLink, parseRuns, parseViewer, prLook, pullItems, queryVariables, readGitHub, resetState, runItems, runLook, runMs, runStatus, shortRef,
  type Connection, type Deps, type GitHubData,
} from './github.ts';
import plugin, { actions, inbox, reviews } from './index.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const RUNS = fixture('workflow-runs.json');
const VIEWER = fixture('graphql-viewer.json');
const NOTIFS = fixture('notifications.json');
const NOW = Date.parse('2026-11-09T10:12:00Z');
const colors = { alert: 'r', warn: 'a', info: 'b', ok: 'v', inkDim: 'g' };

const conn = (o: Partial<Connection> = {}): Connection => ({ host: '', token: 'ghp_test1234', bin: 'gh', repos: ['octo-org/web-app'], recentRepos: 5, runsPerRepo: 10, maxMentions: 10, query: '', ...o });

interface Call { url: string; init?: RequestInit }

/** A fake GitHub: routes by URL, records calls, answers 304 to a matching If-None-Match. */
function fakeGitHub(overrides: { graphql?: () => Response; runs?: () => Response; notifications?: () => Response } = {}) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const inm = (init?.headers as Record<string, string> | undefined)?.['If-None-Match'];
    if (url.endsWith('/graphql')) return overrides.graphql?.() ?? new Response(VIEWER, { status: 200 });
    if (url.includes('/actions/runs')) {
      if (overrides.runs) return overrides.runs();
      return inm === 'W/"runs-1"' ? new Response(null, { status: 304 }) : new Response(RUNS, { status: 200, headers: { ETag: 'W/"runs-1"' } });
    }
    if (url.includes('/notifications')) return overrides.notifications?.() ?? new Response(NOTIFS, { status: 200, headers: { ETag: '"n-1"', 'X-Poll-Interval': '60' } });
    return new Response('{"message":"Not Found"}', { status: 404 });
  }) as typeof fetch;
  return { calls, fetch: f };
}

const deps = (f: typeof fetch, extra: Partial<Deps> = {}): Deps => ({ fetch: f, exec: async () => { throw new Error('gh: not found'); }, now: () => NOW, ...extra });
const signal = new AbortController().signal;

beforeEach(() => resetState());

test('workflow runs: status folded, triggering actor, start time', () => {
  const runs = parseRuns(RUNS, 'octo-org/web-app');
  assert.deepEqual(runs.map((r) => r.status), ['failure', 'in_progress', 'success']);
  assert.equal(runs[0]!.workflow, 'CI');
  assert.equal(runs[0]!.title, 'Bump the router to v7');
  assert.equal(runs[1]!.actor, 'rerunner', 'whoever re-ran it');
  assert.equal(runs[2]!.actor, 'dependabot[bot]');
  assert.equal(runMs(runs[0]!, NOW), (6 * 60 + 28) * 1000);
  assert.equal(runMs(runs[1]!, NOW), (60 + 55) * 1000, 'running: counts up to now');
  assert.equal(runMs({ ...runs[1]!, status: 'queued' }, NOW), null);
  assert.equal(runStatus('waiting', null), 'queued');
  assert.equal(runStatus('completed', 'timed_out'), 'failure');
  assert.equal(runStatus('completed', 'stale'), 'skipped');
  assert.equal(latestRuns(runs).length, 2, 'one per workflow + branch');
});

test('GraphQL viewer: review requested, mine with review and checks, mentions', () => {
  const v = parseViewer(VIEWER);
  assert.equal(v.me, 'you');
  assert.deepEqual(v.recentRepos, ['octo-org/web-app', 'you/dotfiles']);
  assert.equal(v.toReview[0]!.checks, 'failure');
  assert.equal(v.authored[0]!.review, 'changes_requested');
  assert.equal(v.authored[1]!.draft, true);
  assert.equal(v.authored[1]!.checks, null);
  assert.equal(v.mentions[0]!.kind, 'issue');
  assert.equal(v.mentions[0]!.author, 'ghost');
  assert.deepEqual(v.authored.map((p) => prLook(p, colors).label), [{ en: 'changes', es: 'cambios' }, { en: 'no CI', es: 'sin CI' }]);
  assert.throws(() => parseViewer('{"data":null,"errors":[{"type":"RATE_LIMITED","message":"API rate limit exceeded"}]}'), /rate limit/);
  assert.throws(() => parseViewer('{"errors":[{"message":"Bad credentials"}]}'), /Bad credentials/);
});

test('hosts: github.com and Enterprise endpoints', () => {
  assert.deepEqual(endpoints(''), { rest: 'https://api.github.com', graphql: 'https://api.github.com/graphql' });
  assert.deepEqual(endpoints('api.github.com'), endpoints(''));
  assert.deepEqual(endpoints('https://github.example.com/'), { rest: 'https://github.example.com/api/v3', graphql: 'https://github.example.com/api/graphql' });
  assert.equal(hostName('https://GitHub.Example.com/'), 'github.example.com');
});

test('read: one GraphQL call, runs per repo, notifications; ETag makes the second runs call a 304', async () => {
  const gh = fakeGitHub();
  const d = await readGitHub(conn(), signal, deps(gh.fetch));
  assert.equal(d.state, 'ok');
  assert.equal(d.runs.length, 3);
  assert.equal(d.toReview.length, 1);
  assert.equal(d.notifications, 3);
  const auth = (gh.calls[0]!.init!.headers as Record<string, string>).Authorization;
  assert.equal(auth, 'Bearer ghp_test1234');
  assert.match(String(gh.calls[0]!.init!.body), /"recent":false/, 'repos configured: no recent-repos lookup');

  gh.calls.length = 0;
  const d2 = await readGitHub(conn(), signal, deps(gh.fetch));
  const runsCall = gh.calls.find((c) => c.url.includes('/actions/runs'))!;
  assert.equal((runsCall.init!.headers as Record<string, string>)['If-None-Match'], 'W/"runs-1"');
  assert.equal(d2.runs.length, 3, '304: the cached body is used');
  assert.ok(!gh.calls.some((c) => c.url.includes('/notifications')), 'X-Poll-Interval honoured');
});

test('read: no repos configured uses the recently pushed ones', async () => {
  const gh = fakeGitHub();
  await readGitHub(conn({ repos: [] }), signal, deps(gh.fetch));
  const runUrls = gh.calls.filter((c) => c.url.includes('/actions/runs')).map((c) => c.url);
  assert.deepEqual(runUrls.map((u) => u.split('/repos/')[1]!.split('/actions')[0]), ['octo-org/web-app', 'you/dotfiles']);
});

test('read: no token, no gh → not configured; gh token used when there', async () => {
  const gh = fakeGitHub();
  assert.equal((await readGitHub(conn({ token: '' }), signal, deps(gh.fetch))).state, 'unconfigured');
  assert.equal(gh.calls.length, 0);
  let args: string[] = [];
  const d = await readGitHub(conn({ token: '', host: 'github.example.com' }), signal, deps(gh.fetch, { exec: async (_b, a) => { args = a; return 'gho_fromgh\n'; } }));
  assert.deepEqual(args, ['auth', 'token', '--hostname', 'github.example.com']);
  assert.equal(d.state, 'ok');
  assert.equal(gh.calls[0]!.url, 'https://github.example.com/api/graphql');
  assert.equal((gh.calls[0]!.init!.headers as Record<string, string>).Authorization, 'Bearer gho_fromgh');
});

test('read: rate limit keeps the last data, flags it and stops calling until the reset', async () => {
  const reset = Math.floor(NOW / 1000) + 600;
  let limited = false;
  const gh = fakeGitHub({ graphql: () => (limited ? new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } }) : new Response(VIEWER)) });
  await readGitHub(conn(), signal, deps(gh.fetch));
  limited = true;
  const d = await readGitHub(conn(), signal, deps(gh.fetch));
  assert.equal(d.rateLimitedUntil, reset * 1000);
  assert.equal(d.runs.length, 3, 'last good data kept');
  gh.calls.length = 0;
  await readGitHub(conn(), signal, deps(gh.fetch, { now: () => NOW + 60_000 }));
  assert.equal(gh.calls.length, 0, 'nothing called before the reset');
});

test('read: fine-grained tokens without notifications, a repo without access, bad credentials', async () => {
  const gh = fakeGitHub({ notifications: () => new Response('{"message":"Resource not accessible by personal access token"}', { status: 403 }), runs: () => new Response('{"message":"Not Found"}', { status: 404 }) });
  const d = await readGitHub(conn(), signal, deps(gh.fetch));
  assert.equal(d.notifications, null);
  assert.deepEqual(d.problems, ['octo-org/web-app: HTTP 404']);
  resetState();
  await assert.rejects(readGitHub(conn(), signal, deps(fakeGitHub({ graphql: () => new Response('{"message":"Bad credentials"}', { status: 401 }) }).fetch)), /401/);
});

test('short references, the repos filter and looks', () => {
  assert.equal(shortRef('octo-org/web-app', 412), 'web-app#412');
  assert.equal(shortRef('octo-org/integration-tests', 120), 'integrati…#120');
  assert.equal(shortRef('octo-org/integration-tests', 120, { 'integration-tests': 'itest' }), 'itest#120');
  assert.equal(shortRef('octo-org/web-app'), 'web-app');
  assert.ok(inRepos('octo-org/web-app', ['web-*']));
  assert.ok(inRepos('octo-org/web-app', ['octo-org/*', '!*-old']));
  assert.ok(!inRepos('octo-org/web-app', ['api']));
  assert.ok(inRepos('octo-org/web-app', ['front'], { 'web-app': 'front' }), 'by alias');
  assert.ok(runLook('failure', colors).rank < runLook('in_progress', colors).rank && runLook('in_progress', colors).rank < runLook('success', colors).rank);
});

test('query variables: recent repos, mentions and extra qualifiers', () => {
  const v = queryVariables(conn({ recentRepos: 12, maxMentions: 0, query: '  org:acme   -repo:acme/old ' }), false);
  assert.equal(v.recent, true);
  assert.equal(v.recentCount, 12);
  assert.equal(v.withMentions, false);
  assert.equal(v.reviewQ, 'is:open is:pr archived:false review-requested:@me sort:created-asc org:acme -repo:acme/old');
  assert.match(String(v.authoredQ), /author:@me .* org:acme/);
  const w = queryVariables(conn({ maxMentions: 25 }), true);
  assert.deepEqual([w.recent, w.withMentions, w.mentionsCount, w.reviewQ], [false, true, 25, 'is:open is:pr archived:false review-requested:@me sort:created-asc']);
});

test('read: the recent repos count and the qualifiers go to GraphQL as variables', async () => {
  const gh = fakeGitHub();
  await readGitHub(conn({ repos: [], recentRepos: 9, query: 'org:"acme corp"' }), signal, deps(gh.fetch));
  const body = JSON.parse(String(gh.calls[0]!.init!.body)) as { query: string; variables: Record<string, unknown> };
  assert.equal(body.variables.recentCount, 9);
  assert.match(String(body.variables.reviewQ), /org:"acme corp"$/);
  assert.doesNotMatch(body.query, /acme/, 'user text never inside the query itself');
});

const notifs = (n: number, from = 0) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: String(from + i) })));

test('notifications: counted over two pages, so the inbox can tell 70 from "99+"', async () => {
  const link = (page: number) => `<https://api.github.com/notifications?per_page=50&page=${page}>; rel="next", <https://api.github.com/notifications?per_page=50&page=4>; rel="last"`;
  assert.equal(nextLink(link(2)), 'https://api.github.com/notifications?per_page=50&page=2');
  assert.equal(nextLink('<https://x/a?page=3>; rel="last"'), null);
  assert.equal(nextLink(null), null);
  let pages = 0;
  const seventy = fakeGitHub({ notifications: () => (++pages === 1 ? new Response(notifs(50), { headers: { Link: link(2) } }) : new Response(notifs(20, 50))) });
  assert.equal((await readGitHub(conn(), signal, deps(seventy.fetch))).notifications, 70);
  assert.equal(seventy.calls.filter((c) => c.url.includes('/notifications')).length, 2);
  resetState();
  const lots = fakeGitHub({ notifications: () => new Response(notifs(50), { headers: { Link: link(3) } }) });
  const d = await readGitHub(conn(), signal, deps(lots.fetch));
  assert.equal(d.notifications, MAX_NOTIFICATIONS);
  assert.equal(lots.calls.filter((c) => c.url.includes('/notifications')).length, 2, 'never more than two pages');
});

test('notifications: a 304 keeps the count across pages (the Link header is cached with the body)', async () => {
  const link = '<https://api.github.com/notifications?per_page=50&page=2>; rel="next"';
  const gh = fakeGitHub({ notifications: () => new Response(null, { status: 304 }) });
  let first = true;
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/notifications') && first) {
      if (url.includes('page=2')) { first = false; return new Response(notifs(5), { headers: { ETag: '"p2"' } }); }
      return new Response(notifs(50), { headers: { ETag: '"p1"', Link: link } });
    }
    return gh.fetch(input, init);
  }) as typeof fetch;
  assert.equal((await readGitHub(conn(), signal, deps(f))).notifications, 55);
  const later = await readGitHub(conn(), signal, deps(f, { now: () => NOW + 120_000 }));
  assert.equal(later.notifications, 55);
});

const data = demoGitHub(NOW);
const runOpts = { onlyLatest: true, hidePassing: false, repos: [] as string[], branches: [] as string[], aliases: {} as Record<string, string> };
const pullOpts = { includeMine: true, includeMentions: false, includeDrafts: false, hideApproved: false, repos: [] as string[], aliases: {} as Record<string, string> };

test('actions: broken first, hidePassing, repos and branches filters', () => {
  assert.deepEqual(runItems(data.runs, runOpts).map((r) => r.status), ['failure', 'in_progress', 'queued', 'success', 'success', 'cancelled']);
  assert.ok(!runItems(data.runs, { ...runOpts, hidePassing: true }).some((r) => r.status === 'success'));
  assert.deepEqual([...new Set(runItems(data.runs, { ...runOpts, repos: ['api'] }).map((r) => r.repo))], ['octo-org/api']);
  assert.ok(runItems(data.runs, { ...runOpts, repos: ['octo-org/*'] }).every((r) => r.repo.startsWith('octo-org/')));
  assert.deepEqual(runItems(data.runs, { ...runOpts, branches: ['fix/*'] }).map((r) => r.branch), ['fix/login-flake']);
  assert.ok(!runItems(data.runs, { ...runOpts, branches: ['!fix/*'] }).some((r) => r.branch.startsWith('fix/')));
});

test('pull requests: to review first, mine, mentions, drafts, hideApproved and repos', () => {
  const refs = (o = {}) => pullItems(data, { ...pullOpts, ...o }).map(({ p, mine }) => `${p.repo.split('/')[1]}#${p.number}${mine ? '*' : ''}`);
  assert.deepEqual(refs(), ['infra#12', 'api#91', 'web-app#398', 'web-app#412*', 'api#88*', 'web-app#405*']);
  assert.deepEqual(refs({ includeMine: false }), ['infra#12', 'api#91', 'web-app#398']);
  assert.ok(refs({ includeDrafts: true }).includes('mobile#17*'));
  assert.ok(!refs({ hideApproved: true }).includes('web-app#405*'));
  assert.deepEqual(refs({ includeMentions: true }).at(-1), 'web-app#377');
  assert.deepEqual(refs({ repos: ['api'] }), ['api#91', 'api#88*']);
});

/** Renders a widget and returns every text it drew, in order. */
function texts(w: WidgetDefinition<any, any>, options: Record<string, unknown>, d: GitHubData, size = { w: 600, h: 220 }, locale = 'en'): string[] {
  const out: string[] = [];
  const spy = { ...kit, drawTracked: (...a: Parameters<typeof kit.drawTracked>) => (out.push(a[1]), kit.drawTracked(...a)) };
  const canvas = createCanvas(size.w, size.h);
  const theme = DEFAULT_THEME;
  w.render(canvas.getContext('2d'), {
    ...createBaseContext({ now: NOW, locale, timeFormat: '24h' }), options: validate(w.options!, options).value, data: undefined, sources: { 'github/activity': d }, working: true,
    box: { x: 0, y: 0, w: size.w, h: size.h }, theme, fonts: theme.fonts, kit: spy, canvas: { createCanvas, loadImage: (() => {}) as never }, preview: false,
  } as never);
  return out;
}

const manyRuns = (n: number): GitHubData => ({ ...data, runs: Array.from({ length: n }, (_, i) => ({ ...data.runs[0]!, id: i, workflow: `WF${i}`, branch: `b${i}` })) });
const manyPulls = (n: number): GitHubData => ({ ...data, authored: [], toReview: Array.from({ length: n }, (_, i) => ({ ...data.toReview[0]!, number: i, title: `PR ${i}` })) });

test('actions: rows, layout and "+N more"; timers from ctx.fmt', () => {
  const titles = (t: string[]) => t.filter((x) => x.startsWith('WF')).length;
  let t = texts(actions, { rows: 4 }, manyRuns(10));
  assert.equal(titles(t), 4);
  assert.ok(t.includes('+6 more'));
  t = texts(actions, { layout: 'detailed' }, manyRuns(10));
  assert.ok(titles(t) < 10 && t.includes(`+${10 - titles(t)} more`));
  t = texts(actions, {}, data);
  assert.ok(t.includes('running 3 min'), t.join('|'));
  assert.ok(texts(actions, {}, data, undefined, 'es').includes('en curso 3 min'));
  t = texts(actions, { layout: 'detailed' }, data);
  assert.ok(t.some((x) => x === 'web-app · sam · 6 min'), t.join('|'));
});

test('reviews: no silent cuts; auto goes one line when that shows more', () => {
  const titles = (t: string[]) => t.filter((x) => x.startsWith('PR ')).length;
  let t = texts(reviews, { layout: 'detailed' }, manyPulls(9));
  assert.ok(titles(t) < 9 && t.includes(`+${9 - titles(t)} more`));
  t = texts(reviews, {}, manyPulls(7));
  assert.equal(titles(t), 7);
  t = texts(reviews, {}, data, { w: 600, h: 420 });
  assert.ok(t.includes('web-app#412 · yours · 1 d'), t.join('|'));
});

test('inbox: a token without notifications shows two numbers, not a dash; "99+"', () => {
  assert.deepEqual(texts(inbox, {}, data).filter((_, i) => i % 2 === 0), ['3', '1', '7']);
  assert.deepEqual(texts(inbox, {}, { ...data, notifications: null }).filter((_, i) => i % 2 === 0), ['3', '1']);
  assert.ok(texts(inbox, {}, { ...data, notifications: 100 }).includes('99+'));
});

test('empty lists and states: message, hidden when asked, rate-limit hint in the clock format', () => {
  const none: GitHubData = { ...data, runs: [], toReview: [], authored: [], mentions: [] };
  assert.deepEqual(texts(actions, {}, none), ['No recent workflow runs']);
  const state = (w: WidgetDefinition<any, any>, d: GitHubData | undefined) => ({ options: validate(w.options!, {}).value, data: undefined, sources: { 'github/activity': d }, now: NOW, working: true }) as never;
  assert.equal(reviews.empty!(state(reviews, none)), true);
  assert.equal(reviews.empty!(state(reviews, { ...none, state: 'unconfigured' })), false, 'not configured: says so');
  assert.equal(actions.empty!(state(actions, undefined)), false);
  assert.equal(reviews.hideWhenEmpty, true);
  assert.ok(!actions.hideWhenEmpty);
  const until = new Date(NOW + 600_000);
  const hint = `rate-limited, resumes ${String(until.getHours()).padStart(2, '0')}:${String(until.getMinutes()).padStart(2, '0')}`;
  assert.ok(texts(actions, {}, { ...data, rateLimitedUntil: until.getTime() }).includes(hint));
});

test('plugin: every widget reads the shared source, has demo data and paints every state', () => {
  const source = plugin.sources?.[0];
  assert.equal(source?.id, 'activity');
  assert.ok((source?.minIntervalMs ?? 0) >= 60_000, 'a floor for the API');
  const token = (source?.options as { props: Record<string, { secret?: boolean }> }).props.token;
  assert.equal(token?.secret, true);
  const demo = demoGitHub(NOW);
  const states = [demo, { ...demo, rateLimitedUntil: NOW + 600_000 }, { ...demo, state: 'unconfigured' as const }, { ...demo, runs: [], toReview: [], authored: [], mentions: [] }];
  for (const w of plugin.widgets ?? []) {
    assert.deepEqual(w.sources, ['github/activity']);
    assert.ok(w.icon && w.category && w.size?.preferred, w.id);
    assert.ok(w.demo!({ options: w.options!.default, now: NOW, locale: 'en' }).sources?.['github/activity'], w.id);
    for (const size of [w.size!.min!, w.size!.preferred!, { w: 300, h: 420 }]) {
      for (const d of states) for (const options of [{}, { rows: 3 }, { layout: 'detailed' }, { layout: 'one-line' }]) texts(w, options, d, size, 'es');
    }
  }
});
