// Falhas de 14-16/11/2026: login do X2 preso no aviso "senha inicial". A mensagem final
// precisa apontar a causa certa em vez de "sessão expirada".
const { mensagemFalhaMenuLogistica } = require("../scripts/x2-estoque-export");

describe("mensagemFalhaMenuLogistica", () => {
  const estado = "url=https://x/login_form.jsp | links=5 | senha=4";
  const diag = ' | loginErro=[] | alertasX2=[] | tela=""';

  test("com aviso de senha inicial, orienta trocar a senha e atualizar o .env", () => {
    const msg = mensagemFalhaMenuLogistica({
      estado, diag, mensagensDoX2: ["alert: Você está usando a sua senha inicial. Por favor, troque a senha."],
    });
    expect(msg).toContain("senha inicial");
    expect(msg).toContain("X2_SENHA");
    expect(msg).not.toContain("provavelmente expirada");
  });

  test("sem o aviso, mantém a orientação antiga", () => {
    const msg = mensagemFalhaMenuLogistica({ estado, diag, mensagensDoX2: ["alert: usuário já logado"] });
    expect(msg).toContain("provavelmente expirada");
    expect(msg).toContain(estado);
  });

  test("aceita lista vazia ou ausente", () => {
    expect(mensagemFalhaMenuLogistica({ estado, diag, mensagensDoX2: [] })).toContain("Logística");
    expect(mensagemFalhaMenuLogistica({ estado, diag })).toContain("Logística");
  });
});
