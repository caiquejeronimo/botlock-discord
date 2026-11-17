import { heroName } from './api.js';

// Nome e cor de cada time, pelo ID que a API usa (campo `team`).
// Se descobrir que está invertido, troque os números das chaves (0 vira 1 e 1 vira 0),
// mantendo cada nome junto da sua cor. Âmbar = Hidden King, safira = Archmother.
export const TEAMS = {
  0: { name: 'Hidden King', color: '#f5a524' },
  1: { name: 'Archmother', color: '#4c8dff' },
};
const FALLBACK_COLORS = ['#f5a524', '#4c8dff'];

export const fmtK = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
export const fmtTime = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

const teamLabel = (id) => TEAMS[id]?.name ?? `Time ${id}`;
const teamColor = (id, idx) => TEAMS[id]?.color ?? FALLBACK_COLORS[idx % 2];

// Partida ao vivo: só há heróis, nomes e souls por time.
export function viewFromActive(m, nameOf) {
  const players = m.players ?? [];
  const ids = [...new Set(players.map((p) => p.team))].sort();
  return {
    kind: 'live',
    matchId: m.match_id,
    spectators: m.spectators ?? null,
    elapsedS: m.start_time ? Math.max(0, Math.floor(Date.now() / 1000) - m.start_time) : null,
    teams: ids.map((id, idx) => ({
      id,
      label: teamLabel(id),
      color: teamColor(id, idx),
      netWorth: (m.team_stats ?? []).find((t) => t.team === id)?.net_worth ?? null,
      rows: players.filter((p) => p.team === id).map((p) => ({
        heroId: p.hero_id,
        hero: heroName(p.hero_id),
        name: nameOf(p.account_id) ?? `ID ${p.account_id}`,
      })),
    })),
  };
}

// Partida finalizada: K/D/A e souls por jogador.
export function viewFromMetadata(matchId, info, nameOf) {
  const players = info.players ?? [];
  const ids = [...new Set(players.map((p) => p.team))].sort();
  return {
    kind: 'finished',
    matchId,
    winner: info.winning_team,
    durationS: info.duration_s ?? null,
    startTime: info.start_time ?? null,
    teams: ids.map((id, idx) => {
      const list = players.filter((p) => p.team === id).sort((a, b) => (b.net_worth ?? 0) - (a.net_worth ?? 0));
      return {
        id,
        label: teamLabel(id),
        color: teamColor(id, idx),
        netWorth: list.every((p) => p.net_worth != null) ? list.reduce((s, p) => s + p.net_worth, 0) : null,
        rows: list.map((p) => ({
          heroId: p.hero_id,
          hero: heroName(p.hero_id),
          name: nameOf(p.account_id) ?? `ID ${p.account_id}`,
          kda: `${p.kills ?? 0}/${p.deaths ?? 0}/${p.assists ?? 0}`,
          souls: p.net_worth != null ? fmtK(p.net_worth) : '',
        })),
      };
    }),
  };
}
