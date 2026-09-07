import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import { setupIpc, teardownIpc } from "./ipc";
import { closeLog, writeLog } from "./logger";
import { check, setupUpdater } from "./updater";

/**
 * 가먼트 프린터 출력 클라이언트.
 *
 * 창 하나로 폴링·인쇄·장비 전송을 모두 다룬다. 현장 PC 는 사람이 상주하지 않는 경우가
 * 많아, 창을 닫아도 진행 중인 일이 끊기지 않도록 상태는 메인 프로세스가 들고 있는다.
 */

let mainWindow: BrowserWindow | null = null;

const createWindow = (): void => {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: "가먼트 프린터",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 흰 화면이 깜빡이지 않도록 그려진 뒤에 띄운다
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // 외부 링크는 기본 브라우저로. 앱 창이 웹뷰로 바뀌지 않게 한다
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => undefined);
    return { action: "deny" };
  });

  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
};

// 두 개가 동시에 뜨면 같은 큐를 이중으로 가져간다. 한 번에 하나만 돌게 막는다
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    ipcMain.handle("app:version", () => app.getVersion());

    createWindow();
    if (mainWindow) {
      writeLog("info", `앱 시작 v${app.getVersion()}`);
      setupIpc(mainWindow);
      setupUpdater(mainWindow, app.getVersion());
      // 앱 시작 시 한 번 확인. 이후로는 수동 버튼으로만 확인한다
      void check();
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  // 폴링이 남으면 다음 실행에서 같은 큐를 이중으로 가져간다
  app.on("before-quit", () => {
    writeLog("info", "앱 종료");
    teardownIpc();
    closeLog();
  });
}
