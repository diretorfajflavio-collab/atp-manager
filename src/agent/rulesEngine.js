/**
 * ATP Manager — Motor de Regras ATP (Rules Engine)
 * =================================================
 * Porte fiel de run_local_automation() + funções PJ Autora do agente Python.
 * Recebe uma página Playwright já autenticada e executa as regras ATP ativas:
 *   - Navega pelos localizadores (PETIÇÃO INICIAL JEE) com paginação
 *   - Detecta CNPJ no polo ativo (PJ Autora)
 *   - Move processos para localizador e lança movimentos
 *   - Avalia condições e aplica ações genéricas
 */

const PROC_REGEX = /\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/;

// ── Captura de tela em caso de falha (ajuda a corrigir seletores) ────────────
// Salva um print do que o eproc mostrava quando algo deu errado. As imagens
// vão para a pasta de diagnóstico informada pelo app (opts.screenshotDir).
async function captureFailure(page, label, opts, log) {
  try {
    if (!opts || !opts.screenshotDir) return null;
    const fs = require("fs");
    const path = require("path");
    fs.mkdirSync(opts.screenshotDir, { recursive: true });
    const safe = String(label)
      .replace(/[^a-z0-9_-]/gi, "_")
      .slice(0, 60);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(opts.screenshotDir, `falha_${safe}_${stamp}.png`);
    await page.screenshot({ path: file, fullPage: true });
    if (log) log("info", `Captura de tela salva para diagnóstico: ${file}`);
    return file;
  } catch (err) {
    if (log) log("warn", `Não foi possível capturar a tela: ${err.message}`);
    return null;
  }
}

// ── Avaliação de condições (idêntico ao Python) ──────────────────────────────
function evaluateCondition(condition, data) {
  const fieldValue = String(data[condition.field] ?? "").toLowerCase();
  let condValue = condition.value;
  const operator = condition.operator || "contains";

  const condList = Array.isArray(condValue)
    ? condValue.map((v) => String(v).toLowerCase())
    : [String(condValue).toLowerCase()];
  const single = String(
    Array.isArray(condValue) ? "" : condValue,
  ).toLowerCase();

  switch (operator) {
    case "equals":
      return fieldValue === single;
    case "contains":
      return fieldValue.includes(single);
    case "startsWith":
      return fieldValue.startsWith(single);
    case "endsWith":
      return fieldValue.endsWith(single);
    case "in":
      return condList.some((v) => fieldValue.includes(v));
    case "notIn":
      return !condList.some((v) => fieldValue.includes(v));
    default:
      return false;
  }
}

function matchesRule(rule, data) {
  const conditions = rule.conditions || [];
  if (!conditions.length) return true;
  return conditions.every((c) => evaluateCondition(c, data));
}

// ── Cálculo de dias úteis (feriados nacionais fixos) ─────────────────────────
function addBusinessDays(startDate, days) {
  const fixedHolidays = new Set([
    "1-1",
    "4-21",
    "5-1",
    "9-7",
    "10-12",
    "11-2",
    "11-15",
    "12-25",
  ]);
  const current = new Date(startDate);
  let added = 0;
  while (added < days) {
    current.setDate(current.getDate() + 1);
    const dow = current.getDay(); // 0=dom ... 6=sáb
    if (dow >= 1 && dow <= 5) {
      const key = `${current.getMonth() + 1}-${current.getDate()}`;
      if (!fixedHolidays.has(key)) added += 1;
    }
  }
  return current;
}

// ── Comunicação PJ Autora com o painel ───────────────────────────────────────
async function getPjProcessedList(serverUrl, token, log) {
  try {
    const resp = await fetch(`${serverUrl}/api/agent/pj-autora/processed`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.ok) {
      const data = await resp.json();
      return new Set(data.processNumbers || []);
    }
  } catch (err) {
    log(
      "warn",
      `Não foi possível buscar processos PJ já processados: ${err.message}`,
    );
  }
  return new Set();
}

async function registerPjAutora(serverUrl, token, processData, log) {
  try {
    const resp = await fetch(`${serverUrl}/api/agent/pj-autora/register`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(processData),
    });
    if (resp.ok) {
      const data = await resp.json();
      return { ok: !!data.ok, alreadyExists: !!data.alreadyExists };
    }
    return { ok: false, alreadyExists: false, error: `HTTP ${resp.status}` };
  } catch (err) {
    return { ok: false, alreadyExists: false, error: err.message };
  }
}

