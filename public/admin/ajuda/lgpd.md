Em **Configurações → Segurança e LGPD** ficam o 2FA obrigatório, os prazos de guarda, o aviso de privacidade e os pedidos dos clientes.

![Segurança e LGPD](img/config-lgpd.jpg)

## Acesso ao painel
Com **Exigir verificação em duas etapas** ligado, administradores e perfis que alteram usuários, permissões ou configurações precisam usar 2FA.

## Por quanto tempo guardar os dados
O sistema apaga sozinho, uma vez por dia, o que passar do prazo. O máximo é **10 anos**.
- **Notas e respostas de múltipla escolha**: sem prazo. Não têm dados pessoais e são a base dos relatórios.
- **Comentários escritos pelo cliente**: de 1 a 10 anos.
- **Contato do cliente** (nome, telefone e e-mail): de 1 a 10 anos.
- **Localização aproximada** (QR Code): depois do prazo, apaga o ponto no mapa e mantém só cidade, UF e região.
- **Registro de auditoria**: de 6 meses a 10 anos.

> Dica: a LGPD pede que dados pessoais fiquem guardados só pelo tempo necessário. Para os contatos, prefira 1 ou 2 anos. Acima de 2 anos, a tela mostra um aviso para você registrar o motivo no controle de tratamento de dados da empresa.

## Aviso de privacidade
Texto exibido no tablet e no QR Code antes do cliente deixar contato ou localização.

## Pedido do titular
Quando um cliente pedir acesso ou exclusão dos dados dele:
1. Informe o telefone ou o e-mail e clique em `Localizar`.
2. Use `Exportar dados (JSON)` para entregar uma cópia ou `Excluir dados` para apagar contato e comentários. As notas ficam, sem ligação com a pessoa.
