// Gera a imagem do placar. Totalmente opcional: se @napi-rs/canvas ou as fontes
// não estiverem disponíveis, o bot usa o layout em texto (ver ui.js).
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { heroIcon } from './api.js';
import { fmtK, fmtTime } from './views.js';

let lib = null;
try {
  lib = await import('@napi-rs/canvas');
} catch { /* dependência opcional */ }

const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'fonts');
const fonts = { regular: 'sans-serif', bold: 'sans-serif' };
let enabled = false;
export let imageStatus = 'desativado (@napi-rs/canvas não instalado)';

if (lib) {
  const { GlobalFonts } = lib;
  const find = (names) => names.map((n) => path.join(FONT_DIR, n)).find((p) => existsSync(p));
  const reg = find(['font-regular.ttf', 'font-regular.otf', 'NotoSans-Regular.ttf']);
  const bold = find(['font-bold.ttf', 'font-bold.otf', 'NotoSans-Bold.ttf']);
  if (reg) { GlobalFonts.registerFromPath(reg, 'UI'); fonts.regular = 'UI'; fonts.bold = 'UI'; }
  if (bold) { GlobalFonts.registerFromPath(bold, 'UIBold'); fonts.bold = 'UIBold'; }
  const hasSystemFonts = Array.isArray(GlobalFonts.families) && GlobalFonts.families.length > 0;
  if (process.env.IMAGES === 'off') imageStatus = 'desativado (IMAGES=off)';
  else if (reg || hasSystemFonts) {
    enabled = true;
    imageStatus = `ativo (${reg ? 'fonte do projeto' : 'fontes do sistema'})`;
  } else imageStatus = 'desativado (sem fontes: coloque font-regular.ttf em assets/fonts)';
}

const C = { bg: '#0d1017', panel: '#171c27', panel2: '#222938', text: '#eef0f6', muted: '#8b93a7', live: '#ed4245', gold: '#f5b700' };

// ---------- helpers de desenho ----------
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fit(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

const iconCache = new Map();
async function loadIcon(heroId) {
  if (iconCache.has(heroId)) return iconCache.get(heroId);
  let img = null;
  const url = heroIcon(heroId);
  if (url) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) img = await lib.loadImage(Buffer.from(await res.arrayBuffer()));
    } catch { /* sem ícone: desenha um placeholder */ }
  }
  iconCache.set(heroId, img);
  return img;
}

