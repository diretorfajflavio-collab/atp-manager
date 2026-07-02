/**
 * ATP Manager — Agent Runner (Node.js / Playwright)
 * ==================================================
 * Porte fiel do agente Python (atp_agent.py v3.4.6) para Node.js.
 * Esta é a lógica que efetivamente acessa o eproc TJSP e executa as
 * automações ATP. Usa Playwright (Chromium embutido no app) — o usuário
 * NÃO precisa instalar Python, Node.js nem navegador algum.
 *
 * Preserva fielmente a lógica validada de:
 *   - Login automático SSO TJSP (Keycloak) em uma ou duas etapas
 *   - Detecção de sessão expirada
 *   - Captura e reenvio de cookies ao painel
 *   - Comunicação REST com o painel (endpoints /api/agent/*)
 */

const VERSION = "4.0.2";

// ── Constantes ─────────────────────────────────────────────────────────────
const TJSP_DOMAINS = ["tjsp", "jus.br", "eproc"];

// ── Utilidades de log ────────────────────────────────────────────────────────
function makeLogger(onLog) {
  return (level, message) => {
    const entry = { level, message, at: new Date().toISOString() };
    if (typeof onLog === "function") onLog(entry);
    // eslint-disable-next-line no-console
    console.log(`[${level}] ${message}`);
  };
}

