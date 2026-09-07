import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import { check, setupUpdater } from "./updater";

/**
 * 가먼트 프린터 출력 클라이언트.
 *
 * 1단계 뼈대 — 창을 띄우고 자동 업데이트가 도는 것까지만 한다.
 * 서버 폴링·인쇄·장비 연동은 이후 단계에서 붙인다.
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
}
