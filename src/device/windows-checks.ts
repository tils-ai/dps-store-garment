import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Windows 환경 점검.
 *
 * 현장에서 장비 전송이 깨지는 원인은 코드가 아니라 PC 상태인 경우가 대부분이다.
 * 인터넷에서 받은 파일이 차단돼 있거나, 32/64비트가 어긋났거나, VC++ 런타임이 없거나,
 * 스풀러가 죽어 있다. 진단 보고서에 그 네 가지를 함께 담는다.
 *
 * Windows 가 아니면 모두 건너뛴다 — 개발 중인 맥에서 무의미한 실패를 남기지 않는다.
 */

export const isWindows = process.platform === "win32";

/**
 * NTFS 대체 데이터 스트림 `Zone.Identifier`.
 *
 * 인터넷에서 받은 파일에 Windows 가 붙이는 표식이다. 붙어 있으면 실행이 막히거나
 * 라이브러리 로드가 조용히 실패한다.
 */
export function checkZoneIdentifier(target: string): string {
  if (!isWindows) return "(Windows 아님)";
  if (!fs.existsSync(target)) return "(파일 없음)";
  try {
    const content = fs.readFileSync(`${target}:Zone.Identifier`, "utf8").trim();
    if (!content) return "차단 표시 있음 (Zone 정보 비어 있음)";
    return `차단됨 — ${content.replace(/\r?\n/g, " | ")}`;
  } catch (error) {
    // 스트림이 없으면 ENOENT — 차단 표식이 없다는 뜻이다
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "정상 (차단 표시 없음)";
    return `확인 실패: ${(error as Error).message}`;
  }
}

/** PE 헤더의 machine 값 → 아키텍처. 32/64비트가 어긋나면 로드 자체가 실패한다 */
export function checkArchitecture(target: string): string {
  if (!fs.existsSync(target)) return "(파일 없음)";
  let fd: number | null = null;
  try {
    fd = fs.openSync(target, "r");
    const head = Buffer.alloc(2);
    fs.readSync(fd, head, 0, 2, 0);
    if (head.toString("latin1") !== "MZ") return "PE 아님 (MZ 시그니처 없음)";

    const offset = Buffer.alloc(4);
    fs.readSync(fd, offset, 0, 4, 0x3c);
    const peOffset = offset.readUInt32LE(0);

    const signature = Buffer.alloc(4);
    fs.readSync(fd, signature, 0, 4, peOffset);
    if (signature.toString("latin1") !== "PE\0\0") return "PE 시그니처 없음";

    const machine = Buffer.alloc(2);
    fs.readSync(fd, machine, 0, 2, peOffset + 4);
    const value = machine.readUInt16LE(0);
    return (
      { 0x014c: "x86 (32-bit)", 0x8664: "x64 (64-bit)", 0xaa64: "ARM64" }[value] ??
      `알 수 없음 (machine=0x${value.toString(16).padStart(4, "0")})`
    );
  } catch (error) {
    return `확인 실패: ${(error as Error).message}`;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** 벤더 라이브러리가 의존하는 VC++ 재배포 런타임 */
const VC_RUNTIME = ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll", "msvcp140_1.dll"];

export function checkVcRuntime(): string[] {
  if (!isWindows) return ["  (Windows 아님 — 건너뜀)"];
  const system32 = path.join(process.env.WINDIR || "C:\\Windows", "System32");
  return VC_RUNTIME.map((name) => {
    const found = fs.existsSync(path.join(system32, name));
    return `  ${name.padEnd(22)} : ${found ? "존재" : "없음 (재배포 패키지 미설치 가능성)"}`;
  });
}

/** PowerShell 한 줄 실행. 실패 사유도 문자열로 돌려준다 — 보고서가 끊기면 안 된다 */
export function powershell(script: string, timeoutMs = 15_000): Promise<string> {
  if (!isWindows) return Promise.resolve("(Windows 아님)");
  return new Promise((resolve) => {
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: timeoutMs, windowsHide: true },
      (error, stdout, stderr) => {
        const out = (stdout || "").trim();
        if (out) return resolve(out);
        if (error) return resolve(`(실행 실패: ${error.message})`);
        resolve((stderr || "").trim() || "(출력 없음)");
      }
    );
  });
}

/** 인쇄 스풀러 상태 — 죽어 있으면 어떤 인쇄도 나가지 않는다 */
export const spoolerStatus = (): Promise<string> =>
  powershell("(Get-Service Spooler | Select-Object Status,Name,StartType | Format-List | Out-String).Trim()");

/**
 * 설치된 프린터 드라이버와 큐.
 *
 * 제조사로 걸러내지 않고 전부 나열한다. 걸러내려면 제품명을 코드에 적어야 하는데,
 * 이 레포는 공개라 장비 명칭을 남기지 않는다. 목록이 몇 줄 길어질 뿐이다.
 */
export const printerDrivers = (): Promise<string> =>
  powershell("(Get-PrinterDriver | Select-Object Name,Manufacturer | Format-Table -AutoSize | Out-String).Trim()");

export const printerQueues = (): Promise<string> =>
  powershell(
    "(Get-Printer | Select-Object Name,DriverName,PortName,PrinterStatus | Format-Table -AutoSize | Out-String).Trim()"
  );
