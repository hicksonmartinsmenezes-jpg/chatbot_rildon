/**
 * Testes de unidade para utils/access-control — as regras que decidem quem
 * ACESSA e quem GERENCIA cada ticket. É segurança pura: uma regressão aqui
 * pode expor conversas de clientes ao atendente errado.
 *
 * Atenção ao modo do atendente:
 *  - Padrão (ATTENDANT_CONVERSATIONS_FULL_ACCESS ausente/"true"): atendente vê
 *    tudo, como admin.
 *  - Restrito ("false"): atendente só acessa ticket atribuído a ele (ou não
 *    atribuído do mesmo setor). É esse modo que exercita a lógica sensível.
 */
const ac = require("../src/utils/access-control");

const ENV_KEY = "ATTENDANT_CONVERSATIONS_FULL_ACCESS";
const ORIGINAL = process.env[ENV_KEY];

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL;
});

// Coloca o atendente no modo restrito, onde as regras de atribuição valem.
function modoRestrito() { process.env[ENV_KEY] = "false"; }
// Modo padrão: acesso total do atendente.
function modoPadrao() { delete process.env[ENV_KEY]; }

const admin      = { id: "1", perfil: "admin" };
const supervisor = { id: "2", perfil: "supervisor" };
const api        = { id: "3", perfil: "api" };
const atendente  = { id: "10", perfil: "atendente", sector: "vendas" };

describe("isPrivileged", () => {
  test("admin, supervisor e api são privilegiados", () => {
    expect(ac.isPrivileged(admin)).toBe(true);
    expect(ac.isPrivileged(supervisor)).toBe(true);
    expect(ac.isPrivileged(api)).toBe(true);
  });

  test("atendente e usuários inválidos não são privilegiados", () => {
    expect(ac.isPrivileged(atendente)).toBe(false);
    expect(ac.isPrivileged(null)).toBe(false);
    expect(ac.isPrivileged({})).toBe(false);
  });

  test("é case-insensitive", () => {
    expect(ac.isPrivileged({ perfil: "ADMIN" })).toBe(true);
    expect(ac.isPrivileged({ perfil: "Supervisor" })).toBe(true);
  });
});

describe("canUseFullConversationPanel", () => {
  test("privilegiado sempre pode", () => {
    expect(ac.canUseFullConversationPanel(admin)).toBe(true);
  });

  test("atendente pode no modo padrão", () => {
    modoPadrao();
    expect(ac.canUseFullConversationPanel(atendente)).toBe(true);
  });

  test("atendente NÃO pode no modo restrito", () => {
    modoRestrito();
    expect(ac.canUseFullConversationPanel(atendente)).toBe(false);
  });

  test("usuário nulo nunca pode", () => {
    expect(ac.canUseFullConversationPanel(null)).toBe(false);
  });
});

describe("canAccessTicket — modo restrito (regras de atribuição)", () => {
  beforeEach(modoRestrito);

  test("privilegiado acessa qualquer ticket, mesmo de outro atendente", () => {
    const ticket = { assignedTo: "999", sector: "financeiro" };
    expect(ac.canAccessTicket(admin, ticket)).toBe(true);
  });

  test("atendente acessa ticket atribuído a ele", () => {
    const ticket = { assignedTo: "10", sector: "vendas" };
    expect(ac.canAccessTicket(atendente, ticket)).toBe(true);
  });

  test("aceita tanto assignedTo (camelCase) quanto assigned_to (snake_case)", () => {
    expect(ac.canAccessTicket(atendente, { assigned_to: "10", sector: "vendas" })).toBe(true);
  });

  test("atendente NÃO acessa ticket de outro atendente", () => {
    const ticket = { assignedTo: "999", sector: "vendas" };
    expect(ac.canAccessTicket(atendente, ticket)).toBe(false);
  });

  test("ticket não atribuído do mesmo setor: só com allowUnassigned", () => {
    const ticket = { assignedTo: null, sector: "vendas" };
    expect(ac.canAccessTicket(atendente, ticket)).toBe(false);
    expect(ac.canAccessTicket(atendente, ticket, { allowUnassigned: true })).toBe(true);
  });

  test("ticket não atribuído de OUTRO setor: negado mesmo com allowUnassigned", () => {
    const ticket = { assignedTo: null, sector: "financeiro" };
    expect(ac.canAccessTicket(atendente, ticket, { allowUnassigned: true })).toBe(false);
  });

  test("user ou ticket ausente → negado", () => {
    expect(ac.canAccessTicket(null, { sector: "vendas" })).toBe(false);
    expect(ac.canAccessTicket(atendente, null)).toBe(false);
  });
});

