import { BrowserWindow, ipcMain, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { Agent } from "./agent";
import { DeviceStatusPoller, deviceContext } from "./device";
import { collectDeviceLog, runMaintenance, type MaintenanceCommand } from "./device/maintenance";
import { pollAuth, requestAuth } from "./api";
import { cliStatePath, configPath, diagnosticsDir, getConfig, primaryPrinter, setConfig, vendorDir } from "./config";
import { writeLog } from "./logger";
import { IncomingWatcher } from "./watcher";
import type { AppConfig } from "./config";

/**
 * 렌더러와 주고받는 창구.
 *
 * 화면은 상태를 직접 만들지 않고 여기서 밀어주는 것만 그린다. 폴링·인증은 창을 닫아도
 * 이어져야 하므로 메인 프로세스가 들고 있는다.
 */

let agent: Agent | null = null;
let statusPoller: DeviceStatusPoller | null = null;
let watcher: IncomingWatcher | null = null;
let window: BrowserWindow | null = null;

const send = (channel: string, payload: unknown): void => {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
};

export function setupIpc(mainWindow: BrowserWindow): void {
  window = mainWindow;

  agent = new Agent({
    onReady: (item) => send("queue:ready", item),
    onItemChanged: (item) => send("queue:changed", item),
    onRemoved: (jobId) => send("queue:removed", jobId),
    onLog: (level, message) => {
      // 화면 로그는 앱을 닫으면 사라진다. 나중에 되짚을 수 있게 파일에도 남긴다
      writeLog(level, message);
      send("log", { level, message, at: Date.now() });
    },
    onStateChange: (running) => send("agent:state", { running }),
  });

  // 장비 상태는 전송 중에도 읽혀야 해서 폴링 루프와 따로 돈다
  statusPoller = new DeviceStatusPoller(
    // 조회를 꺼 두면 맥락을 주지 않는다. 조회 자체가 CLI 호출이라 전송과 겹치면 장비가 바쁘다
    () => (getConfig().deviceStatusEnabled ? currentDeviceContext() : null),
    (status) => send("device:status", status),
    () => getConfig().deviceStatusIntervalSec * 1000,
    (status) => {
      const detail = status.errors.length > 0 ? status.errors.join("; ") : "출력 정지";
      const message = `장비 오류: ${detail}${status.currentFile ? ` (${status.currentFile})` : ""}`;
      writeLog("error", message);
      send("log", { level: "error", message, at: Date.now() });
    }
  );
  statusPoller.start();

  // 감시 폴더 — 서버 큐와 별개로 떨궈진 파일도 집는다
  watcher = new IncomingWatcher({
    onFile: async (filePath) => {
      await agent?.addLocalFile(filePath);
    },
    onLog: (level, message) => {
      writeLog(level, message);
      send("log", { level, message, at: Date.now() });
    },
  });
  syncWatcher();

  ipcMain.handle("device:status", () => statusPoller?.current ?? null);

  // 앱이 꺼졌다 켜져도 이미 받아 둔 건이 남아 있어야 한다.
  // 서버는 그 건들을 READY 로 보고 다시 내려주지 않는다
  agent.restore();

  // 현장 PC 는 사람이 상주하지 않는다. 이미 연결된 단말이면 켜자마자 폴링을 시작한다
  if (getConfig().apiKey) agent.start();

  // ── 설정 ──
  ipcMain.handle("config:get", () => getConfig());
  ipcMain.handle("config:set", (_e, patch: Partial<AppConfig>) => {
    const next = setConfig(patch);
    // 감시 폴더 설정은 저장만 해서는 반영되지 않는다. 바로 다시 건다
    syncWatcher();
    return next;
  });
  ipcMain.handle("config:path", () => configPath());

  // ── 인증 ──
  // 승인 대기 폴링이 겹치면 코드가 꼬이므로 진행 중인 것을 취소하고 새로 시작한다
  let authAbort: (() => void) | null = null;

  ipcMain.handle("auth:start", async (_e, tenant: string) => {
    authAbort?.();
    const { baseUrl } = getConfig();
    const info = await requestAuth(baseUrl, tenant);

    // 브라우저를 열어 사람이 승인하게 한다
    void shell.openExternal(info.verifyUrl);

    let cancelled = false;
    authAbort = () => {
      cancelled = true;
    };

    // 승인될 때까지 2초 간격으로 묻는다. 만료되면 화면에 알린다
    const deadline = Date.now() + info.expiresIn * 1000;
    void (async () => {
      while (!cancelled && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        if (cancelled) return;
        try {
          const result = await pollAuth(baseUrl, info.deviceCode);
          if (result.status === "approved" && result.apiKey) {
            setConfig({ apiKey: result.apiKey, tenant });
            send("auth:result", { status: "approved" });
            return;
          }
          if (result.status === "expired") {
            send("auth:result", { status: "expired" });
            return;
          }
        } catch {
          // 네트워크가 잠깐 끊겨도 만료 전까지는 계속 묻는다
        }
      }
      if (!cancelled) send("auth:result", { status: "expired" });
    })();

    return { userCode: info.userCode, verifyUrl: info.verifyUrl, expiresIn: info.expiresIn };
  });

  ipcMain.handle("auth:cancel", () => {
    authAbort?.();
    authAbort = null;
    return true;
  });

  // ── 폴링 ──
  ipcMain.handle("agent:start", () => {
    agent?.start();
    return agent?.isRunning ?? false;
  });
  ipcMain.handle("agent:stop", () => {
    agent?.stop();
    return agent?.isRunning ?? false;
  });
  ipcMain.handle("agent:state", () => ({
    running: agent?.isRunning ?? false,
    items: agent?.snapshot() ?? [],
  }));

  // ── 작업지시서 ──
  ipcMain.handle("workorder:print", async (_e, jobId: string) => {
    if (!agent) return { ok: false, reason: "준비되지 않았습니다." };
    return agent.printWorkOrder(jobId);
  });

  // 실물 대조용 — 인쇄 결과가 현행과 같은지 눈으로 견주기 위해 PDF 로 떨군다
  ipcMain.handle("workorder:preview", async (_e, jobId: string) => {
    if (!agent) return { ok: false, reason: "준비되지 않았습니다." };
    return agent.previewWorkOrder(jobId);
  });

  // ── 장비 전송 ──
  ipcMain.handle("device:send", async (_e, jobId: string, ink?: number) => {
    if (!agent) return { ok: false, reason: "준비되지 않았습니다." };
    return agent.sendToPrinter(jobId, ink);
  });

  ipcMain.handle("queue:delete", async (_e, jobId: string) => {
    if (!agent) return { ok: false, reason: "준비되지 않았습니다." };
    return agent.deleteItem(jobId);
  });

  // ── 폴더 열기 ── 문제 확인 때 현장에서 직접 들여다본다
  ipcMain.handle("open:folder", (_e, kind: "download" | "incoming" | "logs" | "config") => {
    const target =
      kind === "download"
        ? getConfig().downloadDir
        : kind === "incoming"
          ? getConfig().incomingDir
          : kind === "logs"
          ? path.dirname(diagnosticsDir()) // app.log 와 diagnostics 를 함께 본다
          : path.dirname(configPath());
    fs.mkdirSync(target, { recursive: true });
    void shell.openPath(target);
    return target;
  });

  // ── 장비 관리 ── 모두 LAN 연결 장비 전용이다
  ipcMain.handle("device:maintenance", async (_e, command: MaintenanceCommand) => {
    const ctx = currentDeviceContext();
    if (!ctx) return { ok: false, reason: "장비 전송이 꺼져 있거나 장비가 선택되지 않았습니다." };
    // 출력 중에 보내면 진행 중인 작업이 흐트러진다
    if (statusPoller?.current?.printing) return { ok: false, reason: "출력 중에는 보낼 수 없습니다." };
    const result = await runMaintenance(ctx, command);
    writeLog(result.ok ? "info" : "warn", `장비 관리 ${command}: ${result.ok ? "성공" : result.reason}`);
    return result;
  });

  ipcMain.handle("device:log", async () => {
    const ctx = currentDeviceContext();
    if (!ctx) return { ok: false, reason: "장비 전송이 꺼져 있거나 장비가 선택되지 않았습니다." };
    const result = await collectDeviceLog(ctx, diagnosticsDir());
    if (result.ok && result.dir) void shell.openPath(result.dir);
    return result;
  });

  // ── 프린터 목록 ──
  ipcMain.handle("printers:list", async () => {
    const printers = await mainWindow.webContents.getPrintersAsync();
    return printers.map((p) => ({ name: p.name, displayName: p.displayName, isDefault: p.isDefault }));
  });
}

/**
 * 장비 명령에 쓸 실행 맥락.
 *
 * 여러 대를 물려도 상태 조회와 관리 명령은 대표 장비 한 대에만 보낸다. 전 대에 돌리면
 * 조회가 겹쳐 장비가 바쁘고, 어느 대의 답인지도 화면에서 갈리지 않는다.
 */
function currentDeviceContext() {
  const config = getConfig();
  const printerName = primaryPrinter(config);
  if (!config.garmentEnabled || !printerName) return null;
  return deviceContext({
    cliPaths: {
      legacy: config.cliLegacyPath || path.join(vendorDir(), "cli_legacy.exe"),
      pro: config.cliProPath || path.join(vendorDir(), "cli_pro.exe"),
    },
    setting: config.print.cli,
    printerName,
    diagnosticsDir: diagnosticsDir(),
    cliStatePath: cliStatePath(),
    onLog: writeLog,
  });
}

/** 설정에 맞춰 감시 폴더를 걸거나 푼다 */
function syncWatcher(): void {
  const config = getConfig();
  if (config.watchEnabled) watcher?.start(config.incomingDir);
  else watcher?.stop();
}

/** 창이 닫힐 때 폴링과 변환기를 멈춘다. 남겨두면 프로세스가 안 죽는다 */
export function teardownIpc(): void {
  statusPoller?.stop();
  statusPoller = null;
  watcher?.stop();
  watcher = null;
  agent?.stop();
  agent = null;
  window = null;
}
