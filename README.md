# Deadlock Discord Bot
 
Bot de Discord que mostra o placar ao vivo da sua partida de Deadlock (e partidas finalizadas) usando a [Deadlock API](https://github.com/deadlock-api), com um quiz pontuado.
 
## Comandos
Funcionam com prefixo (`!aovivo`) e com barra (`/aovivo`).
 
| Comando | O que faz |
|---|---|
| `!vincular <id>` | Liga sua conta do Deadlock (Account ID ou SteamID64) ao seu Discord. Use `/vincular` para fazer em privado |
| `!aovivo` | Placar ao vivo da **sua** partida (atualiza sozinho por 5 min) |
| `!aovivo @pessoa` / `!aovivo <id>` | Placar ao vivo da partida de outro jogador |
| `!partida <match_id>` | Placar final com K/D/A e souls (se estiver em andamento, mostra ao vivo) |
| `!jogador` | Suas últimas 5 partidas (também aceita `@pessoa` ou `<id>`) |
| `!quiz` | Pergunta do dia: **1 resposta por dia** por pessoa e por servidor (10 pontos por acerto) |
| `!perfil [@pessoa]` · `!ranking` | Pontos, posição e taxa de acerto · Top 10 do servidor |
| `!desvincular` | Remove o vínculo da conta |
| `!status` | Diagnóstico (exige permissão de Gerenciar Servidor) |
| `!ajuda` (ou `!comandos`) | Mostra todos os comandos disponíveis |
 
## Como rodar
1. Node.js 18 ou superior.
2. `npm install` (o `@napi-rs/canvas` é opcional: sem ele o bot usa placar em texto).
3. Copie `.env.example` para `.env` e preencha `DISCORD_TOKEN`.
4. Para o placar em imagem, coloque `NotoSans-Regular.ttf` e `NotoSans-Bold.ttf` em `assets/fonts/` (veja o `LEIA-ME.txt` da pasta).
5. `npm start`
## Quiz diário
- Cada pessoa responde **uma pergunta por dia** em cada servidor. O dia vira à meia-noite do fuso `QUIZ_TZ` (padrão: `America/Sao_Paulo`).
- A pergunta do dia é fixa: pedir `!quiz` de novo antes de responder devolve a mesma pergunta. Depois de responder, o bot informa quando libera a próxima.
- Para testar sem limite, use `QUIZ_DAILY_LIMIT=off` no `.env`.
## Comandos com prefixo (!)
Exigem a **Message Content Intent** (privilegiada):
1. Developer Portal → seu app → aba **Bot** → *Privileged Gateway Intents* → ative **Message Content Intent**.
2. Dê ao bot, nos canais, as permissões: *Ver Canal*, *Enviar Mensagens*, *Anexar Arquivos*, *Inserir Links*, *Ler Histórico de Mensagens* (e *Gerenciar Mensagens* se quiser que ele apague o `!vincular`).
Se a intent estiver desligada, o bot avisa no console e continua funcionando só com `/`. Para mudar o prefixo, use `PREFIX` no `.env`.
 
## Vários servidores
- Deixe `GUILD_ID` **vazio** no `.env` para registrar os comandos `/` de forma global.
- A pontuação do quiz é separada por servidor. O vínculo de conta (`links.json`) vale em todos.
- Para convidar o bot a outros servidores, ative **Public Bot** na aba *Bot* e use o link de instalação (escopos `bot` e `applications.commands`).
## Dados e privacidade
- `scores.json` guarda pontos do quiz; `links.json` guarda a ligação entre seu ID do Discord e seu Account ID do Deadlock. Ambos ficam só no servidor onde o bot roda. `!desvincular` apaga o vínculo.
- O feed ao vivo traz heróis, souls por time e espectadores. K/D/A por jogador só existe depois que a partida termina.
## Créditos
Dados da comunidade [Deadlock API](https://deadlock-api.com). Projeto não afiliado à Valve.
 