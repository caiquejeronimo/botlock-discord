import 'dotenv/config';
import dns from 'node:dns';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, SlashCommandBuilder, MessageFlags,
} from 'discord.js';

// Muitos hosts não têm IPv6 funcionando; preferir IPv4 evita "fetch failed".
dns.setDefaultResultOrder('ipv4first');

const API = 'https://api.deadlock-api.com';
const ASSETS = 'https://assets.deadlock-api.com';
const STATS_FILE = 'scores.json';
const QUESTIONS_FILE = 'questions.json';
const POINTS_PER_CORRECT = 10;
const STEAM64_BASE = 76561197960265728n;
const HEADERS = { 'User-Agent': 'deadlock-discord-bot/0.2', Accept: 'application/json' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Cliente HTTP com erros legíveis ----------
class ApiError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function getJson(url, { retries = 2 } = {}) {
  let err;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15_000) });
      if (res.ok) return await res.json();
      err = new ApiError(`HTTP ${res.status}`, { status: res.status });
      if (res.status !== 429 && res.status < 500) break; // 4xx: repetir não adianta
    } catch (e) {
      // e.cause.code traz o motivo real (ENOTFOUND, ETIMEDOUT, ECONNREFUSED...)
      err = new ApiError(e.message, { code: e.cause?.code ?? e.name });
    }
    if (attempt < retries) await sleep(1000 * (attempt + 1));
  }
  console.error(`[API] ${url} -> ${err.status ?? err.code}: ${err.message}`);
  throw err;
}

function describeError(e) {
  if (e.status === 429) return 'A API está limitando as requisições. Tente de novo em alguns segundos.';
  if (e.status) return `A API respondeu com erro ${e.status}. Tente novamente mais tarde.`;
  return `Não consegui conectar à API (${e.code ?? 'erro de rede'}). Use /status para diagnosticar.`;
}

// ---------- Dados do jogo ----------
let heroes = new Map();
async function ensureHeroes() {
  if (heroes.size) return;
  try {
    const data = await getJson(`${ASSETS}/v2/heroes`);
    if (Array.isArray(data)) heroes = new Map(data.map((h) => [h.id, h.name]));
  } catch { /* já logado em getJson; segue com nomes genéricos */ }
}
const heroName = (id) => heroes.get(id) ?? `Herói #${id}`;

const matchCache = new Map(); // partidas finalizadas não mudam
const api = {
  async matchMetadata(id) {
    if (matchCache.has(id)) return matchCache.get(id);
    const data = await getJson(`${API}/v1/matches/${id}/metadata`);
    if (matchCache.size >= 100) matchCache.delete(matchCache.keys().next().value);
    matchCache.set(id, data);
    return data;
  },
  matchHistory: (id) => getJson(`${API}/v1/players/${id}/match-history`),
  activeMatches: () => getJson(`${API}/v1/matches/active`),
};

const formatDuration = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function parseAccountId(input) {
  const s = input.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = BigInt(s);
  const id = n >= STEAM64_BASE ? n - STEAM64_BASE : n; // aceita SteamID64 também
  return id <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(id) : null;
}

// ---------- Perfil / pontuação ----------
function loadStats() {
  if (!existsSync(STATS_FILE)) return {};
  try {
    const raw = JSON.parse(readFileSync(STATS_FILE, 'utf8'));
    for (const [id, v] of Object.entries(raw)) {
      // migra o formato antigo (apenas um número de pontos)
      if (typeof v === 'number') raw[id] = { points: v, answered: 0, correct: 0 };
    }
    return raw;
  } catch {
    return {};
  }
}

function recordAnswer(userId, correct) {
  const all = loadStats();
  const s = all[userId] ?? { points: 0, answered: 0, correct: 0 };
  s.answered += 1;
  if (correct) {
    s.correct += 1;
    s.points += POINTS_PER_CORRECT;
  }
  all[userId] = s;
  writeFileSync(STATS_FILE, JSON.stringify(all));
  return s;
}

function rankOf(userId) {
  const sorted = Object.entries(loadStats()).sort((a, b) => b[1].points - a[1].points);
  const idx = sorted.findIndex(([id]) => id === userId);
  return idx === -1 ? null : idx + 1;
}

const accuracy = (s) => (s.answered ? Math.round((s.correct / s.answered) * 100) : 0);
const loadQuestions = () => JSON.parse(readFileSync(QUESTIONS_FILE, 'utf8'));

// ---------- Comandos ----------
const commands = [
  new SlashCommandBuilder().setName('partida').setDescription('Detalhes de uma partida pelo match ID')
    .addIntegerOption((o) => o.setName('match_id').setDescription('ID da partida').setRequired(true)),
  new SlashCommandBuilder().setName('jogador').setDescription('Últimas partidas de um jogador')
    .addStringOption((o) => o.setName('id').setDescription('Account ID ou SteamID64').setRequired(true)),
  new SlashCommandBuilder().setName('aovivo').setDescription('Partidas acontecendo agora'),
  new SlashCommandBuilder().setName('quiz').setDescription('Pergunta aleatória sobre Deadlock'),
  new SlashCommandBuilder().setName('perfil').setDescription('Sua pontuação no quiz')
    .addUserOption((o) => o.setName('usuario').setDescription('Ver o perfil de outra pessoa')),
  new SlashCommandBuilder().setName('ranking').setDescription('Ranking do quiz'),
  new SlashCommandBuilder().setName('status').setDescription('Testa a conexão do bot com a Deadlock API'),
].map((c) => c.toJSON());

