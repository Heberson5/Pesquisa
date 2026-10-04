# Planejamento — Sistema de Pesquisa de Satisfação (NPS) multi-filial

## 1. Objetivo
Coletar pesquisas de satisfação em **tablets nas filiais**, sem login do cliente, garantindo que **as respostas de cada filial nunca se misturem**, e analisar tudo em um **painel administrativo** com indicador **NPS** calculado sobre as perguntas marcadas.

## 2. Requisitos atendidos
| Pedido | Como foi resolvido |
|---|---|
| Painel de administração para coletar as pesquisas | Painel web `/admin`: visão geral (NPS), respostas com filtros, exportação CSV, pesquisas, filiais, tablets, usuários, auditoria |
| Marcar perguntas que entram na análise de NPS | Checkbox **"⭐ Entra na análise de NPS"** em cada pergunta do tipo 0–10. O NPS geral, por filial, por pergunta e por dia usa somente as marcadas |
| Tela da pesquisa sem login | Tablet abre `/kiosk`; é ativado **uma única vez** com um código de 8 caracteres gerado no painel (válido 15 min, uso único). Depois disso nunca mais pede nada |
| Vários locais sem misturar | Cada tablet fica vinculado a **uma filial no servidor**. A filial gravada vem do token do tablet — o tablet não envia nem consegue trocar a filial (testado com tentativa de fraude) |
| Uso como aplicativo, sem o cliente navegar | Tela cheia, sem menus, bloqueio de menu de contexto/zoom/atalhos, instalável como app (PWA). Travamento do sistema operacional detalhado na seção 7 |
| Agradecimento com imagem ou vídeo curto | Título + mensagem + imagem (JPG/PNG/WEBP/GIF) ou vídeo (MP4/WEBM, até 25 MB), tempo configurável (3–60 s) |
| Volta sozinho à tela inicial | Após o agradecimento (tempo configurável) **e** se o cliente abandonar no meio (inatividade configurável, padrão 45 s — resposta parcial é descartada) |

| Escolher carinhas, números, estrelas etc. para o NPS | Toda pergunta de escala (NPS 0–10 e 1–5) tem **Aparência**: Padrão das configurações, Números coloridos, Carinhas coloridas ou Ícones (estrela, coração, joinha, sorriso, chama, raio, medalha, coroa, círculo, visto). O tablet **sempre grava o número de 0 a 10**, então o NPS é calculado igual em qualquer aparência |
| Logo, ícone do navegador e ícone do aplicativo | **Configurações → Identidade visual**: nome da empresa, cor principal e de destaque, logo (painel, tablet, login e PowerPoint), favicon e ícone do app instalado no tablet |
| Exportar para PowerPoint bem formatado | Botão **Exportar PowerPoint** (Visão geral e Respostas) respeitando os filtros. Gera ~9 slides com **gráficos nativos editáveis**, logo e cores da empresa: capa, resumo, distribuição 0–10, evolução diária, NPS por filial, NPS por pergunta, demais perguntas e comentários |
| Layout moderno e intuitivo | Painel redesenhado: ícones, cartões, tema claro/escuro, tela de login com a marca, responsivo (no celular o menu vira gaveta) |
| Barra lateral recolhível | Botão **Recolher menu** (fica só com ícones; lembrado por navegador) |
| Trocar ícones dos menus e das respostas | **Configurações → Ícones do menu** (35 opções por item) e **Ícones das respostas**: galeria com prévia para escolher o estilo padrão — **Números coloridos**, **Carinhas coloridas** (cor e expressão mudam conforme a satisfação) ou um dos 10 ícones —, cores por **faixas do NPS** (vermelho 0–6, amarelo 7–8, verde 9–10) ou **gradiente**, e carinhas coloridas ou só contorno |

| **Fase 3 — completar o sistema** | |
| Implantação na VPS com Docker e domínio | Imagem endurecida, HTTPS automático (Caddy) ou nginx existente, backup diário, CI no GitHub — guia em `docs/DEPLOY.md` |
| 2FA e recuperação de senha | App autenticador (obrigatório para admin), 10 códigos de recuperação, "Esqueci minha senha" por e-mail |
| Alerta de cliente insatisfeito + tratamento | Nota 0–6 abre **Caso** (status, responsável, histórico) e avisa a filial por e-mail, webhook e/ou WhatsApp |
| Contato opcional | Ao final, só com consentimento explícito; dados criptografados |
| LGPD | Aviso de privacidade, pedidos do titular (localizar/exportar/excluir), retenção automática |
| Relatório semanal | PowerPoint por e-mail, cada gestor só com as filiais dele |
| Metas e ranking | Meta de NPS por filial, ranking na visão geral |
| Perguntas condicionais | Ex.: "O que podemos melhorar?" só para notas ≤ 6 |
| Campanhas agendadas | Pesquisa temporária por filial ou para todas, volta sozinha à padrão |
| QR Code / link por filial | Cliente responde no celular; cartaz pronto para imprimir; antiabuso |
| Idiomas | Português, inglês e espanhol |
| Tablets | Alerta de tablet sem sinal, horário de funcionamento com tela de descanso, guia de instalação (`docs/INSTALACAO-TABLET.md`) |

