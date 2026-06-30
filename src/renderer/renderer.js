/* ATP Manager — Lógica da Interface (Renderer)
   Conecta a interface gráfica à ponte segura window.atp. */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let config = {};
const historyLog = [];

// ---------- Tradução de mensagens técnicas para linguagem humana ----------
// (definida em shared/messages.js, carregada antes deste script)
const humanizeMessage = window.ATPMessages.humanizeMessage;

// ---------- Onboarding (primeiro uso) ----------
let obStep = 0;
function showOnboarding() {
  $("#onboarding").hidden = false;
  // Pré-preenche endereço do painel
  window.atp.getConfig().then((c) => {
    $("#obServerUrl").value = c.serverUrl || "";
  });
}
function gotoObStep(n) {
  obStep = n;
  $$(".ob-step").forEach((s) =>
    s.classList.toggle("active", Number(s.dataset.step) === n),
  );
  $$(".ob-dot").forEach((d) =>
    d.classList.toggle("active", Number(d.dataset.step) === n),
  );
}
async function finishOnboarding() {
  // Salva o que foi preenchido no assistente
  const partial = {};
  if ($("#obServerUrl").value.trim())
    partial.serverUrl = $("#obServerUrl").value.trim();
  if ($("#obToken").value.trim()) partial.token = $("#obToken").value.trim();
  if ($("#obEprocUser").value.trim())
    partial.eprocUsername = $("#obEprocUser").value.trim();
  if ($("#obEprocPass").value) partial.eprocPassword = $("#obEprocPass").value;
  partial.onboarded = true;
  config = await window.atp.setConfig(partial);
  $("#onboarding").hidden = true;
  await loadConfig();
}

document.addEventListener("click", (e) => {
  if (e.target.classList.contains("ob-next")) {
    if (obStep < 3) gotoObStep(obStep + 1);
  }
  if (e.target.classList.contains("ob-skip")) {
    if (obStep < 3) gotoObStep(3);
  }
});
$("#obFinish") && $("#obFinish").addEventListener("click", finishOnboarding);

// Testar conexão dentro do onboarding
$("#obTestToken") &&
  $("#obTestToken").addEventListener("click", async () => {
    const status = $("#obTokenStatus");
    status.textContent = "Testando...";
    status.className = "inline-status";
    const res = await window.atp.validateToken(
      $("#obServerUrl").value.trim(),
      $("#obToken").value.trim(),
    );
    if (res.ok) {
      status.textContent = "✓ Conectado";
      status.className = "inline-status ok";
      $("#obStep1Next").disabled = false;
    } else {
      status.textContent = "✗ " + humanizeMessage(res.error);
      status.className = "inline-status err";
    }
  });

// ---------- Navegação por abas ----------
$$(".nav-item").forEach((item) => {
  item.addEventListener("click", () => {
    const tab = item.dataset.tab;
    $$(".nav-item").forEach((n) => n.classList.toggle("active", n === item));
    $$(".tab").forEach((t) =>
      t.classList.toggle("active", t.dataset.tab === tab),
    );
  });
});

// ---------- Status ----------
function setStatus(text, kind = "idle") {
  $("#statusText").textContent = text;
  const dot = $("#statusDot");
  dot.className = "dot";
  if (kind === "ok") dot.classList.add("ok");
  else if (kind === "busy") dot.classList.add("busy");
  else if (kind === "err") dot.classList.add("err");
}

// ---------- Log ao vivo ----------
function pushLog(entry) {
  historyLog.unshift(entry);
  // Live log (aba Início)
  const body = $("#liveLogBody");
  const empty = body.querySelector(".log-empty");
  if (empty) empty.remove();
  const line = document.createElement("div");
  line.className = `log-line ${entry.level || "info"}`;
  const time = new Date(entry.at).toLocaleTimeString("pt-BR");
  line.innerHTML = `<span class="t">${time}</span><span class="m">${escapeHtml(entry.message)}</span>`;
  body.prepend(line);
  // Limitar a 200 linhas visíveis
  while (body.children.length > 200) body.lastChild.remove();

  renderHistory();
}

