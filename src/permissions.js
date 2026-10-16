'use strict';
// Perfis de acesso: cada perfil diz, menu por menu, o que pode ver, incluir, editar e excluir,
// além de ações específicas (exportar CSV, ativar QR Code…) e se enxerga todas as filiais ou só as do usuário.
// O perfil "Administrador" é fixo e tem acesso total. Tudo é conferido no servidor: esconder um botão não basta.
const { get, all, run } = require('./db');
const { HttpError, bad, str } = require('./validate');

const OPS = { ver: 'Ver', incluir: 'Incluir', editar: 'Editar', excluir: 'Excluir' };

// Catálogo exibido na tela "Permissões". A ordem e os grupos seguem o menu lateral.
const MODULES = [
  { key: 'dashboard', label: 'Visão geral', hint: 'NPS, ranking e gráficos', group: 'Análise', ops: ['ver'], extra: { pptx: 'Exportar PowerPoint' } },
  { key: 'casos', label: 'Casos', hint: 'Clientes insatisfeitos. Editar = mudar status, responsável e anotar', group: 'Análise', ops: ['ver', 'editar'], extra: { contato: 'Ver contato do cliente' } },
  { key: 'respostas', label: 'Respostas', hint: 'Respostas recebidas dos tablets e do QR Code', group: 'Análise', ops: ['ver', 'excluir'], extra: { csv: 'Exportar CSV' } },
  { key: 'pesquisas', label: 'Pesquisas', hint: 'Perguntas, aparência e idiomas', group: 'Coleta', ops: ['ver', 'incluir', 'editar'], extra: {} },
  { key: 'campanhas', label: 'Campanhas', hint: 'Pesquisas agendadas por período', group: 'Coleta', ops: ['ver', 'incluir', 'excluir'], extra: {} },
  { key: 'filiais', label: 'Filiais', hint: 'Cadastro, alertas e horário de funcionamento', group: 'Coleta', ops: ['ver', 'incluir', 'editar'],
    extra: { pesquisa: 'Escolher a pesquisa dos tablets', qrcode: 'QR Code: ativar, desativar e gerar novo link' } },
  { key: 'tablets', label: 'Tablets', hint: 'Excluir = revogar o acesso do tablet', group: 'Coleta', ops: ['ver', 'incluir', 'excluir'], extra: { codigo: 'Gerar novo código de pareamento' } },
  { key: 'usuarios', label: 'Usuários', hint: 'Desativar um usuário é feito em Editar', group: 'Administração', ops: ['ver', 'incluir', 'editar'], extra: { mfa: 'Reiniciar o 2FA de outra pessoa' } },
  { key: 'permissoes', label: 'Perfis e permissões', hint: 'Esta tela', group: 'Administração', ops: ['ver', 'incluir', 'editar', 'excluir'], extra: {} },
  { key: 'cfg_marca', label: 'Configurações · Identidade e ícones', hint: 'Nome, cores, logo e ícones', group: 'Administração', ops: ['ver', 'editar'], extra: {} },
  { key: 'cfg_alertas', label: 'Configurações · Alertas e relatórios', hint: 'Alertas, relatório semanal, metas e tela do tablet', group: 'Administração', ops: ['ver', 'editar'],
    extra: { relatorio: 'Enviar o relatório semanal agora' } },
  { key: 'cfg_envios', label: 'Configurações · E-mail e WhatsApp', hint: 'Servidor de e-mail, WhatsApp e fila de envios', group: 'Administração', ops: ['ver', 'editar'], extra: {} },
  { key: 'cfg_modelos', label: 'Configurações · Modelos de mensagem', hint: 'Textos dos alertas e e-mails, com prévia', group: 'Administração', ops: ['ver', 'editar'], extra: {} },
  { key: 'cfg_lgpd', label: 'Configurações · Segurança e LGPD', hint: '2FA obrigatório, prazos de guarda e aviso de privacidade', group: 'Administração', ops: ['ver', 'editar'],
    extra: { titular: 'Pedidos do titular (localizar, exportar e excluir dados)' } },
  { key: 'auditoria', label: 'Auditoria', hint: 'Histórico de quem fez o quê', group: 'Administração', ops: ['ver'], extra: {} },
];
const BY_KEY = new Map(MODULES.map((m) => [m.key, m]));
const ALL_PERMS = MODULES.flatMap((m) => [...m.ops, ...Object.keys(m.extra)].map((a) => `${m.key}.${a}`));
const VALID = new Set(ALL_PERMS);

