/**
 * commitlint.config.js
 *
 * O histórico deste repositório já usa uma convenção própria e consistente
 * (checado em 149 de 150 commits recentes): "Área: descrição objetiva",
 * em português, com a área capitalizada (ex: "Catálogo: redesign do form
 * de busca", "Bot: respostas mais curtas + limite de 3 mensagens").
 *
 * Em vez de forçar o vocabulário em inglês do Conventional Commits padrão
 * (feat/fix/chore/docs/...), que quebraria quase todo o histórico existente
 * e não traria benefício real pra um time pequeno que já escreve mensagens
 * claras — este config mantém as regras estruturais úteis do
 * @commitlint/config-conventional (não pode ter assunto vazio, não pode
 * terminar com ponto, limite de tamanho da linha) e desliga só as duas
 * regras que exigiriam o vocabulário/estilo em inglês.
 */
module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Aceita qualquer prefixo de área (Catálogo, Bot, Dashboard, X2, ...),
    // não só a lista fixa do Conventional Commits (feat/fix/chore/...).
    "type-enum": [0],
    // Prefixos de área deste projeto são capitalizados ("Catálogo:", não
    // "catálogo:") — mantém a convenção real em vez de forçar lower-case.
    "type-case": [0],
    "header-max-length": [2, "always", 100],
  },
};
