/**
 * Wrapper para handlers async do Express.
 * Captura qualquer rejeição/exceção e repassa para o global error handler
 * via next(err), eliminando try/catch repetitivo nas rotas.
 *
 * Uso:
 *   router.get('/rota', asyncHandler(async (req, res) => { ... }))
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
