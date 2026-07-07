/**
 * Testes de twoFactor.service — setup/confirmação de TOTP e verificação do
 * desafio de login (código do app autenticador OU backup code). Pool e
 * repositório são mockados; o segredo/código TOTP em si usa o otplib real
 * (authenticator.generate) para gerar um código válido "ao vivo" nos testes,
 * em vez de hardcoded, já que um código de 30s fixo ficaria expirado.
 */
const { authenticator } = require("otplib");

jest.mock("../src/database/postgres", () => ({ query: jest.fn() }));
jest.mock("../src/repositories/user.repository", () => ({
  findById: jest.fn(),
  setTotpPendingSecret: jest.fn(),
  enableTotp: jest.fn(),
  disableTotp: jest.fn(),
  updateBackupCodes: jest.fn()
}));

const pool = require("../src/database/postgres");
const userRepository = require("../src/repositories/user.repository");
const twoFactorService = require("../src/services/twoFactor.service");

describe("twoFactor.service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("setup", () => {
    test("gera segredo pendente e QR code (data URL)", async () => {
      const { secret, qrCodeDataUrl } = await twoFactorService.setup("user-1", "joao");

      expect(secret).toEqual(expect.any(String));
      expect(secret.length).toBeGreaterThan(10);
      expect(qrCodeDataUrl).toMatch(/^data:image\//);
      expect(userRepository.setTotpPendingSecret).toHaveBeenCalledWith("user-1", secret);
    });
  });

  describe("confirmSetup", () => {
    test("rejeita se não há setup pendente", async () => {
      userRepository.findById.mockResolvedValue({ id: "user-1", totpPendingSecret: null });

      await expect(twoFactorService.confirmSetup("user-1", "123456"))
        .rejects.toThrow(/pendente/i);
    });

    test("rejeita código incorreto", async () => {
      const secret = authenticator.generateSecret();
      userRepository.findById.mockResolvedValue({ id: "user-1", totpPendingSecret: secret });

      await expect(twoFactorService.confirmSetup("user-1", "000000"))
        .rejects.toThrow(/inválido/i);
    });

    test("ativa o 2FA e retorna 8 backup codes com código válido", async () => {
      const secret = authenticator.generateSecret();
      const codigoValido = authenticator.generate(secret);
      userRepository.findById.mockResolvedValue({ id: "user-1", totpPendingSecret: secret });

      const { backupCodes } = await twoFactorService.confirmSetup("user-1", codigoValido);

      expect(backupCodes).toHaveLength(8);
      backupCodes.forEach(code => expect(code).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{2}$/));
      expect(userRepository.enableTotp).toHaveBeenCalledWith(
        "user-1",
        secret,
        expect.arrayContaining([expect.any(String)])
      );
    });
  });

  describe("criarDesafioLogin", () => {
    test("insere o desafio e retorna token + expiresIn", async () => {
      pool.query.mockResolvedValue({ rows: [] });

      const { token, expiresIn } = await twoFactorService.criarDesafioLogin("user-1");

      expect(token).toEqual(expect.any(String));
      expect(token.length).toBeGreaterThanOrEqual(32);
      expect(expiresIn).toBe(5 * 60 * 1000);
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO two_factor_challenges"),
        [expect.any(String), "user-1", expect.any(Number)]
      );
    });
  });

  describe("verificarDesafioLogin", () => {
    test("rejeita desafio inexistente", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] }); // buscarDesafio → nada encontrado

      await expect(twoFactorService.verificarDesafioLogin("token-invalido", "123456"))
        .rejects.toThrow(/inválido ou expirado/i);
    });

    test("rejeita desafio expirado e limpa", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ token: "t1", user_id: "user-1", expires_at: Date.now() - 1000 }] })
        .mockResolvedValueOnce({ rows: [] }); // DELETE do desafio expirado

      await expect(twoFactorService.verificarDesafioLogin("t1", "123456"))
        .rejects.toThrow(/expirou/i);

      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM two_factor_challenges"),
        ["t1"]
      );
    });

    test("aceita código TOTP válido e remove o desafio", async () => {
      const secret = authenticator.generateSecret();
      const codigoValido = authenticator.generate(secret);

      pool.query
        .mockResolvedValueOnce({ rows: [{ token: "t1", user_id: "user-1", expires_at: Date.now() + 60000 }] })
        .mockResolvedValueOnce({ rows: [] }); // DELETE após sucesso

      userRepository.findById.mockResolvedValue({
        id: "user-1", totpEnabled: true, totpSecret: secret, totpBackupCodes: []
      });

      const resultado = await twoFactorService.verificarDesafioLogin("t1", codigoValido);

      expect(resultado.userId).toBe("user-1");
      expect(resultado.usouBackupCode).toBeUndefined();
    });

    test("aceita backup code válido, consome e não deixa reutilizar", async () => {
      const bcrypt = require("bcrypt");
      const backupCode = "ABCD-1234-EF";
      const hash = await bcrypt.hash(backupCode, 10);

      pool.query
        .mockResolvedValueOnce({ rows: [{ token: "t1", user_id: "user-1", expires_at: Date.now() + 60000 }] })
        .mockResolvedValueOnce({ rows: [] }); // DELETE após sucesso

      userRepository.findById.mockResolvedValue({
        id: "user-1", totpEnabled: true, totpSecret: authenticator.generateSecret(), totpBackupCodes: [hash]
      });

      const resultado = await twoFactorService.verificarDesafioLogin("t1", backupCode);

      expect(resultado.userId).toBe("user-1");
      expect(resultado.usouBackupCode).toBe(true);
      expect(userRepository.updateBackupCodes).toHaveBeenCalledWith("user-1", []);
    });

    test("rejeita código totalmente errado", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ token: "t1", user_id: "user-1", expires_at: Date.now() + 60000 }] });

      userRepository.findById.mockResolvedValue({
        id: "user-1", totpEnabled: true, totpSecret: authenticator.generateSecret(), totpBackupCodes: []
      });

      await expect(twoFactorService.verificarDesafioLogin("t1", "000000"))
        .rejects.toThrow(/incorreto/i);
    });
  });
});
