/**
 * GitHub at a glance, the sibling of kiosko-plugin-gitlab: your Actions runs
 * (broken first, in red, running ones with a timer), the pull requests
 * waiting for your review next to your own, and a small inbox tile. All read
 * one shared source, configured once in Settings → Sources.
 */
import { defineSource, definePlugin, defineWidget, t, type Box, type Graphics, type RenderContext } from '@kiosko/sdk';
import { age, clock, demoGitHub, duration, latestRuns, prLook, readGitHub, runLook, shortRef, type GitHubData, type PullRequest } from './github.ts';

export * from './github.ts';

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
      help: { en: 'owner/repo. Empty = your 5 most recently pushed repos.', es: 'owner/repo. Vacío = tus 5 repos con push más reciente.' },
    }),
    runsPerRepo: t.integer({ default: 10, min: 1, max: 30, advanced: true, label: { en: 'Runs read per repo', es: 'Ejecuciones leídas por repo' } }),
    mentions: t.boolean({ default: true, advanced: true, label: { en: 'Also look for mentions', es: 'Buscar también menciones' } }),
    bin: t.string({ default: 'gh', format: 'path', risk: 'exec', advanced: true, label: { en: 'gh command', es: 'Comando gh' } }),
  }),
  intervalMs: 2 * 60_000,
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

const dataOf = (sources: Record<string, unknown>) => sources[SOURCE] as GitHubData | undefined;
const demo = ({ now }: { now: number }) => ({ sources: { [SOURCE]: demoGitHub(now) } });

