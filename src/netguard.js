'use strict';
// Endereços que o servidor pode chamar (webhook, servidor de e-mail): só IPs públicos da internet.
// Lista de blocos especiais (rede interna, loopback, link-local, multicast, NAT64, 6to4, Teredo…)
// conferida pelo próprio Node (net.BlockList) — sem comparação de texto que formas alternativas do IPv6 driblem.
const net = require('node:net');

const blocked = new net.BlockList();
for (const [addr, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(addr, prefix, 'ipv4');
// No IPv6, só a faixa global (2000::/3) é pública; dentro dela, ficam de fora os blocos especiais.
const global6 = new net.BlockList();
global6.addSubnet('2000::', 3, 'ipv6');
for (const [addr, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) blocked.addSubnet(addr, prefix, 'ipv6');

function isPublicIp(ip) {
  const s = String(ip || '').split('%')[0];
  if (net.isIPv4(s)) return !blocked.check(s, 'ipv4');
  if (!net.isIPv6(s)) return false;
  // IPv4 escrito como IPv6 (::ffff:10.0.0.1): vale a regra do IPv4.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  if (mapped) return isPublicIp(mapped[1]);
  return global6.check(s, 'ipv6') && !blocked.check(s, 'ipv6');
}

module.exports = { isPublicIp };
