import { BrowserWindow, ipcMain, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { Agent } from "./agent";
import { disposeConverter } from "./device";
import { pollAuth, requestAuth } from "./api";
import { configPath, diagnosticsDir, getConfig, setConfig } from "./config";
import type { AppConfig } from "./config";

/**
 * 렌더러와 주고받는 창구.
 *
 * 화면은 상태를 직접 만들지 않고 여기서 밀어주는 것만 그린다. 폴링·인증은 창을 닫아도
 * 이어져야 하므로 메인 프로세스가 들고 있는다.
 */

let agent: Agent | null = null;
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
    onLog: (level, message) => send("log", { level, message, at: Date.now() }),
    onStateChange: (running) => send("agent:state", { running }),
  });

  // 앱이 꺼졌다 켜져도 이미 받아 둔 건이 남아 있어야 한다.
  // 서버는 그 건들을 READY 로 보고 다시 내려주지 않는다
  agent.restore();

  // ── 설정 ──
  ipcMain.handle("config:get", () => getConfig());
  ipcMain.handle("config:set", (_e, patch: Partial<AppConfig>) => setConfig(patch));
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
  ipcMain.handle("open:folder", (_e, kind: "download" | "logs" | "config") => {
    const target =
      kind === "download" ? getConfig().downloadDir : kind === "logs" ? diagnosticsDir() : path.dirname(configPath());
    fs.mkdirSync(target, { recursive: true });
    void shell.openPath(target);
    return target;
  });

  // ── 프린터 목록 ──
  ipcMain.handle("printers:list", async () => {
    const printers = await mainWindow.webContents.getPrintersAsync();
    return printers.map((p) => ({ name: p.name, displayName: p.displayName, isDefault: p.isDefault }));
  });
}

/** 창이 닫힐 때 폴링과 변환기를 멈춘다. 남겨두면 프로세스가 안 죽는다 */
export function teardownIpc(): void {
  agent?.stop();
  agent = null;
  window = null;
  disposeConverter();
}
