import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  checkArchitecture,
  checkVcRuntime,
  checkZoneIdentifier,
  printerDrivers,
  printerQueues,
  spoolerStatus,
} from "./windows-checks";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * 장비 CLI 호출.
 *
 * 벤더가 제공하는 명령줄 도구를 실행하고 반환 코드를 해석한다. 파이썬 판
 * `garment_cli.py` 를 그대로 옮긴 것으로, **반환 코드 표와 계열 탐색 규칙은 현장에서
 * 드라이버가 갈려 겪은 지식이라 임의로 줄이지 않는다.**
 */

/** 반환 코드 → 작업자가 읽을 설명 */
export const RETURN_CODES: Record<number, string> = {
  0: "성공",
  [-1001]: "드라이버 파일 없음 — 장비 드라이버 설치 확인",
  [-1401]: "드라이버 파일 없음 — 장비 드라이버/API 라이브러리 위치 확인",
  [-1402]: "메모리 할당 실패",
  [-1403]: "프린터를 찾을 수 없거나 드라이버 사용 불가",
  [-2001]: "PNG 파일이 아니거나 로드 불가",
  [-2401]: "프린터 미발견 또는 LAN 미연결",
  [-2701]: "프린터 연결 실패",
  [-3102]: "XML 파일 없음",
  [-3103]: "이미지 파일 없음",
  [-3104]: "-P 와 -A 동시 지정 불가",
  [-3108]: "-S 와 -R 동시 지정 불가 또는 둘 다 미지정",
};

/** 파일·DLL 누락 계열 — 이 코드가 나오면 진단 보고서를 따로 남긴다 */
const FILE_MISSING_CODES = new Set([-1001, -1401, -1403, -2001, -3102, -3103]);

/**
 * 드라이버·장비 매칭 실패 계열 — "이 CLI 가 이 장비에 안 맞음" 신호.
 * 이때만 다른 계열로 넘어간다. 입력 오류(-2001/-3102/-3103)는 어느 CLI 로도 같이 실패한다.
 */
const DRIVER_MISMATCH_CODES = new Set([-1001, -1401, -1403, -1701]);

export type CliModel = "legacy" | "pro";

export type CliPaths = {
  legacy: string;
  pro: string;
};

export type CliResult = {
  code: number;
  description: string;
  stdout: string;
  stderr: string;
  /** 실제로 쓴 실행 파일 */
  exe: string;
};

/** Windows 가 음수 종료 코드를 unsigned 32bit 로 주는 경우를 되돌린다 */
const normalizeCode = (code: number): number => (code > 0x7fffffff ? code - 0x100000000 : code);

const modelForExe = (exe: string): CliModel | "" => {
  const base = path.basename(exe || "").toLowerCase();
  if (base.includes("pro")) return "pro";
  if (base.includes("legacy")) return "legacy";
  return "";
};

/**
 * 확정된 CLI 를 기억한다.
 *
 * 한 번 맞는 계열을 찾으면 이후 작업이 그것을 재사용한다. 매번 탐색하면 첫 시도가
 * 실패로 기록되고 로그가 지저분해진다. 매칭 실패가 나면 지우고 다시 찾는다.
 */
let activeExe: string | null = null;
let statePath = "";

export function setCliStatePath(filePath: string): void {
  statePath = filePath;
}

const loadActiveExe = (paths: CliPaths): string | null => {
  if (activeExe && fs.existsSync(activeExe)) return activeExe;
  try {
    const model = fs.readFileSync(statePath, "utf8").trim() as CliModel;
    const exe = paths[model];
    if (exe && fs.existsSync(exe)) {
      activeExe = exe;
      return exe;
    }
  } catch {
    // 상태 파일이 없거나 깨졌다. 다음 작업에서 다시 찾는다
  }
  return null;
};

const saveActiveExe = (exe: string): void => {
  activeExe = exe;
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, modelForExe(exe), "utf8");
  } catch {
    // 기억하지 못해도 동작에는 지장이 없다. 다음에 다시 찾을 뿐이다
  }
};

const clearActiveExe = (): void => {
  activeExe = null;
  try {
    fs.rmSync(statePath, { force: true });
  } catch {
    // 지우지 못해도 메모리 캐시는 비웠다
  }
};

/**
 * 프린터 이름으로 계열을 추측한다.
 *
 * 설정에서 계열을 못박아 두면 그것을 따른다. 아니면 프린터 이름에서 찾는다.
 * Windows 드라이버명까지 보면 더 정확하지만 그건 네이티브 호출이 필요해, 여기서는
 * 이름만 본다. 판정이 안 되면 탐색으로 넘어간다.
 */
