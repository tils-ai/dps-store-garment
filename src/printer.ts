import { BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";

/**
 * 인쇄.
 *
 * 숨은 창에 HTML 을 띄우고 `webContents.print` 로 곧장 프린터에 보낸다. 파이썬 판은
 * PDF 를 만들어 프린터 DC 에 그렸는데, 그 경로가 폰트 임베딩 사고의 출처였다.
 * 여기서는 만들지 않고 그리던 것을 그대로 찍는다.
 */

export type PrintResult = { ok: true } | { ok: false; reason: string };

/**
 * 설정된 프린터가 실제로 설치돼 있는지 본다.
 *
 * 이름이 한 글자만 어긋나도 인쇄는 조용히 실패하거나 엉뚱한 장치로 나간다. 벤더 CLI 의
 * 숫자 코드보다 "이 이름을 못 찾았고 설치된 것은 이것들이다" 가 현장에서 훨씬 빠르다.
 *
 * 목록 조회 자체가 실패하면 통과시킨다 — 확인이 안 된다고 인쇄를 막을 이유는 없다.
 */
async function ensureInstalled(win: BrowserWindow, deviceName: string): Promise<void> {
  if (!deviceName) return; // 기본 프린터로 보낸다
  const printers = await win.webContents.getPrintersAsync().catch(() => []);
  if (printers.length === 0) return;
  if (printers.some((printer) => printer.name === deviceName)) return;

  throw new Error(
    `설정된 프린터를 찾을 수 없습니다: '${deviceName}'. 설치된 프린터: ${printers.map((p) => p.name).join(", ")}`
  );
}

/**
 * HTML 을 지정한 프린터로 조용히 인쇄한다.
 *
 * `silent: true` 는 대화상자를 띄우지 않는다. 작업자가 매번 확인을 누르게 하면 자동
 * 출력의 의미가 없다. 대신 실패해도 화면에 아무것도 안 뜨므로 결과를 꼭 돌려준다.
 */
export async function printHtml(html: string, deviceName: string): Promise<PrintResult> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      // 지시서 HTML 은 우리가 만든 문자열이지만, 주문 정보가 섞여 들어간다.
      // 스크립트를 아예 못 돌게 막아 두는 편이 안전하다
      javascript: false,
      sandbox: true,
    },
  });

  try {
    await ensureInstalled(win, deviceName);
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

    // 이미지(생산 이미지·썸네일·QR)가 그려지기 전에 찍으면 빈 칸이 나온다.
    // data URL 이라 네트워크를 타지 않으므로 한 프레임만 기다리면 충분하다
    await new Promise((resolve) => setTimeout(resolve, 300));

    return await new Promise<PrintResult>((resolve) => {
      win.webContents.print(
        {
          silent: true,
          printBackground: true, // 표 머리 배경과 경고 배너가 빠지지 않게 한다
          ...(deviceName ? { deviceName } : {}),
          margins: { marginType: "none" },
          pageSize: "A4",
        },
        (success, failureReason) => {
          resolve(success ? { ok: true } : { ok: false, reason: failureReason || "인쇄에 실패했습니다." });
        }
      );
    });
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  } finally {
    // 남겨두면 숨은 창이 계속 쌓인다
    if (!win.isDestroyed()) win.destroy();
  }
}

/**
 * 이미지를 프린터로 그대로 인쇄한다 — `direct` 모드.
 *
 * 벤더 CLI 를 거치지 않고 Windows 프린터에 그린다. 파이썬 판의 `print_image` 에 해당하는
 * 물러설 자리다. 잉크·플레이트 같은 장비 설정을 실을 수 없으므로 장비 패널 설정을 따른다.
 *
 * 용지 크기를 지정하지 않는다. 장비 드라이버가 잡아 둔 플레이트 크기를 그대로 쓰려는 것이며,
 * A4 를 강제하면 도안이 엉뚱한 크기로 나간다.
 */
export async function printImageFiles(files: string[], deviceName: string): Promise<PrintResult> {
  if (files.length === 0) return { ok: false, reason: "인쇄할 이미지가 없습니다." };

  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true } });
  try {
    await ensureInstalled(win, deviceName);

    // data URL 페이지에서는 file: 참조가 막힌다. 이미지 옆에 HTML 을 두고 파일로 연다
    const pageDir = path.dirname(files[0]);
    const htmlPath = path.join(pageDir, "direct-print.html");
    const body = files
      .map((file) => `<div class="page"><img src="${encodeURIComponent(path.basename(file))}" /></div>`)
      .join("");
    fs.writeFileSync(
      htmlPath,
      `<!doctype html><meta charset="utf-8"><style>
         html,body{margin:0;padding:0}
         .page{page-break-after:always;width:100%;height:100vh;display:flex;align-items:flex-start;justify-content:center}
         .page:last-child{page-break-after:auto}
         img{max-width:100%;max-height:100%;object-fit:contain}
       </style>${body}`,
      "utf8"
    );

    await win.loadFile(htmlPath);
    await new Promise((resolve) => setTimeout(resolve, 300));

    return await new Promise<PrintResult>((resolve) => {
      win.webContents.print(
        {
          silent: true,
          printBackground: false,
          ...(deviceName ? { deviceName } : {}),
          margins: { marginType: "none" },
        },
        (success, failureReason) => {
          resolve(success ? { ok: true } : { ok: false, reason: failureReason || "인쇄에 실패했습니다." });
        }
      );
    });
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/**
 * 미리보기용 PDF 저장 — 실물 대조에 쓴다.
 *
 * 인쇄 결과가 현행과 같은지 확인하려면 눈으로 견줄 것이 있어야 한다. 운영 경로는
 * 아니고, 개발·검증 중에만 쓴다.
 */
export async function saveHtmlAsPdf(html: string, destPath: string): Promise<PrintResult> {
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true } });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const data = await win.webContents.printToPDF({
      pageSize: "A4",
      printBackground: true,
      margins: { marginType: "none" },
    });
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, data);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}