// ── Comunicação com o painel (REST) ──────────────────────────────────────────
async function apiGet(serverUrl, token, pathName) {
  const resp = await fetch(`${serverUrl}${pathName}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

async function apiPost(serverUrl, token, pathName, body) {
  const resp = await fetch(`${serverUrl}${pathName}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

async function validateToken(serverUrl, token) {
  try {
    await apiGet(serverUrl, token, "/api/agent/status");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function getRules(serverUrl, token) {
  return apiGet(serverUrl, token, "/api/agent/get-rules");
}

async function getCredentials(serverUrl, token) {
  return apiGet(serverUrl, token, "/api/agent/get-credentials");
}

async function sendCookies(serverUrl, token, cookies) {
  const data = await apiPost(serverUrl, token, "/api/agent/push-cookies", {
    cookies,
  });
  return data.cookieCount ?? cookies.length;
}

async function reportResult(serverUrl, token, result) {
  return apiPost(serverUrl, token, "/api/agent/report-result", result);
}

// ── Detecção de sessão expirada ──────────────────────────────────────────────
function isSessionExpired(url) {
  if (!url) return true;
  return (
    url.includes("sso.tjsp.jus.br") ||
    url.includes("openid-connect") ||
    url.includes("keycloak") ||
    url.includes("login") ||
    url.includes("txtUsuario")
  );
}

// ── Login automático SSO TJSP (porte fiel do Python) ─────────────────────────
async function performAutoLogin(page, username, password, eprocUrl, log) {
  log("info", `Realizando login automático como: ${username}`);
  try {
    await page.goto(eprocUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(2000);
    let currentUrl = page.url();
    log("info", `URL após navegação: ${currentUrl}`);

    const atSso =
      currentUrl.includes("sso.tjsp.jus.br") ||
      currentUrl.includes("openid-connect") ||
      currentUrl.includes("keycloak");

    if (atSso) {
      log("info", "Redirecionado para SSO TJSP, preenchendo credenciais...");
      await page.waitForSelector(
        "input[name='username'], input[id='username']",
        { timeout: 15000 },
      );
      await page.waitForTimeout(1000);

      // ── Função auxiliar: revelar (se oculto) e preencher a senha de forma robusta ──
      const preencherSenha = async () => {
        // 1) Revela o campo de senha, caso o SSO TJSP o mantenha oculto via CSS
        await page.evaluate(() => {
          const pw = document.querySelector("input[type='password']");
          if (pw) {
            pw.style.display = "block";
            pw.style.visibility = "visible";
            pw.style.opacity = "1";
            pw.removeAttribute("hidden");
            pw.removeAttribute("disabled");
            pw.removeAttribute("readonly");
            let el = pw.parentElement;
            for (let i = 0; i < 6 && el; i++) {
              el.style.display = "block";
              el.style.visibility = "visible";
              el.style.opacity = "1";
              el = el.parentElement;
            }
          }
        });
        await page.waitForTimeout(300);

        const pwField = page.locator("input[type='password']").first();

        // 2) Foca o campo e limpa qualquer conteúdo
        try {
          await pwField.click({ force: true });
        } catch (_) {}
        await page.keyboard.press("Control+a");
        await page.keyboard.press("Delete");
        await page.waitForTimeout(150);

        // 3) MÉTODO PRINCIPAL: insertText insere o texto diretamente no campo
        // focado, caractere a caractere, SEM simular teclas físicas. Isso é
        // imune ao layout do teclado (ABNT2/BR), corrigindo senhas com símbolos
        // como @ # ! $ % & que antes saíam trocados.
        await page.keyboard.insertText(password);
        await page.waitForTimeout(200);

        // 4) Dispara os eventos que o site espera reconhecer
        await page.evaluate(() => {
          const pw = document.querySelector("input[type='password']");
          if (pw) {
            pw.dispatchEvent(new Event("input", { bubbles: true }));
            pw.dispatchEvent(new Event("change", { bubbles: true }));
          }
        });
        await page.waitForTimeout(150);

        // 5) Confere se o comprimento bate; se não, tenta uma vez o método .value
        try {
          const pwVal = await pwField.inputValue();
          if (!pwVal || pwVal.length !== password.length) {
            log(
              "info",
              "Ajustando preenchimento da senha (verificação de integridade)...",
            );
            await page.evaluate((pwd) => {
              const pw = document.querySelector("input[type='password']");
              if (pw) {
                pw.focus();
                pw.value = pwd;
                pw.dispatchEvent(new Event("input", { bubbles: true }));
                pw.dispatchEvent(new Event("change", { bubbles: true }));
              }
            }, password);
          }
        } catch (_) {}
      };

      // Detectar o tipo de formulário pela EXISTÊNCIA do campo de senha
      // (não pela visibilidade — o SSO TJSP costuma deixá-lo oculto via CSS,
      // mas ele já está presente na mesma tela = login de etapa única).
      await page.waitForTimeout(500);
      const pwCount = await page.locator("input[type='password']").count();
      const pwExiste = pwCount > 0;

      if (pwExiste) {
        // ── ETAPA ÚNICA (usuário e senha na mesma tela) ──
        log("info", "Formulário de etapa única detectado.");
        const userField = page
          .locator("input[name='username'], input[id='username']")
          .first();
        await userField.click();
        await page.waitForTimeout(200);
        await page.keyboard.press("Control+a");
        await page.keyboard.press("Delete");
        await page.keyboard.insertText(username);
        await page.waitForTimeout(400);

        await preencherSenha();
        await page.waitForTimeout(400);

        log("info", "Clicando em Entrar...");
        const submit = page
          .locator(
            "input[type='submit'][value='Entrar'], button:has-text('Entrar'), input[type='submit'], button[type='submit']",
          )
          .first();
        await submit.click();
      } else {
        // ── DUAS ETAPAS (reserva: usuário primeiro, senha depois) ──
        log("info", "Formulário de duas etapas detectado. Etapa 1: usuário.");
        const userField = page
          .locator("input[name='username'], input[id='username']")
          .first();
        await userField.click();
        await userField.fill(username);
        await page.waitForTimeout(500);

        log("info", "Clicando em Continuar...");
        const continuar = page
          .locator(
            "button[type='submit'], input[type='submit'], button:has-text('Continuar'), button:has-text('Next'), button:has-text('Continue')",
          )
          .first();
        await continuar.click();
        await page.waitForTimeout(1500);

        log("info", "Etapa 2: revelando e preenchendo campo de senha...");
        await preencherSenha();

        log("info", "Clicando em Entrar...");
        const submit = page
          .locator(
            "button[type='submit'], input[type='submit'], button:has-text('Entrar'), button:has-text('Login'), button:has-text('Acessar')",
          )
          .first();
        await submit.click({ force: true });
      }

      // Aguardar redirecionamento de volta ao eproc
      log("info", "Aguardando redirecionamento após login...");
      try {
        await page.waitForURL(
          (url) =>
            url.toString().includes("eproc") && !url.toString().includes("sso"),
          {
            timeout: 30000,
          },
        );
      } catch (_) {}
      await page.waitForTimeout(2000);

      const finalUrl = page.url();
      log("info", `URL final: ${finalUrl}`);

      if (
        finalUrl.includes("sso.tjsp.jus.br") ||
        finalUrl.includes("openid-connect")
      ) {
        try {
          const errEl = page
            .locator(".alert-error, .kc-feedback-text, [class*='error']")
            .first();
          if (await errEl.isVisible({ timeout: 2000 })) {
            const errText = (await errEl.textContent()) || "Erro desconhecido";
            return { ok: false, error: `Erro de login: ${errText.trim()}` };
          }
        } catch (_) {}
        return {
          ok: false,
          error: "Login não concluído — verifique as credenciais ou 2FA.",
        };
      }

      log("info", "Login automático realizado com sucesso!");
      return { ok: true };
    } else if (currentUrl.includes("eproc") && !currentUrl.includes("sso")) {
      log("info", "Sessão já ativa, login não foi necessário.");
      return { ok: true };
    }
    return { ok: false, error: `URL inesperada após navegação: ${currentUrl}` };
  } catch (err) {
    return {
      ok: false,
      error: `Erro durante login automático: ${err.message}`,
    };
  }
}

// ── Localizar o Chromium embutido no app ─────────────────────────────────────
function resolveChromium() {
  // Em produção (app empacotado), o Chromium do Playwright fica em resources/
  // Definimos PLAYWRIGHT_BROWSERS_PATH no main para apontar pra lá.
  try {
    const { chromium } = require("playwright-core");
    return chromium;
  } catch (_) {
    const { chromium } = require("playwright");
    return chromium;
  }
}

// ── Núcleo: abrir navegador, garantir sessão, executar regras ────────────────
async function openAndEnsureSession(cfg, log) {
  const chromium = resolveChromium();
  const eprocUrl = cfg.eprocUrl || "https://eproc1g.tjsp.jus.br/eproc/";
  const headless = !cfg.showBrowser;

  // Usamos um PERFIL PERSISTENTE: o navegador guarda cookies e a "confiança
  // do dispositivo" do TJSP numa pasta permanente. Assim, o código de dois
  // fatores (2FA) é pedido apenas na PRIMEIRA vez; depois o tribunal reconhece
  // este computador e não pede mais — exatamente como acontece no navegador comum.
  const path = require("path");
  const os = require("os");
  const userDataDir =
    cfg.browserProfileDir ||
    path.join(os.homedir(), ".atp-manager", "browser-profile");

  // launchPersistentContext devolve diretamente um "context" (não um browser).
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    viewport: { width: 1366, height: 768 },
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  // Para manter compatibilidade com o restante do código, expomos um objeto
  // "browser" cujo close() encerra o contexto persistente.
  const browser = {
    close: async () => {
      try {
        await context.close();
      } catch (_) {}
    },
  };
  const page = context.pages()[0] || (await context.newPage());

  log("info", `Navegando para ${eprocUrl}...`);
  // Rede de tribunal pode oscilar — tentamos até 3 vezes com espera crescente.
  const maxAttempts = 3;
  let lastErr = null;
  let navegou = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await page.goto(eprocUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      await page.waitForTimeout(3000);
      navegou = true;
      break;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const espera = attempt * 4; // 4s, depois 8s
        log(
          "warn",
          `Tentativa ${attempt} de acessar o eproc falhou. Nova tentativa em ${espera}s...`,
        );
        await page.waitForTimeout(espera * 1000);
      }
    }
  }
  if (!navegou) {
    await browser.close();
    throw new Error(
      `Não foi possível acessar o eproc após ${maxAttempts} tentativas: ${lastErr ? lastErr.message : "erro desconhecido"}. Verifique se está na rede do tribunal.`,
    );
  }

  let currentUrl = page.url();
  log("info", `URL atual: ${currentUrl}`);

  if (isSessionExpired(currentUrl)) {
    if (cfg.eprocUsername && cfg.eprocPassword) {
      log("warn", "Sessão expirada. Tentando login automático...");
      const res = await performAutoLogin(
        page,
        cfg.eprocUsername,
        cfg.eprocPassword,
        eprocUrl,
        log,
      );
      if (!res.ok) {
        await browser.close();
        return {
          browser: null,
          context: null,
          page: null,
          status: "session_expired",
          message: res.error,
        };
      }
    } else {
      await browser.close();
      return {
        browser: null,
        context: null,
        page: null,
        status: "session_expired",
        message:
          "Sessão expirada e login automático não configurado. Preencha usuário e senha do eproc.",
      };
    }
  }

  log("info", "Sessão ativa no eproc!");

  // Capturar e reenviar cookies atualizados ao painel
  if (cfg.serverUrl && cfg.token) {
    try {
      const fresh = await context.cookies();
      const toSend = fresh
        .filter((c) => TJSP_DOMAINS.some((d) => (c.domain || "").includes(d)))
        .map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || "/",
          secure: !!c.secure,
          httpOnly: !!c.httpOnly,
          expirationDate: c.expires,
        }));
      if (toSend.length) {
        const n = await sendCookies(cfg.serverUrl, cfg.token, toSend);
        log("info", `${n} cookies atualizados no painel automaticamente.`);
      }
    } catch (err) {
      log(
        "warn",
        `Não foi possível atualizar cookies no painel: ${err.message}`,
      );
    }
  }

  return { browser, context, page, status: "ok", message: "Sessão ativa." };
}

