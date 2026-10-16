'use strict';
// Atualização em tempo real do painel (Server-Sent Events): cada painel aberto mantém uma conexão e recebe
// um aviso curto quando algo muda (ex.: { area: 'filiais' }). A tela então busca os dados de novo, pelas
// rotas normais — que conferem permissão e escopo. O aviso nunca leva dados, só o nome da área.
const { get } = require('./db');
const { scope } = require('./scope');

const clients = new Set();
const HEARTBEAT_MS = Number(process.env.LIVE_HEARTBEAT_MS) || 25_000; // nos testes, menor

function subscribe(req, res) {
  res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  res.write('retry: 5000\n\n');
  const client = { res, user: req.user };
  clients.add(client);
  // A cada batida confere se a sessão ainda vale (saiu, foi desativado, trocou a senha): se não, encerra.
  const beat = setInterval(() => {
    if (!get('SELECT 1 AS x FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND u.active = 1', req.user.sessionHash)) return res.end();
    res.write(': ok\n\n');
  }, HEARTBEAT_MS);
  beat.unref?.();
  req.on('close', () => { clearInterval(beat); clients.delete(client); });
}

// area: parte do painel que mudou; branchId (opcional): só avisa quem enxerga a filial; by: quem fez.
function publish(area, { branchId = null, by = null } = {}) {
  if (!clients.size) return;
  const data = `event: change\ndata: ${JSON.stringify({ area, by })}\n\n`;
  for (const c of clients) {
    try {
      if (branchId !== null) { const s = scope(c.user); if (s && !s.includes(branchId)) continue; }
      c.res.write(data);
    } catch { clients.delete(c); }
  }
}

// Áreas do painel por rota da API (o que muda quando a rota grava algo).
const AREAS = { branches: 'filiais', devices: 'tablets', surveys: 'pesquisas', schedules: 'pesquisas', users: 'usuarios', roles: 'permissoes',
  settings: 'configuracoes', templates: 'configuracoes', 'whatsapp-qr': 'configuracoes', responses: 'respostas', media: null, me: 'conta' };

// Middleware: depois de uma gravação bem-sucedida no painel, avisa os outros painéis abertos.
function afterWrite(fixedArea = null) {
  return (req, res, next) => {
    if (req.method !== 'GET') {
      res.on('finish', () => {
        if (res.statusCode >= 400) return;
        const area = fixedArea || AREAS[req.path.split('/')[1]];
        if (area) publish(area, { by: req.user?.id ?? null });
      });
    }
    next();
  };
}

const connected = () => clients.size;

module.exports = { subscribe, publish, afterWrite, connected };
