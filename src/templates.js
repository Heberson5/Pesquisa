'use strict';
// Modelos de mensagem: o texto de cada tipo de envio (e-mail e WhatsApp) pode ser editado no painel.
// Variáveis entre chaves, ex.: {filial}. A mesma montagem serve para a prévia e para o envio real.
// No e-mail tudo é escapado (renderEmail): um comentário de cliente nunca vira HTML ou link.
const { get, run } = require('./db');
const { bad } = require('./validate');
const { renderEmail, oneLine } = require('./notify');
const { getSettings } = require('./settings');

const V = (key, label, sample) => ({ key, label, sample });
const COMMON = [V('empresa', 'Nome da empresa', 'Rede Sol'), V('destinatario', 'Nome de quem recebe', 'Ana Paula')];

// Tipos de envio. channels: onde o texto é usado. vars: o que pode aparecer entre chaves.
const KINDS = {
  detractor: {
    label: 'Cliente insatisfeito', description: 'Enviado na hora em que chega uma nota de 0 a 6. Abre um caso para tratamento.',
    channels: ['email', 'whatsapp'],
    vars: [...COMMON, V('filial', 'Filial', 'Loja Centro · Campinas'), V('nota', 'Nota dada', '3'), V('data_hora', 'Data e hora da resposta', '16/10/2026 14:32'),
      V('canal', 'Tablet ou QR Code', 'QR Code'), V('comentario', 'Comentário do cliente', 'Esperei 40 minutos para ser atendido.'),
      V('cliente', 'Nome do cliente (se pediu contato)', 'Mariana S.'), V('telefone_cliente', 'Telefone do cliente (se pediu contato)', '(19) 99812-4410'),
      V('link_caso', 'Link do caso no painel', 'https://pesquisa.suaempresa.com.br/admin/#/casos/128')],
    email: {
      subject: '[Alerta] Nota {nota} em {filial}', title: 'Cliente insatisfeito — {filial}',
      intro: 'Uma resposta com nota {nota} acabou de chegar. Um caso foi aberto para tratamento.', button: 'Abrir o caso no painel',
      footer: 'Você recebe este aviso porque está cadastrado para alertas desta filial. Ajuste em Minha conta.',
    },
    whatsapp: { text: '🔴 *Cliente insatisfeito: {filial}*\n\nOlá, {destinatario}. Chegou uma nota *{nota}* em {data_hora} ({canal}).\n\n💬 _{comentario}_\n\nAbra o caso: {link_caso}' },
  },
  offline: {
    label: 'Tablet sem sinal', description: 'Enviado quando um tablet fica sem comunicação durante o horário de funcionamento.',
    channels: ['email', 'whatsapp'],
    vars: [...COMMON, V('filial', 'Filial', 'Loja Centro · Campinas'), V('tablet', 'Nome do tablet', 'Tablet do caixa 2'),
      V('minutos', 'Minutos sem sinal para avisar', '30'), V('ultimo_contato', 'Último contato do tablet', '16/10/2026 13:58'),
      V('link_painel', 'Link da tela de tablets', 'https://pesquisa.suaempresa.com.br/admin/#/dispositivos')],
    email: {
      subject: '[Alerta] Tablet sem sinal: {tablet} ({filial})', title: 'Tablet sem sinal — {filial}',
      intro: 'O tablet "{tablet}" não se comunica com o sistema há mais de {minutos} minutos, durante o horário de funcionamento. Verifique se está ligado, conectado ao Wi-Fi e com a pesquisa aberta.',
      button: 'Ver tablets no painel', footer: '',
    },
    whatsapp: { text: '⚠️ *Tablet sem sinal*\n\n{tablet} ({filial}) está sem conexão há mais de {minutos} minutos, dentro do horário de funcionamento. Último contato: {ultimo_contato}.\n\nConfira se está ligado e no Wi-Fi.\n{link_painel}' },
  },
  weekly: {
    label: 'Relatório semanal', description: 'E-mail com o PowerPoint da semana anexado. Cada pessoa recebe só as filiais dela.',
    channels: ['email'],
    vars: [...COMMON, V('periodo', 'Período do relatório', '06/10/2026 a 12/10/2026'), V('nps', 'NPS da semana', '74'),
      V('respostas', 'Total de respostas', '412'), V('casos_pendentes', 'Casos pendentes', '7'), V('link_painel', 'Link do painel', 'https://pesquisa.suaempresa.com.br/admin/')],
    email: {
      subject: '{empresa}: relatório semanal (NPS {nps})', title: 'Relatório semanal de satisfação',
      intro: 'Resumo de {periodo}. O relatório completo em PowerPoint está anexado.', button: 'Abrir o painel',
      footer: 'Para deixar de receber, desmarque "Relatório semanal" em Minha conta.',
    },
  },
  reset: {
    label: 'Redefinição de senha', description: 'Enviado quando alguém clica em "Esqueci minha senha". O link vale por 30 minutos.',
    channels: ['email'],
    // O link de redefinição só vai no botão (montado pelo sistema): não pode ser colocado no texto, onde alguém
    // com acesso aos modelos poderia embrulhá-lo num endereço próprio.
    vars: [...COMMON, V('ip', 'IP de onde veio o pedido', '200.150.10.20')],
    email: {
      subject: '{empresa}: redefinição de senha', title: 'Redefinição de senha',
      intro: 'Olá, {destinatario}. Recebemos um pedido para redefinir sua senha do painel. O link vale por 30 minutos e só pode ser usado uma vez. Se não foi você, ignore este e-mail — sua senha continua a mesma.',
      button: 'Criar nova senha', footer: 'Pedido feito a partir do IP {ip}.',
    },
  },
  test: {
    label: 'Mensagem de teste', description: 'Enviada pelos botões "Enviar teste" para conferir se o envio funciona.',
    channels: ['email', 'whatsapp'],
    vars: [...COMMON],
    email: { subject: '{empresa}: e-mail de teste', title: 'E-mail de teste', intro: 'Se você recebeu esta mensagem, o envio de e-mails do sistema de pesquisa está funcionando.', button: '', footer: '' },
    whatsapp: { text: '✅ Teste de envio do *{empresa}*.\nOlá, {destinatario}! Se você recebeu esta mensagem, os alertas por WhatsApp estão funcionando.' },
  },
};

