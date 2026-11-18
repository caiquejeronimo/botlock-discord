import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, SlashCommandBuilder, MessageFlags, InteractionContextType,
} from 'discord.js';
import {
  API, ASSETS, ApiError, getJson, describeError, sleep, heroes, ensureHeroes, heroName,
  activeMatches, matchMetadata, matchHistory, playerNames,
} from './src/api.js';
import { viewFromActive, viewFromMetadata } from './src/views.js';
import { cardPayload, liveButtons, livePicker, simplePayload, listButton } from './src/ui.js';
import { imageStatus } from './src/render.js';

const STATS_FILE = 'scores.json';
const QUESTIONS_FILE = 'questions.json';
const POINTS_PER_CORRECT = 10;
const STEAM64_BASE = 76561197960265728n;
const WATCH_INTERVAL_MS = 30_000;
const WATCH_TICKS = 10;      // 10 x 30s = 5 minutos de atualização automática
const MAX_WATCHERS = 20;     // limite para proteger o host e a API

function parseAccountId(input) {
  const s = input.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = BigInt(s);
  const id = n >= STEAM64_BASE ? n - STEAM64_BASE : n; // aceita SteamID64 também
  return id <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(id) : null;
}

// ---------- Perfil / pontuação (separados por servidor) ----------
function saveAllStats(all) {
  writeFileSync(STATS_FILE, JSON.stringify(all));
}

function loadAllStats(guildId) {
  if (!existsSync(STATS_FILE)) return {};
  let raw;
  try {
    raw = JSON.parse(readFileSync(STATS_FILE, 'utf8'));
  } catch {
    return {};
  }
  // Formato antigo (usuário -> pontos, sem separar por servidor): migra para o
  // primeiro servidor que consultar a pontuação depois da atualização.
  const legacy = Object.values(raw).some((v) => typeof v === 'number' || (v && typeof v === 'object' && 'points' in v));
  if (legacy) {
    const users = {};
    for (const [uid, v] of Object.entries(raw)) {
      users[uid] = typeof v === 'number' ? { points: v, answered: 0, correct: 0 } : v;
    }
    const migrated = { [guildId]: users };
    saveAllStats(migrated);
    return migrated;
  }
  return raw;
}

const loadStats = (guildId) => loadAllStats(guildId)[guildId] ?? {};

function recordAnswer(guildId, userId, correct) {
  const all = loadAllStats(guildId);
  const users = (all[guildId] ??= {});
  const s = users[userId] ?? { points: 0, answered: 0, correct: 0 };
  s.answered += 1;
  if (correct) {
    s.correct += 1;
    s.points += POINTS_PER_CORRECT;
  }
  users[userId] = s;
  saveAllStats(all);
  return s;
}

function rankOf(guildId, userId) {
  const sorted = Object.entries(loadStats(guildId)).sort((a, b) => b[1].points - a[1].points);
  const idx = sorted.findIndex(([id]) => id === userId);
  return idx === -1 ? null : idx + 1;
}

const accuracy = (s) => (s.answered ? Math.round((s.correct / s.answered) * 100) : 0);
const loadQuestions = () => JSON.parse(readFileSync(QUESTIONS_FILE, 'utf8'));

// ---------- Comandos ----------
const commands = [
  new SlashCommandBuilder().setName('partida').setDescription('Placar de uma partida pelo match ID')
    .addIntegerOption((o) => o.setName('match_id').setDescription('ID da partida').setRequired(true)),
  new SlashCommandBuilder().setName('aovivo').setDescription('Placar das partidas ao vivo')
    .addIntegerOption((o) => o.setName('partida').setDescription('Match ID de uma partida ao vivo'))
    .addStringOption((o) => o.setName('jogador').setDescription('Account ID ou SteamID64: acha a partida atual dele')),
  new SlashCommandBuilder().setName('jogador').setDescription('Últimas partidas de um jogador')
    .addStringOption((o) => o.setName('id').setDescription('Account ID ou SteamID64').setRequired(true)),
  new SlashCommandBuilder().setName('quiz').setDescription('Pergunta aleatória sobre Deadlock')
    .setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder().setName('perfil').setDescription('Sua pontuação no quiz')
    .addUserOption((o) => o.setName('usuario').setDescription('Ver o perfil de outra pessoa'))
    .setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder().setName('ranking').setDescription('Ranking do quiz neste servidor')
    .setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder().setName('status').setDescription('Testa a conexão do bot com a Deadlock API'),
].map((c) => c.toJSON());

