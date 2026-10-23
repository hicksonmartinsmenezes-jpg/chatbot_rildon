// Coloca o ícone no .exe (afterPack). O electron-builder faria isso sozinho, mas baixar o winCodeSign
// falha no Windows sem privilégio de link simbólico; aqui usamos o rcedit já extraído no cache.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function achar(dir, nome, prof = 0) {
  if (prof > 3 || !fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === nome) return p;
    if (e.isDirectory()) { const r = achar(p, nome, prof + 1); if (r) return r; }
  }
  return null;
}

exports.default = async function (ctx) {
  const cache = path.join(process.env.LOCALAPPDATA || "", "electron-builder", "Cache", "winCodeSign");
  const rcedit = achar(cache, "rcedit-x64.exe");
  const exe = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.exe`);
  if (!rcedit) { console.warn("[icone] rcedit não encontrado; .exe fica com o ícone padrão"); return; }
  execFileSync(rcedit, [exe, "--set-icon", path.join(__dirname, "icon.ico")]);
  console.log("[icone] ícone aplicado em", exe);
};
