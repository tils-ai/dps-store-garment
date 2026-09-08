import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPrintXml } from "./build-xml";
import { dataExtension, preferredModel, runOnActive, runWithProbe, setCliStatePath, type CliContext } from "./cli";
import { centerPosition, dimsInMm10, fitPosition, parseSize, readDesignImage } from "./design-file";
import { printImageFiles } from "../printer";
import { extractPrintData } from "./extract";
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
  /** PNG 이 해상도를 밝히지 않을 때 쓸 기본값 */
  renderDpi: number;
  /** 보낸 인쇄 데이터를 되풀어 진단 폴더에 남길지 */
  extractDiagnostic?: boolean;
  /**
   * 전송 방식. `cli` 가 기본이고, `direct` 는 변환한 이미지를 프린터로 그대로 인쇄한다.
   * 벤더 자산이 없거나 CLI 가 듣지 않을 때의 물러설 자리다.
   */
  mode?: "cli" | "direct";
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
};

export type SendResult = { ok: true } | { ok: false; reason: string; code?: number };

/** 0.1mm 단위 플레이트 크기. 번호는 벤더가 정한 값이다 */
/**
 * 플레이트 실측 크기 (0.1mm).
 *
 * 파이썬 판 `config.PLATEN_DIMS` 와 **같은 값이어야 한다.** 배치 좌표를 이 값으로 계산하므로
 * 어긋나면 도안이 플레이트에서 밀린다. 인치를 반올림하지 말 것.
 */
