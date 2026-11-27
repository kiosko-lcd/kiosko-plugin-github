/**
 * GitHub at a glance, the sibling of kiosko-plugin-gitlab: your Actions runs
 * (broken first, in red, running ones with a timer), the pull requests
 * waiting for your review next to your own, and a small inbox tile. All read
 * one shared source, configured in Settings → Sources. It has profiles
 * (Kiosko 0.2.12 on): several accounts or organisations, each with its
 * token and its own rate limit, and each tile picks one.
 */
import { defineSource, definePlugin, defineWidget, drawEmpty, listLayout, listOptions, t, type Box, type Graphics, type RenderContext } from '@kiosko/sdk';
import { drawLines } from './draw.ts';
import { demoGitHub, latestRuns, prLook, pullItems, readGitHub, runItems, runLook, runMs, shortRef, type GitHubData } from './github.ts';

export * from './github.ts';
export * from './draw.ts';

const SOURCE = 'github/activity';

export const activity = defineSource({
  id: 'activity',
  name: { en: 'GitHub activity', es: 'Actividad de GitHub', de: 'GitHub-Aktivität', 'zh-Hant': 'GitHub 動態', 'zh-Hans': 'GitHub 动态' },
  description: {
    en: 'Actions runs of your repos, your open pull requests and the ones you are asked to review, through a token or the gh CLI.',
    es: 'Las ejecuciones de Actions de tus repos, tus pull requests abiertas y las que te piden revisar, con un token o con el CLI gh.',
    de: 'Actions-Läufe deiner Repos, deine offenen Pull Requests und die, für die ein Review von dir angefragt ist, über ein Token oder die gh-CLI.',
    'zh-Hant': '透過權杖或 gh CLI 取得：你的儲存庫的 Actions 執行、你開啟中的 PR，以及請你審查的 PR。',
    'zh-Hans': '通过令牌或 gh CLI 获取：你的仓库的 Actions 运行、你开放中的 PR，以及请你审查的 PR。',
  },
  options: t.object({
    host: t.string({ placeholder: 'github.com', risk: 'network', label: { en: 'GitHub host', es: 'Servidor de GitHub', de: 'GitHub-Host', 'zh-Hant': 'GitHub 主機', 'zh-Hans': 'GitHub 主机' }, help: { en: 'Empty = github.com. A GitHub Enterprise Server host uses its /api/v3.', es: 'Vacío = github.com. Un servidor GitHub Enterprise usa su /api/v3.', de: 'Leer = github.com. Ein GitHub-Enterprise-Server-Host nutzt seine /api/v3.', 'zh-Hant': '留空 = github.com。GitHub Enterprise Server 主機會使用它的 /api/v3。', 'zh-Hans': '留空 = github.com。GitHub Enterprise Server 主机会使用它的 /api/v3。' } }),
    token: t.string({
      secret: true,
      label: { en: 'Access token', es: 'Token de acceso', de: 'Zugriffstoken', 'zh-Hant': '存取權杖', 'zh-Hans': '访问令牌' },
      help: {
        en: 'Fine-grained token with read access to Actions, Pull requests and Metadata, or a classic one with repo and read:org (and notifications for the inbox count). Empty = use the gh CLI and its login.',
        es: 'Token fine-grained con lectura de Actions, Pull requests y Metadata, o uno clásico con repo y read:org (y notifications para el contador del buzón). Vacío = usar el CLI gh y su sesión.',
        de: 'Fine-grained Token mit Lesezugriff auf Actions, Pull requests und Metadata, oder ein klassisches mit repo und read:org (und notifications für die Zahl im Posteingang). Leer = die gh-CLI und ihre Anmeldung verwenden.',
        'zh-Hant': '具備 Actions、Pull requests 與 Metadata 讀取權限的細粒度權杖，或具備 repo 與 read:org 的傳統權杖（收件匣計數另需 notifications）。留空 = 使用 gh CLI 及其登入。',
        'zh-Hans': '具有 Actions、Pull requests 和 Metadata 读取权限的细粒度令牌，或具有 repo 和 read:org 的经典令牌（收件箱计数另需 notifications）。留空 = 使用 gh CLI 及其登录。',
      },
    }),
    repos: t.list(t.string({ placeholder: 'owner/repo' }), {
      max: 20,
      label: { en: 'Repositories for Actions', es: 'Repositorios para Actions', de: 'Repositorys für Actions', 'zh-Hant': 'Actions 的儲存庫', 'zh-Hans': 'Actions 的仓库' },
      help: { en: 'owner/repo. Empty = your most recently pushed repos.', es: 'owner/repo. Vacío = tus repos con push más reciente.', de: 'owner/repo. Leer = deine zuletzt gepushten Repos.', 'zh-Hant': 'owner/repo。留空 = 你最近推送的儲存庫。', 'zh-Hans': 'owner/repo。留空 = 你最近推送的仓库。' },
    }),
    recentRepos: t.integer({
      default: 5, min: 1, max: 20,
      label: { en: 'Recent repos for Actions', es: 'Repos recientes para Actions', de: 'Letzte Repos für Actions', 'zh-Hant': 'Actions 的近期儲存庫數', 'zh-Hans': 'Actions 的近期仓库数' },
      help: { en: 'Without a list of repositories: how many of your most recently pushed ones. Each costs one call per read.', es: 'Sin lista de repositorios: cuántos de los que tienen push más reciente. Cada uno cuesta una llamada por lectura.', de: 'Ohne Liste von Repositorys: wie viele deiner zuletzt gepushten. Jedes kostet einen API-Aufruf pro Abfrage.', 'zh-Hant': '未指定儲存庫清單時：取你最近推送的幾個儲存庫。每個儲存庫每次讀取都會花費一次 API 呼叫。', 'zh-Hans': '未指定仓库列表时：取你最近推送的几个仓库。每个仓库每次读取都会消耗一次 API 调用。' },
    }),
    query: t.string({
      placeholder: 'org:acme',
      label: { en: 'Extra search qualifiers', es: 'Calificadores de búsqueda extra', de: 'Zusätzliche Suchfilter', 'zh-Hant': '額外搜尋限定詞', 'zh-Hans': '额外搜索限定符' },
      help: { en: 'Added to the pull request searches, e.g. org:acme or -repo:acme/old. Empty = everything you can see.', es: 'Se añaden a las búsquedas de pull requests, p. ej. org:acme o -repo:acme/old. Vacío = todo lo que ves.', de: 'Werden an die Pull-Request-Suchen angehängt, z. B. org:acme oder -repo:acme/old. Leer = alles, was du sehen kannst.', 'zh-Hant': '加在 PR 搜尋條件後，例如 org:acme 或 -repo:acme/old。留空 = 你能看到的全部。', 'zh-Hans': '附加到 PR 搜索条件中，例如 org:acme 或 -repo:acme/old。留空 = 你能看到的全部。' },
    }),
    runsPerRepo: t.integer({ default: 10, min: 1, max: 30, advanced: true, label: { en: 'Runs read per repo', es: 'Ejecuciones leídas por repo', de: 'Gelesene Läufe pro Repo', 'zh-Hant': '每個儲存庫讀取的執行數', 'zh-Hans': '每个仓库读取的运行数' } }),
    maxMentions: t.integer({
      default: 10, min: 0, max: 50, advanced: true,
      label: { en: 'Mentions read', es: 'Menciones leídas', de: 'Gelesene Erwähnungen', 'zh-Hant': '讀取的提及數', 'zh-Hans': '读取的提及数' },
      help: { en: 'Open issues and pull requests that mention you, at most. 0 = don\'t look for mentions.', es: 'Issues y pull requests abiertas que te mencionan, como mucho. 0 = no buscar menciones.', de: 'Höchstens so viele offene Issues und Pull Requests, die dich erwähnen. 0 = nicht nach Erwähnungen suchen.', 'zh-Hant': '提及你的開啟中問題與 PR 的上限。0 = 不查詢提及。', 'zh-Hans': '提及你的开放中议题和 PR 的上限。0 = 不查询提及。' },
    }),
    bin: t.string({ default: 'gh', format: 'path', risk: 'exec', advanced: true, label: { en: 'gh command', es: 'Comando gh', de: 'gh-Befehl', 'zh-Hant': 'gh 指令', 'zh-Hans': 'gh 命令' } }),
  }),
  intervalMs: 2 * 60_000,
  // One GraphQL query and a REST call per repo each read: a floor that keeps far from the hourly API limit.
  minIntervalMs: 60_000,
  timeoutMs: 30_000,
  // Each profile's rate limit, ETags and last data apart: `ctx.profile` (Kiosko 0.2.12 on; undefined before).
  read: (ctx) => readGitHub(ctx.options, ctx.signal, undefined, (ctx as { profile?: string }).profile),
  demo: ({ now, locale }) => demoGitHub(now, locale),
  // Several accounts (personal, work, an Enterprise host), each with its token: Kiosko 0.2.12 and later; older ones ignore it.
  ...({ profiles: true } as {}),
  // Every repo it has seen (runs and pull requests), for the widgets' filter.
  choices: {
    repos: (d) => {
      if (!d || d.state !== 'ok') return [];
      const runs = new Set(d.runs.map((r) => r.repo));
      const pulls = new Set([...d.authored, ...d.toReview, ...d.mentions].map((p) => p.repo));
      return [...new Set([...runs, ...pulls])].sort((a, b) => a.localeCompare(b)).map((value) => ({ value, group: runs.has(value) ? 'Actions' : 'Pull requests' }));
    },
  },
});