export function preferredModel(setting: "auto" | CliModel, printerName: string): CliModel | "" {
  if (setting === "pro" || setting === "legacy") return setting;
  const target = (printerName || "").toLowerCase().replace(/[\s-]/g, "");
  if (target.includes("pro")) return "pro";
  return "";
}

/** 계열에 맞는 인쇄 데이터 확장자. pro 는 다른 포맷을 쓴다 */
export function dataExtension(setting: "auto" | CliModel, printerName: string, paths: CliPaths): string {
  if (preferredModel(setting, printerName) === "pro") return ".arxp";
  const active = loadActiveExe(paths);
  return modelForExe(active || "") === "pro" ? ".arxp" : ".arx4";
}

/** 시도할 실행 파일 순서 — 추측된 계열을 먼저, 그다음 나머지 */
const candidateExes = (setting: "auto" | CliModel, printerName: string, paths: CliPaths): string[] => {
  const preferred = preferredModel(setting, printerName);
  const ordered: string[] = [];
  if (preferred && paths[preferred]) ordered.push(paths[preferred]);
  for (const exe of [paths.legacy, paths.pro]) {
    if (exe && !ordered.includes(exe)) ordered.push(exe);
  }
  return ordered.filter((exe) => exe && fs.existsSync(exe));
};

async function exec(exe: string, args: string[]): Promise<CliResult> {
  // 실행 파일과 동봉 라이브러리가 같은 폴더에 있어야 동작한다. cwd 를 강제한다
  const cwd = path.dirname(exe) || undefined;
  try {
    const { stdout, stderr } = await run(exe, args, { cwd, timeout: 120_000, windowsHide: true });
    return { code: 0, description: RETURN_CODES[0], stdout: String(stdout), stderr: String(stderr), exe };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    const code = normalizeCode(typeof e.code === "number" ? e.code : -1);
    return {
      code,
      description: RETURN_CODES[code] ?? `알 수 없는 오류 (${code})`,
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? e.message ?? ""),
      exe,
    };
  }
}

export type CliContext = {
  paths: CliPaths;
  setting: "auto" | CliModel;
  printerName: string;
  /** 진단 보고서를 남길 폴더 */
  diagnosticsDir: string;
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
};

/**
 * 계열을 확정하지 않은 명령(인쇄 데이터 생성)에 쓴다.
 *
 * 성공한 CLI 를 확정하고 이후 명령이 재사용한다. 매칭 실패면 다음 후보로 넘어가고,
 * 입력 오류면 즉시 멈춘다. 다른 CLI 로도 똑같이 실패하기 때문이다.
 */
export async function runWithProbe(ctx: CliContext, args: string[]): Promise<CliResult> {
  const candidates = candidateExes(ctx.setting, ctx.printerName, ctx.paths);
  if (candidates.length === 0) {
    return {
      code: -1401,
      description: "장비 CLI 를 찾지 못했습니다. 설치 폴더를 확인하세요.",
      stdout: "",
      stderr: "",
      exe: "",
    };
  }

  let last: CliResult | null = null;
  for (const exe of candidates) {
    const result = await exec(exe, args);
    if (result.code === 0) {
      if (exe !== activeExe) {
        saveActiveExe(exe);
        ctx.onLog?.("info", `장비 CLI 확정: ${modelForExe(exe) || path.basename(exe)}`);
      }
      return result;
    }
    await writeDiagnostics(ctx, result, args);
    if (!DRIVER_MISMATCH_CODES.has(result.code)) return result; // 입력 오류 — 넘어가도 소용없다
    last = result;
  }

  clearActiveExe();
  return last!;
}

/** 계열이 확정된 뒤의 명령(전송·상태·제어)에 쓴다 */
export async function runOnActive(ctx: CliContext, args: string[]): Promise<CliResult> {
  const preferred = preferredModel(ctx.setting, ctx.printerName);
  const exe =
    (preferred && ctx.paths[preferred] && fs.existsSync(ctx.paths[preferred]) ? ctx.paths[preferred] : null) ??
    loadActiveExe(ctx.paths) ??
    ctx.paths.legacy;

  if (!exe || !fs.existsSync(exe)) {
    return { code: -1401, description: "장비 CLI 를 찾지 못했습니다.", stdout: "", stderr: "", exe: "" };
  }

  const result = await exec(exe, args);
  if (result.code !== 0) {
    await writeDiagnostics(ctx, result, args);
    // 확정해 둔 CLI 가 매칭 실패를 내면 캐시를 버려 다음 작업에서 다시 찾게 한다
    if (DRIVER_MISMATCH_CODES.has(result.code) && exe === activeExe) {
      ctx.onLog?.("warn", `확정 CLI 매칭 실패(${result.code}) — 다음 작업에서 다시 찾습니다`);
      clearActiveExe();
    }
  }
  return result;
}

