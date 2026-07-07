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
    foto: user.foto || ""
  };
}

async function createUser(data) {

  const exists =
    await findUserByUsername(
      data.usuario
    );

  if (exists) {
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
      updated.ativo
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
