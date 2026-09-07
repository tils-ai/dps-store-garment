/*
  빌드 직전, vendor/ 의 가명 자산을 실제 이름으로 복원한다.

  레포는 공개다. 그래서 **벤더 원본 파일명을 git 에 남기지 않는다.**
  추적되는 것은 가명 바이너리(vendor/*.bin, *.lib)뿐이고, 원본 라이브러리 이름은
  미추적 매니페스트(vendor/.dll_manifest) 또는 CI secret 으로만 들어온다.

    vendor/cli_legacy.bin  →  .vendor-build/cli_legacy.exe   (중립 이름, 제품 특정 불가)
    vendor/cli_pro.bin     →  .vendor-build/cli_pro.exe
    vendor/cli_legacy.lib  →  .vendor-build/<원본 라이브러리 이름>
    vendor/cli_pro.lib     →  .vendor-build/<원본 라이브러리 이름>

  실행 파일은 코드가 찾는 중립 이름으로 복원한다. 라이브러리는 실행 파일이 내부에서
  원본 이름으로 불러오므로 원본 이름이어야 한다 — 그래서 이름만 감춘다.

  복원 결과는 asar 안으로 들어간다. 설치 폴더에 그대로 드러나지 않게 하려는 것이며,
  암호화가 아니다. 파이썬 판이 PyInstaller 로 exe 안에 넣던 것과 목적이 같다.
*/

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.dirname(__dirname);
const VENDOR = path.join(ROOT, "vendor");
const OUT = path.join(ROOT, ".vendor-build");
const MANIFEST = path.join(VENDOR, ".dll_manifest");

/** 가명 → 중립 실행 파일 이름. 코드가 이 이름을 찾는다 */
const EXE_MAP = {
  "cli_legacy.bin": "cli_legacy.exe",
  "cli_pro.bin": "cli_pro.exe",
};

/** 가명 → 원본 라이브러리 이름. 미추적 매니페스트에서만 읽는다 */
function loadLibMap() {
  const map = {};
  if (!fs.existsSync(MANIFEST)) return map;
  for (const line of fs.readFileSync(MANIFEST, "utf8").split("\n")) {
    const text = line.trim();
    if (!text || text.startsWith("#") || !text.includes("=")) continue;
    const [alias, real] = text.split("=", 2);
    map[alias.trim()] = real.trim();
  }
  return map;
}

function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  if (!fs.existsSync(VENDOR)) {
    console.log("[vendor] vendor 폴더가 없습니다 — 장비 전송 기능이 빠진 빌드가 나옵니다.");
    return;
  }

  const libMap = loadLibMap();
  let restored = 0;

  for (const [alias, realName] of Object.entries(EXE_MAP)) {
    const src = path.join(VENDOR, alias);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(OUT, realName));
    restored += 1;
  }

  for (const [alias, realName] of Object.entries(libMap)) {
    const src = path.join(VENDOR, alias);
    if (!fs.existsSync(src)) {
      console.log(`[vendor] 가명 파일 없음: ${alias}`);
      continue;
    }
    fs.copyFileSync(src, path.join(OUT, realName));
    restored += 1;
  }

  if (restored === 0) {
    // 개발 중에는 벤더 자산이 없을 수 있다. 빌드를 막지는 않는다
    console.log("[vendor] 복원한 자산이 없습니다 — 장비 전송 기능이 빠진 빌드가 나옵니다.");
    return;
  }

  if (Object.keys(libMap).length === 0) {
    console.log("[vendor] 매니페스트가 없어 라이브러리를 복원하지 못했습니다. 실행 파일만 들어갑니다.");
  }
  console.log(`[vendor] ${restored}개 복원 완료 → ${path.relative(ROOT, OUT)}`);
}

main();
