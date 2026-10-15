const bcrypt = require("bcrypt");
const crypto = require("crypto");
const logger = require("../utils/logger");
const { validarForcaSenha } = require("../utils/passwordPolicy");

const userRepository =
  require("../repositories/user.repository");

const SALT_ROUNDS = 10;

// Lista canônica das telas do menu — espelha PANEL_SCREEN_PERMISSIONS em
// frontend/js/09-users.js (mesmos 9 ids). Cada perfil sugere um conjunto
// PADRÃO de telas (PROFILE_SCREEN_ACCESS abaixo), mas a permissão
// individual sempre pode sobrepor em qualquer direção — LIBERAR uma tela
// fora do padrão do perfil (pedido do usuário, 2026-09-19: "não consigo dar
// permissão... mesmo que seja atendente ou supervisor") ou RETIRAR uma tela
// que o perfil teria por padrão (comportamento que já existia antes).
const ALL_SCREEN_IDS = [
  "dashboard", "conversations", "history", "contacts", "catalogo",
  "channels", "metrics", "chatbot", "settings"
];

// "Padrão" de cada perfil quando a tela não foi definida explicitamente em
// `permissions` — usado só como fallback, nunca mais como teto. admin não
// tem entrada aqui de propósito (normalizeScreenPermissions trata perfil
// "admin" à parte, sempre liberando tudo).
const PROFILE_SCREEN_ACCESS = {
  atendente: new Set(["dashboard", "conversations", "history", "contacts", "catalogo"]),
  supervisor: new Set(["dashboard", "conversations", "history", "contacts", "catalogo", "channels", "metrics"])
};

function normalizeScreenPermissions(perfil, permissions = {}) {
  if (perfil === "admin") {
    // admin sempre tem acesso total — não faz sentido restringir a única
    // conta que administra o resto (evita o risco de autoexclusão
    // acidental do próprio painel).
    return Object.fromEntries(ALL_SCREEN_IDS.map(screen => [screen, true]));
  }

  const defaultSet = PROFILE_SCREEN_ACCESS[perfil] || PROFILE_SCREEN_ACCESS.atendente;
  const normalized = {};
  for (const screen of ALL_SCREEN_IDS) {
    normalized[screen] = permissions[screen] === undefined
      ? defaultSet.has(screen)
      : permissions[screen] === true;
  }
  return normalized;
}

async function getUsers(options = {}) {
  return userRepository.findAll(options);
}

async function getUserById(id) {
  return userRepository.findById(id);
}

async function countActiveAdmins() {
  return userRepository.countActiveAdmins();
}

async function findUserByUsername(usuario) {
  return userRepository.findByUsername(usuario);
}

async function validateUser(usuario, senha) {

  const user =
    await findUserByUsername(usuario);

  if (!user || user.ativo === false) {
    return null;
  }

  const senhaOk =
    await bcrypt.compare(
      String(senha || ""),
      String(user.senha || "")
    );

  if (!senhaOk) {
    return null;
  }

  return {
    id: user.id,
    nome: user.nome,
    usuario: user.usuario,
    perfil: user.perfil,
    sector: user.sector || "geral",
    numero: user.numero || "",
    foto: user.foto || "",
    // Só o flag booleano — nunca o segredo/backup codes. Necessário no
    // cliente pra decidir "Ativar 2FA" vs "Desativar 2FA" no perfil.
    totpEnabled: !!user.totpEnabled,
    permissions: user.permissions || {}
  };
}

async function createUser(data) {

  const exists =
    await findUserByUsername(
      data.usuario
    );

  // "usuario" tem UNIQUE NOT NULL no schema, e excluir um usuário (painel)
  // só faz soft delete (ativo = false) — a linha nunca some de verdade. Se o
  // usuário achado já estiver desativado, reativa a linha (nome/senha/perfil/
  // sector novos) em vez de recusar com "já existe": sem isso, era impossível
  // recriar um usuário com o mesmo nome de usuário depois de excluído.
  if (exists && exists.ativo !== false) {
    throw new Error(
      "Usuário já existe."
    );
  }

  const forca = validarForcaSenha(data.senha);
  if (!forca.valido) {
    throw new Error(forca.erro);
  }

  const senhaHash =
    await bcrypt.hash(
      String(data.senha || ""),
      SALT_ROUNDS
    );

  if (exists) {
    const reactivated = await userRepository.reactivate(exists.id, {
      nome: data.nome,
      senha: senhaHash,
      perfil: data.perfil || "atendente",
      sector: data.sector || "geral",
      numero: data.numero || "",
      foto: data.foto || "",
      permissions: normalizeScreenPermissions(data.perfil || "atendente", data.permissions || {})
    });

    // Mesmo bug do branch de usuário novo abaixo — numero/foto ficavam de
    // fora da resposta imediata da reativação.
    return {
      id: reactivated.id,
      nome: reactivated.nome,
      usuario: reactivated.usuario,
      perfil: reactivated.perfil,
      sector: reactivated.sector,
      numero: reactivated.numero || "",
      foto: reactivated.foto || "",
      ativo: reactivated.ativo,
      permissions: reactivated.permissions || {},
      reactivated: true
    };
  }

  const newUser = {
    id: crypto.randomUUID(),
    nome: data.nome,
    usuario: data.usuario,
    senha: senhaHash,
    perfil:
      data.perfil || "atendente",
    sector:
      data.sector || "geral",
    numero:
      data.numero || "",
    foto:
      data.foto || "",
    permissions:
      normalizeScreenPermissions(data.perfil || "atendente", data.permissions || {}),
    ativo:
      data.ativo !== undefined ? data.ativo : true
  };

  const created =
    await userRepository.create(
      newUser
    );

  // BUG CORRIGIDO (achado escrevendo teste pro cadastro de telefone): este
  // retorno omitia "numero" e "foto" — mesmo o valor sendo gravado
  // corretamente no banco (userRepository.create já persiste os dois), a
  // resposta imediata do POST /api/users vinha sem o telefone recém
  // cadastrado. Na prática o painel corrige sozinho ao recarregar a lista
  // logo em seguida (loadPanelUsers), mas o dado retornado devia estar
  // certo desde já — mesmo padrão já usado no branch de reativação abaixo
  // e em updateUserProfile().
  return {
    id: created.id,
    nome: created.nome,
    usuario: created.usuario,
    perfil: created.perfil,
    sector: created.sector,
    numero: created.numero || "",
    foto: created.foto || "",
    ativo: created.ativo,
    permissions: created.permissions || {}
  };
}

