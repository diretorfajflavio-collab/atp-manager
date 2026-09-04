/**
 * ATP Manager Desktop — Processo Principal (Electron Main)
 * ---------------------------------------------------------
 * Responsável por criar a janela, gerenciar o ciclo de vida do app,
 * a bandeja do sistema (system tray) e a ponte (IPC) entre a interface
 * gráfica e a lógica do agente de automação.
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  dialog,
  shell,
  nativeImage,
} = require("electron");
const path = require("path");
const fs = require("fs");

// ---------------------------------------------------------------------------
// Caminho do Chromium empacotado (Playwright)
// Em produção, o navegador vai em resources/ms-playwright. Apontamos o
// Playwright para lá ANTES de qualquer require do agente, para o usuário
// nunca precisar instalar navegador nenhum.
// ---------------------------------------------------------------------------
if (app.isPackaged) {
  const bundled = path.join(process.resourcesPath, "ms-playwright");
  if (fs.existsSync(bundled)) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = bundled;
  }
}

const store = require("./store");
const agent = require("../agent/agentRunner");
const scheduler = require("./scheduler");

const isDev = process.argv.includes("--dev");
let mainWindow = null;
let tray = null;
let isQuitting = false;

// Pasta onde ficam as capturas de tela de diagnóstico (falhas)
const DIAG_DIR = path.join(app.getPath("userData"), "diagnostico");

// Pasta do perfil persistente do navegador (cookies + confiança de dispositivo p/ 2FA)
const BROWSER_PROFILE_DIR = path.join(
  app.getPath("userData"),
  "browser-profile",
);

// ---------------------------------------------------------------------------
// Janela principal
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 860,
    minHeight: 620,
    title: "ATP Manager",
    icon: getIconPath(),
    backgroundColor: "#0f1729",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  // Fechar a janela apenas esconde o app (continua na bandeja)
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      return false;
    }
  });

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
}

function getIconPath() {
  const candidates = [
    path.join(__dirname, "../../build/icon.png"),
    path.join(__dirname, "../../build/icon.ico"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Bandeja do sistema (System Tray)
// ---------------------------------------------------------------------------
function createTray() {
  const iconPath = getIconPath();
  if (!iconPath) return;

  let img = nativeImage.createFromPath(iconPath);
  if (process.platform === "darwin") {
    img = img.resize({ width: 18, height: 18 });
  }

  tray = new Tray(img);
  tray.setToolTip("ATP Manager — Assistente de Automatização");
  updateTrayMenu();
  tray.on("click", () => {
    if (mainWindow) mainWindow.show();
  });
}

function updateTrayMenu(statusText = "Pronto") {
  if (!tray) return;
  const contextMenu = Menu.buildFromTemplate([
    { label: `Status: ${statusText}`, enabled: false },
    { type: "separator" },
    { label: "Abrir painel", click: () => mainWindow && mainWindow.show() },
    {
      label: "Executar verificação agora",
      click: async () => {
        mainWindow && mainWindow.show();
        mainWindow && mainWindow.webContents.send("trigger-run-now");
      },
    },
    { type: "separator" },
    {
      label: "Sair",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);
}

// ---------------------------------------------------------------------------
// Instância única (evita abrir o app duas vezes)
// ---------------------------------------------------------------------------
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    createTray();

    // Inicia o agendador interno com base na configuração salva
    scheduler.init({
      onStatus: (s) => {
        updateTrayMenu(s);
        if (mainWindow) mainWindow.webContents.send("status-update", s);
      },
      onLog: (entry) => {
        if (mainWindow) mainWindow.webContents.send("log-entry", entry);
      },
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  // Não encerra: app vive na bandeja. Só encerra no macOS se explicitamente pedido.
  if (process.platform !== "darwin" && isQuitting) {
    app.quit();
  }
});

app.on("before-quit", () => {
  isQuitting = true;
});

// ---------------------------------------------------------------------------
// IPC — Ponte entre a interface (renderer) e a lógica (main)
// ---------------------------------------------------------------------------

// Configuração: ler e salvar
ipcMain.handle("config:get", () => store.getAll());
ipcMain.handle("app:get-version", () => agent.VERSION);
ipcMain.handle("config:set", (_e, partial) => {
  store.setMany(partial);
  // Reaplica o agendamento se os horários mudaram
  scheduler.reload();
  return store.getAll();
});

// Validar token contra o painel
ipcMain.handle("agent:validate-token", async (_e, { serverUrl, token }) => {
  return agent.validateToken(serverUrl, token);
});

// Executar verificação agora (manual)
ipcMain.handle("agent:run-now", async (_e, opts) => {
  return agent.runNow({
    ...store.getAll(),
    ...opts,
    screenshotDir: DIAG_DIR,
    browserProfileDir: BROWSER_PROFILE_DIR,
    onLog: (entry) =>
      mainWindow && mainWindow.webContents.send("log-entry", entry),
    onStatus: (s) => {
      updateTrayMenu(s);
      mainWindow && mainWindow.webContents.send("status-update", s);
    },
  });
});

// Abrir a pasta de diagnóstico (capturas de tela das falhas)
ipcMain.handle("open-diag-folder", async () => {
  fs.mkdirSync(DIAG_DIR, { recursive: true });
  await shell.openPath(DIAG_DIR);
  return DIAG_DIR;
});

// Login manual interativo (primeira vez / autenticação de dois fatores)
ipcMain.handle("agent:manual-login", async () => {
  return agent.manualLogin({
    ...store.getAll(),
    browserProfileDir: BROWSER_PROFILE_DIR,
    onLog: (entry) =>
      mainWindow && mainWindow.webContents.send("log-entry", entry),
  });
});

// Renovar cookies / login (keepalive)
ipcMain.handle("agent:keepalive", async () => {
  return agent.keepalive({
    ...store.getAll(),
    browserProfileDir: BROWSER_PROFILE_DIR,
    onLog: (entry) =>
      mainWindow && mainWindow.webContents.send("log-entry", entry),
  });
});

// Diagnóstico do ambiente
ipcMain.handle("agent:diagnose", async () => {
  return agent.diagnose(store.getAll());
});

// Abrir link externo no navegador padrão
ipcMain.handle("open-external", (_e, url) => shell.openExternal(url));

// Iniciar com o sistema (login item)
ipcMain.handle("system:set-autostart", (_e, enabled) => {
  app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
  store.set("autostart", enabled);
  return enabled;
});
ipcMain.handle("system:get-autostart", () => {
  return app.getLoginItemSettings().openAtLogin;
});

// Mostrar caixa de diálogo nativa
ipcMain.handle("dialog:message", (_e, opts) => {
  return dialog.showMessageBox(mainWindow, opts);
});
