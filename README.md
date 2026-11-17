# Deadlock Discord Bot

Bot de Discord que consulta a [Deadlock API](https://github.com/deadlock-api) e traz um quiz sobre a lore do jogo.

## Comandos
| Comando | O que faz |
|---|---|
| `/partida match_id` | Detalhes de uma partida |
| `/jogador account_id` | Últimas 5 partidas |
| `/aovivo` | Partidas em andamento |
| `/quiz` | Pergunta de lore com botões |
| `/ranking` | Top 10 do quiz |

## Como rodar
1. Node.js 18 ou superior.
2. `npm install`
3. Copie `.env.example` para `.env` e preencha `DISCORD_TOKEN`.
4. `npm start`

## Contribuindo com perguntas
Edite `questions.json` (campos: `question`, `options`, `answer` = índice da opção correta, `explanation`).

## Créditos
Dados fornecidos pela comunidade [Deadlock API](https://deadlock-api.com). Projeto não afiliado à Valve.
