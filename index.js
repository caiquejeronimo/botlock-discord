import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  SlashCommandBuilder, MessageFlags, InteractionContextType, PermissionFlagsBits,
} from 'discord.js';
import {
  API, ASSETS, ApiError, getJson, describeError, sleep, heroes, ensureHeroes, heroName,
  activeMatches, activeMatchesFor, matchMetadata, matchHistory, playerNames,
} from './src/api.js';
import { getLink, setLink, removeLink } from './src/links.js';
import { viewFromActive, viewFromMetadata } from './src/views.js';
import { cardPayload, liveButtons, simplePayload } from './src/ui.js';
import { imageStatus } from './src/render.js';

const PREFIX = process.env.PREFIX || '!';
const PREFIX_ENABLED = process.env.PREFIX_COMMANDS !== 'off';
const STATS_FILE = 'scores.json';
const QUESTIONS_FILE = 'questions.json';
const POINTS_PER_CORRECT = 10;
const STEAM64_BASE = 76561197960265728n;
const WATCH_INTERVAL_MS = 30_000;
const WATCH_TICKS = 10;      // 10 x 30s = 5 minutos de atualização automática
const MAX_WATCHERS = 20;     // limite para proteger o host e a API
const COOLDOWN_MS = 3_000;   // por usuário, nos comandos com prefixo

// Quiz: 1 resposta por dia, por usuário e servidor. O "dia" vira à meia-noite deste fuso.
// QUIZ_DAILY_LIMIT=off libera respostas ilimitadas (útil para testar).
const QUIZ_LIMIT = process.env.QUIZ_DAILY_LIMIT !== 'off';
let QUIZ_TZ = process.env.QUIZ_TZ || 'America/Sao_Paulo';
try {
  new Intl.DateTimeFormat('en-US', { timeZone: QUIZ_TZ });
} catch {
  console.warn(`[quiz] Fuso inválido "${QUIZ_TZ}", usando America/Sao_Paulo.`);
  QUIZ_TZ = 'America/Sao_Paulo';
}

let client;
let prefixActive = false;

function parseAccountId(input) {
  const s = String(input).trim();
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

// ----- "dia" do quiz no fuso configurado -----
function tzParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  return Object.fromEntries(f.formatToParts(ms).map((p) => [p.type, p.value]));
}
const dayKey = (ms, tz) => {
  const o = tzParts(ms, tz);
  return `${o.year}-${o.month}-${o.day}`;
};
function nextResetMs(ms, tz) {
  const o = tzParts(ms, tz);
  const guess = Date.UTC(+o.year, +o.month - 1, +o.day + 1); // 00:00 UTC do dia seguinte
  const p = tzParts(guess, tz);
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return guess - (wall - guess); // converte "meia-noite no fuso" para o instante real
}
const nextResetTs = () => Math.floor(nextResetMs(Date.now(), QUIZ_TZ) / 1000);

const played = (s) => s.answered > 0 || s.points > 0;
const answeredToday = (s) => QUIZ_LIMIT && s?.daily?.day === dayKey(Date.now(), QUIZ_TZ) && s.daily.done === true;

// Escolhe (ou devolve) a pergunta do dia. Pedir de novo antes de responder devolve a MESMA
// pergunta, para ninguém abrir várias e escolher a mais fácil.
function assignQuiz(guildId, userId, total) {
  const resetTs = nextResetTs();
  const pick = (avoid) => {
    let qi = Math.floor(Math.random() * total);
    if (total > 1 && qi === avoid) qi = (qi + 1) % total;
    return qi;
  };
  if (!QUIZ_LIMIT) return { blocked: false, qi: pick(-1), resetTs };

  const today = dayKey(Date.now(), QUIZ_TZ);
  const all = loadAllStats(guildId);
  const users = (all[guildId] ??= {});
  const s = (users[userId] ??= { points: 0, answered: 0, correct: 0 });
  if (s.daily?.day === today) {
    if (s.daily.done) return { blocked: true, resetTs };
    if (s.daily.qi < total) return { blocked: false, qi: s.daily.qi, resetTs };
  }
  const qi = pick(s.daily?.qi ?? -1);
  s.daily = { day: today, qi, done: false };
  saveAllStats(all);
  return { blocked: false, qi, resetTs };
}