describe("canAccessTicket — modo padrão (acesso total do atendente)", () => {
  beforeEach(modoPadrao);

  test("atendente acessa ticket de outro atendente e de outro setor", () => {
    const ticket = { assignedTo: "999", sector: "financeiro" };
    expect(ac.canAccessTicket(atendente, ticket)).toBe(true);
  });
});

describe("canManageTicket — mais estrito que acessar", () => {
  beforeEach(modoRestrito);

  test("privilegiado gerencia qualquer ticket", () => {
    expect(ac.canManageTicket(supervisor, { assignedTo: "999" })).toBe(true);
  });

  test("atendente gerencia apenas ticket atribuído a ele", () => {
    expect(ac.canManageTicket(atendente, { assignedTo: "10" })).toBe(true);
    expect(ac.canManageTicket(atendente, { assignedTo: "999" })).toBe(false);
  });

  // BUG CORRIGIDO: esta suíte descrevia canManageTicket como "mais estrito"
  // que canAccessTicket por não ter allowUnassigned — mas um ticket
  // "Pendente" normalmente está SEM atribuição (assignedTo null), e sem
  // essa allowance NENHUM atendente em modo restrito conseguia fechar/
  // mudar status de um ticket ainda não assumido no próprio setor (relatado
  // pelo usuário como "sem permissão" ao clicar Fechar em Pendentes).
  // canManageTicket agora espelha a mesma regra "ticket livre + mesmo
  // setor" que já existia em canAccessTicket.
  test("atendente gerencia ticket não atribuído do seu próprio setor", () => {
    const ticket = { assignedTo: null, sector: "vendas" };
    expect(ac.canManageTicket(atendente, ticket)).toBe(true);
  });

  test("atendente NÃO gerencia ticket não atribuído de OUTRO setor", () => {
    const ticket = { assignedTo: null, sector: "financeiro" };
    expect(ac.canManageTicket(atendente, ticket)).toBe(false);
  });
});

describe("canSeeSensitiveDashboard", () => {
  test("só privilegiados", () => {
    expect(ac.canSeeSensitiveDashboard(admin)).toBe(true);
    expect(ac.canSeeSensitiveDashboard(atendente)).toBe(false);
  });
});

describe("middleware requirePrivileged", () => {
  function mockRes() {
    const res = {};
    res.status = jest.fn(() => res);
    res.json = jest.fn(() => res);
    return res;
  }

  test("sem sessão → 401 e não chama next", () => {
    const res = mockRes();
    const next = jest.fn();
    ac.requirePrivileged({}, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test("usuário não privilegiado → 403 e não chama next", () => {
    const res = mockRes();
    const next = jest.fn();
    ac.requirePrivileged({ user: atendente }, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test("privilegiado → chama next sem erro", () => {
    const res = mockRes();
    const next = jest.fn();
    ac.requirePrivileged({ user: admin }, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe("middleware requireProfiles", () => {
  function mockRes() {
    const res = {};
    res.status = jest.fn(() => res);
    res.json = jest.fn(() => res);
    return res;
  }

  test("perfil na lista → next", () => {
    const res = mockRes();
    const next = jest.fn();
    ac.requireProfiles("admin", "supervisor")({ user: admin }, res, next);
    expect(next).toHaveBeenCalled();
  });

  test("perfil fora da lista → 403", () => {
    const res = mockRes();
    const next = jest.fn();
    ac.requireProfiles("admin")({ user: atendente }, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
