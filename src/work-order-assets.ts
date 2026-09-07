import fs from "node:fs";
import path from "node:path";
import QRCode from "qrcode";

/**
 * 작업지시서에 실을 이미지 준비.
 *
 * 지시서는 숨은 창에서 인쇄하는데, 그 창은 로컬 파일 경로를 그대로 못 읽는다
 * (`data:` URL 로 띄우기 때문). 그래서 파일을 읽어 data URL 로 바꿔 넣는다.
 * 어차피 인쇄 전에 다 그려져 있어야 하므로 미리 읽어 두는 편이 확실하다.
 */

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** 로컬 이미지 파일을 data URL 로. 읽지 못하면 null (지시서는 그 칸만 비우고 계속 나간다) */
export function fileToDataUrl(filePath: string): string | null {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext];
    if (!mime) return null;
    const buffer = fs.readFileSync(filePath);
    if (buffer.length === 0) return null;
    return `data:${mime};base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  }
}

/** 작업 상세로 가는 QR */
export async function makeQrDataUrl(url: string): Promise<string> {
  return QRCode.toDataURL(url, { width: 150, margin: 1 });
}

/**
 * 목록 카드용 작은 미리보기.
 *
 * 디자인 원본은 300DPI 라 한 장에 수 MB 다. 그대로 화면에 실으면 카드가 몇십 개일 때
 * 목록이 통째로 무거워진다. 변환기가 만들어 둔 PNG 를 작은 판으로 줄여 담는다.
 *
 * PDF 는 여기서 렌더하지 않는다 — 목록을 그리자고 무거운 변환을 돌릴 이유가 없다.
 * 그런 건은 미리보기 없이 자리만 둔다.
 */
export async function makeThumbnail(filePath: string, maxEdge = 240): Promise<string | null> {
  const { BrowserWindow } = await import("electron");
  const ext = path.extname(filePath).toLowerCase();
  if (![".png", ".jpg", ".jpeg", ".webp"].includes(ext)) return null;

  const source = fileToDataUrl(filePath);
  if (!source) return null;

  // 숨은 창에서 캔버스로 줄인다. 메인 프로세스에는 캔버스가 없다
  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true },
  });
  try {
    await win.loadURL("data:text/html,<html><body></body></html>");
    return (await win.webContents.executeJavaScript(
      `(async () => {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = ${JSON.stringify(source)}; });
        const scale = Math.min(1, ${maxEdge} / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.width * scale));
        c.height = Math.max(1, Math.round(img.height * scale));
        const ctx = c.getContext("2d");
        // 투명 배경은 흰색으로 깔아 카드에서 도안이 보이게 한다
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        return c.toDataURL("image/jpeg", 0.7);
      })()`,
      true
    )) as string;
  } catch {
    return null;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}
