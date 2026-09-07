import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPrintXml } from "./build-xml";
import { dataExtension, preferredModel, runOnActive, runWithProbe, setCliStatePath, type CliContext } from "./cli";
import { centerPosition, convertDesign, dimsInMm10, fitPosition, parseSize } from "./convert";
import type { PrintSettings } from "./print-settings";

/**
 * 장비 전송.
 *
 * 디자인 파일을 PNG 로 바꾸고, 설정 XML 을 만들고, 벤더 CLI 로 인쇄 데이터를 생성해
 * 장비로 보낸다. 파이썬 판 `processor._print_via_cli` 의 흐름을 그대로 옮긴 것이다.
 */

export type SendOptions = {
  /** 내려받은 디자인 파일 */
  designPath: string;
  /** 장비(프린터) 이름 */
  printerName: string;
  /** 인쇄 설정 */
  settings: PrintSettings;
  /** 잉크 모드 덮어쓰기 — 작업자가 옷 색으로 고른다 */
  ink?: number;
  /** 플레이트 교체 대상이면 아동 플레이트를 쓴다 */
  needsPlateChange: boolean;
  /** 몇 장 뽑을지 */
  quantity: number;
  /** 작업 파일을 둘 폴더 */
  workDir: string;
  /** 진단 보고서 폴더 */
  diagnosticsDir: string;
  /** 계열 확정 상태를 기억할 파일 */
  cliStatePath: string;
  /** 벤더 CLI 경로 */
  cliPaths: { legacy: string; pro: string };
  /** PDF 를 래스터화할 해상도 */
  renderDpi: number;
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
};

export type SendResult = { ok: true; pages: number } | { ok: false; reason: string; code?: number };

/** 0.1mm 단위 플레이트 크기. 번호는 벤더가 정한 값이다 */
const PLATEN_SIZES: Record<number, { w: number; h: number }> = {
  0: { w: 4570, h: 4570 }, // 18x18
  1: { w: 4060, h: 4570 }, // 16x18
  2: { w: 3550, h: 4060 }, // 14x16
  3: { w: 2540, h: 3050 }, // 10x12
  4: { w: 1780, h: 2030 }, // 7x8
};

export async function sendToDevice(opts: SendOptions): Promise<SendResult> {
  const log = opts.onLog ?? (() => undefined);
  setCliStatePath(opts.cliStatePath);

  const ctx: CliContext = {
    paths: opts.cliPaths,
    setting: opts.settings.cli,
    printerName: opts.printerName,
    diagnosticsDir: opts.diagnosticsDir,
    onLog: opts.onLog,
  };

  // 작업 파일은 임시 폴더에 모은다. 원본은 건드리지 않아 재시도가 가능해야 한다
  const workDir = fs.mkdtempSync(path.join(opts.workDir || os.tmpdir(), "garment-"));

  try {
    const pages = await convertDesign(opts.designPath, workDir, opts.renderDpi);
    if (pages.length === 0) return { ok: false, reason: "변환된 이미지가 없습니다." };

    const ink = opts.ink ?? opts.settings.ink;
    // 플레이트 교체 대상이면 아동 플레이트로 바꾼다
    const platenSize = opts.needsPlateChange ? opts.settings.platenChild : opts.settings.platenAdult;
    const platen = PLATEN_SIZES[platenSize] ?? PLATEN_SIZES[2];
    const model = preferredModel(opts.settings.cli, opts.printerName);
    const dataExt = dataExtension(opts.settings.cli, opts.printerName, opts.cliPaths);

    for (const [i, page] of pages.entries()) {
      const label = pages.length > 1 ? `${i + 1}/${pages.length}면` : "";

      const xmlPath = buildPrintXml(path.join(workDir, `print_${i + 1}.xml`), opts.settings, {
        ink,
        platenSize,
        targetModel: model || "legacy",
      });

      // 배치 위치 — 자동 맞춤이면 가로 가운데·세로 위쪽, 자동 가운데면 정가운데
      const dims = dimsInMm10(page.width, page.height, page.dpi ?? opts.renderDpi);
      const size = parseSize(opts.settings.size, dims.w, dims.h);
      let position = opts.settings.position;
      if (opts.settings.autoFit) {
        position = fitPosition(size.w, platen.w);
      } else if (opts.settings.autoCenter) {
        position = centerPosition(size.w, size.h, platen.w, platen.h);
      }

      const dataPath = path.join(workDir, `print_${i + 1}${dataExt}`);

      // 인쇄 데이터 생성 — 여기서 계열이 확정된다
      const args = ["print", "-X", xmlPath, "-I", page.filePath, "-A", dataPath, "-L", position];
      // -S 와 -R 은 동시에 못 준다. 하나는 반드시 있어야 한다
      if (opts.settings.size) args.push("-S", opts.settings.size);
      else if (opts.settings.magnification) args.push("-R", opts.settings.magnification);
      if (opts.settings.whiteAs !== undefined) args.push("-W", String(opts.settings.whiteAs));

      const created = await runWithProbe(ctx, args);
      if (created.code !== 0) {
        return { ok: false, reason: `인쇄 데이터 생성 실패${label ? ` (${label})` : ""}: ${created.description}`, code: created.code };
      }

      // 수량만큼 반복 전송한다. 장비가 매수를 스스로 늘리지 않는다
      for (let copy = 1; copy <= Math.max(1, opts.quantity); copy++) {
        const sendArgs = ["send", "-A", dataPath, "-P", opts.printerName];
        // 인쇄 후 작업 삭제(-D)는 pro 전용이다. legacy 에 주면 -3301 로 실패한다
        if (dataExt === ".arxp") sendArgs.push("-D", opts.settings.autoDelete ? "1" : "0");

        const sent = await runOnActive(ctx, sendArgs);
        if (sent.code !== 0) {
          return { ok: false, reason: `장비 전송 실패${label ? ` (${label})` : ""}: ${sent.description}`, code: sent.code };
        }
        log("info", `장비 전송 ${copy}/${opts.quantity}${label ? ` · ${label}` : ""}`);
      }
    }

    return { ok: true, pages: pages.length };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  } finally {
    // 작업 파일에 디자인 원본이 들어 있다. 끝나면 지운다
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      // 지우지 못해도 전송 결과에는 영향이 없다
    }
  }
}

export { disposeConverter } from "./convert";
export { DEFAULT_PRINT_SETTINGS, INK_COLOR_ONLY, INK_WHITE_AND_COLOR, type PrintSettings } from "./print-settings";
export { RETURN_CODES } from "./cli";
export { DeviceStatusPoller, readDeviceStatus, type DeviceStatus, type DeviceState } from "./status";

/** 장비 상태 조회에 쓸 실행 맥락. 설정이 바뀌면 그때그때 새로 만든다 */
export function deviceContext(opts: {
  cliPaths: { legacy: string; pro: string };
  setting: PrintSettings["cli"];
  printerName: string;
  diagnosticsDir: string;
  cliStatePath: string;
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
}) {
  setCliStatePath(opts.cliStatePath);
  return {
    paths: opts.cliPaths,
    setting: opts.setting,
    printerName: opts.printerName,
    diagnosticsDir: opts.diagnosticsDir,
    onLog: opts.onLog,
  };
}
