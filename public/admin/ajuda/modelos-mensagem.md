Em **Configurações → Modelos de mensagem** você edita o texto de cada envio, no e-mail e no WhatsApp, e vê como ele vai chegar.

![Modelo de WhatsApp com prévia](img/config-modelos-whatsapp.jpg)

## Tipos de envio
- **Cliente insatisfeito** (e-mail e WhatsApp)
- **Tablet sem sinal** (e-mail e WhatsApp)
- **Relatório semanal** (e-mail)
- **Redefinição de senha** (e-mail)
- **Mensagem de teste** (e-mail e WhatsApp)

## Editar um texto
1. Escolha o tipo de envio e a guia **E-mail** ou **WhatsApp**.
2. Edite os campos. No e-mail: assunto, título, texto, texto do botão e rodapé. No WhatsApp: o texto da mensagem.
3. Clique numa variável, como `{filial}` ou `{nota}`, para inserir no ponto em que está o cursor.
4. Confira a **Prévia** ao lado, montada com dados de exemplo.
5. Clique em `Salvar modelo`. Os próximos envios já usam o novo texto.

![Modelo de e-mail com prévia](img/config-modelos-email.jpg)

## Bom saber
- No WhatsApp, use `*negrito*`, `_itálico_` e `~riscado~` (ou os botões B, I e S).
- Uma variável que não existe naquele tipo de envio é recusada ao salvar.
- No e-mail, a tabela com os dados (filial, nota, comentários e contato) entra sozinha, abaixo do texto.
- `Restaurar texto padrão` volta ao texto original.
- `Enviar teste para mim` manda o modelo salvo para o seu e-mail ou para o seu WhatsApp de Minha conta.
- Na API oficial da Meta, vale o modelo aprovado lá. O texto livre vale para o WhatsApp conectado pelo QR Code.
