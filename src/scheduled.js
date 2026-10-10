'use strict';
// Envios automáticos: relatório semanal em PowerPoint e alerta de tablet sem sinal.
const { get, all, run, audit } = require('./db');
const { getSettings } = require('./settings');
const { queueEmail, renderEmail } = require('./notify');
const { reportFor } = require('./stats');
const { localNow, formatLocal } = require('./time');
const zones = require('./zones');
const { hoursStatus } = require('./responses');
const { branchRecipients } = require('./alerts');
const { publicUrl } = require('./config');

const fmtNps = (n) => (n === null || n === undefined ? '—' : (n > 0 ? '+' : '') + n.toLocaleString('pt-BR'));
const pct = (v, t) => (t ? Math.round((v / t) * 100) + '%' : '—');
const META_KEY = 'state.weeklyReportLastSent';

// Período: os 7 dias anteriores ao dia do envio (sem o dia atual, que ainda não terminou).
function lastWeek(date) {
  const end = new Date(date + 'T12:00:00Z');
  const to = new Date(end.getTime() - 86_400_000).toISOString().slice(0, 10);
  const from = new Date(end.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
  return { from, to };
}

async function sendWeeklyReport({ force = false, now = Date.now() } = {}) {
  const s = getSettings();
  if (!s.weeklyReport.enabled && !force) return { sent: 0, skipped: 'desativado' };
  const ln = localNow(now);
  if (!force && (ln.weekday !== s.weeklyReport.weekday || ln.hour < s.weeklyReport.hour)) return { sent: 0, skipped: 'fora do horário' };
  const last = get('SELECT value FROM settings WHERE key = ?', META_KEY)?.value;
  if (!force && last === JSON.stringify(ln.date)) return { sent: 0, skipped: 'já enviado hoje' };
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', META_KEY, JSON.stringify(ln.date));

  const period = lastWeek(ln.date);
  // Destinatários: cada usuário recebe o relatório no SEU escopo (gestor só as filiais dele).
  const users = all("SELECT id, name, email, role FROM users WHERE active = 1 AND notify_reports = 1");
  const recipients = users.map((u) => ({ email: u.email, user: u }));
  const adminScope = { id: 0, role: 'admin', name: 'Relatório automático' };
  for (const e of s.weeklyReport.extraEmails) if (!recipients.some((r) => r.email === e)) recipients.push({ email: e, user: adminScope });

  let sent = 0;
  for (const r of recipients) {
    if (r.user.role === 'gestor' && !get('SELECT 1 FROM user_branches WHERE user_id = ?', r.user.id)) continue;
    const { buffer, stats } = await reportFor(r.user, period, 'Relatório automático');
    const o = stats.overall;
    const open = get(`SELECT COUNT(*) AS n FROM cases c ${r.user.role === 'gestor' ? 'JOIN user_branches ub ON ub.branch_id = c.branch_id AND ub.user_id = ?' : ''}
      WHERE c.status IN ('aberto','em_contato')`, ...(r.user.role === 'gestor' ? [r.user.id] : [])).n;
    const { html, text } = renderEmail({
      brand: s, title: 'Relatório semanal de satisfação',
      intro: `Resumo de ${period.from.split('-').reverse().join('/')} a ${period.to.split('-').reverse().join('/')}. O relatório completo em PowerPoint está anexado.`,
      rows: [['NPS', fmtNps(o.nps)], ['Respostas', String(stats.totalResponses)], ['Promotores', pct(o.promoters, o.total)],
        ['Detratores', pct(o.detractors, o.total)], ['Casos pendentes', String(open)],
        ...stats.ranking.slice(0, 5).map((b) => [`${b.position}º ${b.name}`, `NPS ${fmtNps(b.nps)}${b.goal !== null ? ` (meta ${b.goal})` : ''}`])],
      button: { label: 'Abrir o painel', url: `${publicUrl}/admin/` },
      footer: 'Para deixar de receber, desmarque "Relatório semanal" em Minha conta.',
    });
    if (queueEmail({ to: r.email, subject: `${s.companyName}: relatório semanal (NPS ${fmtNps(o.nps)})`, text, html, kind: 'weekly_report',
      attachment: buffer, attachmentName: `relatorio-nps-${period.to}.pptx` })) sent++;
  }
  audit(null, 'report.weekly_queued', { sent, period }, null);
  return { sent, period };
}

function checkOfflineTablets(now = Date.now()) {
  const s = getSettings();
  if (!s.offlineAlert.enabled) return 0;
  const limit = now - s.offlineAlert.minutes * 60_000;
  const devices = all(`SELECT d.*, b.name AS branch_name FROM devices d JOIN branches b ON b.id = d.branch_id
    WHERE d.active = 1 AND b.active = 1 AND d.token_hash IS NOT NULL AND d.last_seen_at < ?
      AND (d.offline_alerted_at IS NULL OR d.offline_alerted_at < d.last_seen_at)`, limit);
  let alerted = 0;
  for (const d of devices) {
    const branch = get('SELECT * FROM branches WHERE id = ?', d.branch_id);
    if (!hoursStatus(branch, now, zones.forBranch(branch, d)).open) continue; // fora do expediente, tablet desligado é esperado
    const { html, text } = renderEmail({
      brand: s, title: `Tablet sem sinal — ${d.branch_name}`,
      intro: `O tablet "${d.name}" não se comunica com o sistema há mais de ${s.offlineAlert.minutes} minutos, durante o horário de funcionamento. Verifique se está ligado, conectado ao Wi-Fi e com a pesquisa aberta.`,
      rows: [['Filial', d.branch_name], ['Tablet', d.name], ['Último contato', formatLocal(d.last_seen_at, zones.forBranch(branch, d))]],
      button: { label: 'Ver tablets no painel', url: `${publicUrl}/admin/#/dispositivos` },
    });
    for (const to of branchRecipients(d.branch_id, 'notify_offline')) {
      queueEmail({ to, subject: `[Alerta] Tablet sem sinal: ${d.name} (${d.branch_name})`, text, html, kind: 'device_offline' });
    }
    run('UPDATE devices SET offline_alerted_at = ? WHERE id = ?', now, d.id);
    alerted++;
  }
  return alerted;
}

module.exports = { sendWeeklyReport, checkOfflineTablets, lastWeek };
