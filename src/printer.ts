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
