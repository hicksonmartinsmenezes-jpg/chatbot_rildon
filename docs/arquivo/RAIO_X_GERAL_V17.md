# Raio-X Geral do Projeto — V17 (2026-07-20)

Avaliação de acompanhamento do bot Rildon Eletropeças (Node.js/Express/Baileys/PostgreSQL + painel vanilla JS), três dias depois do V16 (2026-07-17). No intervalo entraram duas features novas (análise de foto de peça via IA de visão, transcrição de áudio via Groq Whisper), o investimento de teste recomendado no V16 (`message-utils.js` e `validators.js`) foi feito, e duas rodadas de teste ao vivo (painel + WhatsApp simultâneos) encontraram e corrigiram 4 bugs reais em produção. Esta avaliação foca no que mudou, não repete achados do V16 que continuam válidos.

## O que mudou desde o V16

**Cobertura de teste**: passou de 60,7%/52,8% (statements/branches) para **68,3%/59,9%**. `message-utils.js` foi de 2% para 100%, `validators.js` de 31% para 95%. Suíte cresceu de 396 para **524 testes em 44 arquivos**, todos passando, mais o `test-flow.js` (simulador de conversa) em **110/110 cenários**. `npm audit --audit-level=high`: 0 vulnerabilidades. Lint: 0 erros, 4 avisos cosméticos de variável não usada (nenhum novo, mesmo status do V16).

**Features novas**: extração de descrição de peça a partir de foto (visão, Gemini/Anthropic) e transcrição de áudio (Groq Whisper) — ambas com teste unitário e de integração dedicado, e testadas manualmente ao vivo com arquivo real antes do commit.

**Bugs reais encontrados e corrigidos em teste ao vivo (2026-07-20)**, todos com teste de regressão e verificados após restart do processo:

1. Menu principal com pontuação natural ("1.", "2)", "3!") caía no fallback de IA em vez de rotear direto — cliente perdia a navegação por número.
2. Confirmação de orçamento ("sim"/"1" com pontuação) tinha o mesmo problema — extensão do mesmo padrão de correção.
3. `vendas.flow.js` só verificava `session.produtoInicial` para pular a pergunta "qual peça você precisa?", mas o caminho de confirmação de orçamento em `main.flow.js` só grava `session.pecaInicial` — cliente que já tinha dito a peça era perguntado de novo.
4. **O mais grave**: dedup por conteúdo em `dedup.js` usava janela de 8s sem tamanho mínimo de mensagem — um cliente respondendo "2" duas vezes em poucos segundos para perguntas *diferentes* (navegação normal de menu numerado) tinha a segunda mensagem **completamente ignorada**, sem resposta nem fallback. Corrigido: janela reduzida para 2s e mensagens curtas (<10 caracteres — exatamente os dígitos de menu, "sim", "0") excluídas deste dedup. A dedup primária por ID de mensagem do Baileys continua intacta e é quem de fato pega duplicata real.

Todos os 4 fixes foram validados ao vivo depois do restart do processo — não é só teste automatizado, é comportamento confirmado em produção.

## O que continua igual (válido desde o V16)

Arquitetura, segurança (2FA, rate limiting por feature, sessão com cookie seguro, SQL sempre parametrizado, LGPD), indexação de banco e paginação seguem no mesmo estado — sem achados novos nessas frentes. `bcrypt` com 10 rounds continua coerente com a decisão já tomada de PIN de 4 dígitos. As 9 rotas sem controller dedicado continuam como inconsistência de padrão, não urgente.

## Prioridades recomendadas

Nenhum item é bloqueante — o projeto está estável e em produção, com uma disciplina de teste-ao-vivo-antes-de-declarar-corrigido que está pegando bugs reais que testes automatizados sozinhos não pegariam (o bug #4 é o exemplo mais claro: só apareceu simulando dois clientes de verdade digitando ao mesmo tempo).

1. `src/config/whatsapp.js` continua com cobertura baixa (47% agora, era 17% no V16 — melhorou como efeito colateral, mas ainda é o maior arquivo do projeto depois de `main.flow.js` e o de maior superfície de risco). Não é fácil de testar sem WhatsApp real, mas é onde os bugs #3 e #4 desta rodada moravam — vale considerar extrair mais lógica pura (como já foi feito com `dedup.js`, `contacts.js`, `message-utils.js`) para módulos testáveis isoladamente.
2. `dedup.js` em si só tem 37% de cobertura — o arquivo do bug mais grave encontrado nesta rodada tem teste dedicado bom (`tests/dedup.test.js`), mas o restante do módulo (camada de banco, limpeza periódica) ainda não.
3. Itens cosméticos do V16 (3 avisos de lint, pasta `uploads/profile` vazia) seguem pendentes — gratuitos, zero risco.
4. Considerar formalizar a rotina de teste-ao-vivo dual-role (painel + WhatsApp simultâneos) como checklist recorrente antes de cada deploy maior — foi o que achou os 4 bugs reais desta rodada, nenhum deles apareceu nos 110 cenários do `test-flow.js` nem nos 524 testes Jest.

Resumo pro dono da loja: o bot está mais confiável hoje do que há três dias. O bug mais sério (cliente sendo silenciosamente ignorado ao navegar o menu numerado normalmente) foi encontrado e corrigido antes de virar reclamação de cliente real — e a suíte de teste cresceu junto, então a chance de o mesmo tipo de problema voltar sem avisar é menor.
