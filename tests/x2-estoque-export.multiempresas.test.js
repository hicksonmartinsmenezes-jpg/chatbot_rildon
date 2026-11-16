// Estoque nas 3 unidades (Matriz, Distribuidora, Ecommerce): escolha da opção
// do select "Empresa" do Relatório de Estoque Multiempresas.
const { escolherOpcaoEmpresa } = require('../scripts/x2-estoque-export');

const opcoes = [
  { value: '1', text: 'RILDON ELETRO PECAS' },
  { value: '2', text: 'RILDON DISTRIBUIDORA (DIST)' },
  { value: '3', text: 'RILDON ECOMMERCE (EC)' },
];

describe('escolherOpcaoEmpresa', () => {
  test('Matriz = a opção sem sufixo; DIST e EC pelo sufixo', () => {
    expect(escolherOpcaoEmpresa(opcoes, 'MATRIZ')).toBe('1');
    expect(escolherOpcaoEmpresa(opcoes, 'DIST')).toBe('2');
    expect(escolherOpcaoEmpresa(opcoes, 'EC')).toBe('3');
  });

  test('ignora placeholder "Selecione"/"Todas"', () => {
    expect(escolherOpcaoEmpresa([{ value: '', text: 'Selecione' }, ...opcoes], 'MATRIZ')).toBe('1');
  });

  test('ambíguo ou ausente devolve null (não adivinha)', () => {
    expect(escolherOpcaoEmpresa([{ value: '1', text: 'A' }, { value: '2', text: 'B' }], 'MATRIZ')).toBeNull();
    expect(escolherOpcaoEmpresa(opcoes.slice(0, 2), 'EC')).toBeNull();
    expect(escolherOpcaoEmpresa(null, 'DIST')).toBeNull();
  });
});

describe('pastaDaEmpresa', () => {
  const { pastaDaEmpresa, ESTOQUE_DIR } = require('../scripts/x2-estoque-export');
  test('Matriz/legado ficam em ESTOQUE_DIR; DIST e EC numa subpasta', () => {
    expect(pastaDaEmpresa()).toBe(ESTOQUE_DIR);
    expect(pastaDaEmpresa('MATRIZ')).toBe(ESTOQUE_DIR);
    expect(pastaDaEmpresa('DIST')).toMatch(/multiempresas$/);
    expect(pastaDaEmpresa('EC')).toMatch(/multiempresas$/);
  });
});