// ---------- Respostas de erro ----------
async function fail(i, message) {
  try {
    if (i.isMessageComponent() || i.replied) await i.followUp({ content: message, flags: MessageFlags.Ephemeral });
    else await i.editReply({ content: message });
  } catch (e) {
    console.error('[fail]', e.message);
  }
}

// ---------- Placar ao vivo ----------
async function buildLiveView(matchId) {
  const match = (await activeMatches()).find((m) => Number(m.match_id) === matchId);
  if (!match) return null;
  await ensureHeroes();
  const nameOf = await playerNames((match.players ?? []).map((p) => p.account_id));
  return viewFromActive(match, nameOf);
}

async function finishedPayload(matchId) {
  await ensureHeroes();
  const data = await matchMetadata(matchId);
  const info = data.match_info ?? data;
  const players = info.players ?? [];
  if (!players.length) throw new ApiError('sem jogadores', { status: 404 });
  const nameOf = await playerNames(players.map((p) => p.account_id));
  return cardPayload(viewFromMetadata(matchId, info, nameOf));
}

// Quando a partida sai do feed: tenta mostrar o placar final, senão avisa.
async function endedPayload(matchId) {
  try {
    return await finishedPayload(matchId);
  } catch { /* resultado ainda não processado */ }
  return simplePayload(
    `## 🏁 Partida ${matchId} terminou\nO resultado final ainda não está disponível na API. Tente \`/partida ${matchId}\` em alguns minutos.`,
    listButton(),
  );
}

const watchers = new Map(); // id da mensagem -> token da vigilância ativa
const stopWatch = (msgId) => watchers.delete(msgId);

function startWatch(i, msgId, matchId) {
  if (watchers.size >= MAX_WATCHERS) return; // o botão Atualizar continua funcionando
  const token = Symbol();
  watchers.set(msgId, token);
  (async () => {
    for (let n = 0; n < WATCH_TICKS; n++) {
      await sleep(WATCH_INTERVAL_MS);
      if (watchers.get(msgId) !== token) return; // outra ação assumiu a mensagem
      try {
        const view = await buildLiveView(matchId);
        if (!view) {
          await i.editReply(await endedPayload(matchId));
          break;
        }
        await i.editReply(await cardPayload(view, liveButtons(matchId)));
      } catch (e) {
        console.error('[watch]', e.message); // token expirado, API fora do ar etc.
        break;
      }
    }
    if (watchers.get(msgId) === token) watchers.delete(msgId);
  })();
}

async function showLive(i, matchId) {
  try {
    const msgId = i.message?.id ?? (await i.fetchReply()).id;
    const view = await buildLiveView(matchId);
    if (!view) {
      stopWatch(msgId);
      return await i.editReply(await endedPayload(matchId));
    }
    await i.editReply(await cardPayload(view, liveButtons(matchId)));
    startWatch(i, msgId, matchId);
  } catch (e) {
    await fail(i, describeError(e));
  }
}

async function handleLiveButton(i) {
  const [, action, id] = i.customId.split(':');
  await i.deferUpdate();
  if (action === 'refresh') return showLive(i, Number(id));
  if (action === 'list') {
    stopWatch(i.message.id);
    try {
      return await i.editReply(livePicker(await activeMatches()));
    } catch (e) {
      return fail(i, describeError(e));
    }
  }
}

async function handleLivePick(i) {
  await i.deferUpdate();
  return showLive(i, Number(i.values[0]));
}

// ---------- Quiz ----------
function quizRows(q, qi, userId, { chosen = null, disabled = false } = {}) {
  const row = new ActionRowBuilder();
  q.options.forEach((opt, idx) => {
    let style = ButtonStyle.Secondary;
    if (disabled && idx === q.answer) style = ButtonStyle.Success;
    else if (disabled && idx === chosen) style = ButtonStyle.Danger;
    row.addComponents(
      new ButtonBuilder().setCustomId(`quiz:${userId}:${qi}:${idx}`)
        .setLabel(opt.slice(0, 80)).setStyle(style).setDisabled(disabled),
    );
  });
  return [row];
}

