import { BrowserWindow, ipcMain } from "electron";
import { autoUpdater } from "electron-updater";

/**
 * 자동 업데이트.
 *
 * 확인 시점을 **앱 시작 시**와 **설정의 수동 버튼** 둘로만 둔다. 주기 확인은 하지 않는다.
 * 출력 도중에 새 버전을 받아 재시작을 부추기면 작업이 끊기기 때문이다. 시작 시점은 아직
 * 큐를 잡기 전이라 안전하고, 수동 버튼은 작업자가 한가한 때를 고른다.
 *
 * **자동으로 재시작하지 않는다.** 받아둔 것이 있어도 화면에 알리기만 하고, 언제 적용할지는
 * 사람이 정한다.
 */

export type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "available"; version: string }
  | { status: "downloading"; percent: number }
  | { status: "ready"; version: string }
  | { status: "latest"; version: string }
  | { status: "error"; message: string };

let state: UpdateState = { status: "idle" };
let mainWindow: BrowserWindow | null = null;

const push = (next: UpdateState) => {
  state = next;
  mainWindow?.webContents.send("update:state", next);
};

export function setupUpdater(window: BrowserWindow, currentVersion: string): void {
  mainWindow = window;

  // 다운로드까지는 자동으로 하되, 설치(재시작)는 사람이 누를 때만 한다
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("checking-for-update", () => push({ status: "checking" }));
  autoUpdater.on("update-available", (info) => push({ status: "available", version: info.version }));
  autoUpdater.on("update-not-available", () => push({ status: "latest", version: currentVersion }));
  autoUpdater.on("download-progress", (p) => push({ status: "downloading", percent: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", (info) => push({ status: "ready", version: info.version }));
  autoUpdater.on("error", (err) => {
    // 업데이트 서버에 못 닿아도 앱은 계속 돌아야 한다. 알리기만 한다
    push({ status: "error", message: err?.message ?? "업데이트 확인에 실패했습니다." });
  });

  ipcMain.handle("update:check", async () => {
    await check();
    return state;
  });

  ipcMain.handle("update:state", () => state);

  ipcMain.handle("update:install", () => {
    if (state.status !== "ready") return false;
    // isSilent=false: 설치 마법사를 보여준다. isForceRunAfter=true: 설치 후 다시 띄운다
    autoUpdater.quitAndInstall(false, true);
    return true;
  });
}

/** 새 버전 확인. 개발 중에는 업데이트 서버가 없으므로 건너뛴다 */
export async function check(): Promise<void> {
  if (!require("electron").app.isPackaged) {
    push({ status: "latest", version: require("electron").app.getVersion() });
    return;
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    push({ status: "error", message: (error as Error).message });
  }
}