const aliasesField = () =>
  t.map({
    advanced: true,
    label: { en: 'Short repo names', es: 'Nombres cortos de repo', de: 'Kurze Repo-Namen', 'zh-Hant': '儲存庫簡稱', 'zh-Hans': '仓库简称' },
    help: { en: 'Repo (name or owner/name) → what to show, e.g. web-frontend → web.', es: 'Repo (nombre u owner/nombre) → lo que se muestra, p. ej. web-frontend → web.', de: 'Repo (Name oder owner/Name) → was angezeigt wird, z. B. web-frontend → web.', 'zh-Hant': '儲存庫（名稱或 owner/名稱）→ 顯示內容，例如 web-frontend → web。', 'zh-Hans': '仓库（名称或 owner/名称）→ 显示内容，例如 web-frontend → web。' },
    keyLabel: { en: 'Repo', es: 'Repo', de: 'Repo', 'zh-Hant': '儲存庫', 'zh-Hans': '仓库' },
    valueLabel: { en: 'Show as', es: 'Mostrar como', de: 'Anzeigen als', 'zh-Hant': '顯示為', 'zh-Hans': '显示为' },
  });

const reposField = () => t.filter({ label: { en: 'Repositories', es: 'Repositorios', de: 'Repositorys', 'zh-Hant': '儲存庫', 'zh-Hans': '仓库' }, choices: { source: 'github/activity', list: 'repos' } });