// Registra a resposta. Só vale se for a pergunta de hoje e ainda não respondida.
function submitAnswer(guildId, userId, qi, correct) {
  const all = loadAllStats(guildId);
  const users = (all[guildId] ??= {});
  const s = (users[userId] ??= { points: 0, answered: 0, correct: 0 });
  if (QUIZ_LIMIT) {
    const today = dayKey(Date.now(), QUIZ_TZ);
    if (s.daily?.day !== today || s.daily.qi !== qi) return { status: 'expired' };
    if (s.daily.done) return { status: 'done' };
    s.daily.done = true;
  }
  s.answered += 1;
  if (correct) {
    s.correct += 1;
    s.points += POINTS_PER_CORRECT;
  }
  saveAllStats(all);
  return { status: 'ok', stats: s };
}

function rankOf(guildId, userId) {
  const sorted = Object.entries(loadStats(guildId)).filter(([, s]) => played(s)).sort((a, b) => b[1].points - a[1].points);
  const idx = sorted.findIndex(([id]) => id === userId);
  return idx === -1 ? null : idx + 1;
}

const accuracy = (s) => (s.answered ? Math.round((s.correct / s.answered) * 100) : 0);
const loadQuestions = () => JSON.parse(readFileSync(QUESTIONS_FILE, 'utf8'));

// ---------- Comandos / (slash) ----------
const commands = [
  new SlashCommandBuilder().setName('aovivo').setDescription('Placar ao vivo da partida de um jogador (padrão: você)')
    .addUserOption((o) => o.setName('usuario').setDescription('Outro membro que já vinculou a conta'))
    .addStringOption((o) => o.setName('jogador').setDescription('Account ID ou SteamID64')),
  new SlashCommandBuilder().setName('partida').setDescription('Placar de uma partida pelo match ID')
    .addIntegerOption((o) => o.setName('match_id').setDescription('ID da partida').setRequired(true)),
  new SlashCommandBuilder().setName('jogador').setDescription('Últimas partidas de um jogador (padrão: você)')
    .addUserOption((o) => o.setName('usuario').setDescription('Outro membro que já vinculou a conta'))
    .addStringOption((o) => o.setName('id').setDescription('Account ID ou SteamID64')),
  new SlashCommandBuilder().setName('vincular').setDescription('Vincula sua conta do Deadlock ao seu Discord')
    .addStringOption((o) => o.setName('id').setDescription('Account ID ou SteamID64').setRequired(true)),
  new SlashCommandBuilder().setName('desvincular').setDescription('Remove o vínculo da sua conta'),
  new SlashCommandBuilder().setName('quiz').setDescription('Pergunta aleatória sobre Deadlock')
    .setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder().setName('perfil').setDescription('Sua pontuação no quiz')
    .addUserOption((o) => o.setName('usuario').setDescription('Ver o perfil de outra pessoa'))
    .setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder().setName('ranking').setDescription('Ranking do quiz neste servidor')
    .setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder().setName('status').setDescription('Testa a conexão do bot com a Deadlock API')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('ajuda').setDescription('Mostra todos os comandos disponíveis'),
].map((c) => c.toJSON());

// ---------- Comandos com prefixo (!) ----------
const ALIASES = {
  aovivo: 'aovivo', live: 'aovivo',
  partida: 'partida', match: 'partida',
  jogador: 'jogador', player: 'jogador',
  vincular: 'vincular', link: 'vincular',
  desvincular: 'desvincular', unlink: 'desvincular',
  quiz: 'quiz', perfil: 'perfil', ranking: 'ranking', rank: 'ranking',
  status: 'status', ajuda: 'ajuda', help: 'ajuda', comandos: 'ajuda', funcoes: 'ajuda',
};

function stripEphemeral(payload) {
  const p = { ...payload };
  if (p.flags != null) {
    const f = Number(p.flags) & ~Number(MessageFlags.Ephemeral); // mensagens normais não têm "efêmero"
    if (f) p.flags = f;
    else delete p.flags;
  }
  return p;
}

