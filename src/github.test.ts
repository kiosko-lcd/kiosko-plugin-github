import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import * as kit from '@loksly/lcd-canvas-kit';
import {
  age, demoGitHub, duration, endpoints, hostName, latestRuns, parseRuns, parseViewer, prLook, readGitHub, resetState, runLook, runStatus, shortRef,
  type Connection, type Deps,
} from './github.ts';
import plugin from './index.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const RUNS = fixture('workflow-runs.json');
const VIEWER = fixture('graphql-viewer.json');
const NOTIFS = fixture('notifications.json');
const NOW = Date.parse('2026-11-09T10:12:00Z');
const colors = { alert: 'r', warn: 'a', info: 'b', ok: 'v', inkDim: 'g' };

const conn = (o: Partial<Connection> = {}): Connection => ({ host: '', token: 'ghp_test1234', bin: 'gh', repos: ['octo-org/web-app'], runsPerRepo: 10, mentions: true, ...o });

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
  assert.equal(duration(runs[0]!, NOW), '6:28');
  assert.equal(duration(runs[1]!, NOW), '1:55', 'running: counts up to now');
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

test('short references, age and looks', () => {
  assert.equal(shortRef('octo-org/web-app', 412), 'web-app#412');
  assert.equal(shortRef('octo-org/integration-tests', 120), 'integrati…#120');
  assert.equal(shortRef('octo-org/integration-tests', 120, { 'integration-tests': 'itest' }), 'itest#120');
  assert.equal(shortRef('octo-org/web-app'), 'web-app');
  assert.equal(age('2026-11-09T07:12:00Z', NOW, 'es'), '3 h');
  assert.ok(runLook('failure', colors).rank < runLook('in_progress', colors).rank && runLook('in_progress', colors).rank < runLook('success', colors).rank);
});

test('plugin: every widget reads the shared source, has demo data and paints every state', () => {
  assert.equal(plugin.sources?.[0]?.id, 'activity');
  const token = (plugin.sources?.[0]?.options as { props: Record<string, { secret?: boolean }> }).props.token;
  assert.equal(token?.secret, true);
  const theme = {
    colors: { bg: '#000', surface: '#111', surfaceEdge: '#222', ink: '#fff', inkDim: '#aaa', inkFaint: '#555', accent: '#0af', alert: '#f00', warn: '#fa0', info: '#0af', ok: '#0f0' },
    fonts: { sans: 'sans-serif', sansBold: 'sans-serif', mono: 'monospace', monoBold: 'monospace' },
  };
  const demo = demoGitHub(NOW);
  const states = [demo, { ...demo, rateLimitedUntil: NOW + 600_000 }, { ...demo, state: 'unconfigured' as const }, { ...demo, runs: [], toReview: [], authored: [], mentions: [] }];
  for (const w of plugin.widgets ?? []) {
    assert.deepEqual(w.sources, ['github/activity']);
    assert.ok(w.icon && w.category && w.size?.preferred, w.id);
    assert.ok(w.demo!({ options: w.options!.default, now: NOW, locale: 'en' }).sources?.['github/activity'], w.id);
    for (const size of [w.size!.min!, w.size!.preferred!, { w: 300, h: 420 }]) {
      for (const data of states) {
        const c = createCanvas(size.w, size.h);
        const g = c.getContext('2d');
        w.render(g, {
          options: w.options!.default, data: undefined, sources: { 'github/activity': data }, now: NOW, working: true, locale: 'es', t: (x: string | { en: string; es?: string }) => (typeof x === 'string' ? x : (x.es ?? x.en)),
          log: () => {}, dataDir: '/tmp', box: { x: 0, y: 0, w: size.w, h: size.h }, theme: theme as never, fonts: theme.fonts, kit, canvas: { createCanvas, loadImage: (() => {}) as never }, preview: true,
        } as never);
      }
    }
  }
});
