const bcrypt = require("bcrypt");
const crypto = require("crypto");
const logger = require("../utils/logger");
const { validarForcaSenha } = require("../utils/passwordPolicy");

const userRepository =
  require("../repositories/user.repository");

const SALT_ROUNDS = 10;

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
    totpEnabled: !!user.totpEnabled
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
      foto: data.foto || ""
    });

    return {
      id: reactivated.id,
      nome: reactivated.nome,
      usuario: reactivated.usuario,
      perfil: reactivated.perfil,
      sector: reactivated.sector,
      ativo: reactivated.ativo,
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
    ativo:
      data.ativo !== undefined ? data.ativo : true
  };

  const created =
    await userRepository.create(
      newUser
    );

  return {
    id: created.id,
    nome: created.nome,
    usuario: created.usuario,
    perfil: created.perfil,
    sector: created.sector,
    ativo: created.ativo
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
    totpEnabled: !!updated.totpEnabled
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
  deactivateUser
};
