/**
 * The rows both lists draw, in the two shared list layouts (see `listLayout`),
 * the same as kiosko-plugin-gitlab's:
 *
 *   one-line   ● web-app  CI · main                      running 3 min
 *   detailed   ● CI · main
 *               running 3 min web-app · sam
 */
import { drawMore, type Graphics, type ListPlan, type RenderContext } from '@kiosko/sdk';

export interface Line {
  /** Colour of the status: the dot and the status word. */
  color: string;
  title: string;
  /** Title in full ink (needs you); otherwise dimmed. */
  strong: boolean;
  /** `web-app#412`, `web-app`. */
  ref: string;
  /** The status in a word ("failed"), coloured. */
  status: string;
  /** One-line layout: the widest the status gets (a running timer), so the titles don't jump as it ticks. */
  statusWidth?: string;
  /** Detailed layout: what follows the reference on the second line (" · sam · 3 h"). */
  meta?: string;
  /** One-line layout: shown dim at the right instead of the status (an age). */
  aside?: string;
}

type Ctx = Pick<RenderContext<unknown, unknown>, 'box' | 'theme' | 'kit' | 't'>;

/**
 * Paints `lines` in the rows of `plan`, then "+N more". `dots` puts the
 * status dot in front of detailed rows too (one-line rows always have it).
 */
export function drawLines(g: Graphics, ctx: Ctx, plan: ListPlan, lines: Line[], o: { dots: boolean }): void {
  const { box, theme, kit } = ctx;
  const { colors, fonts } = theme;
  const shown = lines.slice(0, plan.shown);
  const { rowH } = plan;
  const dotAt = (x: number, y: number, r: number, color: string) => {
    g.fillStyle = color;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  };
  if (plan.layout === 'detailed') {
    const ts = Math.round(rowH * 0.4), ms = Math.round(rowH * 0.3);
    const dot = ts * 0.28;
    const tx = o.dots ? box.x + dot * 3.4 : box.x;
    shown.forEach((l, i) => {
      const top = plan.rows[i]!.y;
      if (o.dots) dotAt(box.x + dot * 1.1, top + ts * 0.66, dot, l.color);
      const t1 = { size: ts, family: fonts.sans, color: l.strong ? colors.ink : colors.inkDim };
      kit.drawTracked(g, kit.truncate(g, l.title, box.x + box.w - tx, t1), tx, top + ts, t1);
      const y2 = top + ts + ms * 1.45;
      const lw = kit.drawTracked(g, l.status, tx, y2, { size: ms, family: fonts.sans, color: l.color });
      const mo = { size: ms, family: fonts.mono, color: colors.inkDim };
      kit.drawTracked(g, kit.truncate(g, `${l.ref}${l.meta ?? ''}`, box.x + box.w - tx - lw - ms, mo), tx + lw + ms * 0.8, y2, mo);
    });
    drawMore(g, ctx, plan, { indent: tx - box.x });
    return;
  }
  const ref = { size: Math.round(rowH * 0.56), family: fonts.mono };
  const lab = { size: Math.round(rowH * 0.56), family: fonts.sans };
  const right = (l: Line) => l.aside ?? l.status;
  const refW = Math.max(0, ...shown.map((l) => kit.measureTracked(g, l.ref, ref)));
  const labW = Math.max(0, ...shown.map((l) => kit.measureTracked(g, l.statusWidth ?? right(l), lab)));
  const dot = rowH * 0.2;
  const x0 = box.x + dot * 3.4;
  // References only when they leave the titles at least half the width.
  const withRef = box.x + box.w - x0 - refW - labW - rowH * 0.8 >= box.w * 0.5;
  shown.forEach((l, i) => {
    const base = plan.rows[i]!.y + rowH * 0.72;
    dotAt(box.x + dot * 1.1, base - rowH * 0.22, dot, l.color);
    if (withRef) kit.drawTracked(g, l.ref, x0, base, { ...ref, color: colors.inkDim });
    const drawn = kit.drawTracked(g, right(l), box.x + box.w, base, { ...lab, color: l.aside === undefined ? l.color : colors.inkDim, align: 'right' });
    const lw = l.statusWidth ? Math.max(drawn, kit.measureTracked(g, l.statusWidth, lab)) : drawn;
    const tx = withRef ? x0 + refW + rowH * 0.4 : x0;
    const o1 = { size: Math.round(rowH * 0.7), family: fonts.sans, color: l.strong ? colors.ink : colors.inkDim };
    kit.drawTracked(g, kit.truncate(g, l.title, box.x + box.w - lw - rowH * 0.4 - tx, o1), tx, base, o1);
  });
  drawMore(g, ctx, plan, { indent: x0 - box.x });
}
