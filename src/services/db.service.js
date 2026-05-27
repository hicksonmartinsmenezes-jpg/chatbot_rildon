/**
 * Camada de persistência com proteção contra race conditions.
 *
 * CORREÇÕES v6.1:
 * - ler() agora usa o mesmo mutex de transacao(), garantindo que
 *   leituras nunca ocorram durante uma escrita (seguro para PM2 fork mode).
 * - Escrita atômica via arquivo temporário + rename, eliminando risco
 *   de arquivo corrompido em caso de crash no meio da escrita.
 *
 * ATENÇÃO — PM2 cluster mode:
 * O Mutex do async-mutex é in-process. Em cluster mode (múltiplos workers),
 * cada worker tem seu próprio mutex, então a proteção vale DENTRO de cada
 * processo. Para coordenação entre processos, migre para SQLite (better-sqlite3)
 * que usa lock nativo do sistema operacional.
 */
const fs   = require("fs");
const path = require("path");
const { Mutex } = require("async-mutex");

const DATA_DIR = path.join(__dirname, "../data");

const mutexes = {};

function getMutex(arquivo) {
    if (!mutexes[arquivo]) mutexes[arquivo] = new Mutex();
    return mutexes[arquivo];
}

function resolverCaminho(nome) {
    return path.join(DATA_DIR, nome);
}

function lerArquivo(filePath) {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8").trim();
    return raw ? JSON.parse(raw) : [];
}

/**
 * Escrita atômica: grava em arquivo .tmp e depois faz rename.
 * Se o processo morrer no meio, o arquivo original fica intacto.
 */
function salvarArquivo(filePath, dados) {
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(dados, null, 2));
    fs.renameSync(tmp, filePath);
}

/**
 * Executa uma função que recebe os dados atuais e retorna
 * os dados novos, de forma atômica (mutex por arquivo).
 *
 * @param {string} nome - nome do arquivo (ex: "tickets.json")
 * @param {function} fn - (dados: Array) => { dados, ...extras } | Array
 * @returns {any} - o que fn retornar
 */
async function transacao(nome, fn) {
    const filePath = resolverCaminho(nome);
    const mutex = getMutex(nome);

    return mutex.runExclusive(() => {
        const dados = lerArquivo(filePath);
        const resultado = fn(dados);

        // IMPORTANTE:
        // Algumas funções alteram o próprio array recebido e retornam o mesmo array.
        // Antes, quando resultado === dados, o arquivo não era salvo.
        // Isso fazia o histórico não gravar em src/data/history.json.
        if (resultado !== undefined) {
            salvarArquivo(filePath, resultado.dados !== undefined ? resultado.dados : resultado);
        }

        return resultado;
    });
}

/**
 * Leitura protegida pelo mesmo mutex de transacao().
 * Garante que nunca lemos enquanto uma escrita está em andamento.
 */
async function ler(nome) {
    const filePath = resolverCaminho(nome);
    const mutex = getMutex(nome);
    return mutex.runExclusive(() => lerArquivo(filePath));
}

/**
 * Leitura síncrona sem lock — use apenas onde async não é possível
 * e o risco de concorrência é aceitável (ex: estatísticas aproximadas).
 */
function lerSync(nome) {
    return lerArquivo(resolverCaminho(nome));
}

module.exports = { transacao, ler, lerSync };
