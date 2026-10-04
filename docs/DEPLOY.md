# Implantação na VPS (Docker) — pesquisa.sauberlich.com.br

Tempo estimado: 30 minutos. Pré-requisitos: VPS com Docker e Docker Compose v2.24+ (`docker compose version`).

## 1. DNS
No painel do domínio `sauberlich.com.br`, crie um registro **A** `pesquisa` apontando para o IP da VPS
(e **AAAA** se a VPS tiver IPv6). Aguarde propagar: `ping pesquisa.sauberlich.com.br`.

> Usamos o subdomínio `pesquisa.` para não interferir no site que já estiver em `sauberlich.com.br`.

## 2. Código
```bash
sudo mkdir -p /opt/pesquisa && sudo chown $USER /opt/pesquisa && cd /opt/pesquisa
git clone -b claude/satisfaction-survey-system-4bzrcg https://github.com/Heberson5/Pesquisa.git .
mkdir -p backups && sudo chown 1000:1000 backups      # o container roda como usuário 1000 (sem root)
```

## 3. Configuração (.env)
```bash
cp .env.example .env && chmod 600 .env
openssl rand -base64 48        # copie o resultado para APP_SECRET no .env
nano .env                      # PUBLIC_URL, APP_SECRET, SMTP_*, DOMAIN, ACME_EMAIL
```
**Guarde o `APP_SECRET` em um cofre de senhas.** Sem ele, os contatos dos clientes e o 2FA salvos no backup não podem ser lidos.

## 4. Subir

**Opção A — a VPS NÃO tem outro site nas portas 80/443** (HTTPS automático com Caddy + Let's Encrypt):
```bash
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d --build
```

**Opção B — a VPS JÁ TEM nginx/Traefik/Caddy** atendendo outros sites:
```bash
docker compose up -d --build          # o app fica em 127.0.0.1:3000 (inacessível de fora)
```
e configure seu proxy apontando para `127.0.0.1:3000` (exemplo pronto para nginx em `deploy/nginx-exemplo.conf`;
certificado com `sudo certbot --nginx -d pesquisa.sauberlich.com.br`).
O proxy **precisa substituir** o cabeçalho `X-Forwarded-For` pelo IP real do cliente (o exemplo já faz isso);
senão os limites de tentativas por IP podem ser burlados.

Confira: `docker compose ps` (app **healthy**) e abra https://pesquisa.sauberlich.com.br/admin/

## 5. Primeiro administrador
```bash
docker compose exec app node scripts/create-admin.js voce@sauberlich.com.br "Seu Nome"
```
No primeiro login o sistema exige ativar o 2FA (Google Authenticator/Microsoft Authenticator). Guarde os códigos de recuperação.

## 6. Primeiros passos no painel
1. **Configurações → Identidade visual**: logo, cores, ícones.
2. **Configurações → Alertas e relatórios**: clique em **Enviar e-mail de teste**.
3. **Filiais**: cadastre as filiais (e-mails de alerta, meta, horário).
4. **Pesquisas**: ajuste a pesquisa e escolha a pesquisa padrão de cada filial.
5. **Tablets**: gere o código e siga o **Guia de instalação** (docs/INSTALACAO-TABLET.md).
6. **Usuários**: crie os gestores e vincule às filiais.

## Firewall da VPS
Libere apenas 22 (SSH), 80 e 443. Exemplo com UFW:
```bash
sudo ufw default deny incoming && sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable
```
Recomendado: SSH só com chave (`PasswordAuthentication no`) e `fail2ban`.

## Backup e restauração
- Automático todo dia às 03:00 em `/opt/pesquisa/backups` (14 dias). Backup manual: `docker compose run --rm backup node scripts/backup.js`
- **Copie a pasta `backups/` para fora da VPS** (ex.: `rclone` para Google Drive/S3), junto com o `.env` guardado em local seguro.
- Restaurar:
```bash
docker compose stop app
docker run --rm -v pesquisa_pesquisa-data:/data -v $PWD/backups:/b alpine sh -c \
  "cp /b/pesquisa-AAAAMMDD-HHMMSS.db /data/pesquisa.db && rm -f /data/pesquisa.db-wal /data/pesquisa.db-shm && cp -n /b/media/* /data/media/ 2>/dev/null; chown -R 1000:1000 /data"
docker compose start app
```

## Atualizar para uma nova versão
```bash
cd /opt/pesquisa && git pull && docker compose up -d --build     # (acrescente -f docker-compose.caddy.yml se usar a opção A)
```
O banco é migrado automaticamente na inicialização. Faça um backup manual antes de atualizar.

## Logs e monitoramento
`docker compose logs -f app` · verificação de saúde: `https://pesquisa.sauberlich.com.br/healthz`
(sugestão: monitore com UptimeRobot/Better Stack, gratuito).