const PLATEN_SIZES: Record<number, { w: number; h: number }> = {
  0: { w: 4064, h: 5334 }, // 16x21
  1: { w: 4064, h: 4572 }, // 16x18
  2: { w: 3556, h: 4064 }, // 14x16
  3: { w: 2540, h: 3048 }, // 10x12
  4: { w: 1778, h: 2032 }, // 7x8
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
    // 받은 PNG 를 그대로 쓴다. 변환도 보정도 하지 않는다 (design-file.ts 설명 참조)
    const design = readDesignImage(opts.designPath);

    // 직접 인쇄는 벤더 CLI 를 거치지 않는다. 장비 설정을 실을 수 없어 장비 패널 값을 따른다
    if (opts.mode === "direct") {
      for (let copy = 1; copy <= Math.max(1, opts.quantity); copy++) {
        const printed = await printImageFiles([design.filePath], opts.printerName);
        if (!printed.ok) return { ok: false, reason: `직접 인쇄 실패: ${printed.reason}` };
        log("info", `직접 인쇄 ${copy}/${opts.quantity}`);
      }
      return { ok: true };
    }

    const ink = opts.ink ?? opts.settings.ink;
    // 플레이트 교체 대상이면 아동 플레이트로 바꾼다
    const platenSize = opts.needsPlateChange ? opts.settings.platenChild : opts.settings.platenAdult;
    const platen = PLATEN_SIZES[platenSize] ?? PLATEN_SIZES[0];
    const model = preferredModel(opts.settings.cli, opts.printerName);
    const dataExt = dataExtension(opts.settings.cli, opts.printerName, opts.cliPaths);

    const xmlPath = buildPrintXml(path.join(workDir, "print.xml"), opts.settings, {
      ink,
      platenSize,
      targetModel: model || "legacy",
    });

    /*
        배치와 크기.

        세 갈래이고 순서가 중요하다 (파이썬 판 `_print_via_cli` 와 같다).

        1. 자동 맞춤(크기 수동 지정이 없을 때) — 플레이트에 들어가도록 **줄이기만** 하고
           (원본이 작으면 그대로) 가로 가운데·세로 위쪽에 놓는다. 이때는 배율(-R)이 아니라
           **0.1mm 절대 크기(-S)** 로 넘긴다. pro 계열은 DPI 없는 PNG + -R 조합에서 기본 DPI
           해석이 달라져 출력 크기가 튄다
        2. 크기 수동 지정 — 그 값을 그대로 쓰고, 자동 가운데면 가운데 배치
        3. 그 외 — 배율(있으면)로 환산한 크기로 자동 가운데 배치
      */
    const dims = dimsInMm10(design.width, design.height, design.dpi ?? opts.renderDpi);
    const manualSize = opts.settings.size;
    const pad4 = (v: number): string => String(Math.max(0, Math.min(9999, v))).padStart(4, "0");

    let sizeArg = "";
    let magArg = "";
    let position = opts.settings.position;
    let effW = dims.w;
    let effH = dims.h;

    if (opts.settings.autoFit && !manualSize) {
      const scale = Math.min(platen.w / Math.max(1, dims.w), platen.h / Math.max(1, dims.h), 1);
      effW = Math.round(dims.w * scale);
      effH = Math.round(dims.h * scale);
      sizeArg = `${pad4(effW)}${pad4(effH)}`;
      position = fitPosition(effW, platen.w);
    } else if (manualSize) {
      sizeArg = manualSize;
      const parsed = parseSize(manualSize, dims.w, dims.h);
      effW = parsed.w;
      effH = parsed.h;
      if (opts.settings.autoCenter) position = centerPosition(effW, effH, platen.w, platen.h);
    } else {
      magArg = opts.settings.magnification || "";
      if (magArg) {
        const mag = Number(magArg) / 1000;
        effW = Math.round(dims.w * mag);
        effH = Math.round(dims.h * mag);
      }
      if (opts.settings.autoCenter) position = centerPosition(effW, effH, platen.w, platen.h);
    }

    // 출력물이 어긋났을 때 무엇을 계산했는지가 이 줄에만 남는다
    log(
      "info",
      `배치 — ${opts.needsPlateChange ? "아동" : "성인"} 플레이트 ${platen.w}x${platen.h}, ` +
        `이미지 ${effW}x${effH} (0.1mm), 위치 ${position}, size=${sizeArg || "-"}, mag=${magArg || "-"}`,
    );

    const dataPath = path.join(workDir, `print${dataExt}`);

    // 인쇄 데이터 생성 — 여기서 계열이 확정된다
    const args = ["print", "-X", xmlPath, "-I", design.filePath, "-A", dataPath, "-L", position];
    // -S 와 -R 은 동시에 못 준다. 하나는 반드시 있어야 한다
    if (sizeArg) args.push("-S", sizeArg);
    else if (magArg) args.push("-R", magArg);
    if (opts.settings.whiteAs !== undefined) args.push("-W", String(opts.settings.whiteAs));

    const created = await runWithProbe(ctx, args);
    if (created.code !== 0) {
      return {
        ok: false,
        reason: `인쇄 데이터 생성 실패: ${created.description}`,
        code: created.code,
      };
    }

    // 무엇을 보냈는지 되풀어 남긴다. 문제를 쫓을 때만 켠다
    if (opts.extractDiagnostic) {
      const extracted = await extractPrintData(ctx, dataPath, opts.diagnosticsDir, 1);
      log(extracted.ok ? "info" : "warn", extracted.ok ? "인쇄 데이터 진단 저장" : extracted.reason!);
    }

    // 수량만큼 반복 전송한다. 장비가 매수를 스스로 늘리지 않는다
    for (let copy = 1; copy <= Math.max(1, opts.quantity); copy++) {
      const sendArgs = ["send", "-A", dataPath, "-P", opts.printerName];
      // 인쇄 후 작업 삭제(-D)는 pro 전용이다. legacy 에 주면 -3301 로 실패한다
      if (dataExt === ".arxp") sendArgs.push("-D", opts.settings.autoDelete ? "1" : "0");

      const sent = await runOnActive(ctx, sendArgs);
      if (sent.code !== 0) {
        return {
          ok: false,
          reason: `장비 전송 실패: ${sent.description}`,
          code: sent.code,
        };
      }
      log("info", `장비 전송 ${copy}/${opts.quantity}`);
    }

    return { ok: true };
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
