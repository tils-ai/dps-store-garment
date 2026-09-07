import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runOnActive, type CliContext } from "./cli";

/**
 * 장비 상태 조회.
 *
 * 상태 명령은 **LAN 으로 연결된 장비 전용**이다. USB 로 붙었거나 꺼져 있으면 조회가
 * 실패하고, 그때는 오프라인으로 본다.
 *
 * 전송(send)은 오래 걸리는 작업이라, 출력 중에도 상태를 읽으려면 별도 주기로 돌아야 한다.
 */

/** 상태 비트 — 벤더 가이드에 정의된 값이다 */
const PS_INITIALIZING = 0x01;
const PS_STANDBY = 0x02;
const PS_READY = 0x04;
const PS_PRINTING = 0x08;
const PS_MENU_ACTIVE = 0x10;
const PS_ERROR_STOP = 0x20;

/** 심각(멈춤) 계열 — 가이드 샘플의 오타 표기도 함께 받는다 */
const FATAL_KEYS = ["Fatal Error", "Fatal Error2", "Usual Error", "Usal Error"];
/** 경고 계열 — 출력은 계속되지만 사람이 알아야 한다 */
const WARN_KEYS = ["Wait OK", "Wait OK2", "Warning"];

export type DeviceState = "error" | "printing" | "init" | "ready" | "standby" | "menu" | "unknown";

export type DeviceStatus = {
  state: DeviceState;
  printing: boolean;
  errors: string[];
  warnings: string[];
  raw: string;
};

/** 아주 단순한 CSV 분해. 상태 파일은 따옴표 이스케이프를 쓰지 않는다 */
const parseCsv = (text: string): string[][] =>
  text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => line.split(",").map((cell) => cell.trim().replace(/^"|"$/g, "")));

const meaningful = (cells: string[]): string[] => cells.filter((c) => c !== "" && c !== "0");

export function parseStatusRows(rows: string[][]): DeviceStatus | null {
  const fields = new Map<string, string[]>();
  for (const row of rows) {
    const key = (row[0] ?? "").trim();
    if (key) fields.set(key, row.slice(1));
  }

  const raw = (fields.get("Printer Status") ?? [""])[0] ?? "";
  if (!raw) return null;

  const value = Number.parseInt(raw, 16);
  if (Number.isNaN(value)) return null;

  const collect = (keys: string[]): string[] =>
    keys
      .filter((k) => fields.has(k) && meaningful(fields.get(k)!).length > 0)
      .map((k) => `${k}: ${meaningful(fields.get(k)!).join(", ")}`);

  const errors = collect(FATAL_KEYS);
  const warnings = collect(WARN_KEYS);

  const errorStop = Boolean(value & PS_ERROR_STOP);
  const printing = Boolean(value & PS_PRINTING);
  const hasError = errorStop || errors.length > 0;

  let state: DeviceState = "unknown";
  if (hasError) state = "error";
  else if (printing) state = "printing";
  else if (value & PS_INITIALIZING) state = "init";
  else if (value & PS_READY) state = "ready";
  else if (value & PS_STANDBY) state = "standby";
  else if (value & PS_MENU_ACTIVE) state = "menu";

  return { state, printing, errors, warnings, raw };
}

/** 상태를 한 번 읽는다. LAN 이 아니거나 꺼져 있으면 null (= 오프라인) */
export async function readDeviceStatus(ctx: CliContext): Promise<DeviceStatus | null> {
  if (!ctx.printerName) return null;

  const csvPath = path.join(os.tmpdir(), `device-status-${Date.now()}.csv`);
  try {
    const result = await runOnActive(ctx, ["status", "-P", ctx.printerName, "-S", csvPath]);
    if (result.code !== 0 || !fs.existsSync(csvPath)) return null;
    // BOM 이 붙어 오는 경우가 있어 걷어낸다
    const text = fs.readFileSync(csvPath, "utf8").replace(/^﻿/, "");
    return parseStatusRows(parseCsv(text));
  } catch {
    return null;
  } finally {
    try {
      fs.rmSync(csvPath, { force: true });
    } catch {
      // 임시 파일이 남아도 다음 조회에는 지장이 없다
    }
  }
}

/**
 * 주기 조회.
 *
 * 전송 중에도 돌아야 하므로 폴링 루프와 따로 둔다. 다만 조회 자체가 CLI 호출이라
 * 전송과 겹치면 장비가 바쁠 수 있어, 간격을 넉넉히 잡는다.
 */
export class DeviceStatusPoller {
  private timer: NodeJS.Timeout | null = null;
  private last: DeviceStatus | null = null;

  constructor(
    private readonly getContext: () => CliContext | null,
    private readonly onStatus: (status: DeviceStatus | null) => void,
    private readonly intervalMs = 15_000
  ) {}

  get current(): DeviceStatus | null {
    return this.last;
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    const ctx = this.getContext();
    if (ctx) {
      const status = await readDeviceStatus(ctx);
      // 같은 상태를 계속 밀면 화면이 불필요하게 다시 그려진다
      if (JSON.stringify(status) !== JSON.stringify(this.last)) {
        this.last = status;
        this.onStatus(status);
      }
    }
    this.timer = setTimeout(() => void this.tick(), this.intervalMs);
  }
}