Extras incluídos: funciona **sem internet** (respostas ficam na fila do tablet e são enviadas quando a conexão volta, sem duplicar), status online/offline de cada tablet, perfis **Administrador** e **Gestor de filial** (gestor só vê as filiais dele), log de auditoria.

## 3. Arquitetura
```
 Tablets (filiais)            Servidor (Node.js + Express)             Navegador do gestor
 ┌──────────────┐  HTTPS     ┌───────────────────────────────┐  HTTPS  ┌──────────────┐
 │ /kiosk (PWA) │──Bearer───▶│ /api/kiosk  (token do tablet) │◀─cookie─│ /admin (SPA) │
 │ fila offline │  token     │ /api/admin  (sessão + CSRF)   │  +CSRF  └──────────────┘
 └──────────────┘            │ SQLite (data/pesquisa.db)     │
                             │ Mídias (data/media/)          │
                             └───────────────────────────────┘
```
- **Back-end:** Node.js 22 + Express 5. Dependências: `express` e `pptxgenjs` (relatório). Uma subdependência do pptxgenjs com falha conhecida (`image-size`) foi forçada para a versão corrigida via `overrides`.
- **Banco:** SQLite embutido do Node (`node:sqlite`), arquivo único — simples de operar e fazer backup. Todas as consultas parametrizadas. Migração futura para PostgreSQL é direta (SQL padrão, camada isolada em `src/db.js`).
- **Front-end:** HTML/CSS/JS puro, sem build. Painel e tablet nunca usam `innerHTML` (proteção contra XSS).

### Estrutura de pastas
```
server.js                 entrada, cabeçalhos, rotas estáticas, tratamento de erros
src/db.js                 esquema do banco
src/security.js           hash de senha (scrypt), tokens, rate limit, CSP
src/auth.js               sessão do painel, CSRF, token do tablet
src/validate.js           validação de entradas
src/surveys.js            tipos de pergunta, aparências, validação de respostas, cálculo de NPS
src/settings.js           configurações (marca, ícones, alertas, LGPD, relatórios) com validação
src/config.js             variáveis de ambiente; recusa iniciar sem segredos em produção
src/vault.js              criptografia AES-256-GCM e HMAC (dados pessoais, 2FA, links)
src/totp.js               2FA (RFC 6238)
src/notify.js             fila de e-mail/webhook/WhatsApp, proteção SSRF
src/alerts.js             casos e alertas de detratores
src/responses.js          gravação de respostas (tablet e QR), campanhas, horário
src/stats.js              estatísticas e relatório no escopo do usuário
src/scheduled.js          relatório semanal e alerta de tablet sem sinal
src/retention.js          retenção LGPD
src/jobs.js               agendador das tarefas em segundo plano
src/routes/auth.js        login + 2FA, recuperação de senha
src/routes/cases.js       casos de detratores
src/routes/privacy.js     pedidos do titular (LGPD)
src/routes/link.js        pesquisa por link/QR Code
Dockerfile, docker-compose*.yml, deploy/   implantação
.github/                  CI (testes, auditoria, imagem) e Dependabot
src/report.js             gerador do relatório PowerPoint (pptxgenjs)
public/shared/icons.js    biblioteca de ícones (painel, tablet e validação no servidor)
src/routes/admin.js       API do painel
src/routes/kiosk.js       API do tablet
public/admin/             painel
public/kiosk/             app do tablet (PWA + service worker)
scripts/create-admin.js   cria o primeiro administrador
scripts/seed-demo.js      dados de demonstração
tests/security.test.js    30 testes de segurança automatizados
```

### Modelo de dados
`branches` (filiais, com a pesquisa ativa) · `devices` (tablets: filial, hash do token, código de pareamento) · `surveys` + `questions` (tipo, obrigatória, **is_nps**) · `responses` (filial, tablet, uuid) + `answers` · `users` + `user_branches` · `sessions` · `media` · `audit_log`.

### Tipos de pergunta
NPS 0–10 (pode entrar no NPS) · Escala 1–5 com carinhas · Escolha única · Múltipla escolha · Sim/Não · Texto livre (comentário).

### Cálculo do NPS
`NPS = % promotores (9–10) − % detratores (0–6)`; neutros 7–8. Calculado no servidor sobre todas as notas das perguntas marcadas, com filtros de período, filial e pesquisa.

