import { BrowserWindow, ipcMain, shell } from "electron";
import { Agent } from "./agent";
import { pollAuth, requestAuth } from "./api";
import { configPath, getConfig, setConfig } from "./config";
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
    onRemoved: (jobId) => send("queue:removed", jobId),
    onLog: (level, message) => send("log", { level, message, at: Date.now() }),
    onStateChange: (running) => send("agent:state", { running }),
  });

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

  // ── 프린터 목록 ──
  ipcMain.handle("printers:list", async () => {
    const printers = await mainWindow.webContents.getPrintersAsync();
    return printers.map((p) => ({ name: p.name, displayName: p.displayName, isDefault: p.isDefault }));
  });
}

/** 창이 닫힐 때 폴링을 멈춘다. 남겨두면 다음 실행에서 큐를 이중으로 가져간다 */
export function teardownIpc(): void {
  agent?.stop();
  agent = null;
  window = null;
}