// O que o "Gestor de filial" sempre pôde fazer — vira o padrão desse perfil.
const GESTOR_DEFAULT = ['dashboard.ver', 'dashboard.pptx', 'casos.ver', 'casos.editar', 'casos.contato', 'respostas.ver', 'respostas.csv',
  'pesquisas.ver', 'campanhas.ver', 'filiais.ver', 'filiais.pesquisa', 'tablets.ver', 'tablets.incluir', 'tablets.excluir', 'tablets.codigo'];

// Permissões que permitem mudar quem acessa o quê ou a configuração do sistema: exigem 2FA (se a empresa exigir).
const SENSITIVE = new Set(['usuarios.incluir', 'usuarios.editar', 'usuarios.mfa', 'permissoes.incluir', 'permissoes.editar', 'permissoes.excluir',
  'cfg_marca.editar', 'cfg_alertas.editar', 'cfg_envios.editar', 'cfg_modelos.editar', 'cfg_lgpd.editar', 'cfg_lgpd.titular']);

// Valida e normaliza a lista: só itens do catálogo; qualquer ação inclui "ver" do mesmo menu.
function normalizePerms(list) {
  if (!Array.isArray(list) || list.length > ALL_PERMS.length * 2) throw bad('Lista de permissões inválida.');
  const out = new Set();
  for (const p of list) {
    if (typeof p !== 'string' || !VALID.has(p)) throw bad('Permissão desconhecida.');
    out.add(p);
    out.add(p.split('.')[0] + '.ver');
  }
  return ALL_PERMS.filter((p) => out.has(p));
}

const parsePerms = (json) => { try { const v = JSON.parse(json || '[]'); return Array.isArray(v) ? v.filter((p) => VALID.has(p)) : []; } catch { return []; } };

// Perfis padrão: criados na primeira vez; usuários antigos recebem o perfil equivalente ao que tinham.
function ensureRoles() {
  const now = Date.now();
  if (!get("SELECT 1 FROM roles WHERE builtin = 'admin'")) {
    run("INSERT INTO roles (name, description, scope, perms, builtin, created_at, updated_at) VALUES ('Administrador', 'Acesso total. Perfil fixo do sistema.', 'all', '[]', 'admin', ?, ?)", now, now);
  }
  if (!get("SELECT 1 FROM roles WHERE builtin = 'gestor'")) {
    run("INSERT INTO roles (name, description, scope, perms, builtin, created_at, updated_at) VALUES ('Gestor de filial', 'Acompanha as filiais ligadas a ele.', 'own', ?, 'gestor', ?, ?)",
      JSON.stringify(GESTOR_DEFAULT), now, now);
  }
  run("UPDATE users SET role_id = (SELECT id FROM roles WHERE builtin = users.role) WHERE role_id IS NULL");
}
ensureRoles();

const builtinRole = (b) => get('SELECT * FROM roles WHERE builtin = ?', b);

// Perfil efetivo de um usuário. role = 'admin' sempre vale como Administrador (o script create-admin usa isso
// para recuperar o acesso); sem perfil definido, vale o "Gestor de filial".
function roleOf(u) {
  if (u.role === 'admin') return builtinRole('admin');
  const r = u.role_id ? get('SELECT * FROM roles WHERE id = ?', u.role_id) : null;
  return r && r.builtin !== 'admin' ? r : builtinRole('gestor');
}

