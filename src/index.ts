/**
 * GitHub at a glance, the sibling of kiosko-plugin-gitlab: your Actions runs
 * (broken first, in red, running ones with a timer), the pull requests
 * waiting for your review next to your own, and a small inbox tile. All read
 * one shared source, configured once in Settings → Sources.
 */
import { defineSource, definePlugin, defineWidget, drawEmpty, listLayout, listOptions, t, type Box, type Graphics, type RenderContext } from '@kiosko/sdk';
import { drawLines } from './draw.ts';
import { demoGitHub, latestRuns, prLook, pullItems, readGitHub, runItems, runLook, runMs, shortRef, type GitHubData } from './github.ts';

export * from './github.ts';
export * from './draw.ts';

const SOURCE = 'github/activity';

export const activity = defineSource({
  id: 'activity',
  name: { en: 'GitHub activity', es: 'Actividad de GitHub' },
  description: {
    en: 'Actions runs of your repos, your open pull requests and the ones you are asked to review, through a token or the gh CLI.',
    es: 'Las ejecuciones de Actions de tus repos, tus pull requests abiertas y las que te piden revisar, con un token o con el CLI gh.',
  },
  options: t.object({
    host: t.string({ placeholder: 'github.com', risk: 'network', label: { en: 'GitHub host', es: 'Servidor de GitHub' }, help: { en: 'Empty = github.com. A GitHub Enterprise Server host uses its /api/v3.', es: 'Vacío = github.com. Un servidor GitHub Enterprise usa su /api/v3.' } }),
    token: t.string({
      secret: true,
      label: { en: 'Access token', es: 'Token de acceso' },
      help: {
        en: 'Fine-grained token with read access to Actions, Pull requests and Metadata, or a classic one with repo and read:org (and notifications for the inbox count). Empty = use the gh CLI and its login.',
        es: 'Token fine-grained con lectura de Actions, Pull requests y Metadata, o uno clásico con repo y read:org (y notifications para el contador del buzón). Vacío = usar el CLI gh y su sesión.',
      },
    }),
    repos: t.list(t.string({ placeholder: 'owner/repo' }), {
      max: 20,
      label: { en: 'Repositories for Actions', es: 'Repositorios para Actions' },
      help: { en: 'owner/repo. Empty = your most recently pushed repos.', es: 'owner/repo. Vacío = tus repos con push más reciente.' },
    }),
    recentRepos: t.integer({
      default: 5, min: 1, max: 20,
      label: { en: 'Recent repos for Actions', es: 'Repos recientes para Actions' },
      help: { en: 'Without a list of repositories: how many of your most recently pushed ones. Each costs one call per read.', es: 'Sin lista de repositorios: cuántos de los que tienen push más reciente. Cada uno cuesta una llamada por lectura.' },
    }),
    query: t.string({
      placeholder: 'org:acme',
      label: { en: 'Extra search qualifiers', es: 'Calificadores de búsqueda extra' },
      help: { en: 'Added to the pull request searches, e.g. org:acme or -repo:acme/old. Empty = everything you can see.', es: 'Se añaden a las búsquedas de pull requests, p. ej. org:acme o -repo:acme/old. Vacío = todo lo que ves.' },
    }),
    runsPerRepo: t.integer({ default: 10, min: 1, max: 30, advanced: true, label: { en: 'Runs read per repo', es: 'Ejecuciones leídas por repo' } }),
    maxMentions: t.integer({
      default: 10, min: 0, max: 50, advanced: true,
      label: { en: 'Mentions read', es: 'Menciones leídas' },
      help: { en: 'Open issues and pull requests that mention you, at most. 0 = don\'t look for mentions.', es: 'Issues y pull requests abiertas que te mencionan, como mucho. 0 = no buscar menciones.' },
    }),
    bin: t.string({ default: 'gh', format: 'path', risk: 'exec', advanced: true, label: { en: 'gh command', es: 'Comando gh' } }),
  }),
  intervalMs: 2 * 60_000,
  // One GraphQL query and a REST call per repo each read: a floor that keeps far from the hourly API limit.
  minIntervalMs: 60_000,
  timeoutMs: 30_000,
  read: ({ options, signal }) => readGitHub(options, signal),
  demo: ({ now }) => demoGitHub(now),
});

