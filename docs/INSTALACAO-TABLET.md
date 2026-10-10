# Guia de instalação do tablet (para a equipe da filial)

Tempo estimado: 15 minutos por tablet. Você vai precisar do **código de 8 letras** gerado no painel
(Tablets → Novo tablet), que vale por 15 minutos.

## Antes de começar
- Tablet com Android 9+ ou iPad com iPadOS 15+, carregado e conectado ao Wi-Fi da loja.
- Suporte/pedestal fixo e carregador ligado na tomada (o tablet fica sempre ligado).
- Endereço da pesquisa: **https://pesquisa.sauberlich.com.br/kiosk/**

---

## Android (recomendado: Fully Kiosk Browser)
O Fully Kiosk impede que o cliente saia da pesquisa, reinicia sozinho se travar e mantém a tela ligada.

1. Na Play Store, instale **Fully Kiosk Browser & Lockdown** (versão Plus recomendada para bloquear botões).
2. Abra o Fully → **Settings**:
   - **Web Content Settings → Start URL**: `https://pesquisa.sauberlich.com.br/kiosk/`
   - **Device Management → Keep Screen On**: ligado
   - **Device Management → Launch on Boot**: ligado
   - **Kiosk Mode → Enable Kiosk Mode**: ligado e defina um **PIN** (anote em local seguro, longe do cliente)
   - **Kiosk Mode → Disable Status Bar / Home / Recent Apps**: ligados
   - **Web Auto Reload → Reload on Network Reconnect**: ligado
3. Volte à tela inicial do Fully: aparece **"Ativar tablet"**. Digite o código de 8 letras do painel.
4. Pronto: a tela "Toque para começar" aparece. No painel, o tablet fica **Online**.

### Alternativa sem aplicativo (Fixar tela)
1. Abra o Chrome em `https://pesquisa.sauberlich.com.br/kiosk/` → menu ⋮ → **Adicionar à tela inicial**.
2. Abra pelo ícone criado (abre em tela cheia) e ative o tablet com o código.
3. Em **Configurações → Segurança → Fixar app** (ou "Fixação de tela"), ative e exija PIN para desafixar.
4. Abra a visão de apps recentes, toque no ícone do app da pesquisa → **Fixar**.

## iPad (Acesso Guiado)
1. No Safari, abra `https://pesquisa.sauberlich.com.br/kiosk/` → Compartilhar → **Adicionar à Tela de Início**.
2. Abra pelo ícone criado e ative o tablet com o código.
3. **Ajustes → Acessibilidade → Acesso Guiado**: ative, defina um **código** e ligue "Atalho de Acessibilidade".
4. **Ajustes → Tela e Brilho → Bloqueio Automático**: **Nunca**.
5. Com a pesquisa aberta, clique 3 vezes no botão lateral/Home → **Iniciar** o Acesso Guiado.
   Para sair: clique 3 vezes e digite o código.

---

## Dia a dia
- **Sem internet?** O tablet continua coletando; as respostas são enviadas sozinhas quando a conexão volta.
- **Fora do horário** cadastrado da filial, aparece uma tela de descanso ("Estamos fechados").
- **Menu técnico escondido:** 7 toques rápidos no canto superior esquerdo mostram o nome do tablet, a filial e
  quantas respostas aguardam envio.
- **Tablet perdido ou roubado:** no painel, Tablets → **Revogar**. Ele para de funcionar na hora.
- **Trocar de aparelho:** no painel, Tablets → **Novo código** e ative o tablet novo.
- **Alerta "tablet sem sinal":** verifique tomada, Wi-Fi e se a pesquisa está aberta na tela.

## Tela sempre acesa e economia de bateria

O próprio sistema mantém a tela acesa (Wake Lock; em iPad antigo usa um vídeo mudo minúsculo como reserva, que só começa depois do primeiro toque) e, depois de um tempo sem toque, **escurece a tela** para poupar bateria. Um toque volta ao brilho normal na hora.

Ajuste em **Configurações → Alertas → Tela do tablet e bateria** (tempo para escurecer e nível de escurecimento). A mudança chega ao tablet em até 1 minuto.

- **Android com Fully Kiosk:** ligue *Other Settings → Enable JavaScript Interface (PLUS)* para o sistema reduzir o brilho de verdade do aparelho.
- **iPad / demais:** uma camada escura reduz a claridade (em tela OLED isso poupa bateria). Deixe também *Bloqueio Automático = Nunca* e, de preferência, o tablet na tomada em horário de funcionamento.
- Um navegador não consegue alterar o brilho do aparelho sozinho; por isso o escurecimento é feito dentro da página.

## Fuso horário (filiais em fusos diferentes)

O horário de funcionamento vale no fuso da filial. Em **Filiais → Editar → Fuso horário da filial** há duas formas:

- **Automático (padrão):** o tablet informa o fuso configurado nele. O servidor usa o **relógio do próprio servidor** nesse fuso, então um relógio errado no tablet não atrapalha — só um fuso errado.
- **Fixo:** escolha Brasília, Fernando de Noronha, Manaus/Mato Grosso ou Rio Branco. Vale mais que o do tablet.

Se o tablet informar um fuso fora do Brasil ou inválido, vale o fuso da empresa (`TZ_EMPRESA`, padrão `America/Sao_Paulo`). No iPad deixe *Ajustes → Geral → Data e Hora → Ajustar Automaticamente*; no Android, o fuso do sistema. O fuso também é usado nas campanhas agendadas da filial, no alerta de tablet sem sinal e na hora dos e-mails de alerta. Em **Tablets** você vê o fuso que cada aparelho informou.
