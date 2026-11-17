# Deadlock Discord Bot
 
Bot de Discord que mostra placares de Deadlock (ao vivo e finalizados) usando a [Deadlock API](https://github.com/deadlock-api) e traz um quiz com pontuação.
 
## Comandos
| Comando | O que faz |
|---|---|
| `/aovivo` | Lista de partidas ao vivo; escolha uma para ver o placar (atualiza sozinho por 5 min) |
| `/aovivo partida:ID` | Placar ao vivo de uma partida específica |
| `/aovivo jogador:ID` | Acha a partida atual de um jogador (se estiver entre as partidas em destaque) |
| `/partida match_id` | Placar final com K/D/A e souls |
| `/jogador id` | Últimas 5 partidas (Account ID ou SteamID64) |
| `/quiz` · `/perfil` · `/ranking` | Quiz com pontuação |
| `/status` | Diagnóstico de conexão e do modo de imagem |
 
## Como rodar
1. Node.js 18 ou superior.
2. `npm install` (o `@napi-rs/canvas` é opcional: sem ele o bot usa placar em texto).
3. Copie `.env.example` para `.env` e preencha `DISCORD_TOKEN`.
4. Para o placar em imagem, coloque duas fontes estáticas em `assets/fonts/`: `font-regular.ttf` e `font-bold.ttf` (por exemplo, Rajdhani ou Inter, do Google Fonts, licença OFL).
5. `npm start`
## Limites dos dados ao vivo
O feed público traz heróis, souls por time e espectadores. K/D/A por jogador só existe depois que a partida termina.
 
## Créditos
Dados da comunidade [Deadlock API](https://deadlock-api.com). Projeto não afiliado à Valve.
 