import { BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";

/**
 * 디자인 파일을 장비용 PNG 로 바꾼다.
 *
 * 변환은 캔버스와 pdf.js 가 필요해 숨은 렌더러에서 돈다(`renderer/convert.js`).
 * 파이썬 판의 poppler 번들이 여기서 없어진다.
 *
 * 창을 매번 새로 띄우면 pdf.js 를 다시 읽어 느리므로, 하나를 만들어 재사용한다.
 */

export type ConvertedPage = {
  /** 저장된 PNG 경로 */
  filePath: string;
  width: number;
  height: number;
  /** 원본이 알려준 해상도. 없으면 렌더 DPI 를 쓴다 */
  dpi: number | null;
};

let worker: BrowserWindow | null = null;
let ready: Promise<void> | null = null;

const ensureWorker = (): Promise<void> => {
  if (ready && worker && !worker.isDestroyed()) return ready;

  worker = new BrowserWindow({
    show: false,
    webPreferences: {
      // 변환기는 pdf.js 를 require 로 읽어야 해서 Node 접근이 필요하다.
      // 이 창에는 우리가 만든 스크립트만 올라가고 외부 콘텐츠는 열지 않는다.
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
  });

  ready = worker.loadFile(path.join(__dirname, "..", "renderer", "convert.html"));
  return ready;
};

/** 앱을 닫을 때 정리한다. 남겨두면 프로세스가 안 죽는다 */
export function disposeConverter(): void {
  if (worker && !worker.isDestroyed()) worker.destroy();
  worker = null;
  ready = null;
}

/**
 * 디자인 파일 → PNG 여러 장.
 *
 * PDF 는 면 수만큼 나오고, 이미 이미지면 한 장이다. 서버가 알려준 타입은 믿지 않고
 * 파일 앞머리로 판별한다 (칼럼 이름이 PDF 라도 실제로는 PNG 인 경우가 있다).
 */
export async function convertDesign(sourcePath: string, outDir: string, renderDpi: number): Promise<ConvertedPage[]> {
  await ensureWorker();
  if (!worker || worker.isDestroyed()) throw new Error("변환기를 띄우지 못했습니다.");

  const buffer = fs.readFileSync(sourcePath);
  const pages = (await worker.webContents.executeJavaScript(
    `window.convertDesign(new Uint8Array(${JSON.stringify([...buffer])}).buffer, ${renderDpi})`,
    true
  )) as { bytes: Record<number, number>; width: number; height: number; dpi: number | null }[];

  fs.mkdirSync(outDir, { recursive: true });
  const base = path.basename(sourcePath, path.extname(sourcePath));

  return pages.map((page, i) => {
    // 렌더러를 건너오며 배열이 객체로 바뀐다. 다시 바이트로 되돌린다
    const bytes = Buffer.from(Object.values(page.bytes));
    const filePath = path.join(outDir, pages.length > 1 ? `${base}_p${i + 1}.png` : `${base}.png`);
    fs.writeFileSync(filePath, bytes);
    return { filePath, width: page.width, height: page.height, dpi: page.dpi ?? renderDpi };
  });
}

// ── 플레이트 배치 계산 ────────────────────────────────

/** 픽셀 + 해상도 → 0.1mm 단위 크기 */
export function dimsInMm10(width: number, height: number, dpi: number): { w: number; h: number } {
  return { w: Math.round((width / dpi) * 254), h: Math.round((height / dpi) * 254) };
}

/** 8자리 크기 문자열을 0.1mm 로. 형식이 어긋나면 넘겨받은 값을 쓴다 */
export function parseSize(size: string, fallbackW: number, fallbackH: number): { w: number; h: number } {
  if (size && size.length === 8 && /^\d{8}$/.test(size)) {
    return { w: Number(size.slice(0, 4)), h: Number(size.slice(4)) };
  }
  return { w: fallbackW, h: fallbackH };
}

const clamp = (v: number): number => Math.max(0, Math.min(9999, v));

/** 가운데 정렬 위치 (8자리) */
export function centerPosition(imgW: number, imgH: number, platenW: number, platenH: number): string {
  const left = clamp(Math.floor((platenW - imgW) / 2));
  const top = clamp(Math.floor((platenH - imgH) / 2));
  return `${String(left).padStart(4, "0")}${String(top).padStart(4, "0")}`;
}

/** 플레이트 맞춤 위치 — 가로는 가운데, 세로는 위쪽 (8자리) */
export function fitPosition(imgW: number, platenW: number): string {
  const left = clamp(Math.floor((platenW - imgW) / 2));
  return `${String(left).padStart(4, "0")}0000`;
}