// Faz uma mensagem "!comando" se comportar como uma interação, para reaproveitar os handlers.
function messageCtx(message, opts) {
  let sent = null;
  const norm = (payload) => ({
    ...stripEphemeral(typeof payload === 'string' ? { content: payload } : payload),
    allowedMentions: { parse: [], repliedUser: false },
  });
  const ctx = {
    user: message.author,
    guildId: message.guildId,
    message: null,
    deferred: false,
    replied: false,
    options: {
      getInteger: (n) => opts[n] ?? null,
      getString: (n) => (opts[n] == null ? null : String(opts[n])),
      getUser: (n) => opts[n] ?? null,
    },
    isMessageComponent: () => false,
    async deferReply() {
      ctx.deferred = true;
      message.channel.sendTyping().catch(() => {});
    },
    async reply(payload) {
      try {
        sent = await message.reply(norm(payload));
      } catch {
        sent = await message.channel.send(norm(payload));
      }
      ctx.replied = true;
      return sent;
    },
    async editReply(payload) {
      if (!sent) return ctx.reply(payload);
      return sent.edit(norm(payload));
    },
    followUp: (payload) => message.channel.send(norm(payload)),
    fetchReply: async () => sent,
    deleteInvocation: () => message.delete().catch(() => {}),
  };
  return ctx;
}

const cooldowns = new Map();
async function onMessage(message) {
  if (message.author.bot || !message.guild || !message.content.startsWith(PREFIX)) return;
  const [raw, ...args] = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = ALIASES[(raw ?? '').toLowerCase()];
  if (!cmd) return;
  if (cmd === 'status' && !message.member?.permissions.has(PermissionFlagsBits.ManageGuild)) return;

  const now = Date.now();
  if (now - (cooldowns.get(message.author.id) ?? 0) < COOLDOWN_MS) return;
  if (cooldowns.size > 1000) cooldowns.clear();
  cooldowns.set(message.author.id, now);

  const mention = message.mentions.users.first() ?? null;
  const first = args.find((a) => !/^<@!?\d+>$/.test(a)) ?? null;
  const opts = {
    usuario: mention,
    jogador: first,
    id: first,
    match_id: first && /^\d+$/.test(first) ? Number(first) : null,
  };
  try {
    await handlers[cmd](messageCtx(message, opts));
  } catch (e) {
    console.error(e);
  }
}

// ---------- Respostas de erro ----------
async function fail(i, message) {
  try {
    if (i.isMessageComponent() || i.replied) await i.followUp({ content: message, flags: MessageFlags.Ephemeral });
    else await i.editReply({ content: message });
  } catch (e) {
    console.error('[fail]', e.message);
  }
}

// Quem é o jogador? ID informado > usuário mencionado > você (conta vinculada).
const NEED_LINK = `Vincule sua conta primeiro: \`${PREFIX}vincular <Account ID ou SteamID64>\` (ou use /vincular, que é privado).`;
function resolveTarget(i) {
  const raw = i.options.getString('jogador') ?? i.options.getString('id');
  if (raw) {
    const accountId = parseAccountId(raw);
    return accountId == null
      ? { error: 'Informe só números: o Account ID ou o SteamID64.' }
      : { accountId, self: false };
  }
  const user = i.options.getUser('usuario') ?? i.user;
  const accountId = getLink(user.id);
  if (accountId) return { accountId, self: user.id === i.user.id };
  return { error: user.id === i.user.id ? NEED_LINK : `${user.displayName} ainda não vinculou uma conta.` };
}

// ---------- Placar ao vivo ----------
async function buildLiveView(matchId, accountId) {
  const pool = accountId ? await activeMatchesFor(accountId) : await activeMatches();
  const match = pool.find((m) => Number(m.match_id) === matchId);
  if (!match) return null;
  await ensureHeroes();
  const nameOf = await playerNames((match.players ?? []).map((p) => p.account_id));
  return viewFromActive(match, nameOf, accountId);
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
    `## 🏁 Partida ${matchId} terminou\nO resultado final ainda não está disponível na API. Tente \`${PREFIX}partida ${matchId}\` em alguns minutos.`,
  );
}

const getMsgId = async (i) => i.message?.id ?? (await i.fetchReply()).id;
const watchers = new Map(); // id da mensagem -> token da vigilância ativa
const stopWatch = (msgId) => watchers.delete(msgId);

function startWatch(i, msgId, matchId, accountId) {
  if (watchers.size >= MAX_WATCHERS) return; // o botão Atualizar continua funcionando
  const token = Symbol();
  watchers.set(msgId, token);
  (async () => {
    for (let n = 0; n < WATCH_TICKS; n++) {
      await sleep(WATCH_INTERVAL_MS);
      if (watchers.get(msgId) !== token) return; // outra ação assumiu a mensagem
      try {
        const view = await buildLiveView(matchId, accountId);
        if (!view) {
          await i.editReply(await endedPayload(matchId));
          break;
        }
        await i.editReply(await cardPayload(view, liveButtons(matchId, accountId)));
      } catch (e) {
        console.error('[watch]', e.message); // token expirado, API fora do ar etc.
        break;
      }
    }
    if (watchers.get(msgId) === token) watchers.delete(msgId);
  })();
}

