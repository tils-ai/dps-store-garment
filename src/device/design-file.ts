import fs from "node:fs";

/**
 * 디자인 파일 확인.
 *
 * **서버가 보내는 디자인은 PNG 뿐이고, 여기서는 그 파일을 손대지 않는다.**
 *
 * 예전에는 PDF 도 받아 캔버스로 래스터화한 뒤 흰 배경을 합성해 넘겼다. 그 합성 단계가
 * 알파 그라데이션을 뭉개 픽셀이 계단처럼 나오는 출력 사고를 냈다. PNG 만 들어오는 지금은
 * 래스터화도 보정도 필요 없다 — 받은 파일을 그대로 벤더 CLI 에 넘긴다.
 *
 * 그래서 이 파일이 하는 일은 두 가지뿐이다.
 * 1. 정말 PNG 인지 확인한다 (확장자와 서버가 알려준 타입은 둘 다 틀릴 수 있어 앞머리로 본다)
 * 2. 배치 계산에 필요한 픽셀 크기와 해상도를 헤더에서 읽는다
 */

export type DesignImage = {
  /** 원본 그대로의 파일 경로. 복사도 변환도 하지 않는다 */
  filePath: string;
  width: number;
  height: number;
  /** PNG 가 스스로 밝힌 해상도(pHYs). 없으면 null */
  dpi: number | null;
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 미터당 픽셀 → DPI */
const perMeterToDpi = (perMeter: number): number => Math.round(perMeter * 0.0254);

/**
 * PNG 헤더에서 크기와 해상도를 읽는다.
 *
 * IHDR 은 규격상 첫 청크라 위치가 고정이고, pHYs 는 있을 수도 없을 수도 있어 청크를 훑는다.
 * 이미지 데이터는 읽지 않으므로 300DPI 원본이라도 앞부분만 건드린다.
 */
export function readDesignImage(filePath: string): DesignImage {
  const fd = fs.openSync(filePath, "r");
  try {
    // IHDR 까지 33바이트 + pHYs 를 찾기 위한 여유. 청크 몇 개 뒤에 있어도 잡힌다
    const head = Buffer.alloc(4096);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    const buf = head.subarray(0, read);

    if (read < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
      throw new Error("PNG 파일이 아닙니다. 이 앱은 PNG 디자인만 출력합니다.");
    }
    if (buf.toString("latin1", 12, 16) !== "IHDR") {
      throw new Error("PNG 헤더를 읽지 못했습니다.");
    }

    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    if (width === 0 || height === 0) throw new Error("PNG 크기를 읽지 못했습니다.");

    return { filePath, width, height, dpi: readPhysDpi(buf) };
  } finally {
    fs.closeSync(fd);
  }
}

/** pHYs 청크(해상도). 단위가 미터가 아니면 비율만 있는 것이라 해상도로 쓸 수 없다 */
function readPhysDpi(buf: Buffer): number | null {
  let offset = 8; // 시그니처 다음부터 청크가 이어진다
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("latin1", offset + 4, offset + 8);
    if (type === "pHYs" && offset + 8 + 9 <= buf.length) {
      const perMeterX = buf.readUInt32BE(offset + 8);
      const unit = buf.readUInt8(offset + 16);
      const dpi = unit === 1 ? perMeterToDpi(perMeterX) : 0;
      return dpi > 0 ? dpi : null;
    }
    // IDAT 부터는 이미지 데이터다. pHYs 는 그 앞에만 올 수 있다
    if (type === "IDAT") return null;
    offset += 12 + length;
  }
  return null;
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