function accessFor(u) {
  if (u.access) return u.access;
  // Objetos sem o perfil carregado (ex.: { id, role } vindos de outras rotinas) buscam no banco.
  const row = u.role === 'admin' || 'role_id' in u ? u : (get('SELECT role, role_id FROM users WHERE id = ?', u.id) || { role: 'gestor', role_id: null });
  const r = roleOf(row);
  const isAdmin = r.builtin === 'admin';
  return { roleId: r.id, roleName: r.name, isAdmin, scopeAll: isAdmin || r.scope === 'all', perms: new Set(isAdmin ? ALL_PERMS : parsePerms(r.perms)) };
}

const can = (user, mod, act) => { const a = accessFor(user); return a.isAdmin || a.perms.has(`${mod}.${act}`); };
const canAny = (user, pairs) => pairs.some(([m, a]) => can(user, m, a));
const isPrivileged = (user) => { const a = accessFor(user); return a.isAdmin || [...a.perms].some((p) => SENSITIVE.has(p)); };

const DENIED = 'Seu perfil não tem permissão para esta ação.';
// Middlewares: need('respostas', 'excluir') ou needAny(['usuarios','ver'], ['permissoes','ver']).
const need = (mod, act) => (req, res, next) => { if (!can(req.user, mod, act)) throw new HttpError(403, DENIED); next(); };
const needAny = (...pairs) => (req, res, next) => { if (!canAny(req.user, pairs)) throw new HttpError(403, DENIED); next(); };
const deny = () => new HttpError(403, DENIED);

// Versão enviada ao navegador (o menu e os botões seguem isto; o servidor confere de novo em cada chamada).
const publicAccess = (user) => { const a = accessFor(user); return { roleId: a.roleId, roleName: a.roleName, isAdmin: a.isAdmin, scopeAll: a.scopeAll, perms: [...a.perms] }; };

// Um perfil "cabe" no de quem está mexendo? Ninguém dá a outra pessoa (nem a si) o que não tem.
function roleWithin(actor, role) {
  const a = accessFor(actor);
  if (a.isAdmin) return true;
  if (role.builtin === 'admin') return false;
  if (role.scope === 'all' && !a.scopeAll) return false;
  const perms = Array.isArray(role.perms) ? role.perms : parsePerms(role.perms);
  return perms.every((p) => a.perms.has(p));
}

function roleInput(body) {
  const scope = body?.scope === 'all' ? 'all' : body?.scope === 'own' ? 'own' : null;
  if (!scope) throw bad('Escolha quais filiais o perfil enxerga.');
  return {
    name: str(body?.name, { field: 'nome do perfil', min: 2, max: 60 }),
    description: str(body?.description, { field: 'descrição', max: 200, optional: true }),
    scope,
    perms: normalizePerms(body?.perms ?? []),
  };
}

function listRoles() {
  const counts = new Map(all("SELECT CASE WHEN role = 'admin' THEN (SELECT id FROM roles WHERE builtin = 'admin') ELSE COALESCE(role_id, (SELECT id FROM roles WHERE builtin = 'gestor')) END AS rid, COUNT(*) AS n FROM users WHERE active = 1 GROUP BY rid")
    .map((r) => [r.rid, r.n]));
  return all("SELECT * FROM roles ORDER BY CASE builtin WHEN 'admin' THEN 0 WHEN 'gestor' THEN 1 ELSE 2 END, name").map((r) => ({
    id: r.id, name: r.name, description: r.description, scope: r.builtin === 'admin' ? 'all' : r.scope, builtin: r.builtin,
    perms: r.builtin === 'admin' ? ALL_PERMS : parsePerms(r.perms), users: counts.get(r.id) || 0, updated_at: r.updated_at,
  }));
}

const catalog = () => ({ ops: OPS, modules: MODULES });

module.exports = {
  MODULES, OPS, ALL_PERMS, GESTOR_DEFAULT, SENSITIVE, normalizePerms, parsePerms, accessFor, can, canAny, isPrivileged, need, needAny, deny,
  publicAccess, roleWithin, roleInput, roleOf, listRoles, catalog, builtinRole, BY_KEY,
};