// ── Detecção de PJ Autora (CNPJ no polo ativo) ───────────────────────────────
async function detectPjAutora(page, processNumber, baseUrl, log) {
  const clean = processNumber.replace(/\./g, "").replace(/-/g, "");
  try {
    const procUrl = `${baseUrl}/externo_controlador.php?acao=processo_selecionar&num_processo=${clean}`;
    await page.goto(procUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);

    const currentUrl = page.url();
    if (
      !currentUrl.includes("processo_selecionar") &&
      !currentUrl.includes("processo_consultar")
    ) {
      const searchUrl = `${baseUrl}/externo_controlador.php?acao=processo_consultar&num_processo=${processNumber}`;
      await page.goto(searchUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await page.waitForTimeout(2000);
    }

    const pageText = await page.content();

    // Extrair seção do polo ativo
    const poloMatch = pageText.match(
      /(?:polo\s+ativo|autora?|requerente)[^<]{0,500}/i,
    );
    const poloSection = poloMatch ? poloMatch[0] : pageText.slice(0, 5000);

    // CNPJ formatado ou 14 dígitos
    const cnpjFormatted = poloSection.match(
      /\b(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})\b/,
    );
    const cnpjRaw = poloSection.match(/\b(\d{14})\b/);
    const cnpjMatch = cnpjFormatted || cnpjRaw;

    if (cnpjMatch) {
      const cnpj = cnpjMatch[1];
      let authorName = null;
      const nameMatch = poloSection.match(
        /(?:autora?|requerente)[^<]{0,200}?([A-ZÁÉÍÓÚÂÊÎÔÛÃÕÇ][A-ZÁÉÍÓÚÂÊÎÔÛÃÕÇ\s.&]{5,80})/i,
      );
      if (nameMatch) authorName = nameMatch[1].trim();

      let autuacaoDate = null;
      const dateMatch = pageText.match(
        /autua[çc][aã]o[^<]{0,100}?(\d{2}\/\d{2}\/\d{4})/i,
      );
      if (dateMatch) {
        const [d, m, y] = dateMatch[1].split("/");
        autuacaoDate = new Date(`${y}-${m}-${d}`);
      }
      return { isPj: true, cnpj, authorName, autuacaoDate };
    }
    return { isPj: false };
  } catch (err) {
    log(
      "warn",
      `Erro ao verificar PJ autora no processo ${processNumber}: ${err.message}`,
    );
    return { isPj: false };
  }
}

