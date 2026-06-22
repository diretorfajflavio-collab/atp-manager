/* Testes da lógica crítica — comparação fiel com o comportamento do Python.
   Roda com: node test/logic.test.js  (sem dependências externas) */

const assert = require("assert");
const {
  evaluateCondition,
  matchesRule,
  addBusinessDays,
  executePjAutoraRule,
  captureFailure,
} = require("../src/agent/rulesEngine");
const { isSessionExpired } = require("../src/agent/agentRunner");
const { humanizeMessage } = require("../src/shared/messages");

let passed = 0;
let failed = 0;
const asyncTests = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

console.log("\nevaluateCondition");
test("equals — igual exato", () => {
  assert.strictEqual(
    evaluateCondition(
      { field: "tipo", value: "inicial", operator: "equals" },
      { tipo: "inicial" },
    ),
    true,
  );
});
test("equals — diferente", () => {
  assert.strictEqual(
    evaluateCondition(
      { field: "tipo", value: "inicial", operator: "equals" },
      { tipo: "recurso" },
    ),
    false,
  );
});
test("contains — substring", () => {
  assert.strictEqual(
    evaluateCondition(
      { field: "desc", value: "petição", operator: "contains" },
      { desc: "Petição inicial" },
    ),
    true,
  );
});
test("startsWith", () => {
  assert.strictEqual(
    evaluateCondition(
      { field: "n", value: "0001", operator: "startsWith" },
      { n: "0001234" },
    ),
    true,
  );
});
test("endsWith", () => {
  assert.strictEqual(
    evaluateCondition(
      { field: "n", value: "0000", operator: "endsWith" },
      { n: "123.8.26.0000" },
    ),
    true,
  );
});
test("in — qualquer um da lista", () => {
  assert.strictEqual(
    evaluateCondition(
      { field: "t", value: ["recurso", "inicial"], operator: "in" },
      { t: "petição inicial" },
    ),
    true,
  );
});
test("notIn — nenhum da lista", () => {
  assert.strictEqual(
    evaluateCondition(
      { field: "t", value: ["recurso", "embargos"], operator: "notIn" },
      { t: "petição inicial" },
    ),
    true,
  );
});
test("operador desconhecido retorna false", () => {
  assert.strictEqual(
    evaluateCondition({ field: "t", value: "x", operator: "xyz" }, { t: "x" }),
    false,
  );
});

console.log("\nmatchesRule");
test("sem condições → sempre casa", () => {
  assert.strictEqual(
    matchesRule({ conditions: [] }, { qualquer: "coisa" }),
    true,
  );
});
test("todas as condições precisam casar (AND)", () => {
  const rule = {
    conditions: [
      { field: "tipo", value: "inicial", operator: "equals" },
      { field: "loc", value: "JEE", operator: "contains" },
    ],
  };
  assert.strictEqual(
    matchesRule(rule, { tipo: "inicial", loc: "PETIÇÃO INICIAL JEE" }),
    true,
  );
  assert.strictEqual(
    matchesRule(rule, { tipo: "inicial", loc: "OUTRO" }),
    false,
  );
});

console.log("\naddBusinessDays");
test("pula fim de semana", () => {
  // Sexta 2026-06-19 + 1 dia útil = segunda 2026-06-22
  const sexta = new Date("2026-06-19T12:00:00");
  const r = addBusinessDays(sexta, 1);
  assert.strictEqual(r.getDay(), 1, "deveria cair numa segunda");
});
test("10 dias úteis sempre cai em dia de semana", () => {
  const r = addBusinessDays(new Date("2026-06-16T12:00:00"), 10);
  assert.ok(r.getDay() >= 1 && r.getDay() <= 5, "deve ser dia útil");
});
test("pula feriado nacional fixo (7 de setembro)", () => {
  // 2026-09-04 é sexta. +1 dia útil normalmente seria 09-07 (feriado), deve pular p/ 09-08
  const r = addBusinessDays(new Date("2026-09-04T12:00:00"), 1);
  const key = `${r.getMonth() + 1}-${r.getDate()}`;
  assert.notStrictEqual(key, "9-7", "não pode cair no feriado de 7/9");
});

console.log("\nisSessionExpired");
test("URL do SSO = sessão expirada", () => {
  assert.strictEqual(
    isSessionExpired("https://sso.tjsp.jus.br/auth/realms/..."),
    true,
  );
});
test("URL com openid-connect = expirada", () => {
  assert.strictEqual(isSessionExpired("https://x/openid-connect/auth"), true);
});
test("URL do eproc logado = sessão ativa", () => {
  assert.strictEqual(
    isSessionExpired(
      "https://eproc1g.tjsp.jus.br/eproc/controlador.php?acao=principal",
    ),
    false,
  );
});
test("URL vazia = expirada (seguro)", () => {
  assert.strictEqual(isSessionExpired(""), true);
});