const aliasesField = () =>
  t.map({
    advanced: true,
    label: { en: 'Short repo names', es: 'Nombres cortos de repo' },
    help: { en: 'Repo (name or owner/name) → what to show, e.g. web-frontend → web.', es: 'Repo (nombre u owner/nombre) → lo que se muestra, p. ej. web-frontend → web.' },
    keyLabel: { en: 'Repo', es: 'Repo' },
    valueLabel: { en: 'Show as', es: 'Mostrar como' },
  });

const reposField = () => t.filter({ label: { en: 'Repositories', es: 'Repositorios' } });

const dataOf = (sources: Record<string, unknown>) => sources[SOURCE] as GitHubData | undefined;
const demo = ({ now }: { now: number }) => ({ sources: { [SOURCE]: demoGitHub(now) } });

type Ctx = Pick<RenderContext<unknown, unknown>, 'theme' | 'kit' | 't' | 'fmt'>;

/** A dim one-liner (or two) in place of the list. */
function message(g: Graphics, box: Box, { theme, kit }: Ctx, text: string, hint?: string): void {
  const { colors, fonts } = theme;
  const s = Math.round(Math.min(32, box.h * 0.3));
  kit.drawTracked(g, kit.truncate(g, text, box.w, { size: s, family: fonts.sans }), box.x, box.y + s * 1.1, { size: s, family: fonts.sans, color: colors.inkDim });
  if (hint && box.h > s * 2.4) {
    const hs = Math.round(s * 0.6);
    kit.drawTracked(g, kit.truncate(g, hint, box.w, { size: hs, family: fonts.sans }), box.x, box.y + s * 1.1 + hs * 1.6, { size: hs, family: fonts.sans, color: colors.inkFaint });
  }
}

/**
 * Handles the states every card shares. Returns the box left for the list
 * (shorter by one line when a rate-limit hint is shown), or null when the
 * card has already been painted.
 */
function frame(g: Graphics, box: Box, ctx: Ctx, data: GitHubData | undefined): Box | null {
  if (!data) return null;
  const tr = ctx.t;
  if (data.state === 'unconfigured') {
    message(g, box, ctx, tr({ en: 'GitHub not configured', es: 'GitHub sin configurar' }), tr({ en: 'Set a token in Sources, or run gh auth login', es: 'Pon un token en Fuentes o ejecuta gh auth login' }));
    return null;
  }
  if (!data.rateLimitedUntil) return box;
  const { colors, fonts } = ctx.theme;
  const s = Math.max(11, Math.round(Math.min(18, box.h * 0.12)));
  const hint = `${tr({ en: 'rate-limited, resumes', es: 'límite de peticiones, vuelve a las' })} ${ctx.fmt.time(data.rateLimitedUntil)}`;
  ctx.kit.drawTracked(g, ctx.kit.truncate(g, hint, box.w, { size: s, family: fonts.sans }), box.x + box.w, box.y + box.h - s * 0.25, { size: s, family: fonts.sans, color: colors.warn, align: 'right' });
  return { ...box, h: box.h - s * 1.4 };
}

/** Listed, and so able to be empty, only once GitHub answered. */
const listed = (data: GitHubData | undefined): data is GitHubData => data?.state === 'ok';

