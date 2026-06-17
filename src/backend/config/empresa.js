/**
 * empresa.js — Base de conhecimento da Rildon Eletropeças
 *
 * Edite este arquivo para treinar o bot com informações da empresa.
 * As alterações são carregadas automaticamente no próximo restart do servidor.
 */

const EMPRESA = {

  nome:      "Rildon Eletropeças",
  descricao: "Empresa especializada em peças e materiais elétricos AUTOMOTIVOS, atendendo linha leve, linha pesada (caminhões/ônibus) e linha agrícola. Fundada em 1991, com mais de 30 anos de experiência e referência em Sergipe.",

  // ── Localização ──────────────────────────────────────────────────────────────
  endereco:    "Avenida Chanceler Osvaldo Aranha, 151, Novo Paraíso",
  cidade:      "Aracaju - SE",
  como_chegar: "",

  // ── Contato ──────────────────────────────────────────────────────────────────
  telefone: "(79) 99135-3569",
  email:    "vendas@rildoneletro.com.br",
  site:     "https://rildoneletro.com.br/",

  // ── Horário de atendimento ───────────────────────────────────────────────────
  horario: {
    semana:  "Segunda a sexta: 07:50 às 17:50",
    sabado:  "Sábado: 08:00 às 12:00",
    domingo: "Domingo: fechado",
  },

  // ── Formas de pagamento ──────────────────────────────────────────────────────
  pagamento: [
    "Dinheiro",
    "PIX",
    "Cartão de débito",
    "Cartão de crédito (parcelamento — consulte condições)",
    "Boleto bancário (prazo de compensação 1-2 dias úteis)",
  ],

  // ── Produtos principais ──────────────────────────────────────────────────────
  produtos: [
    "Alternadores completos e peças (rotor, estator, regulador de voltagem, retificador)",
    "Motores de partida completos e peças (impulsor, automático, induzido, coletor)",
    "Lâmpadas automotivas (halógenas, LED, OSRAM, Gauss — 12V e 24V)",
    "Fusíveis automotivos (lâmina, mini lâmina, maxi lâmina, mega, louça, vidro)",
    "Velas de ignição e cabos de vela",
    "Bobinas de ignição e módulos eletrônicos",
    "Sensores automotivos (temperatura, rotação, posição, nível, ABS, oxigênio)",
    "Faróis, lanternas, lentes e carcaças",
    "Buzinas (caracol e paquerinha)",
    "Palhetas do limpador de parabrisa",
    "Cabos e fios automotivos, cabos de bateria, chicotes elétricos",
    "Interruptores e chaves automotivas (seta, luz, limpador, vidro elétrico, ignição)",
    "Relés, disjuntores térmicos e conectores",
    "Bombas de combustível e componentes do sistema de combustível",
    "Motores elétricos auxiliares (ventilador, vidro elétrico, limpador)",
    "Baterias e acessórios (terminais, garras, ponteiras)",
    "Alarmes, bloqueadores e acessórios de segurança",
    "Kits de reboque e tomadas elétricas para reboque",
    "Discos para tacógrafo",
    "Produtos químicos automotivos (água desmineralizada, adesivos, selantes)",
    "Peças de mecânica geral: filtros (ar, óleo, combustível), pastilhas e lonas de freio, componentes de suspensão e direção",
  ],

  servicos: [
    "Consultoria técnica em elétrica automotiva",
    "Orçamentos personalizados por WhatsApp",
    "Atendimento presencial na loja e online",
    "Venda para eletricistas, frotas e mecânicas com condições especiais",
  ],

  // ── Marcas parceiras ─────────────────────────────────────────────────────────
  marcas: [
    "OSRAM", "Gauss", "ZM", "SEG Automotive", "Kostal",
    "Bosch", "Denso", "Wega", "Delco Remy", "Lucas",
    "MTE", "ASX", "Olimpic", "Bobinauto", "Prima Parts",
    "Fiamm", "Neolux", "Contactsul", "TC Chicotes", "Ikro",
    "Marflex", "DNI", "Cemak", "Eletricway", "KTR", "AMS",
  ],

  // ── Políticas ────────────────────────────────────────────────────────────────
  politica_troca:  "Troca em até 7 dias para produtos com defeito, com nota fiscal e na embalagem original. Produtos elétricos instalados não podem ser trocados.",
  prazo_entrega:   "Retirada na loja disponível no mesmo dia. Entrega mediante consulta de disponibilidade e localização.",
  prazo_orcamento: "Orçamentos respondidos em até 1 dia útil via WhatsApp.",

  // ── Perguntas frequentes ─────────────────────────────────────────────────────
  faq: [
    {
      pergunta: "Vocês têm peças para caminhão?",
      resposta: "Sim! Atendemos linha pesada (MB, Volvo, Scania, Iveco, VW Truck) e linha agrícola também.",
    },
    {
      pergunta: "Vocês fazem entrega?",
      resposta: "A retirada é disponível na loja no mesmo dia. Para entregas, consulte nossa equipe pelo WhatsApp.",
    },
    {
      pergunta: "Emitem nota fiscal?",
      resposta: "Sim, emitimos NF-e para todas as compras. Para NF com CNPJ, informe os dados no ato da compra.",
    },
    {
      pergunta: "Têm peças para linha agrícola?",
      resposta: "Sim! Temos peças para tratores e máquinas agrícolas — motores de partida, alternadores, fusíveis e mais.",
    },
    {
      pergunta: "Atendem pessoa jurídica / frota?",
      resposta: "Sim! Para compras em quantidade ou frota, consulte nossa equipe para condições especiais.",
    },
  ],

  // ── Instruções de comportamento do bot ──────────────────────────────────────
  instrucoes: [
    "A loja é especializada em PEÇAS ELÉTRICAS AUTOMOTIVAS e também trabalha com peças de mecânica geral (filtros, freios, suspensão, direção). Não vendemos materiais elétricos residenciais/industriais como disjuntores de painel, tomadas NBR ou eletrodutos.",
    "Quando o cliente perguntar sobre uma peça automotiva que a loja provavelmente tem, incentive-o a solicitar um orçamento (opção 1 do menu).",
    "Nunca invente preços — sempre oriente a solicitar um orçamento formal.",
    "Se não souber responder, oriente o cliente a solicitar um orçamento (opção 1) ou diga que um atendente entrará em contato.",
    "Use linguagem simples e informal, como um atendente experiente da loja.",
    "Quando o cliente demonstrar intenção de compra, incentive-o a solicitar um orçamento.",
    "Não ofereça informações que o cliente não pediu (endereço, horário, etc.).",
  ],
};

module.exports = EMPRESA;
