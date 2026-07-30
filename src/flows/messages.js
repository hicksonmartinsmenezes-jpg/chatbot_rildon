// messages.js — Centralização de todas as mensagens do chatbot

const MSG = {
  VOLTAR_MENU:     "\n_Digite *0* para voltar ao menu._",
  NAO_INFORMADO:   "Não informado",
  CPF_INVALIDO:    "⚠️ CPF inválido. Por favor, informe um *CPF válido* (somente números).",
  NOME_INVALIDO:   "⚠️ Por favor, informe seu nome. _Ex: João Silva ou Marcos_",
  DESCRICAO_CURTA: (min) => `⚠️ Por favor, descreva com mais detalhes (mínimo ${min} caracteres).`,
  ESCAPE_DICA:     "\n_Digite *0* a qualquer momento para voltar ao menu._",

  vendas: {
    MENU: () =>
      "🛒 *Orçamento / Atendimento*\n\n" +
      "Como posso te ajudar?\n\n" +
      "1 - Solicitar orçamento de peça\n" +
      "0 - Voltar ao menu principal",

    PEDIR_NOME:     "📝 Para solicitar orçamento, informe seu *nome completo*:",
    // Pedido do usuário (2026-07-28): reduzir o "ping-pong" de perguntas —
    // antes pedia só o veículo aqui e a peça na etapa seguinte, sempre em
    // 2 mensagens. Passou a convidar a responder os dois juntos numa
    // mensagem só (ex: "Uno 2015, alternador"). A lógica de separar
    // veículo/peça de uma resposta combinada já existia (vendas.flow.js,
    // split por ano ou por quebra de linha) — só era usada como atalho
    // ocasional; virou o caminho principal. Ela já tem fallback seguro:
    // se não conseguir separar com confiança, pergunta a peça de novo
    // separadamente na próxima etapa, sem perder nem confundir o que o
    // cliente já disse.
    // Pedido do usuário (2026-07-29): remover o convite "pode mandar tudo
    // numa mensagem só" + a dica "*pular*" do texto exibido — só a
    // pergunta do veículo permanece visível. A palavra "pular" continua
    // funcionando normalmente se o cliente digitar por conta própria (ver
    // vendas.flow.js, step aguardando_veiculo) — só a dica na mensagem
    // que saiu.
    PEDIR_VEICULO:  "🚗 Me diga o *veículo* _(marca, modelo e ano)_",
    PEDIR_ORCAMENTO: "🔧 Qual *peça* você precisa?",

    // Pedido do usuário: quando o cliente só faz uma pergunta de
    // disponibilidade ("tem X pra Y?"), em vez de despejar o menu
    // completo (1-4), pergunta direto se ele quer o orçamento — mais
    // natural que forçar o cliente a escolher "1" de novo depois de já
    // ter perguntado sobre a peça.
    CONFIRMAR_ORCAMENTO: "Deseja que eu já registre esse orçamento? Digite *sim* para confirmar ou *0* para voltar ao menu.",

    ORCAMENTO_SOLICITADO: (ticket) => {
      // BUG CORRIGIDO (achado em sessão de testes ao vivo, 2026-07-29 —
      // persona que digitou "pular" no veículo): quando o cliente já tem
      // ticket aberto no dia, ticketRepository.prependDescription empilha
      // cada novo pedido no TOPO da description, separado por "\n---\n" +
      // "(pedido anterior) " antes do texto antigo — a description inteira
      // acumula TODOS os pedidos do dia. O regex de veículo/produto rodava
      // sobre essa string inteira; se o pedido ATUAL não tinha veículo
      // (cliente pulou), o /Veículo:\s*([^|]+)/ sem "g" caía pro PRÓXIMO
      // "Veículo:" que aparecesse — de um pedido anterior — e a confirmação
      // mostrava um veículo errado (ex: "Hilux 2015" de um pedido passado,
      // pra um item novo de "correia dentada" sem veículo nenhum). Fix:
      // isolar só o primeiro segmento (antes do separador "\n---\n") —
      // é sempre o pedido que acabou de ser registrado — e rodar os regex
      // só nele.
      const segmentoAtual = (ticket.description || "").split(/\n---\n/)[0];
      const veiculoMatch = segmentoAtual.match(/Veículo:\s*([^|]+)/);
      // BUG CORRIGIDO (relatado pelo usuário — caso V. Hugo, orçamento com
      // vários itens em linhas separadas: "8 Corujinhas...;\n8 conectores...;
      // \n1 multímetro;\n10m de conduíte..."): "." não casa quebra de linha
      // por padrão, então /Produto:\s*(.+)/ só capturava até o primeiro \n —
      // o ticket.description gravado no banco SEMPRE teve o texto completo
      // (vendas.flow.js._finalizarOrcamento salva produtoTexto inteiro,
      // sem truncar), só a MENSAGEM DE CONFIRMAÇÃO exibida ao cliente/painel
      // cortava os itens depois do primeiro. [\s\S]+ casa qualquer caractere
      // (inclusive quebra de linha), preservando a lista inteira dentro do
      // segmento atual (o "\n---\n" acima já corta antes de qualquer pedido
      // anterior, então isso continua pegando a lista inteira do pedido novo).
      const pecaMatch    = segmentoAtual.match(/Produto:\s*([\s\S]+)/);
      const veiculo      = veiculoMatch ? veiculoMatch[1].trim() : null;
      const peca         = pecaMatch    ? pecaMatch[1].trim()    : segmentoAtual;

      return (
        `✅ *Orçamento registrado!*\n\n` +
        `👤 ${ticket.customerName} — 🎫 *#${ticket.protocolo}*\n` +
        (veiculo ? `🚗 ${veiculo}\n` : "") +
        `🔧 ${peca}\n\n` +
        `Em breve nosso consultor entrará em contato. _Digite *0* para o menu._`
      );
    },

    CONSULTOR: (ticket) =>
      `👤 Um atendente entrará em contato em breve!\n` +
      `🎫 Protocolo: *#${ticket.protocolo}*\n\n` +
      `_Digite *0* para o menu._`,
  },

  // "crediario" removido (2026-07-24, decisão do usuário): tinha um fluxo
  // próprio (solicitar/consultar, coletando nome+CPF+motivo). Descontinuado
  // — quem pede crediário agora é direcionado pro telefone direto do setor
  // (ver outrosContatos.LISTA logo abaixo), igual Garantia/RH/Ouvidoria.

  // Pedido do usuário (2026-07-21): o antigo fluxo "gestao" (opção 3 do menu,
  // "Falar com a Equipe") pedia nome + motivo e criava um ticket pra alguém
  // da gestão responder depois. Decisão deliberada de substituir por uma
  // lista estática de contatos diretos — o cliente liga direto pro setor
  // certo, sem passar pelo bot/ticket. Não é mais um fluxo com etapas, só
  // uma mensagem informativa.
  outrosContatos: {
    LISTA: () =>
      "📞 *Outros Contatos*\n\n" +
      "Fale direto com o setor responsável:\n\n" +
      "🧑‍💼 Recursos Humanos / DP: (79) 9152-0145\n" +
      "💳 Crediário: (79) 9135-2723\n" +
      "🛠️ Garantia: (79) 9199-1922\n" +
      "📢 Ouvidoria: (79) 9180-0035\n\n" +
      "_Digite *0* para voltar ao menu._",
  },

  main: {
    PEDIR_MOTIVO_ATENDENTE:
      "💬 Certo! Para agilizar seu atendimento, descreva brevemente o que precisa:\n" +
      "_Ex: Quero orçamento de alternador, Dúvida sobre um pedido..._\n\n" +
      "_Digite *0* para voltar ao menu._",

    ATENDENTE_HUMANO: (ticket) =>
      "👤 *Falar com Atendente*\n\n" +
      "Sua solicitação foi registrada!\n\n" +
      `🎫 Protocolo: *#${ticket.protocolo}*\n` +
      "🕐 Um atendente entrará em contato em breve.\n\n" +
      "Horário: Seg–Sex 07:50–17:50 | Sáb 08:00–12:00\n\n" +
      "Posso ajudar com mais alguma coisa? Digite *0* para o menu.",
  },
};

module.exports = MSG;
