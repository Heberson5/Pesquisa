Em **Perfis e permissões** você define, menu por menu, o que cada perfil pode **Ver**, **Incluir**, **Editar** e **Excluir**, além de ações específicas.

![Perfis e permissões](img/permissoes.jpg)

## Perfis que já vêm prontos
- **Administrador**: acesso total. É fixo e não pode ser alterado nem excluído.
- **Gestor de filial**: vê os números e trata os casos das filiais ligadas a ele. Pode ser ajustado.

## Criar um perfil
1. Clique em `Novo perfil` (ou `Duplicar perfil` para partir de um existente).
2. Dê um nome e, se quiser, uma descrição (ex.: "Diretoria que só acompanha os números").
3. Escolha quais filiais o perfil enxerga: **Todas as filiais** ou **Só as filiais da pessoa**.
4. Marque as permissões de cada menu e as ações específicas, como "Exportar CSV" ou "Ver contato do cliente".
5. Clique em `Salvar perfil`. Quem usa esse perfil já passa a ter as novas permissões, sem precisar entrar de novo.

## Como as caixas funcionam
- Sem **Ver**, o menu some da barra lateral e o servidor recusa o acesso, mesmo por link direto.
- Marcar Incluir, Editar, Excluir ou uma ação específica marca **Ver** junto.
- Um traço (—) quer dizer que a ação não existe naquele menu.

![Permissões no celular](img/celular-permissoes.jpg)

## Regras de segurança
- Ninguém cria ou altera um perfil com mais acesso que o seu, nem dá a alguém um perfil maior que o seu.
- Perfis que alteram usuários, permissões ou configurações precisam de 2FA, se a empresa exigir.
- Toda mudança fica na [Auditoria](#/ajuda/auditoria) com o que entrou e o que saiu.
- Um perfil em uso não pode ser excluído: troque o perfil das pessoas antes.
