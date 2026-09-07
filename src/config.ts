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

  /** 장비 전송용 프린터 이름 (비면 기본 장치) */
  garmentPrinterName: string;
  /** 작업지시서를 뽑을 일반 프린터 이름 */
  workOrderPrinterName: string;

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

  /** 장비 인쇄 설정 */
  print: PrintSettings;
};

const defaults = (): AppConfig => ({
  baseUrl: "https://store.dpl.shop",
  apiKey: "",
  tenant: "",
  garmentEnabled: true,
  workOrderEnabled: false,
  garmentPrinterName: "",
  workOrderPrinterName: "",
  pollIntervalSec: 5,
  downloadDir: path.join(app.getPath("userData"), "downloads"),
  autoSend: false,
  cliLegacyPath: "",
  cliProPath: "",
  renderDpi: 300,
  print: { ...DEFAULT_PRINT_SETTINGS },
});

let cache: AppConfig | null = null;

const filePath = (): string => path.join(app.getPath("userData"), "config.json");

export const getConfig = (): AppConfig => {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(filePath(), "utf8");
    // 저장된 값이 우선하되, 새로 생긴 항목은 기본값으로 채운다
    const saved = JSON.parse(raw) as Partial<AppConfig>;
    // print 는 중첩이라 얕은 병합으로는 새로 생긴 항목이 빈다
    cache = { ...defaults(), ...saved, print: { ...DEFAULT_PRINT_SETTINGS, ...(saved.print ?? {}) } };
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