### Integridade do histórico
Quando uma pesquisa já tem respostas, a estrutura fica **congelada** (não dá para remover perguntas nem mudar tipo/opções — isso corromperia relatórios). Textos e a marcação de NPS continuam editáveis. Para mudanças estruturais: botão **Duplicar**.

## 4. Fluxos
**Implantação de uma filial:** Admin cria a filial → escolhe a pesquisa da filial → em *Tablets* clica "Novo tablet" → recebe código → no tablet abre `https://SEU-DOMINIO/kiosk/`, digita o código → pronto.

**Cliente:** Tela inicial "Toque para começar" → perguntas (uma por tela, avanço automático ao tocar) → Enviar → agradecimento com imagem/vídeo → volta ao início.

**Tablet perdido/roubado:** *Tablets → Revogar* — o acesso cai na hora.

## 5. Segurança — medidas implementadas
| Ameaça | Proteção |
|---|---|
| Senhas vazadas do banco | Hash **scrypt** com salt; política mínima (10+ caracteres, letras e números) |
| Força bruta no login | Limite por IP (20/15 min) + bloqueio da conta após 5 erros (15 min); mesma mensagem para e-mail inexistente e senha errada; tempo de resposta igual |
| Roubo de sessão | Cookie `HttpOnly`, `SameSite=Strict`, `Secure`/`__Host-` em produção; token guardado só como hash; expira por inatividade (2 h) e absoluto (12 h); logout invalida no servidor; troca de senha/desativação derruba todas as sessões |
| CSRF | Token CSRF por sessão + verificação de `Origin` em toda alteração |
| XSS | CSP rígida (`script-src 'self'`, sem `unsafe-inline`); interface usa só `textContent` |
| SQL injection | 100% consultas parametrizadas + validação de tipos |
| Acesso a dados de outra filial (IDOR) | Escopo de filial aplicado no servidor em todas as consultas do gestor |
| Tablet gravando em outra filial | Filial deriva do token; pesquisa aceita só se for a da filial; tokens de 256 bits guardados como hash |
| Pareamento por adivinhação | Código de 8 caracteres (≈ 8,5×10¹¹ combinações), 15 min, uso único, 10 tentativas/15 min por IP |
| Respostas falsas/adulteradas | Validação de cada resposta (escala, opções, obrigatórias, pergunta pertence à pesquisa); limite de 20 envios/min por tablet; UUID impede duplicidade |
| Upload malicioso | Tipo validado pelo **conteúdo binário** (não extensão); SVG/HTML/PDF/executáveis recusados; nome aleatório; `nosniff`; limite 25 MB |
| Path traversal | IDs validados por regex; arquivos estáticos negam dotfiles; banco e código fora da pasta pública |
| CSV injection (Excel) | Células iniciadas por `= + - @` são neutralizadas |
| Clickjacking | `frame-ancestors 'none'` + `X-Frame-Options: DENY` |
| Vazamento de detalhes | Erros genéricos; sem stack trace; sem `X-Powered-By` |
| Configurações maliciosas | Só admin altera; cores aceitas só no formato `#RRGGBB` (bloqueia injeção de CSS); ícones só da lista fixa; logo/ícones só imagens já validadas pelo conteúdo; dados públicos da marca limitados a nome, cores, logo e ícone padrão |
| Relatório PowerPoint | Respeita o escopo do gestor (só as filiais dele); textos com `& < >` escapados; exportação registrada na auditoria |
| Conta de administrador roubada | 2FA (TOTP) obrigatório para admin, anti-replay, códigos de recuperação; troca de senha/2FA derruba sessões |
| Recuperação de senha abusada | Token aleatório de uso único (30 min), resposta idêntica para e-mail existente ou não, link montado com PUBLIC_URL (imune a Host forjado), limite por IP e por e-mail |
| Vazamento de dados pessoais | Contatos criptografados (AES-256-GCM) e buscados por HMAC; consentimento obrigatório; acesso ao contato registrado; retenção automática; exclusão a pedido |
| Webhook usado para atacar a rede interna (SSRF) | Só https, porta 443, sem IP/credenciais na URL, bloqueio de IPs internos inclusive na resolução DNS da conexão (anti DNS rebinding), sem seguir redirecionamentos |
| Injeção em e-mails | Assunto sem quebras de linha, destinatários validados, todo conteúdo escapado no HTML, nodemailer sem acesso a arquivos/URLs |
| Spam pelo QR Code | Bilhete assinado de uso único, tempo mínimo de resposta, limite por IP e por filial, link regenerável/desativável |
| Gestor vendo outra filial | Escopo aplicado em casos, relatórios, PowerPoint semanal, campanhas, QR Code e configurações (gestor não vê integrações) |
| Container comprometido | Usuário sem root, sistema de arquivos somente leitura, sem capabilities, no-new-privileges, porta só em 127.0.0.1 |
| Rastreabilidade | Log de auditoria (login, falhas, exportações, alterações, pareamentos) |