export const actions = defineWidget({
  id: 'actions',
  name: { en: 'Actions runs', es: 'Ejecuciones de Actions' },
  description: {
    en: 'Recent GitHub Actions workflow runs: broken first, then running (with a timer) and queued, passing last.',
    es: 'Las últimas ejecuciones de GitHub Actions: lo roto primero, luego lo que corre (con cronómetro) y espera, lo que pasa al final.',
  },
  icon: 'git-pull-request',
  category: 'dev',
  tags: ['github', 'ci'],
  size: { min: { w: 280, h: 100 }, preferred: { w: 600, h: 220 } },
  sources: [SOURCE],
  options: t.object({
    ...listOptions({ layouts: ['one-line', 'detailed'] }),
    repos: reposField(),
    branches: t.filter({ label: { en: 'Branches', es: 'Ramas' }, help: { en: 'Empty: every branch. Names or patterns, comma-separated (main, release/*, !dependabot/*).', es: 'Vacío: todas las ramas. Nombres o patrones separados por comas (main, release/*, !dependabot/*).' } }),
    hidePassing: t.boolean({ label: { en: 'Hide passing runs', es: 'Ocultar las ejecuciones que pasan' }, help: { en: 'Only what is broken, running or waiting.', es: 'Sólo lo roto, lo que corre y lo que espera.' } }),
    onlyLatest: t.boolean({ default: true, label: { en: 'Only the latest run per workflow and branch', es: 'Solo la última ejecución por workflow y rama' } }),
    aliases: aliasesField(),
  }),
  // A running timer counts seconds only in its first minute.
  redraw: ({ sources, now }) => (dataOf(sources)?.runs.some((r) => r.status === 'in_progress' && now - Date.parse(r.startedAt) < 60_000) ? 'second' : 'minute'),
  empty: ({ options, sources }) => {
    const data = dataOf(sources);
    return listed(data) && !runItems(data.runs, options).length;
  },
  render(g, ctx) {
    const { options, sources, now, theme, fmt, t: tr } = ctx;
    const box = frame(g, ctx.box, ctx, dataOf(sources));
    if (!box) return;
    const data = dataOf(sources)!;
    const { colors } = theme;
    const list = runItems(data.runs, options);
    if (!list.length) return drawEmpty(g, { ...ctx, box }, tr({ en: 'No recent workflow runs', es: 'Sin ejecuciones recientes' }));
    const plan = listLayout(box, list.length, options, {
      sizes: { 'one-line': { min: 22, max: Math.max(22, Math.min(46, box.w / 10)) }, detailed: { min: 40, max: Math.max(40, Math.min(80, box.w / 5)) } },
      // Tall tiles with room: two lines per run (workflow · branch; status, repo, actor, time).
      auto: (b, n) => (b.h >= b.w * 0.7 && b.h / n >= 50 ? 'detailed' : 'one-line'),
      minRows: 3,
    });
    const lasted = (ms: number | null) => (ms === null ? '' : fmt.duration(ms, { seconds: true }));
    drawLines(g, { ...ctx, box }, plan, list.map((r) => {
      const look = runLook(r.status, colors);
      const running = r.status === 'in_progress';
      const label = tr(look.label);
      return {
        color: look.color,
        title: `${r.workflow} · ${r.branch}`,
        strong: look.rank === 0,
        ref: shortRef(r.repo, undefined, options.aliases),
        status: running ? `${label} ${lasted(runMs(r, now))}` : label,
        // Measured with a long timer so the column doesn't jump as it ticks.
        ...(running ? { statusWidth: `${label} 59 min` } : {}),
        meta: ` · ${r.actor}${running || r.status === 'queued' ? '' : ` · ${lasted(runMs(r, now))}`}`,
      };
    }), { dots: true });
  },
  demo,
});

export const reviews = defineWidget({
  id: 'reviews',
  name: { en: 'Pull requests', es: 'Pull requests' },
  description: {
    en: 'Pull requests waiting for your review (whose, how long they have waited, how their checks are doing), then your own with what blocks them: failing checks, changes requested, approved. Mentions last, if you want them.',
    es: 'Las pull requests que te toca revisar (de quién son, cuánto llevan esperando, cómo van sus checks) y luego las tuyas con lo que las frena: checks que fallan, cambios pedidos, aprobada. Las menciones al final, si las quieres.',
  },
  icon: 'git-branch',
  category: 'dev',
  tags: ['github', 'code review'],
  size: { min: { w: 280, h: 100 }, preferred: { w: 600, h: 220 } },
  sources: [SOURCE],
  options: t.object({
    ...listOptions({ layouts: ['one-line', 'detailed'] }),
    repos: reposField(),
    includeMine: t.boolean({ default: true, label: { en: 'Include my own pull requests', es: 'Incluir mis pull requests' } }),
    includeMentions: t.boolean({ label: { en: 'Include mentions', es: 'Incluir menciones' }, help: { en: 'Needs mentions read in the source (Mentions read above 0).', es: 'Necesita que la fuente lea menciones (Menciones leídas por encima de 0).' } }),
    includeDrafts: t.boolean({ label: { en: 'Include drafts', es: 'Incluir borradores' } }),
    hideApproved: t.boolean({ label: { en: 'Hide approved pull requests', es: 'Ocultar las pull requests aprobadas' } }),
    aliases: aliasesField(),
  }),
  hideWhenEmpty: true,
  redraw: 'minute',
  empty: ({ options, sources }) => {
    const data = dataOf(sources);
    return listed(data) && !pullItems(data, options).length;
  },
  render(g, ctx) {
    const { options, sources, theme, fmt, t: tr } = ctx;
    const box = frame(g, ctx.box, ctx, dataOf(sources));
    if (!box) return;
    const data = dataOf(sources)!;
    const { colors } = theme;
    const list = pullItems(data, options);
    if (!list.length) return drawEmpty(g, { ...ctx, box }, tr({ en: 'Nothing to review', es: 'Nada que revisar' }));
    const plan = listLayout(box, list.length, options, {
      sizes: { 'one-line': { min: 22, max: Math.max(22, Math.min(46, box.w / 10)) }, detailed: { min: 40, max: Math.max(40, Math.min(84, box.w / 5.5)) } },
      // Two lines (whose, how long) while every row gets room for them; one line when that shows more of the list.
      auto: (b, n) => (b.h / Math.max(1, n) >= 40 ? 'detailed' : 'one-line'),
      minRows: 2,
    });
    drawLines(g, { ...ctx, box }, plan, list.map(({ p, mine }) => {
      const look = prLook(p, colors);
      const waited = fmt.ago(p.createdAt, { suffix: false });
      return {
        color: look.color,
        title: p.title,
        strong: !mine,
        ref: shortRef(p.repo, p.number, options.aliases),
        status: tr(look.label),
        meta: ` · ${mine ? tr({ en: 'yours', es: 'tuya' }) : p.author} · ${waited}`,
        aside: waited,
      };
    }), { dots: false });
  },
  demo,
});