function renderHistory() {
  const table = $("#logTable");
  if (!historyLog.length) {
    table.innerHTML = '<div class="log-empty">Sem registros ainda.</div>';
    return;
  }
  table.innerHTML = "";
  historyLog.slice(0, 300).forEach((e) => {
    const row = document.createElement("div");
    row.className = `log-row ${e.level || "info"}`;
    const time = new Date(e.at).toLocaleString("pt-BR");
    row.innerHTML = `<span class="time">${time}</span><span class="msg">${escapeHtml(e.message)}</span>`;
    table.appendChild(row);
  });
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

// ---------- Carregar configuração ----------
async function loadConfig() {
  config = await window.atp.getConfig();
  $("#serverUrl").value = config.serverUrl || "";
  $("#token").value = config.token || "";
  $("#eprocUsername").value = config.eprocUsername || "";
  $("#eprocUrl").value =
    config.eprocUrl || "https://eproc1g.tjsp.jus.br/eproc/";
  $("#scheduleEnabled").checked = !!config.scheduleEnabled;
  $("#scheduleTimes").value = (config.scheduleTimes || []).join(", ");
  $("#keepaliveEnabled").checked = !!config.keepaliveEnabled;
  $("#keepaliveTime").value = config.keepaliveTime || "08:00";
  $("#autostart").checked = !!config.autostart;
  $("#showBrowser").checked = !!config.showBrowser;

  // Dias
  const days = config.scheduleDays || [];
  $$(".day").forEach((d) =>
    d.classList.toggle("on", days.includes(d.dataset.day)),
  );

  // Resumo na home
  updateHomeSummary();
  updateHealth();
  setStatus("Pronto", "ok");
}

// ---------- Banner de saúde geral ----------
async function updateHealth() {
  const banner = $("#healthBanner");
  const ico = $("#healthIco");
  const title = $("#healthTitle");
  const sub = $("#healthSub");
  const action = $("#healthAction");

  // Checagens rápidas locais primeiro
  const faltando = [];
  if (!config.token) faltando.push("código de acesso");
  if (!config.eprocUsername) faltando.push("usuário do eproc");
  if (!config.hasPassword && !config.eprocPassword)
    faltando.push("senha do eproc");

  banner.className = "health";
  if (faltando.length) {
    banner.classList.add("warn");
    ico.textContent = "▲";
    title.textContent = "Falta configurar";
    sub.textContent = `Pendente: ${faltando.join(", ")}. Abra a aba Configuração.`;
    action.hidden = false;
    action.onclick = () =>
      document.querySelector('.nav-item[data-tab="config"]').click();
    return;
  }

  // Tudo preenchido: confirma conexão com o painel em segundo plano
  title.textContent = "Conferindo conexão…";
  sub.textContent = "Validando o código de acesso.";
  const res = await window.atp.validateToken(config.serverUrl, config.token);
  if (res.ok) {
    banner.classList.add("ok");
    ico.textContent = "✓";
    title.textContent = "Tudo certo";
    sub.textContent = config.scheduleEnabled
      ? "O programa está configurado e fará as verificações automáticas."
      : "Conectado. A verificação automática está desativada.";
    action.hidden = true;
  } else {
    banner.classList.add("err");
    ico.textContent = "✕";
    title.textContent = "Precisa de atenção";
    sub.textContent = humanizeMessage(res.error);
    action.hidden = false;
    action.textContent = "Rever conexão";
    action.onclick = () =>
      document.querySelector('.nav-item[data-tab="config"]').click();
  }
}

function updateHomeSummary() {
  if (config.scheduleEnabled && (config.scheduleTimes || []).length) {
    const dayNames = {
      MON: "Seg",
      TUE: "Ter",
      WED: "Qua",
      THU: "Qui",
      FRI: "Sex",
      SAT: "Sáb",
      SUN: "Dom",
    };
    const days = (config.scheduleDays || []).map((d) => dayNames[d]).join(", ");
    $("#autoSummary").textContent = "Ativada";
    $("#autoSub").textContent =
      `${days} às ${(config.scheduleTimes || []).join(", ")}`;
  } else {
    $("#autoSummary").textContent = "Desativada";
    $("#autoSub").textContent = "Ative na aba Configuração para rodar sozinho.";
  }
  if (config.lastRun) {
    $("#lastRun").textContent = new Date(config.lastRun).toLocaleString(
      "pt-BR",
    );
    if (config.lastRunResult)
      $("#lastRunResult").textContent = config.lastRunResult.message || "";
  }
}

// ---------- Seletor de dias ----------
$$(".day").forEach((d) => {
  d.addEventListener("click", () => d.classList.toggle("on"));
});

// ---------- Salvar ----------
$("#btnSave").addEventListener("click", async () => {
  const selectedDays = Array.from($$(".day.on")).map((d) => d.dataset.day);
  const times = $("#scheduleTimes")
    .value.split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const partial = {
    serverUrl: $("#serverUrl").value.trim(),
    token: $("#token").value.trim(),
    eprocUsername: $("#eprocUsername").value.trim(),
    eprocUrl:
      $("#eprocUrl").value.trim() || "https://eproc1g.tjsp.jus.br/eproc/",
    scheduleEnabled: $("#scheduleEnabled").checked,
    scheduleDays: selectedDays,
    scheduleTimes: times,
    keepaliveEnabled: $("#keepaliveEnabled").checked,
    keepaliveTime: $("#keepaliveTime").value.trim() || "08:00",
    showBrowser: $("#showBrowser").checked,
  };

  // Senha: só envia se foi preenchida
  const pw = $("#eprocPassword").value;
  if (pw) partial.eprocPassword = pw;

  const status = $("#saveStatus");
  status.textContent = "Salvando...";
  status.className = "inline-status";

  config = await window.atp.setConfig(partial);

  // Autostart é do sistema
  await window.atp.setAutostart($("#autostart").checked);

  $("#eprocPassword").value = "";
  status.textContent = "✓ Configuração salva";
  status.className = "inline-status ok";
  setTimeout(() => (status.textContent = ""), 3000);

  updateHomeSummary();
});

// ---------- Testar conexão ----------
$("#btnTestToken").addEventListener("click", async () => {
  const status = $("#tokenStatus");
  status.textContent = "Testando...";
  status.className = "inline-status";
  const serverUrl = $("#serverUrl").value.trim();
  const token = $("#token").value.trim();
  const res = await window.atp.validateToken(serverUrl, token);
  if (res.ok) {
    status.textContent = "✓ Conexão estabelecida";
    status.className = "inline-status ok";
  } else {
    status.textContent = `✗ ${humanizeMessage(res.error) || "Falha na conexão"}`;
    status.className = "inline-status err";
  }
});

// ---------- Executar agora ----------
async function runVerification(dryRun) {
  const btnRun = $("#btnRunNow");
  const btnDry = $("#btnDryRun");
  btnRun.disabled = true;
  btnDry.disabled = true;
  setStatus(dryRun ? "Simulando..." : "Executando...", "busy");
  if (dryRun) {
    pushLog({
      level: "info",
      message:
        "Iniciando teste em modo simulação — nenhum processo será alterado.",
      at: new Date().toISOString(),
    });
  }
  try {
    const res = await window.atp.runNow({ dryRun });
    const s = res && res.summary;
    if (s) {
      pushLog({
        level: s.status === "error" ? "error" : "info",
        message: humanizeMessage(s.message),
        at: new Date().toISOString(),
      });
    }
    await loadConfig();
  } catch (err) {
    pushLog({
      level: "error",
      message: humanizeMessage(err.message),
      at: new Date().toISOString(),
    });
    setStatus("Precisa de atenção", "err");
  } finally {
    btnRun.disabled = false;
    btnDry.disabled = false;
  }
}

$("#btnRunNow").addEventListener("click", () => runVerification(false));
$("#btnDryRun").addEventListener("click", () => runVerification(true));

// ---------- Renovar sessão ----------
$("#btnKeepalive").addEventListener("click", async () => {
  const btn = $("#btnKeepalive");
  btn.disabled = true;
  setStatus("Renovando sessão...", "busy");
  try {
    await window.atp.keepalive();
    setStatus("Pronto", "ok");
  } catch (err) {
    pushLog({
      level: "error",
      message: humanizeMessage(err.message),
      at: new Date().toISOString(),
    });
    setStatus("Precisa de atenção", "err");
  } finally {
    btn.disabled = false;
  }
});

// ---------- Diagnóstico ----------
$("#btnDiagnose").addEventListener("click", async () => {
  const list = $("#diagList");
  list.innerHTML =
    '<div class="diag-item"><span class="diag-text"><span>Verificando...</span></span></div>';
  const res = await window.atp.diagnose();
  list.innerHTML = "";
  res.checks.forEach((c) => {
    const item = document.createElement("div");
    item.className = "diag-item";
    item.innerHTML = `
      <span class="diag-badge ${c.ok ? "ok" : "err"}">${c.ok ? "✓" : "✗"}</span>
      <span class="diag-text"><strong>${escapeHtml(c.name)}</strong><span>${escapeHtml(c.detail)}</span></span>
    `;
    list.appendChild(item);
  });
});

$("#btnOpenDiag").addEventListener("click", async () => {
  await window.atp.openDiagFolder();
});

$("#btnManualLogin").addEventListener("click", async () => {
  const btn = $("#btnManualLogin");
  btn.disabled = true;
  setStatus("Aguardando login manual...", "busy");
  pushLog({
    level: "info",
    message:
      "Abrindo o navegador para login manual. Faça login e, se pedir, digite o código de dois fatores e marque 'não pedir novamente neste dispositivo'.",
    at: new Date().toISOString(),
  });
  try {
    const res = await window.atp.manualLogin();
    pushLog({
      level: res.status === "success" ? "info" : "error",
      message: humanizeMessage(res.message),
      at: new Date().toISOString(),
    });
    setStatus(
      res.status === "success" ? "Pronto" : "Precisa de atenção",
      res.status === "success" ? "ok" : "err",
    );
  } catch (err) {
    pushLog({
      level: "error",
      message: humanizeMessage(err.message),
      at: new Date().toISOString(),
    });
    setStatus("Precisa de atenção", "err");
  } finally {
    btn.disabled = false;
  }
});

// ---------- Eventos vindos do processo principal ----------
window.atp.onStatus((s) => {
  const kind = /erro/i.test(s) ? "err" : /pronto/i.test(s) ? "ok" : "busy";
  setStatus(s, kind);
});
window.atp.onLog((entry) => pushLog(entry));
window.atp.onTriggerRunNow(() => $("#btnRunNow").click());

// ---------- Inicialização ----------
(async function init() {
  await loadConfig();
  if (!config.onboarded) {
    showOnboarding();
  }
})();