## 6. Testes realizados
- **75 testes automatizados de ataque** (`npm test`, também rodam no GitHub a cada envio). Fase 3: 2FA (código reutilizado, desafio forjado, força bruta, obrigatoriedade), recuperação de senha (Host forjado, token reutilizado/expirado, enumeração), contato (consentimento, injeção de cabeçalho, criptografia no banco), casos (escopo, validação, auditoria), LGPD (busca/exportação/exclusão só por admin), retenção, webhook (SSRF com 21 endereços internos), QR Code (bilhete forjado/reutilizado/adulterado, robô rápido, limite por IP, filial forjada, link regerado), campanhas, condicionais, idiomas, horário, metas, relatório semanal (gestor não recebe outra filial no PowerPoint) e menor privilégio das configurações. Fases anteriores: **39 testes** (`npm test`) — todos passando. Novos: configurações só por admin + CSRF; 18 tentativas de configuração maliciosa (injeção de CSS na cor, ícone com script, arquivo de vídeo como logo, caminho para o banco); marca pública sem dados internos; PowerPoint exige login, gestor não vê outra filial no arquivo e nomes com `& < >` não corrompem o .pptx; aparências/ícones inválidos nas perguntas. Anteriores: cabeçalhos, rotas sem login, cookie forjado, enumeração de usuários, SQL injection (login e filtros), força bruta e bloqueio, rate limit, logout, CSRF (sem token / token errado / origem externa), IDOR entre filiais, escalada de privilégio de gestor, atribuição em massa, senha fraca, tablet forjado/revogado, **fraude de filial**, respostas adulteradas (10 variações), duplicidade, pareamento (uso único, expiração, força bruta), spam de respostas, payload gigante, JSON malformado, prototype pollution, XSS, CSV injection, upload malicioso (SVG/HTML/PDF/EXE), path traversal (11 caminhos), derrubada de sessões na troca de senha.
- **Testes em navegador real (Chromium):** XSS armazenado não executa no painel; cookie inacessível ao JavaScript; fluxo offline → online; abandono no meio volta à tela inicial; gestor só vê a própria filial; zero violações de CSP.
- `npm audit`: 0 vulnerabilidades (nodemailer atualizado para 10.0.14; `image-size` forçado para versão corrigida).
- **Container de produção testado**: roda como usuário 1000, sistema de arquivos somente leitura, porta só local, healthcheck, backup gerado, recusa iniciar sem `APP_SECRET`/`PUBLIC_URL` https, cookie `__Host-` com `Secure`, HSTS atrás do proxy, Caddyfile validado.
- **PowerPoint:** arquivo validado (estrutura OOXML) e renderizado slide a slide para conferência visual.
- **Bug encontrado e corrigido nos testes:** tablet pareado na hora não ativava a sincronização em segundo plano (fila offline só seria enviada após reiniciar o app).

## 7. Riscos residuais e recomendações
1. Siga o `docs/DEPLOY.md`: firewall (só 22/80/443), SSH só com chave, **cópia dos backups fora da VPS** e `APP_SECRET` guardado em cofre de senhas.
2. Travar o tablet no sistema operacional (Fully Kiosk / Acesso Guiado) — `docs/INSTALACAO-TABLET.md`.
3. Rate limit em memória vale para **uma** instância (suficiente para dezenas de filiais). Para várias instâncias: Redis + PostgreSQL.
4. O bloqueio de conta (423) revela que o e-mail existe — escolha consciente pela clareza; pode virar mensagem genérica.
5. O link/QR é público por natureza: os limites reduzem abuso, mas uma pessoa determinada com muitos IPs ainda pode enviar respostas falsas (marcadas como "via QR Code" e filtráveis nos relatórios). Se necessário, desative ou gere novo link.
6. WhatsApp exige conta Business na Meta e modelo de mensagem aprovado (`{{1}}` filial, `{{2}}` nota, `{{3}}` link).
7. Logo em WEBP não entra no PowerPoint — use PNG ou JPG.

### Migração de banco
Bancos criados antes da opção "Padrão das configurações" são migrados automaticamente na inicialização, recriando a tabela de perguntas pelo procedimento oficial do SQLite, com verificação de integridade das referências (testado em cópia do banco anterior: 0 referências quebradas, dados preservados, idempotente).

## 8. Como rodar
```bash
npm install
npm run create-admin -- voce@empresa.com "Seu Nome"   # pede a senha
npm start                                              # http://127.0.0.1:3000/admin
# demonstração:  DEMO_ADMIN_PASSWORD='Demo2026segura' npm run seed:demo
npm test                                               # testes de segurança
```

## 9. Situação
Código no branch `claude/satisfaction-survey-system-4bzrcg`, com CI ativo. Para colocar no ar: `docs/DEPLOY.md`.