// ── Login manual interativo (primeira vez / 2FA) ─────────────────────────────
// Abre o navegador VISÍVEL no mesmo perfil persistente e deixa o usuário fazer
// o login na mão — incluindo digitar o código de dois fatores e marcar
// "não pedir novamente neste dispositivo". Quando detecta que entrou no eproc,
// salva o perfil e fecha. A partir daí, as execuções automáticas não pedem 2FA.
async function manualLogin(cfg) {
  const log = makeLogger(cfg.onLog);
  const chromium = resolveChromium();
  const eprocUrl = cfg.eprocUrl || "https://eproc1g.tjsp.jus.br/eproc/";
  const path = require("path");
  const os = require("os");
  const userDataDir =
    cfg.browserProfileDir ||
    path.join(os.homedir(), ".atp-manager", "browser-profile");

  log(
    "info",
    "Abrindo o navegador para login manual. Faça login normalmente — se pedir o código de dois fatores, digite-o e marque 'não pedir novamente neste dispositivo'.",
  );

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false, // SEMPRE visível — o usuário precisa interagir
    viewport: { width: 1366, height: 768 },
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = context.pages()[0] || (await context.newPage());
  try {
    await page.goto(eprocUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
  } catch (_) {}

  // Aguarda (até 5 minutos) o usuário concluir o login manualmente.
  // Consideramos "logado" quando a URL é do eproc e não é mais tela de login.
  log("info", "Aguardando você concluir o login (até 5 minutos)...");
  const limite = Date.now() + 5 * 60 * 1000;
  let logou = false;
  while (Date.now() < limite) {
    await page.waitForTimeout(2000);
    let url = "";
    try {
      url = page.url();
    } catch (_) {
      // página pode ter sido fechada pelo usuário
      break;
    }
    if (url.includes("eproc") && !isSessionExpired(url)) {
      logou = true;
      break;
    }
  }

  // Captura os cookies do perfil e envia ao painel, se conectado
  if (logou) {
    log("info", "Login concluído! Salvando a confiança deste dispositivo...");
    try {
      const fresh = await context.cookies();
      const toSend = fresh
        .filter((c) => TJSP_DOMAINS.some((d) => (c.domain || "").includes(d)))
        .map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || "/",
          secure: !!c.secure,
          httpOnly: !!c.httpOnly,
          expirationDate: c.expires,
        }));
      if (toSend.length && cfg.serverUrl && cfg.token) {
        const n = await sendCookies(cfg.serverUrl, cfg.token, toSend);
        log("info", `${n} cookies sincronizados com o painel.`);
      }
    } catch (err) {
      log("warn", `Não foi possível sincronizar cookies: ${err.message}`);
    }
  } else {
    log(
      "warn",
      "Não detectei o login concluído. Você pode tentar novamente quando quiser.",
    );
  }

  await context.close();
  return {
    status: logou ? "success" : "error",
    message: logou
      ? "Login manual concluído. As próximas verificações serão automáticas, sem pedir o código de dois fatores."
      : "O login manual não foi concluído. Tente novamente.",
  };
}