// Campos de cada canal: [nome, tamanho máximo, aceita várias linhas]
const FIELDS = {
  email: [['subject', 200, false], ['title', 200, false], ['intro', 1500, true], ['button', 60, false], ['footer', 500, true]],
  whatsapp: [['text', 2000, true]],
};
const VAR_RE = /\{([a-z_]+)\}/g;

function kindOf(kind, channel) {
  const k = KINDS[kind];
  if (!k || !k.channels.includes(channel)) throw bad('Tipo de mensagem inválido.');
  return k;
}

function stored(kind, channel) {
  const row = get('SELECT data, updated_at FROM message_templates WHERE kind = ? AND channel = ?', kind, channel);
  if (!row) return null;
  try { return { data: JSON.parse(row.data), updated_at: row.updated_at }; } catch { return null; }
}

// Modelo em uso (o salvo pela empresa ou o padrão).
function current(kind, channel) {
  const k = kindOf(kind, channel);
  const s = stored(kind, channel);
  return { ...k[channel], ...(s?.data || {}), custom: !!s, updated_at: s?.updated_at || null };
}

// Valida os textos: tamanhos, sem caracteres de controle e só variáveis que existem neste tipo.
function validate(kind, channel, input) {
  const k = kindOf(kind, channel);
  if (!input || typeof input !== 'object') throw bad('Modelo inválido.');
  const allowed = new Set(k.vars.map((v) => v.key));
  const out = {};
  for (const [field, max, multi] of FIELDS[channel]) {
    const v = input[field] === undefined || input[field] === null ? '' : input[field];
    if (typeof v !== 'string') throw bad('Texto inválido.');
    let t = v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
    t = multi ? t.trim() : t.replace(/\s+/g, ' ').trim();
    if (t.length > max) throw bad(`Texto muito longo (máximo de ${max} caracteres).`);
    for (const m of t.matchAll(VAR_RE)) if (!allowed.has(m[1])) throw bad(`A variável {${m[1]}} não existe para "${k.label}".`);
    out[field] = t;
  }
  if (channel === 'email' && (!out.subject || !out.title)) throw bad('Assunto e título são obrigatórios.');
  if (channel === 'whatsapp' && !out.text) throw bad('Escreva o texto da mensagem.');
  return out;
}