// ---------- placar ----------
export async function renderCard(view) {
  if (!enabled) return null;
  const W = 900, pad = 24, rowH = 56, rowGap = 6;
  const teams = view.teams.slice(0, 2);
  const rowsMax = Math.max(1, ...teams.map((t) => t.rows.length));
  const showBar = teams.length === 2 && teams.every((t) => t.netWorth != null);
  const headerH = 88;
  const barBlock = showBar ? 74 : 0;
  const colsY = headerH + barBlock + 8;
  const H = colsY + 40 + rowsMax * (rowH + rowGap) + pad;

  const heroIds = [...new Set(teams.flatMap((t) => t.rows.map((r) => r.heroId)).filter(Boolean))];
  await Promise.all(heroIds.map(loadIcon));

  const canvas = lib.createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  // Cabeçalho
  ctx.fillStyle = C.panel;
  roundRect(ctx, 12, 12, W - 24, headerH - 12, 14);
  ctx.fill();
  ctx.textAlign = 'left';
  ctx.fillStyle = C.text;
  ctx.font = `24px ${fonts.bold}`;
  if (view.kind === 'live') {
    ctx.fillStyle = C.live;
    ctx.beginPath();
    ctx.arc(40, 40, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = C.text;
    ctx.fillText('AO VIVO', 56, 48);
  } else {
    ctx.fillText('PARTIDA FINALIZADA', 32, 48);
  }
  ctx.fillStyle = C.muted;
  ctx.font = `15px ${fonts.regular}`;
  ctx.fillText(`Partida #${view.matchId}`, 32, 72);

  ctx.textAlign = 'right';
  ctx.fillStyle = C.text;
  ctx.font = `18px ${fonts.bold}`;
  const topRight = view.kind === 'live'
    ? (view.elapsedS != null ? fmtTime(view.elapsedS) : '')
    : (view.durationS != null ? fmtTime(view.durationS) : '');
  ctx.fillText(topRight, W - 32, 46);
  ctx.fillStyle = C.muted;
  ctx.font = `14px ${fonts.regular}`;
  if (view.kind === 'live' && view.spectators != null) ctx.fillText(`${view.spectators} espectadores`, W - 32, 70);

  // Barra de vantagem de souls
  if (showBar) {
    const [a, b] = teams;
    const y0 = headerH + 8;
    const barW = W - 2 * pad;
    const aw = Math.round((barW * a.netWorth) / Math.max(1, a.netWorth + b.netWorth));
    ctx.font = `17px ${fonts.bold}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = a.color;
    ctx.fillText(`${a.label}  ${fmtK(a.netWorth)}`, pad, y0 + 20);
    ctx.textAlign = 'right';
    ctx.fillStyle = b.color;
    ctx.fillText(`${fmtK(b.netWorth)}  ${b.label}`, W - pad, y0 + 20);
    ctx.save();
    roundRect(ctx, pad, y0 + 32, barW, 14, 7);
    ctx.clip();
    ctx.fillStyle = a.color;
    ctx.fillRect(pad, y0 + 32, aw, 14);
    ctx.fillStyle = b.color;
    ctx.fillRect(pad + aw, y0 + 32, barW - aw, 14);
    ctx.restore();
    const diff = a.netWorth - b.netWorth;
    ctx.textAlign = 'center';
    ctx.fillStyle = C.muted;
    ctx.font = `14px ${fonts.regular}`;
    ctx.fillText(diff === 0 ? 'Empatado' : `${diff > 0 ? a.label : b.label} +${fmtK(Math.abs(diff))}`, W / 2, y0 + 20);
  }

  // Colunas dos times
  const colW = (W - pad * 3) / 2;
  teams.forEach((t, ti) => {
    const x = pad + ti * (colW + pad);
    ctx.textAlign = 'left';
    ctx.fillStyle = t.color;
    ctx.font = `20px ${fonts.bold}`;
    ctx.fillText(t.label, x, colsY + 22);
    ctx.fillRect(x, colsY + 30, colW, 2);
    ctx.textAlign = 'right';
    if (view.winner != null && t.id === view.winner) {
      ctx.fillStyle = C.gold;
      ctx.font = `16px ${fonts.bold}`;
      ctx.fillText('VENCEDOR', x + colW, colsY + 22);
    } else if (t.netWorth != null) {
      ctx.fillStyle = C.muted;
      ctx.font = `15px ${fonts.regular}`;
      ctx.fillText(`${fmtK(t.netWorth)} souls`, x + colW, colsY + 22);
    }

    t.rows.forEach((r, ri) => {
      const y = colsY + 40 + ri * (rowH + rowGap);
      ctx.fillStyle = C.panel;
      roundRect(ctx, x, y, colW, rowH, 10);
      ctx.fill();
      ctx.fillStyle = t.color;
      roundRect(ctx, x, y, 4, rowH, 2);
      ctx.fill();

      const ix = x + 14, iy = y + 6, is = 44;
      const img = iconCache.get(r.heroId);
      if (img) {
        ctx.save();
        roundRect(ctx, ix, iy, is, is, 8);
        ctx.clip();
        ctx.drawImage(img, ix, iy, is, is);
        ctx.restore();
      } else {
        ctx.fillStyle = C.panel2;
        roundRect(ctx, ix, iy, is, is, 8);
        ctx.fill();
        ctx.fillStyle = C.muted;
        ctx.textAlign = 'center';
        ctx.font = `20px ${fonts.bold}`;
        ctx.fillText((r.hero[0] ?? '?').toUpperCase(), ix + is / 2, iy + 29);
      }

      const textX = ix + is + 12;
      const rightW = r.kda ? 96 : 0;
      const maxW = colW - (textX - x) - rightW - 12;
      ctx.textAlign = 'left';
      ctx.fillStyle = C.text;
      ctx.font = `17px ${fonts.bold}`;
      ctx.fillText(fit(ctx, r.hero, maxW), textX, y + 24);
      ctx.fillStyle = C.muted;
      ctx.font = `14px ${fonts.regular}`;
      ctx.fillText(fit(ctx, r.name, maxW), textX, y + 44);

      if (r.kda) {
        ctx.textAlign = 'right';
        ctx.fillStyle = C.text;
        ctx.font = `17px ${fonts.bold}`;
        ctx.fillText(r.kda, x + colW - 14, y + 24);
        ctx.fillStyle = C.muted;
        ctx.font = `14px ${fonts.regular}`;
        ctx.fillText(r.souls, x + colW - 14, y + 44);
      }
    });
  });

  return canvas.encode('png');
}
