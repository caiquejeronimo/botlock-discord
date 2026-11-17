import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, SlashCommandBuilder, MessageFlags,
} from 'discord.js';

const API = 'https://api.deadlock-api.com';       // confirme na doc OpenAPI
const ASSETS = 'https://assets.deadlock-api.com'; // nomes/imagens de heróis
const SCORES_FILE = 'scores.json';
const QUESTIONS_FILE = 'questions.json';

// ---------- Cliente da API ----------
async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
}

let heroes = new Map();
async function loadHeroes() {
  try {
    const data = await getJson(`${ASSETS}/v2/heroes`);
    heroes = new Map(data.map((h) => [h.id, h.name]));
  } catch (e) {
    console.error('Falha ao carregar heróis:', e.message);
  }
}
const heroName = (id) => heroes.get(id) ?? `Herói #${id}`;

const api = {
  matchMetadata: (id) => getJson(`${API}/v1/matches/${id}/metadata`),
  matchHistory: (id) => getJson(`${API}/v1/players/${id}/match-history`),
  activeMatches: () => getJson(`${API}/v1/matches/active`),
};

// ---------- Pontuação e perguntas ----------
const loadScores = () => (existsSync(SCORES_FILE) ? JSON.parse(readFileSync(SCORES_FILE, 'utf8')) : {});
const addScore = (userId, pts) => {
  const s = loadScores();
  s[userId] = (s[userId] ?? 0) + pts;
  writeFileSync(SCORES_FILE, JSON.stringify(s));
};
const loadQuestions = () => JSON.parse(readFileSync(QUESTIONS_FILE, 'utf8'));

// ---------- Comandos ----------
const commands = [
  new SlashCommandBuilder().setName('partida').setDescription('Detalhes de uma partida pelo match ID')
    .addIntegerOption((o) => o.setName('match_id').setDescription('ID da partida').setRequired(true)),
  new SlashCommandBuilder().setName('jogador').setDescription('Últimas partidas de um jogador')
    .addIntegerOption((o) => o.setName('account_id').setDescription('Account ID (Steam 32 bits)').setRequired(true)),
  new SlashCommandBuilder().setName('aovivo').setDescription('Partidas acontecendo agora'),
  new SlashCommandBuilder().setName('quiz').setDescription('Pergunta aleatória sobre a lore de Deadlock'),
  new SlashCommandBuilder().setName('ranking').setDescription('Ranking do quiz'),
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
    return interaction.reply({ content: 'Essa pergunta é de outra pessoa. Use /quiz!', flags: MessageFlags.Ephemeral });
  }
  const q = loadQuestions()[Number(qi)];
  const chosen = Number(choice);
  const correct = chosen === q.answer;
  if (correct) addScore(ownerId, 10);
  const msg = `${correct ? '✅ Correto! +10 pontos.' : '❌ Errou!'}\n_${q.explanation ?? ''}_`;
  return interaction.update({ content: msg, components: quizRows(q, qi, ownerId, { chosen, disabled: true }) });
}

// ---------- Handlers ----------
const handlers = {
  async partida(i) {
    await i.deferReply();
    try {
      const data = await api.matchMetadata(i.options.getInteger('match_id'));
      // O formato exato pode variar: ajuste conforme a resposta real da API.
      const info = data.match_info ?? data;
      const embed = new EmbedBuilder().setTitle(`Partida ${i.options.getInteger('match_id')}`).setColor(0xf5b700)
        .addFields(
          { name: 'Duração', value: `${Math.floor((info.duration_s ?? 0) / 60)} min`, inline: true },
          { name: 'Vencedor', value: `Time ${info.winning_team ?? '?'}`, inline: true },
        );
      for (const p of (info.players ?? []).slice(0, 12)) {
        embed.addFields({ name: heroName(p.hero_id), value: `K/D/A ${p.kills ?? 0}/${p.deaths ?? 0}/${p.assists ?? 0}`, inline: true });
      }
      await i.editReply({ embeds: [embed] });
    } catch (e) {
      await i.editReply(`Não achei a partida (${e.status ?? 'erro'}).`);
    }
  },

  async jogador(i) {
    await i.deferReply();
    try {
      const history = await api.matchHistory(i.options.getInteger('account_id'));
      const lines = history.slice(0, 5).map((m) => {
        const r = m.match_result === m.player_team ? '🏆' : '💀';
        return `${r} \`${m.match_id}\` ${heroName(m.hero_id)} ${m.player_kills ?? 0}/${m.player_deaths ?? 0}/${m.player_assists ?? 0}`;
      });
      await i.editReply(lines.join('\n') || 'Sem partidas recentes.');
    } catch (e) {
      await i.editReply(`Erro ao buscar jogador (${e.status ?? 'erro'}).`);
    }
  },

  async aovivo(i) {
    await i.deferReply();
    try {
      const matches = await api.activeMatches();
      const ids = matches.slice(0, 10).map((m) => `\`${m.match_id}\``).join('\n');
      await i.editReply(`**${matches.length} partidas ao vivo.** Algumas:\n${ids}`);
    } catch (e) {
      await i.editReply(`Erro (${e.status ?? 'erro'}).`);
    }
  },

  async quiz(i) {
    const qs = loadQuestions();
    const qi = Math.floor(Math.random() * qs.length);
    await i.reply({ content: `🧠 **${qs[qi].question}**`, components: quizRows(qs[qi], qi, i.user.id) });
  },

  async ranking(i) {
    const top = Object.entries(loadScores()).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const text = top.map(([id, pts], n) => `${n + 1}. <@${id}> — ${pts} pts`).join('\n');
    await i.reply({ content: text || 'Ninguém pontuou ainda!', allowedMentions: { parse: [] } });
  },
};

// ---------- Bot ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', async () => {
  await loadHeroes();
  const guildId = process.env.GUILD_ID;
  if (guildId) await (await client.guilds.fetch(guildId)).commands.set(commands);
  else await client.application.commands.set(commands);
  console.log(`Online como ${client.user.tag}`);
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