const dataOf = (sources: Record<string, unknown>) => sources[SOURCE] as GitHubData | undefined;
const demo = ({ now, locale }: { now: number; locale: string }) => ({ sources: { [SOURCE]: demoGitHub(now, locale) } });

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
    message(g, box, ctx, tr({ en: 'GitHub not configured', es: 'GitHub sin configurar', de: 'GitHub nicht eingerichtet', 'zh-Hant': '尚未設定 GitHub', 'zh-Hans': '尚未配置 GitHub' }), tr({ en: 'Set a token in Sources, or run gh auth login', es: 'Pon un token en Fuentes o ejecuta gh auth login', de: 'Token unter Datenquellen eintragen oder gh auth login ausführen', 'zh-Hant': '請在資料來源中設定權杖，或執行 gh auth login', 'zh-Hans': '请在数据源中设置令牌，或运行 gh auth login' }));
    return null;
  }
  if (!data.rateLimitedUntil) return box;
  const { colors, fonts } = ctx.theme;
  const s = Math.max(11, Math.round(Math.min(18, box.h * 0.12)));
  const hint = `${tr({ en: 'rate-limited, resumes', es: 'límite de peticiones, vuelve a las', de: 'Rate-Limit, weiter um', 'zh-Hant': '已達速率限制，恢復時間', 'zh-Hans': '已触发速率限制，恢复时间' })} ${ctx.fmt.time(data.rateLimitedUntil)}`;
  ctx.kit.drawTracked(g, ctx.kit.truncate(g, hint, box.w, { size: s, family: fonts.sans }), box.x + box.w, box.y + box.h - s * 0.25, { size: s, family: fonts.sans, color: colors.warn, align: 'right' });
  return { ...box, h: box.h - s * 1.4 };
}