/**
 * 진단 보고서.
 *
 * 파일·DLL 누락 계열은 로그 한 줄로는 원인을 못 찾는다. 사건마다 파일 하나를 남겨
 * 메인 로그가 비대해지지 않게 한다.
 */
async function writeDiagnostics(ctx: CliContext, result: CliResult, args: string[]): Promise<void> {
  if (!FILE_MISSING_CODES.has(result.code)) return;

  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = path.join(ctx.diagnosticsDir, `device-error-${stamp}.txt`);
    const exeDir = path.dirname(result.exe || "");

    const lines = [
      "장비 CLI 진단 보고서",
      "=".repeat(60),
      "",
      "[1] 실행 정보",
      `  CLI 경로   : ${result.exe || "(없음)"}`,
      `  실행 폴더  : ${exeDir || "(없음)"}`,
      `  전달 인자  : ${args.join(" ")}`,
      `  설정 계열  : ${ctx.setting}`,
      `  프린터     : ${ctx.printerName || "(미지정)"}`,
      "",
      "[2] 반환",
      `  코드       : ${result.code}`,
      `  설명       : ${result.description}`,
      `  stdout     : ${result.stdout.trim() || "(없음)"}`,
      `  stderr     : ${result.stderr.trim() || "(없음)"}`,
      "",
      "[3] 벤더 자산 점검",
      // 인터넷에서 받은 파일이 차단돼 있거나 32/64비트가 어긋나면 로드가 조용히 실패한다
      ...inspectVendorAssets(exeDir),
      "",
      "[4] CLI 폴더 내용",
      ...listDir(exeDir),
    ];

    // 입력 파일 누락이면 그 파일의 상위 폴더도 함께 본다
    if (result.code === -2001 || result.code === -3103) lines.push(...inspectArg(args, "-I", "입력 이미지"));
    if (result.code === -3102) lines.push(...inspectArg(args, "-X", "입력 XML"));

    lines.push("", "[5] VC++ 재배포 런타임 (System32)", ...checkVcRuntime());
    // PowerShell 조회는 느리다. 세 갈래를 함께 돌려 보고서 저장이 늦어지지 않게 한다
    const [spooler, drivers, queues] = await Promise.all([spoolerStatus(), printerDrivers(), printerQueues()]);
    lines.push("", "[6] 인쇄 스풀러", spooler);
    lines.push("", "[7] 프린터 드라이버", drivers);
    lines.push("", "[8] 프린터 큐", queues);

    fs.mkdirSync(ctx.diagnosticsDir, { recursive: true });
    fs.writeFileSync(dest, lines.join("\n"), "utf8");
    ctx.onLog?.("error", `진단 보고서 저장: ${dest}`);
  } catch {
    // 보고서를 못 남겨도 본 작업의 실패 처리는 이어져야 한다
  }
}

/**
 * 벤더 자산 점검.
 *
 * 파일을 이름으로 특정하지 않고 폴더 안 실행 파일·라이브러리를 모두 본다. 목록을
 * 코드에 적어 두면 이 공개 레포에 벤더 파일명이 남는다.
 */
const inspectVendorAssets = (dir: string): string[] => {
  if (!dir) return ["  (폴더 없음)"];
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => /\.(exe|dll)$/i.test(name));
  } catch {
    return [`  (읽기 실패: ${dir})`];
  }
  if (names.length === 0) return ["  (실행 파일·라이브러리 없음)"];

  return names.flatMap((name) => {
    const target = path.join(dir, name);
    return [
      `  -- ${name} --`,
      `    Windows 차단 : ${checkZoneIdentifier(target)}`,
      `    아키텍처     : ${checkArchitecture(target)}`,
    ];
  });
};

const listDir = (dir: string): string[] => {
  if (!dir) return ["  (폴더 없음)"];
  try {
    return fs.readdirSync(dir).map((name) => {
      try {
        const stat = fs.statSync(path.join(dir, name));
        return `  ${name}  ${stat.size.toLocaleString()} bytes`;
      } catch {
        return `  ${name}`;
      }
    });
  } catch {
    return [`  (읽기 실패: ${dir})`];
  }
};

const inspectArg = (args: string[], flag: string, label: string): string[] => {
  const i = args.indexOf(flag);
  const value = i >= 0 ? args[i + 1] : undefined;
  if (!value) return [];
  return ["", `[3b] ${label}`, `  경로 : ${value}`, `  존재 : ${fs.existsSync(value)}`, "  상위 폴더:", ...listDir(path.dirname(value))];
};
