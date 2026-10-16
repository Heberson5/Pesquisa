# Pesquisa de Satisfação (NPS) — multi-filial

Sistema de coleta de pesquisa de satisfação para **tablets em modo quiosque**, com **painel administrativo** e análise de **NPS**.

- **Painel:** `/admin` — NPS geral/por filial/por pergunta, respostas, exportação CSV, pesquisas, filiais, tablets, usuários, auditoria.
- **Configurações:** logo, favicon, ícone do app, cores, ícones do menu e estilo das respostas (números coloridos, carinhas coloridas, estrelas, corações…).
- **PowerPoint:** relatório com gráficos nativos, logo e cores da empresa.
- **Casos:** cada nota de 0 a 6 vira um caso para tratar; alerta por e-mail, webhook ou WhatsApp.
- **Segurança:** 2FA, recuperação de senha, LGPD (consentimento, criptografia, retenção, pedidos do titular).
- **Coleta:** tablet em modo quiosque e QR Code por filial, perguntas condicionais, campanhas agendadas, PT/EN/ES.
- **Fuso horário por filial:** o horário de funcionamento vale no fuso do tablet (modo automático) ou num fuso fixo escolhido na filial; a empresa é a reserva. Vale também para campanhas, alerta de tablet sem sinal e e-mails.
- **E-mail e WhatsApp pelo painel:** Configurações → E-mail e WhatsApp (SMTP com provedores prontos, API oficial da Meta, teste de conexão e fila de envios). Senhas e tokens ficam criptografados e nunca voltam à tela; o servidor SMTP precisa ser público (bloqueia rede interna). Cada pessoa pode cadastrar o próprio WhatsApp em Minha conta.
- **Auditoria em português:** cada ação vira uma frase (quem, o quê, onde), com filtros por tipo, busca e destaque do que merece atenção.
- **Localização das respostas (QR Code):** o cliente pode autorizar a localização; o sistema grava cidade (município do IBGE mais próximo), UF e região, com o ponto arredondado a ~1 km. Tudo offline, sem serviços externos; o ponto é apagado pela política de retenção e a cidade/UF ficam só como estatística. Aparece em Respostas, no filtro por estado, no quadro "Origem das respostas" e no CSV. Nos tablets o local é a cidade da filial.
- **Tablet:** `/kiosk` — sem login; ativado uma vez com código gerado no painel; respostas sempre gravadas na filial do tablet.
- **Perfis e permissões (1.5):** perfis com Ver, Incluir, Editar e Excluir em cada menu, ações específicas e escopo de filiais. Conferido no servidor, com regras contra aumento de acesso.
- **WhatsApp pelo QR Code (1.5):** número da empresa conectado como no WhatsApp Web; alertas para várias pessoas, um por vez, com pausa sorteada de 15 a 60 s. A API oficial da Meta continua disponível.
- **Modelos de mensagem (1.5):** textos de cada envio (e-mail e WhatsApp) editáveis, com variáveis e prévia.
- **Foto de perfil, prazos de guarda de até 10 anos, telas para celular, manual de ajuda e notas de versão (1.5).** Veja o [CHANGELOG](CHANGELOG.md).

```bash
npm install
npm run create-admin -- voce@empresa.com "Seu Nome"
npm start          # http://127.0.0.1:3000/admin
npm test           # testes de segurança e de funcionamento
npm run test:telas # confere as telas em 360 px (precisa do Chromium do Playwright)
npm run docs:prints && npm run docs:manual   # atualiza prints, manual e notas de versão
```

Requer Node.js 22.13+.

| Documento | Para quê |
|---|---|
| [docs/DEPLOY.md](docs/DEPLOY.md) | Colocar no ar na VPS (Docker, HTTPS, backup) |
| [docs/INSTALACAO-TABLET.md](docs/INSTALACAO-TABLET.md) | Instalar e travar os tablets nas filiais |
| [docs/PLANEJAMENTO.md](docs/PLANEJAMENTO.md) | Arquitetura, segurança e testes |
| [docs/MANUAL.md](docs/MANUAL.md) | Manual do painel (o mesmo do menu Ajuda) |
| [CHANGELOG.md](CHANGELOG.md) | Notas de versão (o mesmo do menu Novidades) |

## Telas

| Tablet | Painel |
|---|---|
| ![Números coloridos](docs/screenshots/31-numeros-coloridos-nps.png) | ![Visão geral](docs/screenshots/20-painel-novo.png) |
| ![Carinhas coloridas](docs/screenshots/32-carinhas-coloridas-nps.png) | ![Ícones das respostas](docs/screenshots/24-config-icones-respostas.png) |