/** Listed, and so able to be empty, only once GitHub answered. */
const listed = (data: GitHubData | undefined): data is GitHubData => data?.state === 'ok';

export const actions = defineWidget({
  id: 'actions',
  name: { en: 'Actions runs', es: 'Ejecuciones de Actions', de: 'Actions-Läufe', 'zh-Hant': 'Actions 執行', 'zh-Hans': 'Actions 运行' },
  description: {
    en: 'Recent GitHub Actions workflow runs: broken first, then running (with a timer) and queued, passing last.',
    es: 'Las últimas ejecuciones de GitHub Actions: lo roto primero, luego lo que corre (con cronómetro) y espera, lo que pasa al final.',
    de: 'Die letzten Workflow-Läufe von GitHub Actions: fehlgeschlagene zuerst, dann laufende (mit Timer) und wartende, erfolgreiche zuletzt.',
    'zh-Hant': '近期的 GitHub Actions 工作流程執行：失敗的優先，接著是執行中（附計時）與排隊中，通過的排最後。',
    'zh-Hans': '近期的 GitHub Actions 工作流运行：失败的优先，然后是运行中（附计时）和排队中，通过的排最后。',
  },
  icon: 'git-pull-request',
  category: 'dev',
  tags: ['github', 'ci'],
  size: { min: { w: 280, h: 100 }, preferred: { w: 600, h: 220 } },
  sources: [SOURCE],
  options: t.object({
    ...listOptions({ layouts: ['one-line', 'detailed'] }),
    repos: reposField(),
    branches: t.filter({ label: { en: 'Branches', es: 'Ramas', de: 'Branches', 'zh-Hant': '分支', 'zh-Hans': '分支' }, help: { en: 'Empty: every branch. Names or patterns, comma-separated (main, release/*, !dependabot/*).', es: 'Vacío: todas las ramas. Nombres o patrones separados por comas (main, release/*, !dependabot/*).', de: 'Leer: alle Branches. Namen oder Muster, durch Kommas getrennt (main, release/*, !dependabot/*).', 'zh-Hant': '留空：所有分支。名稱或模式，以逗號分隔（main, release/*, !dependabot/*）。', 'zh-Hans': '留空：所有分支。名称或模式，用逗号分隔（main, release/*, !dependabot/*）。' } }),
    hidePassing: t.boolean({ label: { en: 'Hide passing runs', es: 'Ocultar las ejecuciones que pasan', de: 'Erfolgreiche Läufe ausblenden', 'zh-Hant': '隱藏通過的執行', 'zh-Hans': '隐藏通过的运行' }, help: { en: 'Only what is broken, running or waiting.', es: 'Sólo lo roto, lo que corre y lo que espera.', de: 'Nur was fehlschlägt, läuft oder wartet.', 'zh-Hant': '只顯示失敗、執行中或等待中的。', 'zh-Hans': '只显示失败、运行中或等待中的。' } }),
    onlyLatest: t.boolean({ default: true, label: { en: 'Only the latest run per workflow and branch', es: 'Solo la última ejecución por workflow y rama', de: 'Nur der letzte Lauf pro Workflow und Branch', 'zh-Hant': '每個工作流程與分支只顯示最新一次執行', 'zh-Hans': '每个工作流和分支只显示最新一次运行' } }),
    aliases: aliasesField(),
  }),
  // A running timer counts seconds only in its first minute.
  redraw: ({ sources, now }) => (dataOf(sources)?.runs.some((r) => r.status === 'in_progress' && now - Date.parse(r.startedAt) < 60_000) ? 'second' : 'minute'),
  empty: ({ options, sources }) => {
    const data = dataOf(sources);
    // Not configured: nothing to list (it says so when alone).
    return data?.state === 'unconfigured' || (listed(data) && !runItems(data.runs, options).length);
  },
  render(g, ctx) {
    const { options, sources, now, theme, fmt, t: tr } = ctx;
    const box = frame(g, ctx.box, ctx, dataOf(sources));
    if (!box) return;
    const data = dataOf(sources)!;
    const { colors } = theme;
    const list = runItems(data.runs, options);
    if (!list.length) return drawEmpty(g, { ...ctx, box }, tr({ en: 'No recent workflow runs', es: 'Sin ejecuciones recientes', de: 'Keine aktuellen Workflow-Läufe', 'zh-Hant': '沒有近期的工作流程執行', 'zh-Hans': '没有近期的工作流运行' }));
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
  name: { en: 'Pull requests', es: 'Pull requests', de: 'Pull Requests', 'zh-Hant': '拉取要求（PR）', 'zh-Hans': '拉取请求（PR）' },
  description: {
    en: 'Pull requests waiting for your review (whose, how long they have waited, how their checks are doing), then your own with what blocks them: failing checks, changes requested, approved. Mentions last, if you want them.',
    es: 'Las pull requests que te toca revisar (de quién son, cuánto llevan esperando, cómo van sus checks) y luego las tuyas con lo que las frena: checks que fallan, cambios pedidos, aprobada. Las menciones al final, si las quieres.',
    de: 'Pull Requests, die auf dein Review warten (von wem, wie lange schon, wie ihre Checks stehen), dann deine eigenen mit dem, was sie aufhält: fehlgeschlagene Checks, angeforderte Änderungen, genehmigt. Erwähnungen zuletzt, wenn gewünscht.',
    'zh-Hant': '等你審查的 PR（作者、已等多久、檢查狀況），接著是你自己的 PR 及卡住它們的原因：檢查失敗、要求修改、已核准。提及排最後（如果你需要）。',
    'zh-Hans': '等你审查的 PR（作者、已等多久、检查状况），然后是你自己的 PR 及卡住它们的原因：检查失败、要求修改、已批准。提及排最后（如果你需要）。',
  },
  icon: 'git-branch',
  category: 'dev',
  tags: ['github', 'code review'],
  size: { min: { w: 280, h: 100 }, preferred: { w: 600, h: 220 } },
  sources: [SOURCE],
  options: t.object({
    ...listOptions({ layouts: ['one-line', 'detailed'] }),
    repos: reposField(),
    includeMine: t.boolean({ default: true, label: { en: 'Include my own pull requests', es: 'Incluir mis pull requests', de: 'Eigene Pull Requests einbeziehen', 'zh-Hant': '包含我自己的 PR', 'zh-Hans': '包含我自己的 PR' } }),
    includeMentions: t.boolean({ label: { en: 'Include mentions', es: 'Incluir menciones', de: 'Erwähnungen einbeziehen', 'zh-Hant': '包含提及', 'zh-Hans': '包含提及' }, help: { en: 'Needs mentions read in the source (Mentions read above 0).', es: 'Necesita que la fuente lea menciones (Menciones leídas por encima de 0).', de: 'Die Datenquelle muss Erwähnungen lesen („Gelesene Erwähnungen“ über 0).', 'zh-Hant': '需要資料來源讀取提及（「讀取的提及數」大於 0）。', 'zh-Hans': '需要数据源读取提及（“读取的提及数”大于 0）。' } }),
    includeDrafts: t.boolean({ label: { en: 'Include drafts', es: 'Incluir borradores', de: 'Entwürfe einbeziehen', 'zh-Hant': '包含草稿', 'zh-Hans': '包含草稿' } }),
    hideApproved: t.boolean({ label: { en: 'Hide approved pull requests', es: 'Ocultar las pull requests aprobadas', de: 'Genehmigte Pull Requests ausblenden', 'zh-Hant': '隱藏已核准的 PR', 'zh-Hans': '隐藏已批准的 PR' } }),
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
    if (!list.length) return drawEmpty(g, { ...ctx, box }, tr({ en: 'Nothing to review', es: 'Nada que revisar', de: 'Nichts zu reviewen', 'zh-Hant': '沒有要審查的', 'zh-Hans': '没有待审查的' }));
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
        meta: ` · ${mine ? tr({ en: 'yours', es: 'tuya', de: 'deiner', 'zh-Hant': '你的', 'zh-Hans': '你的' }) : p.author} · ${waited}`,
        aside: waited,
      };
    }), { dots: false });
  },
  demo,
});

