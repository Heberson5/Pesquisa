# Pesquisa de Satisfação (NPS) — multi-filial

Sistema de coleta de pesquisa de satisfação para **tablets em modo quiosque**, com **painel administrativo** e análise de **NPS**.

- **Painel:** `/admin` — NPS geral/por filial/por pergunta, respostas, exportação CSV, pesquisas, filiais, tablets, usuários, auditoria.
- **Configurações:** logo, favicon, ícone do app, cores, ícones do menu e estilo das respostas (números coloridos, carinhas coloridas, estrelas, corações…).
- **PowerPoint:** relatório com gráficos nativos, logo e cores da empresa.
- **Tablet:** `/kiosk` — sem login; ativado uma vez com código gerado no painel; respostas sempre gravadas na filial do tablet.

```bash
npm install
npm run create-admin -- voce@empresa.com "Seu Nome"
npm start          # http://127.0.0.1:3000/admin
npm test           # 39 testes de segurança
```

Requer Node.js 22.13+. Planejamento completo, arquitetura e segurança: [docs/PLANEJAMENTO.md](docs/PLANEJAMENTO.md).

## Telas

| Tablet | Painel |
|---|---|
| ![Números coloridos](docs/screenshots/31-numeros-coloridos-nps.png) | ![Visão geral](docs/screenshots/20-painel-novo.png) |
| ![Carinhas coloridas](docs/screenshots/32-carinhas-coloridas-nps.png) | ![Ícones das respostas](docs/screenshots/24-config-icones-respostas.png) |
