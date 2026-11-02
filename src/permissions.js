'use strict';
// Permissões por perfil. Administrador: acesso total e irrevogável. Gestor: a mesma tabela para todos,
// definida pelo administrador. O servidor confere cada rota; a tela só esconde o que não pode ser usado.
const { get, run } = require('./db');
const { HttpError, bad } = require('./validate');

const STORE_KEY = 'gestorPermissions';

// "needs": ação que depende de outra (sem ver o menu, não há como usar a ação).
const CATALOG = [
  { menu: 'Visão geral', items: [
    { key: 'dashboard.view', label: 'Ver indicadores e gráficos das filiais dele', default: true },
    { key: 'dashboard.export', label: 'Exportar relatório em PowerPoint', default: true, needs: 'dashboard.view' },
  ] },
  { menu: 'Casos', items: [
    { key: 'cases.view', label: 'Ver casos das filiais dele, inclusive o contato do cliente', default: true },
    { key: 'cases.edit', label: 'Alterar status, responsável e anotações', default: true, needs: 'cases.view' },
  ] },
  { menu: 'Respostas', items: [
    { key: 'responses.view', label: 'Ver respostas das filiais dele', default: true },
    { key: 'responses.export', label: 'Exportar planilha (CSV)', default: true, needs: 'responses.view' },
    { key: 'responses.delete', label: 'Excluir respostas', default: false, needs: 'responses.view' },
  ] },
  { menu: 'Pesquisas', items: [
    { key: 'surveys.view', label: 'Ver pesquisas e agendamentos', default: true },
    { key: 'surveys.edit', label: 'Criar, editar e duplicar pesquisas e momentos (vale para todas as filiais)', default: false, needs: 'surveys.view' },
    { key: 'surveys.delete', label: 'Excluir ou arquivar pesquisas e momentos (vale para todas as filiais)', default: false, needs: 'surveys.view' },
    { key: 'schedules.manage', label: 'Criar, editar e encerrar agendamentos das filiais dele', default: false, needs: 'surveys.view' },
  ] },
  { menu: 'Filiais', items: [
    { key: 'branches.view', label: 'Ver filiais dele e o QR Code', default: true },
    { key: 'branches.survey', label: 'Escolher a pesquisa padrão dos tablets da filial', default: true, needs: 'branches.view' },
    { key: 'branches.link', label: 'Ativar, desativar e gerar novo link do QR Code', default: false, needs: 'branches.view' },
    { key: 'branches.edit', label: 'Cadastrar e editar filiais', default: false, needs: 'branches.view' },
    { key: 'branches.delete', label: 'Excluir ou desativar filiais', default: false, needs: 'branches.view' },
  ] },
  { menu: 'Tablets', items: [
    { key: 'devices.view', label: 'Ver tablets das filiais dele', default: true },
    { key: 'devices.manage', label: 'Cadastrar tablets e gerar novo código', default: true, needs: 'devices.view' },
    { key: 'devices.revoke', label: 'Revogar o acesso de um tablet', default: true, needs: 'devices.view' },
    { key: 'devices.delete', label: 'Excluir tablets', default: false, needs: 'devices.view' },
  ] },
  { menu: 'Envios', items: [
    { key: 'sends.view', label: 'Ver envios e falhas das filiais dele, com os telefones', default: true },
    { key: 'sends.resend', label: 'Reenviar mensagens pausadas', default: true, needs: 'sends.view' },
  ] },
  { menu: 'Usuários', items: [
    { key: 'users.view', label: 'Ver gestores das filiais dele (nunca administradores)', default: true },
    { key: 'users.create', label: 'Cadastrar novos gestores nas filiais dele', default: true, needs: 'users.view' },
    { key: 'users.edit', label: 'Editar e desativar somente os gestores que ele cadastrou', default: true, needs: 'users.view' },
  ] },
];
// Sempre exclusivos do administrador: nem a tabela de permissões consegue liberar.
const ADMIN_ONLY = [
  { key: 'admin.settings', menu: 'Configurações', label: 'Marca, envios, alertas, segurança e LGPD' },
  { key: 'admin.permissions', menu: 'Permissões', label: 'Ver e alterar esta tabela' },
  { key: 'admin.audit', menu: 'Auditoria', label: 'Ver o histórico de ações' },
];
const ITEMS = CATALOG.flatMap((g) => g.items);

// Sem o item de que depende, a ação fica desligada.
function normalize(values) {
  const out = {};
  for (const it of ITEMS) out[it.key] = values[it.key] === true && (!it.needs || values[it.needs] === true);
  return out;
}

function gestorValues() {
  const merged = Object.fromEntries(ITEMS.map((it) => [it.key, it.default]));
  try { Object.assign(merged, JSON.parse(get('SELECT value FROM settings WHERE key = ?', STORE_KEY)?.value || '{}')); } catch { /* ignora valor corrompido */ }
  return normalize(merged);
}

function saveGestorValues(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Permissões inválidas.');
  const clean = {};
  for (const it of ITEMS) {
    if (typeof input[it.key] !== 'boolean') throw bad(`Permissão ausente ou inválida: ${it.label}.`);
    clean[it.key] = input[it.key];
  }
  const values = normalize(clean);
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', STORE_KEY, JSON.stringify(values));
  return values;
}

function permsFor(user) {
  if (user.role === 'admin') return Object.fromEntries([...ITEMS, ...ADMIN_ONLY].map((it) => [it.key, true]));
  return gestorValues();
}
const can = (user, key) => user.role === 'admin' || gestorValues()[key] === true;

const requirePerm = (key) => (req, res, next) => {
  if (!can(req.user, key)) throw new HttpError(403, 'Você não tem permissão para esta ação.');
  next();
};

module.exports = { CATALOG, ADMIN_ONLY, gestorValues, saveGestorValues, permsFor, can, requirePerm };