type Ctx = Pick<RenderContext<unknown, unknown>, 'theme' | 'kit' | 't' | 'locale'>;

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
  const hint = `${tr({ en: 'rate-limited, resumes', es: 'límite de peticiones, vuelve a las' })} ${clock(data.rateLimitedUntil, ctx.locale)}`;
  ctx.kit.drawTracked(g, ctx.kit.truncate(g, hint, box.w, { size: s, family: fonts.sans }), box.x + box.w, box.y + box.h - s * 0.25, { size: s, family: fonts.sans, color: colors.warn, align: 'right' });
  return { ...box, h: box.h - s * 1.4 };
}

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
    latestOnly: t.boolean({ default: true, label: { en: 'Only the latest run per workflow and branch', es: 'Solo la última ejecución por workflow y rama' } }),
    branch: t.string({ placeholder: 'main', label: { en: 'Only this branch', es: 'Solo esta rama' }, help: { en: 'Empty = every branch.', es: 'Vacío = todas las ramas.' } }),
    aliases: aliasesField(),
  }),
  redraw: ({ sources }) => (dataOf(sources)?.runs.some((r) => r.status === 'in_progress') ? 'second' : 'minute'),
  render(g, ctx) {
    const { options, sources, now, theme, kit, t: tr } = ctx;
    const box = frame(g, ctx.box, ctx, dataOf(sources));
    if (!box) return;
    const data = dataOf(sources)!;
    const { colors, fonts } = theme;
    const runs = (options.latestOnly ? latestRuns(data.runs) : data.runs).filter((r) => !options.branch.trim() || r.branch === options.branch.trim());
    const list = runs
      .map((r) => ({ r, look: runLook(r.status, colors) }))
      .sort((a, b) => a.look.rank - b.look.rank || b.r.startedAt.localeCompare(a.r.startedAt));
    if (!list.length) return message(g, box, ctx, tr({ en: 'No recent workflow runs', es: 'Sin ejecuciones recientes' }));
    const more = (n: number, x: number, y: number, size: number) =>
      kit.drawTracked(g, `+${n} ${tr({ en: 'more', es: 'más' })}`, x, y, { size, family: fonts.sans, color: colors.inkDim });
    const statusText = (r: (typeof list)[number]) => {
      const d = r.r.status === 'in_progress' ? duration(r.r, now) : '';
      return d ? `${tr(r.look.label)} ${d}` : tr(r.look.label);
    };
    // Tall tiles: two lines per run (workflow · branch; status, repo, actor, time).
    if (box.h >= box.w * 0.7 && box.h / list.length >= 50) {
      const rowH = Math.min(80, box.h / list.length, box.w / 5);
      const ts = Math.round(rowH * 0.4), ms = Math.round(rowH * 0.3);
      const rows = Math.max(1, Math.floor(box.h / rowH + 0.1));
      const shown = list.length <= rows ? list : list.slice(0, rows - 1);
      const dot = ts * 0.28;
      const tx = box.x + dot * 3.4;
      shown.forEach((item, i) => {
        const { r, look } = item;
        const top = box.y + i * rowH;
        g.fillStyle = look.color;
        g.beginPath();
        g.arc(box.x + dot * 1.1, top + ts * 0.66, dot, 0, Math.PI * 2);
        g.fill();
        const o = { size: ts, family: fonts.sans, color: look.rank === 0 ? colors.ink : colors.inkDim };
        kit.drawTracked(g, kit.truncate(g, `${r.workflow} · ${r.branch}`, box.x + box.w - tx, o), tx, top + ts, o);
        const lw = kit.drawTracked(g, statusText(item), tx, top + ts + ms * 1.45, { size: ms, family: fonts.sans, color: look.color });
        const d = r.status === 'in_progress' || r.status === 'queued' ? '' : ` · ${duration(r, now)}`;
        const meta = { size: ms, family: fonts.mono, color: colors.inkDim };
        kit.drawTracked(g, kit.truncate(g, `${shortRef(r.repo, undefined, options.aliases)} · ${r.actor}${d}`, box.x + box.w - tx - lw - ms, meta), tx + lw + ms * 0.8, top + ts + ms * 1.45, meta);
      });
      if (shown.length < list.length) more(list.length - shown.length, tx, box.y + shown.length * rowH + ts, ms);
      return;
    }
    const rowH = Math.max(22, Math.min(46, box.h / Math.max(3, list.length), box.w / 10));
    const rows = Math.max(1, Math.floor(box.h / rowH + 0.1));
    const shown = list.length <= rows ? list : list.slice(0, rows - 1);
    const ref = { size: Math.round(rowH * 0.56), family: fonts.mono };
    const lab = { size: Math.round(rowH * 0.56), family: fonts.sans };
    const refs = shown.map(({ r }) => shortRef(r.repo, undefined, options.aliases));
    const refW = Math.max(...refs.map((r) => kit.measureTracked(g, r, ref)));
    // Measured with a long timer so the column doesn't jump every second.
    const labW = Math.max(...shown.map((item) => kit.measureTracked(g, item.r.status === 'in_progress' ? `${tr(item.look.label)} 00:00` : tr(item.look.label), lab)));
    const dot = rowH * 0.2;
    const x0 = box.x + dot * 3.4;
    const withRef = box.x + box.w - x0 - refW - labW - rowH * 0.8 >= box.w * 0.5;
    shown.forEach((item, i) => {
      const { r, look } = item;
      const base = box.y + i * rowH + rowH * 0.72;
      g.fillStyle = look.color;
      g.beginPath();
      g.arc(box.x + dot * 1.1, base - rowH * 0.22, dot, 0, Math.PI * 2);
      g.fill();
      if (withRef) kit.drawTracked(g, refs[i]!, x0, base, { ...ref, color: colors.inkDim });
      kit.drawTracked(g, statusText(item), box.x + box.w, base, { ...lab, color: look.color, align: 'right' });
      const tx = withRef ? x0 + refW + rowH * 0.4 : x0;
      const o = { size: Math.round(rowH * 0.7), family: fonts.sans, color: look.rank === 0 ? colors.ink : colors.inkDim };
      kit.drawTracked(g, kit.truncate(g, `${r.workflow} · ${r.branch}`, box.x + box.w - labW - rowH * 0.4 - tx, o), tx, base, o);
    });
    if (shown.length < list.length) more(list.length - shown.length, x0, box.y + shown.length * rowH + rowH * 0.72, lab.size);
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
    showMine: t.boolean({ default: true, label: { en: 'Also my own pull requests', es: 'También mis pull requests' } }),
    showMentions: t.boolean({ label: { en: 'Also mentions', es: 'También menciones' } }),
    includeDrafts: t.boolean({ label: { en: 'Include drafts', es: 'Incluir borradores' } }),
    aliases: aliasesField(),
  }),
  redraw: 'minute',
  visible: ({ options, sources }) => {
    const data = dataOf(sources);
    if (data?.state === 'unconfigured') return true;
    const ok = (p: PullRequest) => options.includeDrafts || !p.draft;
    return Boolean(data && (data.toReview.some(ok) || (options.showMine && data.authored.some(ok)) || (options.showMentions && data.mentions.length)));
  },
  render(g, ctx) {
    const { options, sources, now, theme, kit, t: tr, locale } = ctx;
    const box = frame(g, ctx.box, ctx, dataOf(sources));
    if (!box) return;
    const data = dataOf(sources)!;
    const { colors, fonts } = theme;
    const ok = (p: PullRequest) => options.includeDrafts || !p.draft;
    const seen = new Set<string>();
    const once = (p: PullRequest) => {
      const k = `${p.repo}#${p.number}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    };
    // Waiting for you, oldest first; then yours, most blocked first; then mentions.
    const list = [
      ...data.toReview.filter(ok).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((p) => ({ p, mine: false })),
      ...(options.showMine ? data.authored.filter(ok).sort((a, b) => prLook(a, colors).rank - prLook(b, colors).rank || b.updatedAt.localeCompare(a.updatedAt)).map((p) => ({ p, mine: true })) : []),
      ...(options.showMentions ? data.mentions.filter((p) => p.author !== data.me).map((p) => ({ p, mine: false })) : []),
    ].filter(({ p }) => once(p));
    if (!list.length) return message(g, box, ctx, tr({ en: 'Nothing to review', es: 'Nada que revisar' }));
    const rowH = Math.max(40, Math.min(84, box.h / Math.max(2, list.length), box.w / 5.5));
    const rows = Math.max(1, Math.floor(box.h / rowH + 0.1));
    const ts = Math.round(rowH * 0.4), ms = Math.round(rowH * 0.28);
    list.slice(0, rows).forEach(({ p, mine }, i) => {
      const top = box.y + i * rowH;
      const look = prLook(p, colors);
      const t1 = { size: ts, family: fonts.sans, color: mine ? colors.inkDim : colors.ink };
      kit.drawTracked(g, kit.truncate(g, p.title, box.w, t1), box.x, top + ts, t1);
      const lw = kit.drawTracked(g, tr(look.label), box.x, top + ts + ms * 1.45, { size: ms, family: fonts.sans, color: look.color });
      const who = mine ? tr({ en: 'yours', es: 'tuya' }) : p.author;
      const meta = `${shortRef(p.repo, p.number, options.aliases)} · ${who} · ${age(p.createdAt, now, locale)}`;
      const mo = { size: ms, family: fonts.mono, color: colors.inkDim };
      kit.drawTracked(g, kit.truncate(g, meta, box.w - lw - ms, mo), box.x + lw + ms * 0.8, top + ts + ms * 1.45, mo);
    });
  },
  demo,
});

export const inbox = defineWidget({
  id: 'inbox',
  name: { en: 'GitHub inbox', es: 'Buzón de GitHub' },
  description: {
    en: 'Three numbers: reviews waiting for you, failing runs and unread notifications. Coloured only when they ask for you.',
    es: 'Tres números: revisiones pendientes, ejecuciones que fallan y notificaciones sin leer. Con color solo cuando te reclaman.',
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
      { n: data.toReview.length as number | null, label: tr({ en: 'review', es: 'revisar' }), color: colors.warn },
      { n: latestRuns(data.runs).filter((r) => r.status === 'failure').length as number | null, label: tr({ en: 'failing', es: 'fallan' }), color: colors.alert },
      { n: data.notifications, label: tr({ en: 'unread', es: 'sin leer' }), color: colors.info },
    ];
    const w = box.w / cells.length;
    const ls = Math.round(Math.min(box.h * 0.2, w * 0.18));
    const ns = Math.round(Math.min(box.h - ls * 1.6, w * 0.55));
    cells.forEach((c, i) => {
      const cx = box.x + w * i + w / 2;
      const n = c.n === null ? '–' : c.n > 99 ? '99+' : String(c.n);
      const lit = c.n !== null && c.n > 0;
      kit.drawTracked(g, n, cx, box.y + ns * 0.9, { size: ns, family: fonts.sansBold, color: lit ? c.color : colors.inkFaint, align: 'center' });
      kit.drawTracked(g, kit.truncate(g, c.label, w - 4, { size: ls, family: fonts.sans }), cx, box.y + ns * 0.9 + ls * 1.4, { size: ls, family: fonts.sans, color: colors.inkDim, align: 'center' });
    });
  },
  demo,
});

export default definePlugin({
  id: 'github',
  name: { en: 'GitHub', es: 'GitHub' },
  version: '0.1.0',
  description: { en: 'Your Actions runs, the pull requests waiting for your review and your own.', es: 'Tus ejecuciones de Actions, las pull requests que te toca revisar y las tuyas.' },
  author: 'Kiosko',
  license: 'MIT',
  icon: 'github',
  widgets: [actions, reviews, inbox],
  sources: [activity],
});
