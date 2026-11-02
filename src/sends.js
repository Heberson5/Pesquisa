'use strict';
// Relatório de envios e falhas: WhatsApp por QR Code (wa_messages) e e-mail/API oficial/webhook (outbox).
// Gestor vê só as mensagens das filiais dele; o que não tem filial é do administrador.
const { all } = require('./db');
const { bad, id, dateParam } = require('./validate');
const { scope, assertBranch, placeholders } = require('./scope');
const zones = require('./zones');
const { timezone } = require('./config');

const STATUS_LABEL = { queued: 'Na fila', sending: 'Enviando', sent: 'Enviado', failed: 'Falhou', paused: 'Pausado', pending: 'Na fila' };
const CHANNEL_LABEL = { wa_qr: 'WhatsApp (QR Code)', whatsapp: 'WhatsApp (API oficial)', email: 'E-mail', webhook: 'Webhook' };
const KIND_LABEL = { thanks: 'Agradecimento', alert: 'Alerta', detractor: 'Alerta', report: 'Relatório', weekly_report: 'Relatório', test: 'Teste', offline: 'Tablet sem sinal', reset: 'Senha', wa_down: 'WhatsApp desconectado' };

function nextDay(day) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function companyPeriod(column, from, to) {
  const sql = []; const params = [];
  const f = dateParam(from, 'de');
  if (f !== null) { sql.push(`${column} >= ?`); params.push(f); }
  if (dateParam(to, 'até') !== null) { sql.push(`${column} < ?`); params.push(dateParam(nextDay(to), 'até')); }
  return { sql, params };
}

function listSends(user, q = {}, limit = 500) {
  const s = scope(user);
  const branchId = q.branchId ? id(q.branchId, 'filial') : null;
  if (branchId) assertBranch(user, branchId);
  if (q.status && !Object.hasOwn(STATUS_LABEL, q.status)) throw bad('Situação inválida.');
  if (q.channel && !Object.hasOwn(CHANNEL_LABEL, q.channel)) throw bad('Canal inválido.');
  const statuses = q.status === 'queued' ? ['queued', 'sending', 'pending'] : q.status ? [q.status] : null;
  const tz = zones.branchZones();
  const out = [];

  if (!q.channel || q.channel === 'wa_qr') {
    const where = []; const params = [];
    // Dia local da filial; sem filial, o dia da empresa.
    const period = zones.periodSql('m.created_at', 'm.branch_id', q.from, q.to);
    const company = companyPeriod('m.created_at', q.from, q.to);
    if (period) {
      where.push(`(${period.sql} OR (m.branch_id IS NULL AND ${company.sql.join(' AND ') || '1'}))`);
      params.push(...period.params, ...company.params);
    }
    if (branchId) { where.push('m.branch_id = ?'); params.push(branchId); }
    if (s) { where.push(s.length ? `m.branch_id IN (${placeholders(s)})` : '0'); params.push(...s); }
    if (statuses) { where.push(`m.status IN (${placeholders(statuses)})`); params.push(...statuses); }
    const rows = all(`SELECT m.id, m.kind, m.recipient, m.status, m.reason, m.created_at, m.sent_at, m.branch_id, b.name AS branch FROM wa_messages m LEFT JOIN branches b ON b.id = m.branch_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.id DESC LIMIT ?`, ...params, limit);
    for (const r of rows) out.push({ key: `wa-${r.id}`, id: r.id, channel: 'wa_qr', kind: r.kind, recipient: r.recipient, status: r.status, reason: r.reason, at: r.sent_at || r.created_at, branch: r.branch, branch_id: r.branch_id, tz: tz.get(r.branch_id) || timezone });
  }

  // Fila de e-mail e API oficial não guarda filial: fica para o administrador, em relatório geral.
  if (user.role === 'admin' && !branchId && q.channel !== 'wa_qr') {
    const where = []; const params = [];
    const company = companyPeriod('o.created_at', q.from, q.to);
    where.push(...company.sql); params.push(...company.params);
    if (q.channel) { where.push('o.channel = ?'); params.push(q.channel); }
    if (statuses) { where.push(`o.status IN (${placeholders(statuses)})`); params.push(...statuses); }
    const rows = all(`SELECT o.id, o.kind, o.channel, o.recipient, o.status, o.last_error, o.created_at, o.sent_at FROM outbox o ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY o.id DESC LIMIT ?`, ...params, limit);
    for (const r of rows) out.push({ key: `out-${r.id}`, id: null, channel: r.channel, kind: r.kind, recipient: r.recipient, status: r.status === 'pending' ? 'queued' : r.status, reason: r.last_error, at: r.sent_at || r.created_at, branch: null, branch_id: null, tz: timezone });
  }

  out.sort((a, b) => b.at - a.at);
  const totals = { sent: 0, failed: 0, paused: 0, queued: 0 };
  for (const r of out) totals[r.status === 'sending' ? 'queued' : r.status] += 1;
  return { totals, rows: out.slice(0, limit) };
}

const labels = (r) => ({ channel: CHANNEL_LABEL[r.channel] || r.channel, kind: KIND_LABEL[r.kind] || r.kind, status: STATUS_LABEL[r.status] || r.status });

module.exports = { listSends, labels, STATUS_LABEL, CHANNEL_LABEL, KIND_LABEL, nextDay };