// ── Modo keepalive: apenas renova a sessão/cookies ───────────────────────────
async function keepalive(cfg) {
  const log = makeLogger(cfg.onLog);
  log("info", `ATP Manager Agent v${VERSION} — modo renovação de sessão.`);
  const sess = await openAndEnsureSession(cfg, log);
  if (sess.browser) await sess.browser.close();
  if (sess.status !== "ok") {
    if (cfg.serverUrl && cfg.token) {
      await reportResult(cfg.serverUrl, cfg.token, {
        status: sess.status,
        message: sess.message,
        durationMs: 0,
        totalProcessed: 0,
        totalSuccess: 0,
        totalError: 0,
        totalSkipped: 0,
      }).catch(() => {});
    }
    throw new Error(sess.message);
  }
  log("info", "Renovação de sessão concluída.");
  return { status: "success", message: "Sessão renovada com sucesso." };
}

// ── Modo execução: roda as regras ATP ────────────────────────────────────────
async function runNow(cfg) {
  const log = makeLogger(cfg.onLog);
  const setStatus =
    typeof cfg.onStatus === "function" ? cfg.onStatus : () => {};
  const startTime = Date.now();
  log("info", `ATP Manager Agent v${VERSION} — iniciando execução.`);
  setStatus("Conectando ao eproc...");

  // Buscar regras e credenciais do painel
  let rulesData = [];
  if (cfg.serverUrl && cfg.token) {
    try {
      const data = await getRules(cfg.serverUrl, cfg.token);
      rulesData = Array.isArray(data) ? data : data.rules || [];
      log(
        "info",
        `${rulesData.length} regra(s) ATP ativa(s) recuperada(s) do painel.`,
      );
    } catch (err) {
      log("warn", `Não foi possível buscar regras do painel: ${err.message}`);
    }
    // Buscar credenciais se não estiverem na config local
    if (!cfg.eprocUsername || !cfg.eprocPassword) {
      try {
        const creds = await getCredentials(cfg.serverUrl, cfg.token);
        if (creds && creds.autoLoginEnabled) {
          cfg.eprocUsername = cfg.eprocUsername || creds.eprocUsername;
          cfg.eprocPassword = cfg.eprocPassword || creds.eprocPassword;
        }
      } catch (_) {}
    }
  }

  const sess = await openAndEnsureSession(cfg, log);
  if (sess.status !== "ok") {
    if (cfg.serverUrl && cfg.token) {
      await reportResult(cfg.serverUrl, cfg.token, {
        status: sess.status,
        message: sess.message,
        durationMs: Date.now() - startTime,
        totalProcessed: 0,
        totalSuccess: 0,
        totalError: 0,
        totalSkipped: 0,
      }).catch(() => {});
    }
    setStatus("Sessão expirada");
    throw new Error(sess.message);
  }

  const { browser, page } = sess;
  let summary;

  try {
    if (!rulesData.length) {
      summary = {
        status: "success",
        message: "Sessão verificada. Nenhuma regra ATP ativa para executar.",
        durationMs: Date.now() - startTime,
        totalProcessed: 0,
        totalSuccess: 0,
        totalError: 0,
        totalSkipped: 0,
      };
    } else {
      // O motor detalhado de execução de regras (PJ Autora, classificação,
      // movimentação) é portado no módulo rulesEngine para manter este
      // arquivo legível. Aqui orquestramos a chamada.
      const rulesEngine = require("./rulesEngine");
      summary = await rulesEngine.execute({
        page,
        rules: rulesData,
        baseUrl: (cfg.eprocUrl || "").replace(/\/$/, ""),
        serverUrl: cfg.serverUrl,
        token: cfg.token,
        log,
        startTime,
        dryRun: !!cfg.dryRun,
        screenshotDir: cfg.screenshotDir || null,
      });
    }
  } catch (err) {
    summary = {
      status: "error",
      message: `Erro durante execução: ${err.message}`,
      durationMs: Date.now() - startTime,
      totalProcessed: 0,
      totalSuccess: 0,
      totalError: 0,
      totalSkipped: 0,
    };
  } finally {
    if (browser) await browser.close();
  }

  // Reportar ao painel (exceto em simulação, para não poluir o histórico real)
  if (cfg.serverUrl && cfg.token && !cfg.dryRun) {
    await reportResult(cfg.serverUrl, cfg.token, summary).catch((e) =>
      log("warn", `Falha ao reportar resultado: ${e.message}`),
    );
  }

  log(
    summary.status === "error" ? "error" : "info",
    `Execução finalizada: ${summary.message} (processados: ${summary.totalProcessed}, sucesso: ${summary.totalSuccess}, erros: ${summary.totalError})`,
  );
  setStatus(summary.status === "error" ? "Erro na execução" : "Pronto");
  return { summary };
}

