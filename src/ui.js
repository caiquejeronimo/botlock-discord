import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder,
  MediaGalleryBuilder, MediaGalleryItemBuilder, MessageFlags, SeparatorBuilder,
  SeparatorSpacingSize, TextDisplayBuilder,
} from 'discord.js';
import { renderCard } from './render.js';
import { fmtK, fmtTime } from './views.js';

const text = (content) => new TextDisplayBuilder().setContent(content);
const divider = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
const v2 = (container, files = []) => ({
  components: [container], files, attachments: [], flags: MessageFlags.IsComponentsV2,
});

function headerText(view) {
  if (view.kind === 'live') {
    const bits = [`#${view.matchId}`];
    if (view.spectators != null) bits.push(`👁 ${view.spectators}`);
    if (view.elapsedS != null) bits.push(`⏱ ${fmtTime(view.elapsedS)}`);
    return `## 🔴 Partida ao vivo\n-# ${bits.join(' · ')}`;
  }
  const bits = [`#${view.matchId}`];
  if (view.durationS != null) bits.push(`⏱ ${fmtTime(view.durationS)}`);
  if (view.startTime) bits.push(`<t:${view.startTime}:f>`);
  const winner = view.teams.find((t) => t.id === view.winner);
  return `## 🏁 Partida finalizada\n-# ${bits.join(' · ')}${winner ? `\n**Vencedor: ${winner.label}**` : ''}`;
}

// Layout em texto: usado quando a imagem não está disponível.
function teamText(t, winner, highlightId) {
  const head = `**${t.id === winner ? '🏆 ' : ''}${t.label}**${t.netWorth != null ? ` · ${fmtK(t.netWorth)} souls` : ''}`;
  const rows = t.rows.map((r) => `${highlightId && r.accountId === highlightId ? '⭐' : '•'} **${r.hero}** — ${r.name}${r.kda ? ` · ${r.kda}` : ''}${r.souls ? ` · ${r.souls}` : ''}`);
  return [head, ...rows].join('\n');
}

export async function cardPayload(view, buttons = null) {
  const container = new ContainerBuilder().setAccentColor(view.kind === 'live' ? 0xed4245 : 0xf5b700);
  container.addTextDisplayComponents(text(headerText(view)));

  let png = null;
  try {
    png = await renderCard(view);
  } catch (e) {
    console.error('[render]', e);
  }

  let files = [];
  if (png) {
    const name = `placar-${view.matchId}-${Date.now()}.png`;
    files = [new AttachmentBuilder(png, { name })];
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(`attachment://${name}`)),
    );
  } else {
    container.addSeparatorComponents(divider());
    for (const t of view.teams) container.addTextDisplayComponents(text(teamText(t, view.winner, view.highlightId)));
  }

  container.addTextDisplayComponents(text('-# Dados: Deadlock API · podem ter atraso'));
  if (buttons) {
    container.addSeparatorComponents(divider());
    container.addActionRowComponents(buttons);
  }
  return v2(container, files);
}

export function liveButtons(matchId, accountId = null) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`live:refresh:${matchId}:${accountId ?? 0}`)
      .setLabel('Atualizar').setEmoji('🔄').setStyle(ButtonStyle.Primary),
  );
}

export function simplePayload(message, buttons = null) {
  const container = new ContainerBuilder().setAccentColor(0x5865f2).addTextDisplayComponents(text(message));
  if (buttons) container.addActionRowComponents(buttons);
  return v2(container);
}
