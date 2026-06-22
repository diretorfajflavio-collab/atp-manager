/**
 * ATP Manager — Agendador Interno
 * --------------------------------
 * Substitui o Agendador de Tarefas do Windows e os scripts .bat.
 * Funciona identicamente em Windows, Mac e Linux, pois roda dentro do
 * próprio app (que vive na bandeja do sistema e inicia com o computador).
 *
 * Verifica a cada minuto se chegou um horário agendado. Como o app fica
 * sempre aberto na bandeja, não depende de o usuário lembrar de nada.
 */

const store = require("./store");
const agent = require("../agent/agentRunner");

let timer = null;
let callbacks = { onStatus: () => {}, onLog: () => {} };
let lastFiredKey = null; // evita disparo duplicado no mesmo minuto

const DAY_CODES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function nowParts() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return {
    day: DAY_CODES[d.getDay()],
    time: `${hh}:${mm}`,
    key: `${d.toDateString()} ${hh}:${mm}`,
  };
}

async function tick() {
  const cfg = store.getAll();
  const { day, time, key } = nowParts();
  if (key === lastFiredKey) return; // já avaliamos este minuto

  // Keepalive (renovação de cookies) — pode rodar todos os dias
  if (
    cfg.keepaliveEnabled &&
    time === cfg.keepaliveTime &&
    (cfg.keepaliveEveryDay || cfg.scheduleDays.includes(day))
  ) {
    lastFiredKey = key;
    callbacks.onStatus("Renovando sessão...");
    callbacks.onLog({
      level: "info",
      message: `Keepalive agendado disparado (${time}).`,
      at: new Date().toISOString(),
    });
    try {
      await agent.keepalive({ ...cfg, onLog: callbacks.onLog });
      callbacks.onStatus("Pronto");
    } catch (err) {
      callbacks.onLog({
        level: "error",
        message: `Keepalive falhou: ${err.message}`,
        at: new Date().toISOString(),
      });
      callbacks.onStatus("Erro no keepalive");
    }
    return;
  }

  // Execução das automações — apenas nos dias configurados
  if (
    cfg.scheduleEnabled &&
    cfg.scheduleDays.includes(day) &&
    cfg.scheduleTimes.includes(time)
  ) {
    lastFiredKey = key;
    callbacks.onStatus("Executando automações...");
    callbacks.onLog({
      level: "info",
      message: `Execução agendada disparada (${day} ${time}).`,
      at: new Date().toISOString(),
    });
    try {
      const result = await agent.runNow({
        ...cfg,
        onLog: callbacks.onLog,
        onStatus: callbacks.onStatus,
      });
      store.set("lastRun", new Date().toISOString());
      store.set(
        "lastRunResult",
        result && result.summary ? result.summary : null,
      );
      callbacks.onStatus("Pronto");
    } catch (err) {
      callbacks.onLog({
        level: "error",
        message: `Execução falhou: ${err.message}`,
        at: new Date().toISOString(),
      });
      callbacks.onStatus("Erro na execução");
    }
  }
}

module.exports = {
  init(cbs) {
    callbacks = { ...callbacks, ...cbs };
    this.reload();
  },

  reload() {
    if (timer) clearInterval(timer);
    // Verifica a cada 30 segundos (garante pegar a virada do minuto)
    timer = setInterval(tick, 30 * 1000);
    tick();
  },

  stop() {
    if (timer) clearInterval(timer);
    timer = null;
  },
};
