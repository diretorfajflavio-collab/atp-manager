/**
 * ATP Manager — Armazenamento de Configuração Local
 * --------------------------------------------------
 * Guarda as configurações do usuário num arquivo JSON dentro da pasta
 * de dados do aplicativo (userData). Não usa banco de dados — tudo local,
 * simples e portátil. A senha do eproc é guardada de forma reversível
 * apenas no computador do usuário (nunca trafega em texto puro para fora).
 */

const { app, safeStorage } = require("electron");
const path = require("path");
const fs = require("fs");

const CONFIG_FILE = path.join(app.getPath("userData"), "atp-config.json");

const DEFAULTS = {
  // Conexão com o painel
  serverUrl: "https://eprocassist-a42rkir7.manus.space",
  token: "",

  // Credenciais do eproc (para login automático)
  eprocUsername: "",
  eprocPasswordEnc: "", // criptografada via safeStorage quando disponível

  // Agendamento
  scheduleEnabled: true,
  scheduleDays: ["MON", "TUE", "WED", "THU", "FRI"],
  scheduleTimes: ["09:00", "10:00", "14:00"],
  keepaliveEnabled: true,
  keepaliveTime: "08:00",
  keepaliveEveryDay: true,

  // Comportamento
  autostart: true,
  showBrowser: false, // modo debug: mostrar o navegador durante a execução

  // Estado interno
  lastRun: null,
  lastRunResult: null,
  lastKeepalive: null,
  installedAt: null,
  onboarded: false,
};

let cache = null;

function load() {
  if (cache) return cache;
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
      cache = { ...DEFAULTS, ...JSON.parse(raw) };
    } else {
      cache = { ...DEFAULTS, installedAt: new Date().toISOString() };
      persist();
    }
  } catch (err) {
    console.error(
      "[store] Erro ao ler configuração, usando padrões:",
      err.message,
    );
    cache = { ...DEFAULTS };
  }
  return cache;
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cache, null, 2), "utf-8");
  } catch (err) {
    console.error("[store] Erro ao salvar configuração:", err.message);
  }
}

// ---- Senha do eproc: criptografia local ----
function encryptPassword(plain) {
  if (!plain) return "";
  try {
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      return safeStorage.encryptString(plain).toString("base64");
    }
  } catch (_) {}
  // Fallback: base64 simples (melhor que texto puro, mas só protege de olhar casual)
  return "b64:" + Buffer.from(plain, "utf-8").toString("base64");
}

function decryptPassword(enc) {
  if (!enc) return "";
  try {
    if (enc.startsWith("b64:")) {
      return Buffer.from(enc.slice(4), "base64").toString("utf-8");
    }
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(enc, "base64"));
    }
  } catch (err) {
    console.error("[store] Erro ao descriptografar senha:", err.message);
  }
  return "";
}

module.exports = {
  getAll() {
    const c = load();
    // Devolve a senha em claro apenas para uso interno (nunca enviada ao renderer)
    return { ...c, eprocPassword: decryptPassword(c.eprocPasswordEnc) };
  },

  // Versão segura para a interface: sem a senha em claro
  getForRenderer() {
    const c = load();
    const { eprocPasswordEnc, ...rest } = c;
    return { ...rest, hasPassword: !!eprocPasswordEnc };
  },

  get(key) {
    return load()[key];
  },

  set(key, value) {
    load();
    cache[key] = value;
    persist();
  },

  setMany(partial) {
    load();
    // Tratamento especial da senha
    if (typeof partial.eprocPassword === "string") {
      cache.eprocPasswordEnc = encryptPassword(partial.eprocPassword);
      delete partial.eprocPassword;
    }
    cache = { ...cache, ...partial };
    persist();
  },

  path: CONFIG_FILE,
};