// ── Diagnóstico do ambiente ──────────────────────────────────────────────────
async function diagnose(cfg) {
  const result = { version: VERSION, checks: [] };

  // Chromium disponível?
  try {
    const chromium = resolveChromium();
    const b = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    await b.close();
    result.checks.push({
      name: "Navegador (Chromium)",
      ok: true,
      detail: "Disponível e funcional.",
    });
  } catch (err) {
    result.checks.push({
      name: "Navegador (Chromium)",
      ok: false,
      detail: err.message,
    });
  }

  // Conexão com o painel?
  if (cfg.serverUrl && cfg.token) {
    const v = await validateToken(cfg.serverUrl, cfg.token);
    result.checks.push({
      name: "Conexão com o painel",
      ok: v.ok,
      detail: v.ok ? "Token válido." : v.error,
    });
  } else {
    result.checks.push({
      name: "Conexão com o painel",
      ok: false,
      detail: "Token não configurado.",
    });
  }

  // Credenciais eproc?
  result.checks.push({
    name: "Login automático eproc",
    ok: !!(cfg.eprocUsername && cfg.eprocPassword),
    detail: cfg.eprocUsername
      ? `Configurado para ${cfg.eprocUsername}.`
      : "Usuário/senha não configurados.",
  });

  result.allOk = result.checks.every((c) => c.ok);
  return result;
}

module.exports = {
  VERSION,
  validateToken,
  runNow,
  keepalive,
  manualLogin,
  diagnose,
  // exportado para testes
  isSessionExpired,
  performAutoLogin,
};
