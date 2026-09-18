/**
 * Lucide 아이콘을 renderer 가 바로 쓸 수 있는 한 파일로 뽑는다.
 *
 * 렌더러에는 번들러가 없어 `import` 를 쓸 수 없다. 그렇다고 이모지를 두면 Windows·macOS 가
 * 서로 다른 그림을 그리고 색도 못 맞춘다. 그래서 필요한 것만 골라 인라인 SVG 로 굳힌다.
 *
 * 결과물 `renderer/icons.js` 는 생성물이다 — 손으로 고치지 말고 이 스크립트를 다시 돌린다.
 *   pnpm icons
 *
 * lucide-static 은 devDependency 다. 배포물에는 뽑아낸 SVG 만 들어가고 패키지는 따라가지 않는다.
 */
const fs = require("node:fs");
const path = require("node:path");

/** 화면에서 쓰는 것만. 늘어나면 여기에 적는다 */
const WANTED = [
  "x", // 칩·카드 삭제
  "image", // 썸네일 자리
  "file-text", // 작업지시서
  "baby", // 아동 플레이트 교체
  "refresh-cw", // 전송 중
  "circle-check", // 완료
  "triangle-alert", // 경고
  "circle-x", // 실패
  "sun", // 테마 — 라이트
  "moon", // 테마 — 다크
  "monitor", // 테마 — 시스템
  "folder-open", // 실패 건의 error 폴더 열기
];

const src = path.join(__dirname, "..", "node_modules", "lucide-static", "icons");
const dest = path.join(__dirname, "..", "renderer", "icons.js");

const entries = WANTED.map((name) => {
  const file = path.join(src, `${name}.svg`);
  if (!fs.existsSync(file)) throw new Error(`lucide 에 없는 아이콘: ${name}`);
  // <svg …> 바깥 껍데기는 렌더러가 직접 씌운다. 안쪽 도형만 꺼낸다
  const body = fs
    .readFileSync(file, "utf8")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^[\s\S]*?<svg[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("");
  return `  "${name}": '${body.replace(/'/g, "\\'")}',`;
});

const out = `/**
 * 생성물 — scripts/build-icons.js 가 lucide-static 에서 뽑는다. 손으로 고치지 말 것.
 * 아이콘을 늘리려면 그 스크립트의 WANTED 에 적고 \`pnpm icons\` 를 돌린다.
 *
 * Lucide (ISC License) — https://lucide.dev
 */
const ICON_BODY = {
${entries.join("\n")}
};

/**
 * 아이콘 하나를 만든다.
 *
 * stroke 가 currentColor 라 글자색을 그대로 따라간다 — 다크 모드나 오류 빨강에 자동으로 맞는다.
 * 크기는 CSS(.icon)가 쥔다. 장식이라 스크린 리더에는 감춘다.
 */
function icon(name, className) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("fill", "none");
  el.setAttribute("stroke", "currentColor");
  el.setAttribute("stroke-width", "2");
  el.setAttribute("stroke-linecap", "round");
  el.setAttribute("stroke-linejoin", "round");
  el.setAttribute("aria-hidden", "true");
  el.setAttribute("class", className ? \`icon \${className}\` : "icon");
  el.innerHTML = ICON_BODY[name] ?? "";
  return el;
}
`;

fs.writeFileSync(dest, out, "utf8");
console.log(`renderer/icons.js — 아이콘 ${entries.length}개 생성`);
