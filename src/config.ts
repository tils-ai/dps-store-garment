import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PRINT_SETTINGS, type PrintSettings } from "./device/print-settings";

/**
 * 설정 저장.
 *
 * 파이썬 판은 실행 폴더의 `config.ini` 를 썼다. Electron 은 설치 폴더가 쓰기 불가일 수
 * 있고(Program Files) 자동 업데이트로 통째로 교체되므로, **사용자 데이터 폴더**에 둔다.
 * 그래야 업데이트해도 API 키와 프린터 설정이 살아남는다.
 */

export type AppConfig = {
  /** 서버 주소 */
  baseUrl: string;
  /** 발급받은 프린터 API 키. 비어 있으면 인증 화면을 띄운다 */
  apiKey: string;
  /** 인증에 쓴 스토어 식별자 (재인증 시 기본값으로 채운다) */
  tenant: string;

  /** 디자인을 장비로 보내는 역할을 이 단말이 맡는지 */
  garmentEnabled: boolean;
  /** 작업지시서를 인쇄하는 역할을 이 단말이 맡는지 */
  workOrderEnabled: boolean;

  /**
   * 장비 전송용 프린터 이름들.
   *
   * 한 단말에 장비를 여러 대 물릴 수 있다. 같은 장비에 두 건을 동시에 밀면 CLI 와 장비가
   * 엉키므로 **장비별로 한 건씩 차례로** 보내고, 장비끼리는 동시에 나간다.
   */
  garmentPrinterNames: string[];
  /**
   * 여러 대일 때 나누는 방식.
   *
   * `round_robin` 은 번갈아 보내고, `single` 은 첫 번째 것만 쓴다. 한 대를 잠시
   * 빼 두고 싶을 때 목록을 지우지 않고 `single` 로 돌린다.
   */
  garmentDispatch: "round_robin" | "single";
  /**
   * 장비로 보내는 방식.
   *
   * `cli` 는 벤더 CLI 로 인쇄 데이터를 만들어 보낸다(기본). `direct` 는 변환한 이미지를
   * Windows 프린터로 그대로 인쇄한다 — 벤더 자산이 없거나 CLI 가 듣지 않을 때의 물러설 자리다.
   */
  garmentMode: "cli" | "direct";
  /** 작업지시서를 뽑을 일반 프린터 이름 */
  workOrderPrinterName: string;

  /**
   * 장비 상태를 주기 조회할지와 그 간격(초).
   *
   * 상태 조회는 LAN 연결 장비에서만 되고, 조회 자체가 CLI 호출이라 전송과 겹치면
   * 장비가 바쁠 수 있다. 기본은 꺼짐이다.
   */
  deviceStatusEnabled: boolean;
  deviceStatusIntervalSec: number;

  /**
   * 감시 폴더를 볼지.
   *
   * 서버 큐와 별개로, 다른 시스템이 폴더에 떨궈 놓은 파일도 출력한다. 기본은 꺼짐이다 —
   * 켜 두면 폴더에 잘못 들어온 파일까지 대기 목록에 올라온다.
   */
  watchEnabled: boolean;
  /** 감시할 폴더 */
  incomingDir: string;
  /** 집은 원본을 치울 폴더 */
  doneDir: string;
  /** 담지 못한 원본을 치울 폴더 */
  errorDir: string;

  /** 폴링 간격(초). 서버가 값을 주면 그쪽을 따른다 */
  pollIntervalSec: number;
  /** 내려받은 파일을 둘 폴더 */
  downloadDir: string;

  /**
   * 큐를 받으면 작업자 확인 없이 곧장 장비로 보낼지.
   *
   * 기본은 수동이다. 옷 색(잉크 모드)을 작업자가 골라야 하고, 자동으로 보내면
   * 잘못 들어온 건도 그대로 나간다.
   */
  autoSend: boolean;

  /** 벤더 CLI 경로. 비면 설치 폴더에서 찾는다 */
  cliLegacyPath: string;
  cliProPath: string;

  /** PDF 를 래스터화할 해상도 */
  renderDpi: number;

  /**
   * 장비로 보낸 인쇄 데이터를 되풀어 진단 폴더에 남길지.
   *
   * 출력물이 어긋났을 때 무엇을 보냈는지 확인하는 유일한 경로지만, 건마다 원본·XML·
   * 이미지 세 개가 쌓인다. 기본은 꺼짐이고 문제를 쫓을 때만 켠다.
   */
  extractDiagnostic: boolean;

  /**
   * 파일 로그에 어디까지 남길지.
   *
   * 화면 로그는 그대로 다 보여준다. 이 값은 `logs/app.log` 에만 걸린다 — 오래 켜 두는
   * 현장 PC 에서 파일이 불필요하게 커지지 않게 하려는 것이다.
   */
  logLevel: "info" | "warn" | "error";

  /** 장비 인쇄 설정 */
  print: PrintSettings;
};

