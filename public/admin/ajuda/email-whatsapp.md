Em **Configurações → E-mail e WhatsApp** você liga o envio dos avisos.

![E-mail e WhatsApp](img/config-envios.jpg)

## E-mail (SMTP)
1. Escolha o provedor (Gmail, Microsoft 365, Locaweb...) ou preencha servidor e porta.
2. Informe usuário, senha e o remetente.
3. Clique em `Salvar e-mail` e depois em `Enviar e-mail de teste para mim`.

> Dica: no Gmail, use uma "Senha de app" (myaccount.google.com/apppasswords), não a senha normal.

## WhatsApp: escolha a forma de conexão
- **QR Code (número da empresa)**: você conecta um número como no WhatsApp Web. O texto das mensagens é livre e editável em [Modelos de mensagem](#/ajuda/modelos-mensagem).
- **API oficial da Meta**: exige conta comercial na Meta e um modelo de mensagem aprovado por ela.
- **Desligado**: os alertas saem só por e-mail.

## Conectar pelo QR Code
1. Escolha **QR Code (número da empresa)** e clique em `Gerar QR Code`.
2. No celular da empresa, abra o WhatsApp e toque em **⋮** (ou Configurações) → **Aparelhos conectados** → **Conectar um aparelho**.
3. Aponte a câmera para o QR Code da tela. O estado muda para **Conectado**.

O QR Code só aparece para quem tem a permissão "Conectar e desconectar o WhatsApp".

## Intervalo entre os envios
Os alertas saem **um por vez**. Antes de cada mensagem, o sistema sorteia uma pausa entre o mínimo e o máximo que você escolher (de 15 a 60 segundos). O primeiro aviso sai na hora. A **Fila do WhatsApp** mostra o horário de cada mensagem e a pausa sorteada.

## Quem recebe
Os números cadastrados em cada filial e o WhatsApp de cada pessoa que marcou o alerta em [Minha conta](#/ajuda/minha-conta). Um número repetido recebe uma vez só.

## Cuidados com o número
- Use um **chip só para os alertas**, não o número de atendimento.
- Peça para cada pessoa salvar o número e responder uma vez.
- Mandar só para a equipe, com pausas, deixa o risco de bloqueio bem baixo, mas não zero: o WhatsApp não autoriza oficialmente programas de terceiros.
- Se a conexão cair, os administradores recebem um e-mail. As mensagens esperam na fila por até 24 horas.