export const inbox = defineWidget({
  id: 'inbox',
  name: { en: 'GitHub inbox', es: 'Buzón de GitHub' },
  description: {
    en: 'Three numbers: reviews waiting for you, failing runs and unread notifications (when the token can read them). Coloured only when they ask for you.',
    es: 'Tres números: revisiones pendientes, ejecuciones que fallan y notificaciones sin leer (si el token puede leerlas). Con color solo cuando te reclaman.',
  },
  icon: 'bell',
  category: 'dev',
  tags: ['github', 'notifications'],
  size: { min: { w: 160, h: 70 }, preferred: { w: 300, h: 110 } },
  sources: [SOURCE],
  options: t.object({}),
  idle: ({ sources }) => {
    const d = dataOf(sources);
    return !d || (d.state === 'ok' && !d.toReview.length && !latestRuns(d.runs).some((r) => r.status === 'failure') && !d.notifications);
  },
  render(g, ctx) {
    const { sources, theme, kit, t: tr } = ctx;
    const box = frame(g, ctx.box, ctx, dataOf(sources));
    if (!box) return;
    const data = dataOf(sources)!;
    const { colors, fonts } = theme;
    const cells = [
      { n: data.toReview.length, label: tr({ en: 'review', es: 'revisar' }), color: colors.warn },
      { n: latestRuns(data.runs).filter((r) => r.status === 'failure').length, label: tr({ en: 'failing', es: 'fallan' }), color: colors.alert },
      // A token that can't read notifications (fine-grained ones can't) gets two numbers, not a permanent "–".
      ...(data.notifications === null ? [] : [{ n: data.notifications, label: tr({ en: 'unread', es: 'sin leer' }), color: colors.info }]),
    ];
    const w = box.w / cells.length;
    const ls = Math.round(Math.min(box.h * 0.2, w * 0.18));
    const ns = Math.round(Math.min(box.h - ls * 1.6, w * 0.55));
    cells.forEach((c, i) => {
      const cx = box.x + w * i + w / 2;
      const n = c.n > 99 ? '99+' : String(c.n);
      const lit = c.n > 0;
      kit.drawTracked(g, n, cx, box.y + ns * 0.9, { size: ns, family: fonts.sansBold, color: lit ? c.color : colors.inkFaint, align: 'center' });
      kit.drawTracked(g, kit.truncate(g, c.label, w - 4, { size: ls, family: fonts.sans }), cx, box.y + ns * 0.9 + ls * 1.4, { size: ls, family: fonts.sans, color: colors.inkDim, align: 'center' });
    });
  },
  demo,
});

export default definePlugin({
  id: 'github',
  name: { en: 'GitHub', es: 'GitHub' },
  version: '0.2.0',
  description: { en: 'Your Actions runs, the pull requests waiting for your review and your own.', es: 'Tus ejecuciones de Actions, las pull requests que te toca revisar y las tuyas.' },
  author: 'Kiosko',
  license: 'MIT',
  icon: 'github',
  widgets: [actions, reviews, inbox],
  sources: [activity],
});
