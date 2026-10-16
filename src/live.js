'use strict';
// Atualização em tempo real do painel (Server-Sent Events): cada painel aberto mantém uma conexão e recebe
// um aviso curto quando algo muda (ex.: { area: 'filiais' }). A tela então busca os dados de novo, pelas
// rotas normais — que conferem permissão e escopo. O aviso nunca leva dados, só o nome da área.
const { scope } = require('./scope');
const { sessionValid } = require('./auth');

const clients = new Set();
const HEARTBEAT_MS = Number(process.env.LIVE_HEARTBEAT_MS) || 25_000; // nos testes, menor

function subscribe(req, res) {
  res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  res.write('retry: 5000\n\n');
  const client = { res, userId: req.user.id };
  clients.add(client);
  // A cada batida confere se a sessão ainda vale (saiu, foi desativado, trocou a senha, expirou): se não, encerra.
  const beat = setInterval(() => {
    if (!sessionValid(req.user.sessionHash)) return res.end();
    res.write(': ok\n\n');
  }, HEARTBEAT_MS);
  beat.unref?.();
  req.on('close', () => { clearInterval(beat); clients.delete(client); });
}

// area: parte do painel que mudou; branchId (opcional): só avisa quem enxerga a filial; by: aba que fez a gravação.
function publish(area, { branchId = null, by = null } = {}) {
  if (!clients.size) return;
  const data = `event: change\ndata: ${JSON.stringify({ area, by })}\n\n`;
  for (const c of clients) {
    try {
      // Escopo lido na hora (perfil e filiais podem ter mudado desde que o painel abriu).
      if (branchId !== null) { const s = scope({ id: c.userId }); if (s && !s.includes(branchId)) continue; }
      c.res.write(data);
    } catch { clients.delete(c); }
  }
}

// Áreas do painel por rota da API (o que muda quando a rota grava algo).
const AREAS = { branches: 'filiais', devices: 'tablets', surveys: 'pesquisas', schedules: 'pesquisas', users: 'usuarios', roles: 'permissoes',
  settings: 'configuracoes', templates: 'configuracoes', 'whatsapp-qr': 'configuracoes', responses: 'respostas', media: null, me: 'conta' };

// POSTs que não gravam nada visível no painel (prévias, testes de envio, "já vi as novidades"): não avisam ninguém,
// senão cada tecla no editor de modelos recarregaria os outros painéis.
const READ_ONLY = /\/(preview|test)$|^\/settings\/(test-email|test-whatsapp|weekly-report\/send-now)$|^\/me\/seen-version$|^\/logout$/;

// Middleware: depois de uma gravação bem-sucedida no painel, avisa os outros painéis abertos.
function afterWrite(fixedArea = null) {
  return (req, res, next) => {
    if (req.method !== 'GET' && !READ_ONLY.test(req.path)) {
      res.on('finish', () => {
        if (res.statusCode >= 400) return;
        const area = fixedArea || AREAS[req.path.split('/')[1]];
        // by = aba do painel que gravou (cabeçalho X-Tab-Id, aleatório por aba): ela ignora o próprio aviso.
        const tab = req.get('x-tab-id');
        if (area) publish(area, { by: typeof tab === 'string' && /^[a-f0-9]{24}$/.test(tab) ? tab : null });
      });
    }
    next();
  };
}

const connected = () => clients.size;

module.exports = { subscribe, publish, afterWrite, connected };