// ---------- Quiz ----------
function quizRows(q, qi, userId, { chosen = null, disabled = false } = {}) {
  const row = new ActionRowBuilder();
  q.options.forEach((opt, i) => {
    let style = ButtonStyle.Secondary;
    if (disabled && i === q.answer) style = ButtonStyle.Success;
    else if (disabled && i === chosen) style = ButtonStyle.Danger;
    row.addComponents(
      new ButtonBuilder().setCustomId(`quiz:${userId}:${qi}:${i}`)
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
  const stats = recordAnswer(ownerId, correct);
  const pos = rankOf(ownerId);

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
    await ensureHeroes();
    try {
      const data = await api.matchMetadata(matchId);
      const info = data.match_info ?? data;
      const players = info.players ?? [];
      if (!players.length) return i.editReply('A API devolveu essa partida sem dados de jogadores.');

      const winner = info.winning_team;
      const meta = [];
      if (info.duration_s) meta.push(`⏱️ Duração: **${formatDuration(info.duration_s)}**`);
      if (info.start_time) meta.push(`🕒 Início: <t:${info.start_time}:f>`);
      if (winner != null) meta.push(`🏆 Vencedor: **Time ${winner}**`);

      const embed = new EmbedBuilder()
        .setTitle(`Partida ${matchId}`)
        .setColor(0xf5b700)
        .setDescription(meta.join('\n') || null)
        .setFooter({ text: 'Dados: Deadlock API • K/D/A · souls' });

      const byTeam = new Map();
      for (const p of players) {
        const t = p.team ?? 'all';
        if (!byTeam.has(t)) byTeam.set(t, []);
        byTeam.get(t).push(p);
      }
      for (const [t, list] of byTeam) {
        list.sort((a, b) => (b.net_worth ?? 0) - (a.net_worth ?? 0));
        const lines = list.map((p) => {
          const souls = p.net_worth != null ? ` · ${(p.net_worth / 1000).toFixed(1)}k` : '';
          return `**${heroName(p.hero_id)}** ${p.kills ?? 0}/${p.deaths ?? 0}/${p.assists ?? 0}${souls}`;
        });
        embed.addFields({
          name: t === 'all' ? 'Jogadores' : `${t === winner ? '🏆 ' : ''}Time ${t}`,
          value: lines.join('\n').slice(0, 1024),
          inline: true,
        });
      }
      return i.editReply({ embeds: [embed] });
    } catch (e) {
      if (e.status === 404) {
        const live = await api.activeMatches().catch(() => []);
        if (Array.isArray(live) && live.some((m) => Number(m.match_id) === matchId)) {
          return i.editReply(`🔴 A partida \`${matchId}\` está **em andamento**. Os detalhes só ficam disponíveis depois que ela termina.`);
        }
        return i.editReply(
          `Não encontrei a partida \`${matchId}\` na Deadlock API. Isso acontece quando o ID está errado, ` +
          'a partida ainda não foi processada ou nunca foi enviada para a API (ela só tem partidas coletadas pela comunidade).',
        );
      }
      return i.editReply(describeError(e));
    }
  },

  async jogador(i) {
    await i.deferReply();
    const accountId = parseAccountId(i.options.getString('id'));
    if (accountId == null) return i.editReply('Informe só números: o Account ID ou o SteamID64.');
    await ensureHeroes();
    try {
      const history = await api.matchHistory(accountId);
      if (!Array.isArray(history) || !history.length) {
        return i.editReply('Sem partidas recentes para esse jogador na API.');
      }
      const lines = history.slice(0, 5).map((m) => {
        const win = m.match_result === m.player_team;
        const when = m.start_time ? ` · <t:${m.start_time}:R>` : '';
        return `${win ? '🏆' : '💀'} \`${m.match_id}\` **${heroName(m.hero_id)}** ` +
          `${m.player_kills ?? 0}/${m.player_deaths ?? 0}/${m.player_assists ?? 0}${when}`;
      });
      return i.editReply(`**Últimas partidas de** \`${accountId}\`\n${lines.join('\n')}`);
    } catch (e) {
      if (e.status === 404) return i.editReply('Jogador não encontrado na API.');
      return i.editReply(describeError(e));
    }
  },

  async aovivo(i) {
    await i.deferReply();
    try {
      const matches = await api.activeMatches();
      const ids = matches.slice(0, 10).map((m) => `\`${m.match_id}\``).join('\n');
      return i.editReply(`🔴 **${matches.length} partidas ao vivo.** Algumas:\n${ids}`);
    } catch (e) {
      return i.editReply(describeError(e));
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
    const s = loadStats()[target.id];
    if (!s) {
      const msg = target.id === i.user.id
        ? 'Você ainda não respondeu nenhuma pergunta. Use /quiz para começar!'
        : `${target.displayName} ainda não jogou o quiz.`;
      return i.reply({ content: msg, flags: MessageFlags.Ephemeral });
    }
    const pos = rankOf(target.id);
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
    const top = Object.entries(loadStats()).sort((a, b) => b[1].points - a[1].points).slice(0, 10);
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
    lines.push(`Heróis carregados: ${heroes.size}`);
    return i.editReply(lines.join('\n'));
  },
};

// ---------- Bot ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', async () => {
  await ensureHeroes();
  const guildId = process.env.GUILD_ID;
  if (guildId) await (await client.guilds.fetch(guildId)).commands.set(commands);
  else await client.application.commands.set(commands);
  console.log(`Online como ${client.user.tag} • heróis carregados: ${heroes.size}`);
});

client.on('interactionCreate', async (i) => {
  try {
    if (i.isChatInputCommand()) await handlers[i.commandName]?.(i);
    else if (i.isButton() && i.customId.startsWith('quiz:')) await handleQuizButton(i);
  } catch (e) {
    console.error(e);
  }
});

client.login(process.env.DISCORD_TOKEN);