function save(kind, channel, input, userId) {
  const data = validate(kind, channel, input);
  run(`INSERT INTO message_templates (kind, channel, data, updated_at, updated_by) VALUES (?,?,?,?,?)
       ON CONFLICT(kind, channel) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  kind, channel, JSON.stringify(data), Date.now(), userId ?? null);
  return current(kind, channel);
}

function restore(kind, channel) {
  kindOf(kind, channel);
  run('DELETE FROM message_templates WHERE kind = ? AND channel = ?', kind, channel);
  return current(kind, channel);
}

// Textos digitados pelo cliente (anônimo no QR Code) entram nas mensagens à equipe: viram uma linha só, sem
// formatação do WhatsApp e com links desativados — ninguém consegue forjar uma linha "do sistema" nem um link
// clicável enviado pelo número da empresa.
const CUSTOMER_VARS = ['comentario', 'cliente', 'telefone_cliente'];
const customerText = (v) => String(v ?? '').replace(/\s+/g, ' ').replace(/[*_~`]/g, '').replace(/(\w)\.(?=\w)/g, '$1\u2024').replace(/:\/\//g, ': //').trim();
const cleanVars = (vars) => {
  const out = { ...vars };
  for (const k of CUSTOMER_VARS) if (Object.hasOwn(out, k)) out[k] = customerText(out[k]);
  delete out.link_redefinir;
  return out;
};

// Troca {variavel} pelo valor. Valores vazios somem; "{x}" de quem digitou no comentário não é reprocessado.
const fill = (tpl, vars) => String(tpl || '').replace(VAR_RE, (m, key) => (Object.hasOwn(vars, key) ? String(vars[key] ?? '') : m));
const sampleVars = (kind) => Object.fromEntries(KINDS[kind].vars.map((v) => [v.key, v.sample]));

// Monta o e-mail final. rows = tabela automática (filial, nota, contato…); buttonUrl = destino do botão.
function emailFor(kind, vars, { rows = [], buttonUrl = null, override = null } = {}) {
  const t = override ? { ...current(kind, 'email'), ...validate(kind, 'email', override) } : current(kind, 'email');
  const brand = getSettings();
  const v = { empresa: brand.companyName, destinatario: 'equipe', ...cleanVars(vars) };
  const { html, text } = renderEmail({
    brand, title: fill(t.title, v), intro: fill(t.intro, v), rows,
    button: t.button && buttonUrl ? { label: fill(t.button, v), url: buttonUrl } : null, footer: fill(t.footer, v),
  });
  return { subject: oneLine(fill(t.subject, v)), html, text };
}

function whatsappFor(kind, vars, { override = null } = {}) {
  const t = override ? { ...current(kind, 'whatsapp'), ...validate(kind, 'whatsapp', override) } : current(kind, 'whatsapp');
  const v = { empresa: getSettings().companyName, destinatario: 'equipe', ...cleanVars(vars) };
  // Linhas cujas variáveis ficaram todas sem valor (ex.: "💬 _{comentario}_" sem comentário) são retiradas,
  // junto com a formatação em volta; depois, linhas em branco repetidas viram uma só.
  const lines = String(t.text || '').split('\n').filter((line) => {
    const keys = [...line.matchAll(VAR_RE)].map((m) => m[1]).filter((k) => Object.hasOwn(v, k));
    return !keys.length || keys.some((k) => String(v[k] ?? '').trim());
  });
  return lines.map((line) => fill(line, v)).filter((line, i, arr) => line.trim() || (i > 0 && arr[i - 1].trim())).join('\n').trim();
}

// Lista para a tela: tipos, variáveis com exemplo e o texto em uso.
function overview() {
  return Object.entries(KINDS).map(([key, k]) => ({
    key, label: k.label, description: k.description, channels: k.channels, vars: k.vars,
    templates: Object.fromEntries(k.channels.map((c) => [c, current(key, c)])),
    defaults: Object.fromEntries(k.channels.map((c) => [c, k[c]])),
  }));
}

module.exports = { KINDS, FIELDS, current, validate, save, restore, fill, sampleVars, emailFor, whatsappFor, overview, customerText };
