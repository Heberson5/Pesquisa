// Marca de quem desenvolveu o sistema — Sauberlich System. Fica fixa no código, fora das configurações
// (a identidade visual troca o nome e a logo da empresa, não esta marca): "Desenvolvido por" no menu do
// painel, no quiosque, nos e-mails e no relatório; o direito autoral nas telas de entrar. O teste
// tests/marca.test.js falha se ela for retirada de algum desses lugares.
const SAUBERLICH_CREDIT = 'Desenvolvido por Sauberlich System';
const sauberlichCopyright = (year = new Date().getFullYear()) => `© ${year} Sauberlich System · Todos os direitos reservados`;

module.exports = { SAUBERLICH_CREDIT, sauberlichCopyright };