// ── Mover processo para localizador ──────────────────────────────────────────
async function moveToLocalizador(
  page,
  processNumber,
  localizadorName,
  baseUrl,
) {
  const clean = processNumber.replace(/\./g, "").replace(/-/g, "");
  try {
    const procUrl = `${baseUrl}/externo_controlador.php?acao=processo_selecionar&num_processo=${clean}`;
    await page.goto(procUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);

    let moveBtn = page
      .locator("a:has-text('Localizador'), button:has-text('Localizador')")
      .first();
    if ((await moveBtn.count()) === 0) {
      const actionsMenu = page
        .locator("a:has-text('Ações'), #menu_acoes, .menu-acoes")
        .first();
      if ((await actionsMenu.count()) > 0) {
        await actionsMenu.click();
        await page.waitForTimeout(1000);
        moveBtn = page.locator("a:has-text('Localizador')").first();
      }
    }
    if ((await moveBtn.count()) === 0) {
      const locUrl = `${baseUrl}/externo_controlador.php?acao=processo_localizador_alterar&num_processo=${clean}`;
      await page.goto(locUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await page.waitForTimeout(2000);
    } else {
      await moveBtn.click();
      await page.waitForTimeout(2000);
    }

    const selectLoc = page
      .locator(
        "select[name*='localizador'], select[id*='localizador'], select[name*='Localizador']",
      )
      .first();
    if ((await selectLoc.count()) > 0) {
      await selectLoc.selectOption({ label: localizadorName });
      await page.waitForTimeout(500);
    } else {
      const inputLoc = page
        .locator("input[name*='localizador'], input[id*='localizador']")
        .first();
      if ((await inputLoc.count()) > 0) {
        await inputLoc.fill(localizadorName);
        await page.waitForTimeout(500);
      } else {
        return {
          ok: false,
          error: "Campo de localizador não encontrado na página.",
        };
      }
    }

    const saveBtn = page
      .locator(
        "button:has-text('Salvar'), button:has-text('Confirmar'), input[type='submit'][value*='Salvar'], input[type='submit'][value*='Confirmar']",
      )
      .first();
    if ((await saveBtn.count()) > 0) {
      await saveBtn.click();
      await page.waitForTimeout(2000);
      return { ok: true };
    }
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2000);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Lançar movimento "Verificação Documentação" ──────────────────────────────
async function launchMovement(page, processNumber, baseUrl) {
  const clean = processNumber.replace(/\./g, "").replace(/-/g, "");
  try {
    const movUrl = `${baseUrl}/externo_controlador.php?acao=processo_movimento_incluir&num_processo=${clean}`;
    await page.goto(movUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);

    const searchInput = page
      .locator(
        "input[name*='movimento'], input[id*='movimento'], input[placeholder*='movimento'], input[placeholder*='Movimento']",
      )
      .first();
    if ((await searchInput.count()) > 0) {
      await searchInput.fill("Verificação Documentação");
      await page.waitForTimeout(1000);
      const suggestion = page
        .locator(
          "li:has-text('Verificação Documentação'), option:has-text('Verificação Documentação'), td:has-text('Verificação Documentação')",
        )
        .first();
      if ((await suggestion.count()) > 0) {
        await suggestion.click();
        await page.waitForTimeout(500);
      }
    } else {
      const selectMov = page
        .locator("select[name*='movimento'], select[id*='movimento']")
        .first();
      if ((await selectMov.count()) > 0) {
        try {
          await selectMov.selectOption({ label: "Verificação Documentação" });
        } catch (_) {
          const options = await selectMov.locator("option").all();
          for (const opt of options) {
            const txt = ((await opt.textContent()) || "").trim().toLowerCase();
            if (txt.includes("verifica") && txt.includes("doc")) {
              const val = await opt.getAttribute("value");
              if (val) {
                await selectMov.selectOption(val);
                break;
              }
            }
          }
        }
        await page.waitForTimeout(500);
      }
    }

    const saveBtn = page
      .locator(
        "button:has-text('Incluir'), button:has-text('Salvar'), button:has-text('Confirmar'), input[type='submit'][value*='Incluir'], input[type='submit'][value*='Salvar']",
      )
      .first();
    if ((await saveBtn.count()) > 0) {
      await saveBtn.click();
      await page.waitForTimeout(2000);
      return { ok: true };
    }
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2000);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Executar regra PJ Autora em um processo ──────────────────────────────────
async function executePjAutoraRule(
  page,
  petition,
  baseUrl,
  serverUrl,
  token,
  processedSet,
  log,
  opts = {},
) {
  const dryRun = !!opts.dryRun;
  const processNumber = petition.processNumber;
  if (processedSet.has(processNumber)) {
    return {
      success: true,
      actionTaken: "Processo já processado anteriormente (ignorado)",
      status: "skipped",
    };
  }

  log("info", `Verificando PJ autora no processo ${processNumber}...`);
  const { isPj, cnpj, authorName, autuacaoDate } = await detectPjAutora(
    page,
    processNumber,
    baseUrl,
    log,
  );
  if (!isPj) {
    return {
      success: true,
      actionTaken: "Parte autora não é PJ (sem CNPJ detectado)",
      status: "skipped",
    };
  }

  log("info", `PJ detectada! CNPJ: ${cnpj} | Autor: ${authorName || "N/D"}`);

  // ── Modo simulação: não altera o processo, apenas relata o que faria ──
  if (dryRun) {
    log(
      "info",
      `[SIMULAÇÃO] Moveria para 'ANÁLISE PJ AUTORA' e lançaria 'Verificação Documentação'.`,
    );
    const deadline = addBusinessDays(new Date(), 10);
    return {
      success: true,
      actionTaken: `[Simulação] PJ detectada (CNPJ: ${cnpj}). Moveria para ANÁLISE PJ AUTORA e lançaria Verificação Documentação. Prazo: ${deadline.toLocaleDateString("pt-BR")}.`,
      status: "simulated",
      cnpj,
      authorName,
      deadlineDate: deadline.toISOString(),
    };
  }

  const moved = await moveToLocalizador(
    page,
    processNumber,
    "ANÁLISE PJ AUTORA",
    baseUrl,
  );
  if (!moved.ok) log("warn", `Falha ao mover localizador: ${moved.error}`);

  const mov = await launchMovement(page, processNumber, baseUrl);
  if (!mov.ok) log("warn", `Falha ao lançar movimento: ${mov.error}`);

  const deadline = addBusinessDays(new Date(), 10);
  const deadlineStr = deadline.toISOString();

  if (serverUrl && token) {
    const reg = await registerPjAutora(
      serverUrl,
      token,
      {
        processNumber,
        cnpj,
        authorName,
        autuacaoDate: autuacaoDate ? autuacaoDate.toISOString() : null,
        movedToLocalizador: moved.ok,
        movementLaunched: mov.ok,
        deadlineDate: deadlineStr,
        notes: moved.error || mov.error || null,
      },
      log,
    );
    if (reg.ok && !reg.alreadyExists) {
      processedSet.add(processNumber);
      log(
        "info",
        `Prazo: ${deadline.toLocaleDateString("pt-BR")} (10 dias úteis)`,
      );
    } else if (reg.error) {
      log("warn", `Erro ao registrar no painel: ${reg.error}`);
    }
  }

  const parts = [];
  if (moved.ok) parts.push("Movido para ANÁLISE PJ AUTORA");
  if (mov.ok) parts.push("Movimento 'Verificação Documentação' lançado");
  if (!moved.ok && !mov.ok)
    parts.push(`PJ detectada (CNPJ: ${cnpj}) — ações manuais necessárias`);

  return {
    success: moved.ok || mov.ok,
    actionTaken: parts.join(" | ") || "PJ detectada",
    status: moved.ok || mov.ok ? "success" : "error",
    errorMessage: !(moved.ok || mov.ok) ? moved.error || mov.error : null,
    cnpj,
    authorName,
    deadlineDate: deadlineStr,
  };
}

// ── Coletar processos do localizador PETIÇÃO INICIAL JEE (com paginação) ─────
async function collectPeticaoInicialProcessos(page, baseUrl, log, opts = {}) {
  const petitions = [];
  log("info", "Buscando processos no localizador 'PETIÇÃO INICIAL JEE'...");
  try {
    const painelUrl = `${baseUrl}/controlador.php?acao=painel_secretaria_listar&acao_origem=principal`;
    await page.goto(painelUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForTimeout(3000);

    // Localizar o link do localizador no painel
    let locUrlDirect = null;
    const allLinks = await page
      .locator("a[href*='localizador_processos_lista']")
      .all();
    for (const lnk of allLinks) {
      const href = (await lnk.getAttribute("href")) || "";
      const txt = ((await lnk.textContent()) || "").trim().toUpperCase();
      let parentTxt = "";
      try {
        parentTxt = (
          (await lnk.locator("xpath=..").textContent()) || ""
        ).toUpperCase();
      } catch (_) {}
      if (
        txt.includes("PETICAO INICIAL JEE") ||
        txt.includes("PETIÇÃO INICIAL JEE") ||
        parentTxt.includes("PETICAO INICIAL JEE") ||
        parentTxt.includes("PETIÇÃO INICIAL JEE")
      ) {
        if (href) {
          locUrlDirect = href.startsWith("http")
            ? href
            : `${baseUrl}/${href.replace(/^\//, "")}`;
          break;
        }
      }
    }

    if (!locUrlDirect) {
      // Buscar pela linha da tabela
      const rows = await page.locator("tr").all();
      for (const row of rows) {
        const rowTxt = ((await row.textContent()) || "").toUpperCase();
        if (
          rowTxt.includes("PETICAO INICIAL JEE") ||
          rowTxt.includes("PETIÇÃO INICIAL JEE")
        ) {
          const lnk = row.locator("a[href*='localizador']").first();
          if ((await lnk.count()) > 0) {
            const href = (await lnk.getAttribute("href")) || "";
            if (href) {
              locUrlDirect = href.startsWith("http")
                ? href
                : `${baseUrl}/${href.replace(/^\//, "")}`;
              break;
            }
          }
        }
      }
    }

    if (!locUrlDirect) {
      log(
        "warn",
        "Link do localizador 'PETIÇÃO INICIAL JEE' não encontrado no painel.",
      );
      await captureFailure(page, "localizador_nao_encontrado", opts, log);
      return petitions;
    }

    log("info", `Localizador encontrado. Carregando lista...`);
    await page.goto(locUrlDirect, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForTimeout(3000);

    try {
      await page.waitForSelector("a[href*='processo_selecionar']", {
        timeout: 10000,
      });
    } catch (_) {
      log("warn", "Página do localizador não carregou a lista de processos.");
    }

    const allProcessNumbers = [];
    let pageNum = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let foundInPage = 0;
      const procLinks = await page
        .locator("a[href*='processo_selecionar']")
        .all();
      for (const lnk of procLinks) {
        const procText = ((await lnk.textContent()) || "")
          .trim()
          .split(/\s+/)
          .join(" ");
        if (
          PROC_REGEX.test(procText) &&
          !allProcessNumbers.includes(procText)
        ) {
          allProcessNumbers.push(procText);
          foundInPage += 1;
        }
      }
      log(
        "info",
        `Página ${pageNum}: ${foundInPage} processo(s) encontrado(s).`,
      );

      const nextBtn = page
        .locator(
          "a[title='Próxima página'], a:has-text('Próxima'), img[alt='Próxima página']",
        )
        .first();
      if ((await nextBtn.count()) > 0 && foundInPage > 0) {
        await nextBtn.click();
        await page.waitForTimeout(3000);
        pageNum += 1;
      } else {
        break;
      }
    }

    log(
      "info",
      `Total: ${allProcessNumbers.length} processo(s) no localizador.`,
    );
    for (const procNum of allProcessNumbers) {
      petitions.push({
        processNumber: procNum,
        petitionType: "Petição Inicial",
        petitionDescription: "Processo no localizador PETIÇÃO INICIAL JEE",
        localizador: "PETIÇÃO INICIAL JEE",
        rawData: {
          tipo_peticao: "inicial",
          localizador: "PETIÇÃO INICIAL JEE",
          processo: procNum,
        },
      });
    }
  } catch (err) {
    log("warn", `Erro ao buscar processos no localizador: ${err.message}`);
  }
  return petitions;
}

// ── Orquestração principal ───────────────────────────────────────────────────
async function execute({
  page,
  rules,
  baseUrl,
  serverUrl,
  token,
  log,
  startTime,
  dryRun = false,
  screenshotDir = null,
}) {
  const processResults = [];
  let totalProcessed = 0;
  let totalSuccess = 0;
  let totalError = 0;
  let totalSkipped = 0;
  const opts = { dryRun, screenshotDir };

  if (dryRun) {
    log(
      "info",
      "MODO SIMULAÇÃO ativo: nenhum processo será alterado. O programa apenas relata o que faria.",
    );
  }

  // Processos PJ já tratados
  let pjProcessedSet = new Set();
  if (serverUrl && token) {
    pjProcessedSet = await getPjProcessedList(serverUrl, token, log);
    if (pjProcessedSet.size) {
      log(
        "info",
        `${pjProcessedSet.size} processo(s) PJ autora já processados anteriormente (serão ignorados).`,
      );
    }
  }

  // Identificar se há regras PJ Autora
  const pjAutoraRules = rules.filter((r) =>
    (r.actions || []).some((a) => a.type === "pj_autora"),
  );

  let petitions = [];
  if (pjAutoraRules.length) {
    petitions = await collectPeticaoInicialProcessos(page, baseUrl, log, opts);
  } else {
    // Lógica legada: petições pendentes
    try {
      const petUrl = `${baseUrl}/externo_controlador.php?acao=peticao_listar&acao_origem=menu`;
      await page.goto(petUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await page.waitForTimeout(2000);
      const rows = await page
        .locator("table.infraTable tbody tr, table[id*='peticao'] tbody tr")
        .all();
      for (const row of rows) {
        const cells = await row.locator("td").all();
        if (cells.length < 3) continue;
        const procNum = ((await cells[0].textContent()) || "").trim();
        const petType = ((await cells[1].textContent()) || "").trim();
        const petDesc = ((await cells[2].textContent()) || "").trim();
        if (procNum && PROC_REGEX.test(procNum)) {
          petitions.push({
            processNumber: procNum,
            petitionType: petType || "Petição",
            petitionDescription: petDesc,
            rawData: {
              tipo_peticao: petType.toLowerCase(),
              descricao: petDesc.toLowerCase(),
              processo: procNum,
            },
          });
        }
      }
      log(
        "info",
        `${petitions.length} petição(ões) pendente(s) encontrada(s).`,
      );
    } catch (err) {
      log("warn", `Erro ao buscar petições: ${err.message}`);
    }
  }

  // Processar cada petição
  for (const petition of petitions) {
    totalProcessed += 1;
    try {
      const matchedRule = rules.find((r) => matchesRule(r, petition.rawData));

      if (!matchedRule) {
        totalSkipped += 1;
        processResults.push({
          processNumber: petition.processNumber,
          petitionType: petition.petitionType,
          petitionDescription: petition.petitionDescription,
          localizador: petition.localizador || "—",
          actionTaken: "Nenhuma regra correspondente",
          status: "skipped",
        });
        continue;
      }

      const actions = matchedRule.actions || [];
      let actionResult = {
        success: true,
        actionTaken: "Ação executada",
        errorMessage: null,
      };

      for (const action of actions) {
        const actionType = action.type || "";
        const params = action.params || {};
        try {
          if (actionType === "pj_autora") {
            const pj = await executePjAutoraRule(
              page,
              petition,
              baseUrl,
              serverUrl,
              token,
              pjProcessedSet,
              log,
              { dryRun },
            );
            actionResult = {
              success: pj.success,
              actionTaken: pj.actionTaken,
              errorMessage: pj.errorMessage,
              simulated: pj.status === "simulated",
            };
            if (pj.status === "skipped") {
              actionResult = {
                success: true,
                actionTaken: pj.actionTaken,
                errorMessage: null,
              };
            }
          } else if (actionType === "movimentar") {
            const movimento = params.movimento || "";
            const descricao = params.descricao || "Movimento automático";
            actionResult = {
              success: true,
              actionTaken: `Movimento ${movimento}: ${descricao}`,
              errorMessage: null,
            };
          } else if (actionType === "classificar_peticao") {
            const usarIa = params.usar_ia === "true";
            actionResult = {
              success: true,
              actionTaken: `Petição classificada${usarIa ? " com IA" : ""}`,
              errorMessage: null,
            };
          } else if (actionType === "encaminhar_fluxo") {
            const baseadoEm = params.baseado_em || "tipo_peticao";
            actionResult = {
              success: true,
              actionTaken: `Fluxo encaminhado: ${baseadoEm}`,
              errorMessage: null,
            };
          } else {
            actionResult = {
              success: false,
              actionTaken: actionType,
              errorMessage: `Tipo não suportado: ${actionType}`,
            };
            break;
          }
        } catch (err) {
          actionResult = {
            success: false,
            actionTaken: actionType,
            errorMessage: err.message,
          };
          break;
        }
      }

      if (actionResult.success) totalSuccess += 1;
      else totalError += 1;

      processResults.push({
        processNumber: petition.processNumber,
        petitionType: petition.petitionType,
        petitionDescription: petition.petitionDescription,
        localizador: petition.localizador || "—",
        actionTaken: actionResult.actionTaken,
        ruleApplied: matchedRule.name || "—",
        status: actionResult.success ? "success" : "error",
        errorMessage: actionResult.errorMessage,
      });
    } catch (err) {
      // Falha isolada num processo não interrompe o lote inteiro
      totalError += 1;
      log(
        "error",
        `Erro ao processar ${petition.processNumber}: ${err.message}`,
      );
      await captureFailure(
        page,
        `processo_${petition.processNumber}`,
        opts,
        log,
      );
      processResults.push({
        processNumber: petition.processNumber,
        petitionType: petition.petitionType,
        petitionDescription: petition.petitionDescription,
        localizador: petition.localizador || "—",
        actionTaken: "Falha inesperada ao processar",
        status: "error",
        errorMessage: err.message,
      });
    }
  }

  const status = totalError > 0 ? "error" : "success";
  const prefixo = dryRun ? "[Simulação] " : "";
  const message =
    totalError > 0
      ? `${prefixo}Concluído com erros: ${totalSuccess} sucesso(s), ${totalError} erro(s), ${totalSkipped} ignorado(s).`
      : `${prefixo}Concluído: ${totalSuccess} ${dryRun ? "processo(s) que seriam tratados" : "sucesso(s)"}, ${totalSkipped} ignorado(s).`;

  return {
    status,
    message,
    dryRun,
    durationMs: Date.now() - startTime,
    totalProcessed,
    totalSuccess,
    totalError,
    totalSkipped,
    processResults,
  };
}

module.exports = {
  execute,
  // exportados para testes
  evaluateCondition,
  matchesRule,
  addBusinessDays,
  executePjAutoraRule,
  captureFailure,
};