console.log("\nhumanizeMessage");
test("sessão expirada → orientação sobre usuário/senha", () => {
  assert.ok(
    humanizeMessage("status: session_expired").includes("usuário e a senha"),
  );
});
test("timeout de rede → orientação sobre rede do tribunal", () => {
  assert.ok(
    humanizeMessage("Error: net::ERR_TIMED_OUT").includes("rede do tribunal"),
  );
});
test("401 → orientação sobre código de acesso", () => {
  assert.ok(
    humanizeMessage("HTTP 401: unauthorized").includes("código de acesso"),
  );
});
test("mensagem amigável passa sem alteração", () => {
  const m = "Concluído: 5 sucesso(s), 2 ignorado(s).";
  assert.strictEqual(humanizeMessage(m), m);
});
test("vazio → mensagem genérica segura", () => {
  assert.ok(humanizeMessage("").length > 0);
});

// ---------- Testes assíncronos: simulação e captura de falha ----------
// Mock mínimo de página Playwright. Devolve um HTML com CNPJ no polo ativo
// para simular um processo cuja parte autora é pessoa jurídica.
function mockPageComPj() {
  const chamadas = { screenshots: 0, gotos: [] };
  const page = {
    chamadas,
    async goto(url) {
      chamadas.gotos.push(url);
    },
    url() {
      return "https://eproc1g.tjsp.jus.br/eproc/processo_selecionar";
    },
    async content() {
      return `
        <html><body>
          <div>Polo Ativo: EMPRESA EXEMPLO LTDA — CNPJ 12.345.678/0001-99</div>
          <div>Autuação 10/06/2026</div>
        </body></html>`;
    },
    async waitForTimeout() {},
    async screenshot() {
      chamadas.screenshots += 1;
    },
  };
  return page;
}

const noop = () => {};

asyncTests.push([
  "simulação detecta PJ mas NÃO executa ações (status simulated)",
  async () => {
    const page = mockPageComPj();
    const r = await executePjAutoraRule(
      page,
      { processNumber: "1234567-89.2026.8.26.0000" },
      "https://eproc1g.tjsp.jus.br/eproc",
      null,
      null,
      new Set(),
      noop,
      { dryRun: true },
    );
    assert.strictEqual(r.status, "simulated");
    assert.ok(r.actionTaken.toLowerCase().includes("simulação"));
    assert.strictEqual(r.cnpj, "12.345.678/0001-99");
    // Em simulação, nenhuma navegação de escrita (mover/movimentar) deve ocorrer
    const escreveu = page.chamadas.gotos.some(
      (u) =>
        u.includes("localizador_alterar") || u.includes("movimento_incluir"),
    );
    assert.strictEqual(
      escreveu,
      false,
      "não pode navegar para telas de escrita",
    );
  },
]);

asyncTests.push([
  "processo já tratado é ignorado mesmo em simulação",
  async () => {
    const page = mockPageComPj();
    const set = new Set(["1234567-89.2026.8.26.0000"]);
    const r = await executePjAutoraRule(
      page,
      { processNumber: "1234567-89.2026.8.26.0000" },
      "https://x",
      null,
      null,
      set,
      noop,
      { dryRun: true },
    );
    assert.strictEqual(r.status, "skipped");
  },
]);

asyncTests.push([
  "captureFailure não quebra quando não há pasta configurada",
  async () => {
    const page = mockPageComPj();
    const r = await captureFailure(page, "teste", {}, noop);
    assert.strictEqual(r, null);
    assert.strictEqual(page.chamadas.screenshots, 0);
  },
]);

asyncTests.push([
  "captureFailure salva imagem quando há pasta",
  async () => {
    const page = mockPageComPj();
    const dir = require("os").tmpdir() + "/atp-diag-test";
    const r = await captureFailure(
      page,
      "teste falha!",
      { screenshotDir: dir },
      noop,
    );
    assert.ok(r && r.includes("falha_teste_falha"));
    assert.strictEqual(page.chamadas.screenshots, 1);
  },
]);

(async function runAll() {
  console.log("\nsimulação e captura de falha");
  for (const [name, fn] of asyncTests) {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.log(`  ✗ ${name}\n    ${err.message}`);
    }
  }
  console.log(`\n${passed} passou(aram), ${failed} falhou(aram).\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
