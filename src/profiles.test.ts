/**
 * Several accounts (Kiosko 0.2.12 on): the source declares profiles, and each
 * profile (a personal account, a work one, an Enterprise host) reads its own
 * server with its own token and keeps its own ETags, notifications poll,
 * last data and rate limit. Fake servers only.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { createBaseContext, validate } from '@kiosko/sdk';
import { readGitHub, resetState, type Connection, type Deps, type GitHubData } from './github.ts';
import { activity } from './index.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const VIEWER = fixture('graphql-viewer.json');
const RUNS = fixture('workflow-runs.json');
const NOTIFS = fixture('notifications.json');

interface Fake {
  server: Server;
  host: string;
  /** `METHOD path auth if-none-match` of every request. */
  seen: string[];
}

/** A fake GitHub Enterprise answering only its token, with its own org's repos and an ETag on the runs. */
async function fakeEnterprise(token: string, org: string, login: string): Promise<Fake> {
  const seen: string[] = [];
  const viewer = VIEWER.replaceAll('octo-org/', `${org}/`).replace('"login": "you"', `"login": "${login}"`);
  const server = createServer((req: IncomingMessage, res) => {
    const inm = req.headers['if-none-match'] ?? '';
    seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''} ${inm}`.trim());
    if (req.headers.authorization !== `Bearer ${token}`) return void res.writeHead(401).end('{"message":"Bad credentials"}');
    if (req.url === '/api/graphql') return void res.writeHead(200).end(viewer);
    if (req.url?.startsWith(`/api/v3/repos/${org}/`)) {
      const etag = `W/"${org}-runs"`;
      return void (inm === etag ? res.writeHead(304).end() : res.writeHead(200, { etag }).end(RUNS));
    }
    if (req.url?.startsWith('/api/v3/notifications')) return void res.writeHead(200, { 'x-poll-interval': '60' }).end(NOTIFS);
    res.writeHead(404).end('{"message":"Not Found"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, host: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
}

let personal: Fake;
let work: Fake;
before(async () => {
  personal = await fakeEnterprise('ghp_personal', 'you-org', 'you');
  work = await fakeEnterprise('ghp_work', 'acme', 'm-losantos');
});
after(() => {
  personal.server.close();
  work.server.close();
});
beforeEach(() => resetState());

function ctx(options: Record<string, unknown>, profile?: string) {
  return {
    ...createBaseContext({ now: Date.now(), locale: 'en' }),
    options: validate(activity.options!, options).value as never,
    signal: new AbortController().signal,
    intervalMs: 120_000,
    timeoutMs: 30_000,
    ...(profile ? { profile } : {}),
  };
}
const read = (o: Record<string, unknown>, profile?: string) => activity.read!(ctx(o, profile)) as Promise<GitHubData>;
const repoChoices = (d: GitHubData) => activity.choices!.repos!(d, { locale: 'en', t: (x) => (typeof x === 'string' ? x : x.en ?? '') }).map((c) => c.value);

test('source: declares profiles, in a way an older SDK ignores', () => {
  assert.equal((activity as { profiles?: boolean }).profiles, true);
});

test('profiles: two accounts read at once, each its own server, token, data and repo choices', async () => {
  const p = { host: personal.host, token: 'ghp_personal', repos: ['you-org/web-app'] };
  const w = { host: work.host, token: 'ghp_work', repos: ['acme/web-app'] };
  const [a, b] = await Promise.all([read(p), read(w, 'work')]);
  assert.equal(a.me, 'you');
  assert.equal(b.me, 'm-losantos');
  assert.ok(a.runs.length && a.runs.every((r) => r.repo === 'you-org/web-app'));
  assert.ok(b.runs.length && b.runs.every((r) => r.repo === 'acme/web-app'));
  // The widgets' Repositories filter is made from each profile's own data.
  assert.ok(repoChoices(a).includes('you-org/web-app') && !repoChoices(a).some((r) => r.startsWith('acme/')));
  assert.ok(repoChoices(b).includes('acme/web-app') && !repoChoices(b).some((r) => r.startsWith('you-org/')));
  assert.ok(personal.seen.every((l) => l.includes('Bearer ghp_personal')), 'the personal server never sees the work token');
  assert.ok(work.seen.every((l) => l.includes('Bearer ghp_work')));

  // Read again: each profile sends its own ETag, and gets its own runs back from the 304.
  personal.seen.length = work.seen.length = 0;
  const [a2, b2] = await Promise.all([read(p), read(w, 'work')]);
  assert.ok(personal.seen.some((l) => l.endsWith('W/"you-org-runs"')));
  assert.ok(work.seen.some((l) => l.endsWith('W/"acme-runs"')));
  assert.deepEqual(a2.runs, a.runs);
  assert.deepEqual(b2.runs, b.runs);
});

test('profiles: the same address and token in two profiles share no ETag, notifications poll or data', async () => {
  const o = { host: work.host, token: 'ghp_work', repos: ['acme/web-app'] };
  await read(o, 'work');
  work.seen.length = 0;
  // A new profile on the same account: its first read is a full one, notifications included.
  const d = await read(o, 'team');
  assert.ok(work.seen.some((l) => /^GET \/api\/v3\/repos\/acme\/web-app\/actions\/runs\S* Bearer ghp_work$/.test(l)), 'no If-None-Match borrowed from the other profile');
  assert.ok(work.seen.some((l) => l.startsWith('GET /api/v3/notifications')), 'its own poll interval');
  assert.equal(d.notifications, JSON.parse(NOTIFS).length);
});

const conn = (o: Partial<Connection> = {}): Connection => ({ host: '', token: 'ghp_test1234', bin: 'gh', repos: ['octo-org/web-app'], recentRepos: 5, runsPerRepo: 10, maxMentions: 10, query: '', ...o });
const NOW = Date.parse('2026-11-09T10:12:00Z');
const signal = new AbortController().signal;

test('profiles: one account rate-limited keeps its own last data and doesn\'t stop the others', async () => {
  const reset = Math.floor(NOW / 1000) + 600;
  let limited = false;
  const calls: string[] = [];
  const fetchFor = (who: string, viewer: string): typeof fetch =>
    (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(`${who} ${url}`);
      if (url.endsWith('/graphql')) return who === 'work' && limited ? new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } }) : new Response(viewer);
      if (url.includes('/actions/runs')) return new Response(RUNS);
      if (url.includes('/notifications')) return new Response(NOTIFS, { headers: { 'X-Poll-Interval': '60' } });
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
  const deps = (who: string, viewer: string, now = NOW): Deps => ({ fetch: fetchFor(who, viewer), exec: async () => '', now: () => now });
  const workViewer = VIEWER.replace('"login": "you"', '"login": "m-losantos"');

  await readGitHub(conn(), signal, deps('personal', VIEWER));
  await readGitHub(conn({ repos: ['acme/web-app'] }), signal, deps('work', workViewer), 'work');
  limited = true;
  const w = await readGitHub(conn({ repos: ['acme/web-app'] }), signal, deps('work', workViewer), 'work');
  assert.equal(w.rateLimitedUntil, reset * 1000);
  assert.equal(w.me, 'm-losantos', 'the work profile keeps its own last data, not the personal one');
  assert.ok(w.runs.every((r) => r.repo === 'acme/web-app'));

  calls.length = 0;
  const p = await readGitHub(conn(), signal, deps('personal', VIEWER, NOW + 60_000));
  assert.equal(p.rateLimitedUntil, undefined, 'the default profile is not rate-limited');
  assert.equal(p.me, 'you');
  assert.ok(calls.some((c) => c.startsWith('personal ')), 'and it is still read');
  await readGitHub(conn({ repos: ['acme/web-app'] }), signal, deps('work', workViewer, NOW + 60_000), 'work');
  assert.ok(!calls.some((c) => c.startsWith('work ')), 'the work profile waits for its reset');
});