async function updateUserProfile(
  id,
  data
) {

  const user =
    await userRepository.findById(id);

  if (!user) {
    throw new Error(
      "Usuário não encontrado."
    );
  }

  const nome =
    String(data.nome || "").trim();

  const numero =
    String(data.numero || "").trim();

  const foto =
    String(data.foto || "").trim();

  const senhaAtual =
    String(data.senhaAtual || "");

  const novaSenha =
    String(data.novaSenha || "");

  if (!nome) {
    throw new Error(
      "O nome é obrigatório."
    );
  }

  if (foto) {

    const fotoValida =
      foto.startsWith("data:image/") ||
      foto.startsWith(
        "/uploads/profiles/"
      );

    if (!fotoValida) {
      throw new Error(
        "Formato de foto inválido."
      );
    }
  }

  if (novaSenha) {

    const forca = validarForcaSenha(novaSenha);
    if (!forca.valido) {
      throw new Error(forca.erro);
    }

    if (!senhaAtual) {
      throw new Error(
        "Informe a senha atual para alterar a senha."
      );
    }

    const senhaOk =
      await bcrypt.compare(
        senhaAtual,
        String(user.senha || "")
      );

    if (!senhaOk) {
      throw new Error(
        "Senha atual incorreta."
      );
    }

    const senhaHash =
      await bcrypt.hash(
        novaSenha,
        SALT_ROUNDS
      );

    await userRepository.updatePassword(
      id,
      senhaHash
    );
  }

  const updated =
    await userRepository.updateProfile(
      id,
      {
        nome,
        numero,
        foto
      }
    );

  return {
    id: updated.id,
    nome: updated.nome,
    usuario: updated.usuario,
    perfil: updated.perfil,
    sector:
      updated.sector || "geral",
    numero:
      updated.numero || "",
    foto:
      updated.foto || "",
    ativo:
      updated.ativo,
    totpEnabled: !!updated.totpEnabled,
    permissions: updated.permissions || {}
  };
}

async function updateUserPermissions(id, permissions) {
  const current = await userRepository.findById(id);
  if (!current) throw new Error("Usuário não encontrado.");

  const normalizedInput = permissions && typeof permissions === "object" && !Array.isArray(permissions)
    ? permissions
    : {};
  const normalized = normalizeScreenPermissions(current.perfil, normalizedInput);
  const updated = await userRepository.updatePermissions(id, normalized);
  if (!updated) throw new Error("Usuário não encontrado.");
  return {
    id: updated.id,
    nome: updated.nome,
    usuario: updated.usuario,
    perfil: updated.perfil,
    sector: updated.sector || "geral",
    numero: updated.numero || "",
    foto: updated.foto || "",
    ativo: updated.ativo,
    permissions: updated.permissions || {}
  };
}

async function updateUserPassword(
  id,
  novaSenha
) {

  const forca = validarForcaSenha(novaSenha);
  if (!forca.valido) {
    throw new Error(forca.erro);
  }

  const senhaHash =
    await bcrypt.hash(
      String(novaSenha || ""),
      SALT_ROUNDS
    );

  await userRepository.updatePassword(
    id,
    senhaHash
  );

  return true;
}

async function deactivateUser(id) {
  const user = await userRepository.deactivate(id);

  if (!user) {
    throw new Error("Usuário não encontrado.");
  }

  return true;
}

module.exports = {
  getUsers,
  getUserById,
  countActiveAdmins,
  findUserByUsername,
  validateUser,
  createUser,
  updateUserProfile,
  updateUserPassword,
  updateUserPermissions,
  deactivateUser
};
