/**
 * ATP Manager — Preload (ponte segura)
 * -------------------------------------
 * Expõe um conjunto restrito e seguro de funções para a interface gráfica,
 * sem dar acesso direto ao Node.js. Tudo passa por canais IPC nomeados.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("atp", {
  // Configuração
  getConfig: () => ipcRenderer.invoke("config:get"),
  setConfig: (partial) => ipcRenderer.invoke("config:set", partial),

  // Agente
  validateToken: (serverUrl, token) =>
    ipcRenderer.invoke("agent:validate-token", { serverUrl, token }),
  runNow: (opts) => ipcRenderer.invoke("agent:run-now", opts || {}),
  openDiagFolder: () => ipcRenderer.invoke("open-diag-folder"),
  keepalive: () => ipcRenderer.invoke("agent:keepalive"),
  manualLogin: () => ipcRenderer.invoke("agent:manual-login"),
  diagnose: () => ipcRenderer.invoke("agent:diagnose"),

  // Sistema
  setAutostart: (enabled) =>
    ipcRenderer.invoke("system:set-autostart", enabled),
  getAutostart: () => ipcRenderer.invoke("system:get-autostart"),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  messageBox: (opts) => ipcRenderer.invoke("dialog:message", opts),

  // Eventos vindos do main (assinaturas)
  onStatus: (cb) => {
    ipcRenderer.on("status-update", (_e, s) => cb(s));
  },
  onLog: (cb) => {
    ipcRenderer.on("log-entry", (_e, entry) => cb(entry));
  },
  onTriggerRunNow: (cb) => {
    ipcRenderer.on("trigger-run-now", () => cb());
  },
});
