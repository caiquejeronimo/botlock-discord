# Deadlock Discord Bot

Bot de Discord que consulta a [Deadlock API](https://github.com/deadlock-api) e traz um quiz sobre Deadlock.

## Comandos
| Comando | O que faz |
|---|---|
| `/partida match_id` | Placar, duração e K/D/A por time de uma partida finalizada |
| `/jogador id` | Últimas 5 partidas (aceita Account ID ou SteamID64) |
| `/aovivo` | Partidas em andamento |
| `/quiz` | Pergunta com botões; cada acerto vale 10 pontos |
| `/perfil [usuario]` | Pontos, posição e taxa de acerto |
| `/ranking` | Top 10 do quiz |
| `/status` | Testa a conexão do bot com a API |

## Como rodar
1. Node.js 18 ou superior.
2. `npm install`
3. Copie `.env.example` para `.env` e preencha `DISCORD_TOKEN`.
4. `npm start`

## Contribuindo com perguntas
Edite `questions.json` (campos: `question`, `options`, `answer` = índice da opção correta, `explanation`).

## Créditos
Dados fornecidos pela comunidade [Deadlock API](https://deadlock-api.com). Projeto não afiliado à Valve.