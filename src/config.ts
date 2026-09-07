import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

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
});

let cache: AppConfig | null = null;

const filePath = (): string => path.join(app.getPath("userData"), "config.json");

export const getConfig = (): AppConfig => {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(filePath(), "utf8");
    // 저장된 값이 우선하되, 새로 생긴 항목은 기본값으로 채운다
    cache = { ...defaults(), ...(JSON.parse(raw) as Partial<AppConfig>) };
  } catch {
    // 파일이 없거나 깨졌다. 기본값으로 시작한다 — 설정이 깨졌다고 앱이 안 뜨면 안 된다
    cache = defaults();
  }
  return cache;
};

export const setConfig = (patch: Partial<AppConfig>): AppConfig => {
  const next = { ...getConfig(), ...patch };
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