async function handleQuizButton(interaction) {
  const [, ownerId, qi, choice] = interaction.customId.split(':');
  if (interaction.user.id !== ownerId) {
    return interaction.reply({ content: 'Essa pergunta é de outra pessoa. Use /quiz para a sua!', flags: MessageFlags.Ephemeral });
  }
  const q = loadQuestions()[Number(qi)];
  if (!q) {
    return interaction.update({ content: 'Essa pergunta não existe mais. Use /quiz para uma nova.', embeds: [], components: [] });
  }
  const chosen = Number(choice);
  const correct = chosen === q.answer;
  const gid = interaction.guildId ?? 'dm';
  const stats = recordAnswer(gid, ownerId, correct);
  const pos = rankOf(gid, ownerId);

  const embed = new EmbedBuilder()
    .setColor(correct ? 0x57f287 : 0xed4245)
    .setTitle(correct ? `✅ Correto! +${POINTS_PER_CORRECT} pontos` : '❌ Não foi dessa vez')
    .setDescription(
      `**${q.question}**\n\nResposta certa: **${q.options[q.answer]}**` +
      (q.explanation ? `\n\n_${q.explanation}_` : ''),
    )
    .addFields(
      { name: 'Seus pontos', value: `${stats.points}`, inline: true },
      { name: 'Acertos', value: `${stats.correct}/${stats.answered} (${accuracy(stats)}%)`, inline: true },
      { name: 'Posição', value: pos ? `#${pos}` : '—', inline: true },
    )
    .setFooter({ text: '/quiz para jogar de novo • /perfil • /ranking' });

  return interaction.update({ embeds: [embed], components: quizRows(q, qi, ownerId, { chosen, disabled: true }) });
}

