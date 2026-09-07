import fs from "node:fs";
import path from "node:path";
import { runOnActive, type CliContext } from "./cli";

/**
 * 장비 관리 명령.
 *
 * 모두 **LAN 으로 연결된 장비 전용**이다. USB 로 붙었거나 꺼져 있으면 실패한다.
 * 파이썬 판 `garment_cli` 의 관리 함수들을 그대로 옮긴 것이다.
 *
 * 인쇄 중에 보내면 장비가 거절하거나 현재 작업이 흐트러질 수 있어, 화면에서는 장비가
 * 출력 중일 때 버튼을 막는다.
 */

export type MaintenanceCommand =
  | "circulation"
  | "autoCleaning"
  | "printDisable"
  | "printEnable"
  | "menuLock"
  | "menuUnlock";

/** 화면에 그대로 쓰는 이름. 장비 제품명은 넣지 않는다 */
export const MAINTENANCE_LABELS: Record<MaintenanceCommand, string> = {
  circulation: "흰색 잉크 순환",
  autoCleaning: "자동 클리닝",
  printDisable: "인쇄 버튼 잠금",
  printEnable: "인쇄 버튼 해제",
  menuLock: "메뉴 잠금",
  menuUnlock: "메뉴 해제",
};

/** CLI 하위 명령 이름. 대소문자까지 벤더가 정한 그대로여야 한다 */
const ARGV: Record<MaintenanceCommand, string> = {
  circulation: "Circulation",
  autoCleaning: "AutoCleaning",
  printDisable: "PrintDisable",
  printEnable: "PrintEnable",
  menuLock: "MenuLock",
  menuUnlock: "MenuUnlock",
};

export type MaintenanceResult = { ok: boolean; reason?: string };

export async function runMaintenance(ctx: CliContext, command: MaintenanceCommand): Promise<MaintenanceResult> {
  if (!ctx.printerName) return { ok: false, reason: "장비를 먼저 선택하세요." };

  const result = await runOnActive(ctx, [ARGV[command], "-P", ctx.printerName]);
  if (result.code !== 0) {
    return { ok: false, reason: `${MAINTENANCE_LABELS[command]} 실패: ${result.description}` };
  }
  return { ok: true };
}

/**
 * 장비 로그를 내려받아 이력 CSV 로 푼다.
 *
 * 원본 로그는 사람이 읽을 수 없는 형식이라, 인쇄·조작·정비 세 갈래 CSV 로 뽑아야
 * 현장에서 확인이 된다. 두 단계(getlog → picklog)를 한 번에 돌린다.
 */
export async function collectDeviceLog(
  ctx: CliContext,
  outDir: string
): Promise<{ ok: boolean; dir?: string; reason?: string }> {
  if (!ctx.printerName) return { ok: false, reason: "장비를 먼저 선택하세요." };

  // 받을 때마다 폴더를 나눈다. 덮어쓰면 직전 것과 견줄 수 없다
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(outDir, `device-log-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });

  const logPath = path.join(dir, "device.log");
  const got = await runOnActive(ctx, ["getlog", "-P", ctx.printerName, "-L", logPath]);
  if (got.code !== 0) return { ok: false, reason: `장비 로그 내려받기 실패: ${got.description}` };

  const picked = await runOnActive(ctx, [
    "picklog",
    "-L",
    logPath,
    "-P",
    path.join(dir, "print.csv"),
    "-O",
    path.join(dir, "operation.csv"),
    "-M",
    path.join(dir, "maintenance.csv"),
  ]);
  // 추출이 실패해도 원본 로그는 남았다. 벤더에 그대로 보낼 수 있으므로 실패로 보지 않는다
  if (picked.code !== 0) {
    return { ok: true, dir, reason: `이력 CSV 추출 실패(원본 로그는 저장됨): ${picked.description}` };
  }
  return { ok: true, dir };
}