export const inbox = defineWidget({
  id: 'inbox',
  name: { en: 'GitHub inbox', es: 'Buzón de GitHub', de: 'GitHub-Posteingang', 'zh-Hant': 'GitHub 收件匣', 'zh-Hans': 'GitHub 收件箱' },
  description: {
    en: 'Three numbers: reviews waiting for you, failing runs and unread notifications (when the token can read them). Coloured only when they ask for you.',
    es: 'Tres números: revisiones pendientes, ejecuciones que fallan y notificaciones sin leer (si el token puede leerlas). Con color solo cuando te reclaman.',
    de: 'Drei Zahlen: Reviews, die auf dich warten, fehlgeschlagene Läufe und ungelesene Benachrichtigungen (wenn das Token sie lesen darf). Farbig nur, wenn sie dich brauchen.',
    'zh-Hant': '三個數字：等你審查的、失敗的執行，以及未讀通知（權杖可讀取時）。只有需要你處理時才會上色。',
    'zh-Hans': '三个数字：等你审查的、失败的运行，以及未读通知（令牌可读取时）。只有需要你处理时才会着色。',
  },
  icon: 'bell',
  category: 'dev',
  tags: ['github', 'notifications'],
  size: { min: { w: 160, h: 70 }, preferred: { w: 300, h: 110 } },
  sources: [SOURCE],
  options: t.object({}),
  // Not configured: no numbers to show. Zeros are worth seeing, so they are not empty.
  empty: ({ sources }) => dataOf(sources)?.state === 'unconfigured',
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
      { n: data.toReview.length, label: tr({ en: 'review', es: 'revisar', de: 'Review', 'zh-Hant': '待審查', 'zh-Hans': '待审查' }), color: colors.warn },
      { n: latestRuns(data.runs).filter((r) => r.status === 'failure').length, label: tr({ en: 'failing', es: 'fallan', de: 'Fehler', 'zh-Hant': '失敗', 'zh-Hans': '失败' }), color: colors.alert },
      // A token that can't read notifications (fine-grained ones can't) gets two numbers, not a permanent "–".
      ...(data.notifications === null ? [] : [{ n: data.notifications, label: tr({ en: 'unread', es: 'sin leer', de: 'ungelesen', 'zh-Hant': '未讀', 'zh-Hans': '未读' }), color: colors.info }]),
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
  name: { en: 'GitHub', es: 'GitHub', de: 'GitHub', 'zh-Hant': 'GitHub', 'zh-Hans': 'GitHub' },
  version: '0.3.1',
  languages: ['en', 'es', 'de', 'zh-Hant', 'zh-Hans'],
  sdk: '^0.2.0',
  permissions: { network: ['api.github.com', 'user'], exec: ['gh'] },
  description: { en: 'Your Actions runs, the pull requests waiting for your review and your own.', es: 'Tus ejecuciones de Actions, las pull requests que te toca revisar y las tuyas.', de: 'Deine Actions-Läufe, die Pull Requests, die auf dein Review warten, und deine eigenen.', 'zh-Hant': '你的 Actions 執行、等你審查的 PR，以及你自己的 PR。', 'zh-Hans': '你的 Actions 运行、等你审查的 PR，以及你自己的 PR。' },
  author: 'Kiosko',
  license: 'MIT',
  icon: 'github',
  widgets: [actions, reviews, inbox],
  sources: [activity],
});