// ---------- Handlers ----------
const handlers = {
  async partida(i) {
    await i.deferReply();
    const matchId = i.options.getInteger('match_id');
    try {
      await i.editReply(await finishedPayload(matchId));
    } catch (e) {
      if (e.status === 404) {
        const live = await activeMatches().catch(() => []);
        if (live.some((m) => Number(m.match_id) === matchId)) return showLive(i, matchId); // em andamento: mostra ao vivo
        return fail(i,
          `Não encontrei a partida \`${matchId}\` na Deadlock API. Isso acontece quando o ID está errado, ` +
          'a partida ainda não foi processada ou nunca foi enviada para a API (ela só tem partidas coletadas pela comunidade).');
      }
      return fail(i, describeError(e));
    }
  },

  async aovivo(i) {
    await i.deferReply();
    try {
      const matchId = i.options.getInteger('partida');
      const player = i.options.getString('jogador');
      if (matchId) return showLive(i, matchId);
      if (player) {
        const acc = parseAccountId(player);
        if (acc == null) return fail(i, 'Informe só números: o Account ID ou o SteamID64.');
        const m = (await activeMatches()).find((x) => x.players?.some((p) => p.account_id === acc));
        if (!m) {
          return fail(i, 'Esse jogador não aparece nas partidas ao vivo agora. O feed mostra apenas as partidas em destaque.');
        }
        return showLive(i, Number(m.match_id));
      }
      return await i.editReply(livePicker(await activeMatches()));
    } catch (e) {
      return fail(i, describeError(e));
    }
  },

  async jogador(i) {
    await i.deferReply();
    const accountId = parseAccountId(i.options.getString('id'));
    if (accountId == null) return fail(i, 'Informe só números: o Account ID ou o SteamID64.');
    await ensureHeroes();
    try {
      const history = await matchHistory(accountId);
      if (!Array.isArray(history) || !history.length) return fail(i, 'Sem partidas recentes para esse jogador na API.');
      const lines = history.slice(0, 5).map((m) => {
        const win = m.match_result === m.player_team;
        const when = m.start_time ? ` · <t:${m.start_time}:R>` : '';
        return `${win ? '🏆' : '💀'} \`${m.match_id}\` **${heroName(m.hero_id)}** ` +
          `${m.player_kills ?? 0}/${m.player_deaths ?? 0}/${m.player_assists ?? 0}${when}`;
      });
      return await i.editReply(`**Últimas partidas de** \`${accountId}\`\n${lines.join('\n')}\n-# Use /partida com um desses IDs para ver o placar.`);
    } catch (e) {
      return fail(i, e.status === 404 ? 'Jogador não encontrado na API.' : describeError(e));
    }
  },

  async quiz(i) {
    const qs = loadQuestions();
    const qi = Math.floor(Math.random() * qs.length);
    const q = qs[qi];
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('🧠 Quiz Deadlock')
      .setDescription(`**${q.question}**`)
      .setFooter({ text: `${POINTS_PER_CORRECT} pontos por acerto • /perfil mostra sua pontuação` });
    return i.reply({ embeds: [embed], components: quizRows(q, qi, i.user.id) });
  },

  async perfil(i) {
    const target = i.options.getUser('usuario') ?? i.user;
    const gid = i.guildId ?? 'dm';
    const s = loadStats(gid)[target.id];
    if (!s) {
      const msg = target.id === i.user.id
        ? 'Você ainda não respondeu nenhuma pergunta. Use /quiz para começar!'
        : `${target.displayName} ainda não jogou o quiz.`;
      return i.reply({ content: msg, flags: MessageFlags.Ephemeral });
    }
    const pos = rankOf(gid, target.id);
    const embed = new EmbedBuilder()
      .setColor(0xf5b700)
      .setTitle(`Perfil de ${target.displayName}`)
      .setThumbnail(target.displayAvatarURL())
      .addFields(
        { name: 'Pontos', value: `${s.points}`, inline: true },
        { name: 'Posição', value: pos ? `#${pos}` : '—', inline: true },
        { name: 'Respondidas', value: `${s.answered}`, inline: true },
        { name: 'Acertos', value: `${s.correct} (${accuracy(s)}%)`, inline: true },
      );
    return i.reply({ embeds: [embed] });
  },

  async ranking(i) {
    const top = Object.entries(loadStats(i.guildId ?? 'dm')).sort((a, b) => b[1].points - a[1].points).slice(0, 10);
    const medals = ['🥇', '🥈', '🥉'];
    const text = top
      .map(([id, s], n) => `${medals[n] ?? `${n + 1}.`} <@${id}> — **${s.points}** pts (${s.correct}/${s.answered})`)
      .join('\n');
    return i.reply({ content: text || 'Ninguém pontuou ainda. Use /quiz!', allowedMentions: { parse: [] } });
  },

  async status(i) {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const checks = [
      ['Deadlock API', `${API}/v1/matches/active`],
      ['Assets (heróis)', `${ASSETS}/v2/heroes`],
    ];
    const lines = [];
    for (const [name, url] of checks) {
      const t = Date.now();
      try {
        await getJson(url, { retries: 0 });
        lines.push(`✅ ${name}: ${Date.now() - t} ms`);
      } catch (e) {
        lines.push(`❌ ${name}: ${e.status ?? e.code}`);
      }
    }
    lines.push(`Servidores: ${client.guilds.cache.size}`);
    lines.push(`Heróis carregados: ${heroes.size}`);
    lines.push(`Placar em imagem: ${imageStatus}`);
    lines.push(`Atualizações automáticas ativas: ${watchers.size}`);
    return i.editReply(lines.join('\n'));
  },
};

// ---------- Bot ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', async () => {
  await ensureHeroes();
  const guildId = process.env.GUILD_ID;
  if (guildId) {
    // Modo de testes: comandos só neste servidor (aparecem na hora).
    await (await client.guilds.fetch(guildId)).commands.set(commands);
  } else {
    // Produção: comandos globais, valem em todos os servidores onde o bot estiver.
    await client.application.commands.set(commands);
    // Uma vez só: remove os comandos antigos do servidor de testes para não duplicarem.
    const old = process.env.CLEAR_GUILD_ID;
    if (old) await (await client.guilds.fetch(old)).commands.set([]);
  }
  console.log(`Online como ${client.user.tag} • servidores: ${client.guilds.cache.size} • heróis: ${heroes.size} • imagem: ${imageStatus}`);
});

client.on('interactionCreate', async (i) => {
  try {
    if (i.isChatInputCommand()) await handlers[i.commandName]?.(i);
    else if (i.isStringSelectMenu() && i.customId === 'live:pick') await handleLivePick(i);
    else if (i.isButton() && i.customId.startsWith('live:')) await handleLiveButton(i);
    else if (i.isButton() && i.customId.startsWith('quiz:')) await handleQuizButton(i);
  } catch (e) {
    console.error(e);
  }
});

client.login(process.env.DISCORD_TOKEN);