async function showLive(i, matchId, accountId = null) {
  try {
    const view = await buildLiveView(matchId, accountId);
    if (!view) {
      await i.editReply(await endedPayload(matchId));
      stopWatch(await getMsgId(i));
      return;
    }
    await i.editReply(await cardPayload(view, liveButtons(matchId, accountId)));
    startWatch(i, await getMsgId(i), matchId, accountId);
  } catch (e) {
    await fail(i, describeError(e));
  }
}

async function handleLiveButton(i) {
  const [, action, id, acc] = i.customId.split(':');
  if (action !== 'refresh') {
    return i.reply({ content: `Esse botão é de uma versão antiga. Use \`${PREFIX}aovivo\`.`, flags: MessageFlags.Ephemeral });
  }
  await i.deferUpdate();
  return showLive(i, Number(id), Number(acc) || null);
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
    return interaction.reply({ content: `Essa pergunta é de outra pessoa. Use ${PREFIX}quiz para a sua!`, flags: MessageFlags.Ephemeral });
  }
  const q = loadQuestions()[Number(qi)];
  const chosen = Number(choice);
  const gid = interaction.guildId ?? 'dm';
  const res = q ? submitAnswer(gid, ownerId, Number(qi), chosen === q.answer) : { status: 'expired' };

  if (res.status === 'expired') {
    return interaction.update({ content: `Essa pergunta expirou. Use ${PREFIX}quiz para ver a de hoje.`, embeds: [], components: [] });
  }
  if (res.status === 'done') {
    return interaction.update({
      content: `⏳ Você já respondeu o quiz de hoje! A próxima pergunta libera <t:${nextResetTs()}:R>.`,
      embeds: [], components: [],
    });
  }

  const correct = chosen === q.answer;
  const stats = res.stats;
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
    .setFooter({ text: `${PREFIX}perfil • ${PREFIX}ranking` });
  if (QUIZ_LIMIT) embed.addFields({ name: 'Próxima pergunta', value: `<t:${nextResetTs()}:R>`, inline: true });

  return interaction.update({ embeds: [embed], components: quizRows(q, qi, ownerId, { chosen, disabled: true }) });
}

