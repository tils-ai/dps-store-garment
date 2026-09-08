import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { getConfig } from "./config";

/**
 * 파일 로그.
 *
 * 화면 로그는 앱을 닫으면 사라진다. 현장에서 "어제 그 건이 왜 안 나갔는지"를 확인하려면
 * 파일이 남아 있어야 한다. 파이썬 판의 `logs/watcher.log` 에 해당한다.
 *
 * 한 파일이 무한정 커지지 않도록 크기를 넘으면 한 번 갈아 끼운다. 여러 세대를 남기지는
 * 않는다 — 현장 PC 의 디스크를 갉아먹지 않는 편이 낫다.
 */

const MAX_BYTES = 5 * 1024 * 1024;

let stream: fs.WriteStream | null = null;

const logPath = (): string => path.join(app.getPath("userData"), "logs", "app.log");

const open = (): fs.WriteStream | null => {
  if (stream) return stream;
  try {
    const target = logPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });

    // 커졌으면 직전 것 하나만 남기고 새로 시작한다
    try {
      if (fs.statSync(target).size > MAX_BYTES) {
        fs.renameSync(target, `${target}.1`);
      }
    } catch {
      // 파일이 없으면 그냥 새로 만든다
    }

    stream = fs.createWriteStream(target, { flags: "a", encoding: "utf8" });
    return stream;
  } catch {
    // 로그를 못 남겨도 앱은 돌아야 한다
    return null;
  }
};

/** 낮을수록 덜 중요하다. 설정한 단계보다 낮으면 파일에 남기지 않는다 */
const RANK = { info: 0, warn: 1, error: 2 } as const;

export function writeLog(level: "info" | "warn" | "error", message: string): void {
  // 설정을 못 읽어도 로그는 남아야 한다. 읽기 실패는 info 로 본다
  let threshold: keyof typeof RANK = "info";
  try {
    threshold = getConfig().logLevel;
  } catch {
    // 설정 파일이 아직 준비되지 않은 초기 실행
  }
  if (RANK[level] < RANK[threshold]) return;

  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}\n`;
  open()?.write(line);
  // 개발 중에는 콘솔로도 본다
  if (!app.isPackaged) console.log(line.trimEnd());
}

export function closeLog(): void {
  stream?.end();
  stream = null;
}

export const appLogPath = logPath;
