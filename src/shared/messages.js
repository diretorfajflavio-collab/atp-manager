/**
 * ATP Manager — Tradução de mensagens técnicas
 * ----------------------------------------------
 * Converte erros técnicos em orientações claras para servidores de tribunal.
 * Compartilhado entre a interface e os testes (UMD: funciona em Node e browser).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ATPMessages = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  function humanizeMessage(raw) {
    if (!raw) return "Ocorreu um problema não identificado.";
    const s = String(raw).toLowerCase();
    if (
      s.includes("session_expired") ||
      s.includes("sessão expirada") ||
      s.includes("sessao expirada") ||
      s.includes("login não") ||
      s.includes("login nao")
    ) {
      return "Não foi possível entrar no eproc. Confira se o usuário e a senha estão corretos na aba Configuração.";
    }
    if (
      s.includes("rede do tribunal") ||
      s.includes("timeout") ||
      s.includes("etimedout") ||
      s.includes("enotfound") ||
      s.includes("econnrefused") ||
      s.includes("net::")
    ) {
      return "Não consegui acessar o eproc. Verifique se este computador está conectado à rede do tribunal.";
    }
    if (
      s.includes("token") ||
      s.includes(" 401") ||
      s.includes(" 403") ||
      s.includes("unauthorized") ||
      s.includes("forbidden")
    ) {
      return "O código de acesso parece inválido ou expirou. Gere um novo no painel e cole na aba Configuração.";
    }
    if (
      s.includes("2fa") ||
      s.includes("duas etapas") ||
      s.includes("verificação em duas")
    ) {
      return "O eproc pediu verificação em duas etapas. Faça um login manual uma vez para autorizar este computador.";
    }
    if (
      s.includes("chromium") ||
      s.includes("navegador") ||
      s.includes("browser")
    ) {
      return "Houve um problema ao abrir o navegador interno. Tente reiniciar o programa.";
    }
    return raw;
  }
  return { humanizeMessage };
});
