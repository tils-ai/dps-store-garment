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
