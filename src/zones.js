'use strict';
// Fuso horário por filial. Ordem de decisão (a mais forte primeiro):
//   1) fuso escolhido na filial; 2) fuso informado pelo próprio tablet (modo "Automático");
//   3) fuso da empresa (TZ_EMPRESA) como reserva, inclusive quando o tablet informa algo estranho ou fora do Brasil.
// O servidor sempre usa o PRÓPRIO relógio (confiável) com o fuso escolhido: relógio errado no tablet não atrapalha.
const config = require('./config');
const { get } = require('./db');

// Fusos do Brasil aceitos (o que vier de fora desta lista é ignorado).
const BR_ZONES = ['America/Noronha', 'America/Belem', 'America/Fortaleza', 'America/Recife', 'America/Araguaina', 'America/Maceio', 'America/Bahia',
  'America/Sao_Paulo', 'America/Campo_Grande', 'America/Cuiaba', 'America/Santarem', 'America/Porto_Velho', 'America/Boa_Vista', 'America/Manaus',
  'America/Eirunepe', 'America/Rio_Branco'];

// Opções mostradas no cadastro da filial.
const ZONE_CHOICES = [
  { value: 'America/Sao_Paulo', label: 'Brasília (UTC-3)' },
  { value: 'America/Noronha', label: 'Fernando de Noronha (UTC-2)' },
  { value: 'America/Manaus', label: 'Manaus, Mato Grosso e Mato Grosso do Sul (UTC-4)' },
  { value: 'America/Rio_Branco', label: 'Rio Branco e oeste do Amazonas (UTC-5)' },
];

const usable = (tz) => {
  if (typeof tz !== 'string' || tz.length > 40 || !BR_ZONES.includes(tz)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
};
const clean = (tz) => (usable(tz) ? tz : null);

// Fuso em uso para a filial (e, se informado, para o tablet específico).
function forBranch(branch, device = null) {
  return clean(branch?.timezone) || clean(device?.timezone)
    || clean(get('SELECT timezone FROM devices WHERE branch_id = ? AND active = 1 AND timezone IS NOT NULL ORDER BY timezone_at DESC LIMIT 1', branch?.id)?.timezone)
    || config.timezone;
}

module.exports = { BR_ZONES, ZONE_CHOICES, clean, usable, forBranch };