// ---------- Handlers ----------
const handlers = {
  async aovivo(i) {
    await i.deferReply();
    try {
      const target = resolveTarget(i);
      if (target.error) return fail(i, target.error);
      const live = await activeMatchesFor(target.accountId);
      const match = live.find((m) => m.players?.some((p) => p.account_id === target.accountId));
      if (!match) {
        return fail(i, `${target.self ? 'Você não está' : 'Esse jogador não está'} em uma partida agora. ` +
          'Se já entrou na partida, aguarde um instante e tente de novo.');
      }
      return showLive(i, Number(match.match_id), target.accountId);
    } catch (e) {
      return fail(i, describeError(e));
    }
  },

  async partida(i) {
    await i.deferReply();
    const matchId = i.options.getInteger('match_id');
    if (!matchId) return fail(i, `Use: \`${PREFIX}partida <match_id>\``);
    try {
      await i.editReply(await finishedPayload(matchId));
    } catch (e) {
      if (e.status === 404) {
        const live = await activeMatches().catch(() => []);
        if (live.some((m) => Number(m.match_id) === matchId)) return showLive(i, matchId); // em andamento
        return fail(i,
          `Não encontrei a partida \`${matchId}\` na Deadlock API. Isso acontece quando o ID está errado, ` +
          'a partida ainda não foi processada ou nunca foi enviada para a API (ela só tem partidas coletadas pela comunidade).');
      }
      return fail(i, describeError(e));
    }
  },

  async jogador(i) {
    await i.deferReply();
    const target = resolveTarget(i);
    if (target.error) return fail(i, target.error);
    await ensureHeroes();
    try {
      const history = await matchHistory(target.accountId);
      if (!Array.isArray(history) || !history.length) return fail(i, 'Sem partidas recentes para esse jogador na API.');
      const lines = history.slice(0, 5).map((m) => {
        const win = m.match_result === m.player_team;
        const when = m.start_time ? ` · <t:${m.start_time}:R>` : '';
        return `${win ? '🏆' : '💀'} \`${m.match_id}\` **${heroName(m.hero_id)}** ` +
          `${m.player_kills ?? 0}/${m.player_deaths ?? 0}/${m.player_assists ?? 0}${when}`;
      });
      return await i.editReply(`**Últimas partidas**\n${lines.join('\n')}\n-# Use ${PREFIX}partida com um desses IDs para ver o placar.`);
    } catch (e) {
      return fail(i, e.status === 404 ? 'Jogador não encontrado na API.' : describeError(e));
    }
  },

  async vincular(i) {
    const raw = i.options.getString('id');
    const accountId = raw ? parseAccountId(raw) : null;
    if (accountId == null) {
      return i.reply({ content: `Use: \`${PREFIX}vincular <Account ID ou SteamID64>\``, flags: MessageFlags.Ephemeral });
    }
    setLink(i.user.id, accountId);
    await i.reply({ content: `✅ Conta vinculada. Quando estiver em partida, use \`${PREFIX}aovivo\`.`, flags: MessageFlags.Ephemeral });
    i.deleteInvocation?.(); // apaga a mensagem com o ID, se o bot tiver permissão
  },

  async desvincular(i) {
    const had = removeLink(i.user.id);
    return i.reply({ content: had ? '🗑️ Vínculo removido.' : 'Você não tinha conta vinculada.', flags: MessageFlags.Ephemeral });
  },

  async quiz(i) {
    const qs = loadQuestions();
    const slot = assignQuiz(i.guildId ?? 'dm', i.user.id, qs.length);
    if (slot.blocked) {
      return i.reply({
        content: `⏳ Você já respondeu o quiz de hoje! A próxima pergunta libera <t:${slot.resetTs}:R> (<t:${slot.resetTs}:t>).`,
        flags: MessageFlags.Ephemeral,
      });
    }
    const q = qs[slot.qi];
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('🧠 Quiz Deadlock')
      .setDescription(`**${q.question}**`)
      .setFooter({
        text: QUIZ_LIMIT
          ? `1 pergunta por dia • ${POINTS_PER_CORRECT} pontos por acerto`
          : `${POINTS_PER_CORRECT} pontos por acerto`,
      });
    return i.reply({ embeds: [embed], components: quizRows(q, slot.qi, i.user.id) });
  },

  async perfil(i) {
    const target = i.options.getUser('usuario') ?? i.user;
    const gid = i.guildId ?? 'dm';
    const s = loadStats(gid)[target.id];
    if (!s || !played(s)) {
      const msg = target.id === i.user.id
        ? `Você ainda não respondeu nenhuma pergunta. Use ${PREFIX}quiz para começar!`
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
    if (QUIZ_LIMIT) {
      embed.addFields({ name: 'Quiz de hoje', value: answeredToday(s) ? '✅ Respondido' : '⏳ Disponível', inline: true });
    }
    return i.reply({ embeds: [embed] });
  },

  async ranking(i) {
    const top = Object.entries(loadStats(i.guildId ?? 'dm')).filter(([, s]) => played(s))
      .sort((a, b) => b[1].points - a[1].points).slice(0, 10);
    const medals = ['🥇', '🥈', '🥉'];
    const text = top
      .map(([id, s], n) => `${medals[n] ?? `${n + 1}.`} <@${id}> — **${s.points}** pts (${s.correct}/${s.answered})`)
      .join('\n');
    return i.reply({ content: text || `Ninguém pontuou ainda. Use ${PREFIX}quiz!`, allowedMentions: { parse: [] } });
  },

  async status(i) {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const checks = [
      ['Deadlock API', `${API}/v1/matches/active`],
      ['Assets (heróis)', `${ASSETS}/heroes`],
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
    lines.push(`Comandos com prefixo (${PREFIX}): ${prefixActive ? 'ativos' : 'desativados'}`);
    lines.push(`Placar em imagem: ${imageStatus}`);
    lines.push(`Atualizações automáticas ativas: ${watchers.size}`);
    return i.editReply(lines.join('\n'));
  },

  async ajuda(i) {
    const p = prefixActive ? PREFIX : '/';
    const sections = [
      ['🎮 Partidas', [
        ['aovivo', '[@pessoa|id]', 'Placar ao vivo da sua partida (ou de outro jogador)'],
        ['partida', '<match_id>', 'Placar de uma partida, ao vivo ou finalizada'],
        ['jogador', '[@pessoa|id]', 'Últimas 5 partidas'],
      ]],
      ['🔗 Conta', [
        ['vincular', '<id>', 'Liga sua conta do Deadlock (Account ID ou SteamID64) ao seu Discord'],
        ['desvincular', '', 'Remove o vínculo da sua conta'],
      ]],
      ['🧠 Quiz', [
        ['quiz', '', QUIZ_LIMIT ? `1 pergunta por dia, ${POINTS_PER_CORRECT} pontos por acerto` : `Pergunta com ${POINTS_PER_CORRECT} pontos por acerto`],
        ['perfil', '[@pessoa]', 'Pontos, posição e taxa de acerto'],
        ['ranking', '', 'Top 10 do servidor'],
      ]],
      ['⚙️ Outros', [
        ['ajuda', '', 'Mostra esta lista'],
        ['status', '', 'Diagnóstico do bot (exige Gerenciar Servidor)'],
      ]],
    ];
    const embed = new EmbedBuilder()
      .setColor(0xf5b700)
      .setTitle('📖 Comandos do bot')
      .setDescription(
        (prefixActive ? `Funcionam com \`${PREFIX}\` e com \`/\`. ` : 'Use os comandos com `/`. ') +
        '`[ ]` = opcional · `< >` = obrigatório',
      );
    for (const [name, items] of sections) {
      embed.addFields({
        name,
        value: items.map(([c, a, d]) => `\`${p}${c}${a ? ` ${a}` : ''}\` — ${d}`).join('\n'),
      });
    }
    embed.setFooter({ text: `Dica: use ${p}vincular uma vez e depois é só digitar ${p}aovivo quando estiver em partida` });
    return i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
  },
};

// ---------- Bot ----------
function createClient(withContent) {
  const intents = [GatewayIntentBits.Guilds];
  if (withContent) intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
  const c = new Client({ intents });

  c.once('clientReady', async () => {
    prefixActive = withContent;
    await ensureHeroes();
    const guildId = process.env.GUILD_ID;
    if (guildId) {
      // Modo de testes: comandos / só neste servidor (aparecem na hora).
      await (await c.guilds.fetch(guildId)).commands.set(commands);
    } else {
      // Produção: comandos / globais, valem em todos os servidores onde o bot estiver.
      await c.application.commands.set(commands);
      // Uma vez só: remove os comandos antigos do servidor de testes para não duplicarem.
      const old = process.env.CLEAR_GUILD_ID;
      if (old) await (await c.guilds.fetch(old)).commands.set([]);
    }
    console.log(
      `Online como ${c.user.tag} • servidores: ${c.guilds.cache.size} • prefixo: ${withContent ? PREFIX : 'desativado'} ` +
      `• heróis: ${heroes.size} • imagem: ${imageStatus}`,
    );
  });

  c.on('interactionCreate', async (i) => {
    try {
      if (i.isChatInputCommand()) await handlers[i.commandName]?.(i);
      else if (i.isButton() && i.customId.startsWith('live:')) await handleLiveButton(i);
      else if (i.isStringSelectMenu() && i.customId === 'live:pick') {
        await i.reply({ content: `Essa lista foi removida. Use \`${PREFIX}aovivo\` para ver a sua partida.`, flags: MessageFlags.Ephemeral });
      } else if (i.isButton() && i.customId.startsWith('quiz:')) await handleQuizButton(i);
    } catch (e) {
      console.error(e);
    }
  });

  if (withContent) c.on('messageCreate', onMessage);
  return c;
}

async function start() {
  const modes = PREFIX_ENABLED ? [true, false] : [false];
  for (const withContent of modes) {
    client = createClient(withContent);
    try {
      await client.login(process.env.DISCORD_TOKEN);
      return;
    } catch (e) {
      client.destroy();
      if (withContent && (e.code === 'DisallowedIntents' || /intent/i.test(e.message))) {
        console.warn('[intents] "Message Content Intent" está desligado no Developer Portal. ' +
          'Seguindo só com comandos / (veja o README para ativar o prefixo).');
        continue;
      }
      throw e;
    }
  }
}

start().catch((e) => {
  console.error(e);
  process.exit(1);
});