const defaults = (): AppConfig => ({
  baseUrl: "https://store.dpl.shop",
  apiKey: "",
  tenant: "",
  garmentEnabled: true,
  workOrderEnabled: false,
  garmentPrinterNames: [],
  garmentDispatch: "round_robin",
  garmentMode: "cli",
  workOrderPrinterName: "",
  deviceStatusEnabled: false,
  deviceStatusIntervalSec: 15,
  watchEnabled: false,
  incomingDir: path.join(app.getPath("userData"), "incoming"),
  doneDir: path.join(app.getPath("userData"), "incoming", "done"),
  errorDir: path.join(app.getPath("userData"), "incoming", "error"),
  pollIntervalSec: 5,
  downloadDir: path.join(app.getPath("userData"), "downloads"),
  autoSend: false,
  cliLegacyPath: "",
  cliProPath: "",
  renderDpi: 300,
  extractDiagnostic: false,
  logLevel: "info",
  print: { ...DEFAULT_PRINT_SETTINGS },
});

let cache: AppConfig | null = null;

const filePath = (): string => path.join(app.getPath("userData"), "config.json");

export const getConfig = (): AppConfig => {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(filePath(), "utf8");
    // 저장된 값이 우선하되, 새로 생긴 항목은 기본값으로 채운다
    const saved = JSON.parse(raw) as Partial<AppConfig> & { garmentPrinterName?: string };
    // print 는 중첩이라 얕은 병합으로는 새로 생긴 항목이 빈다
    cache = { ...defaults(), ...saved, print: { ...DEFAULT_PRINT_SETTINGS, ...(saved.print ?? {}) } };

    // 프린터를 한 대만 담던 예전 설정을 목록으로 옮긴다. 그냥 두면 업데이트하는 순간
    // 장비 설정이 비어 출력이 멈춘다
    if (cache.garmentPrinterNames.length === 0 && saved.garmentPrinterName) {
      cache.garmentPrinterNames = [saved.garmentPrinterName];
    }
  } catch {
    // 파일이 없거나 깨졌다. 기본값으로 시작한다 — 설정이 깨졌다고 앱이 안 뜨면 안 된다
    cache = defaults();
  }
  return cache;
};

export const setConfig = (patch: Partial<AppConfig>): AppConfig => {
  const current = getConfig();
  const next = { ...current, ...patch, print: { ...current.print, ...(patch.print ?? {}) } };
  const target = filePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // 쓰다 중단돼도 기존 설정이 깨지지 않게 임시 파일에 쓰고 바꿔치운다
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(tmp, target);
  cache = next;
  return next;
};

/** 설정 파일 위치 — 문제 확인 때 알려주기 위해 노출한다 */
export const configPath = (): string => filePath();

/**
 * 전송에 쓸 장비 목록.
 *
 * 비어 있으면 빈 이름 하나를 돌려준다 — 기본 프린터로 보낸다는 뜻이고, 목록이 없다고
 * 전송 자체가 막히면 안 된다. `single` 이면 첫 대만 쓴다.
 */
export function printerPool(config: AppConfig): string[] {
  const names = config.garmentPrinterNames.filter((name) => name.trim().length > 0);
  if (names.length === 0) return [""];
  return config.garmentDispatch === "single" ? [names[0]] : names;
}

/** 상태 조회처럼 한 대만 지목해야 할 때 쓰는 대표 장비 */
export const primaryPrinter = (config: AppConfig): string => printerPool(config)[0];

/** 설치본 안에 넣어 둔 벤더 자산 폴더 */
export const vendorDir = (): string =>
  app.isPackaged
    ? // asarUnpack 으로 풀린 자리. asar 안에 있는 실행 파일은 child_process 로 부를 수 없다
      path.join(process.resourcesPath, "app.asar.unpacked", "vendor")
    : path.join(app.getAppPath(), ".vendor-build");

/** 계열 확정 상태를 기억할 파일 */
export const cliStatePath = (): string => path.join(app.getPath("userData"), "active-cli");

/** 진단 보고서 폴더 */
export const diagnosticsDir = (): string => path.join(app.getPath("userData"), "logs", "diagnostics");

/** 작업 파일 임시 폴더 */
export const workDir = (): string => path.join(app.getPath("userData"), "work");
