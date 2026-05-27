const MAX_CHARS = parseInt(process.env.MAX_CHARS_INPUT || "500");

function validarCPF(cpf) {
    const numeros = cpf.replace(/\D/g, "");
    if (numeros.length !== 11) return false;
    if (/^(\d)\1{10}$/.test(numeros)) return false;

    let soma = 0;
    for (let i = 0; i < 9; i++) soma += parseInt(numeros[i]) * (10 - i);
    let resto = (soma * 10) % 11;
    if (resto === 10 || resto === 11) resto = 0;
    if (resto !== parseInt(numeros[9])) return false;

    soma = 0;
    for (let i = 0; i < 10; i++) soma += parseInt(numeros[i]) * (11 - i);
    resto = (soma * 10) % 11;
    if (resto === 10 || resto === 11) resto = 0;
    return resto === parseInt(numeros[10]);
}

function validarNome(nome) {
    return nome.trim().length >= 3 && nome.trim().split(" ").length >= 2;
}

function formatarCPF(cpf) {
    const n = cpf.replace(/\D/g, "");
    return `${n.slice(0,3)}.${n.slice(3,6)}.${n.slice(6,9)}-${n.slice(9,11)}`;
}

function validarTamanho(texto, minimo = 1) {
    const t = texto.trim();
    if (t.length < minimo) return { ok: false, erro: `minimo` };
    if (t.length > MAX_CHARS) return { ok: false, erro: `maximo` };
    return { ok: true };
}

function mensagemTamanhoInvalido(minimo) {
    return `⚠️ Sua mensagem precisa ter entre ${minimo} e ${MAX_CHARS} caracteres. Por favor, tente novamente.`;
}

module.exports = { validarCPF, validarNome, formatarCPF, validarTamanho, mensagemTamanhoInvalido };
