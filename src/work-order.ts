import type { GarmentJob } from "./types";

/**
 * 작업지시서 HTML.
 *
 * 파이썬 판은 reportlab 좌표로 PDF 를 그린 뒤 프린터에 보냈다. 그 레이아웃 주석이
 * 줄마다 "웹 다운로드와 동일"을 가리키는 데서 보이듯, **원본은 웹의 HTML 이고 PDF 는
 * 그것을 좌표로 옮겨 적은 사본이었다.** 옮겨 적는 과정에서 폰트 임베딩 문제로 인쇄물
 * 글자가 통째로 비던 사고도 났다.
 *
 * 여기서는 사본을 만들지 않는다. 웹과 같은 HTML 을 그려 **그대로 인쇄**한다.
 * PDF 생성도, 폰트 임베딩도, PDF 를 프린터에 밀어 넣는 단계도 없어진다.
 *
 * 기준 치수는 A4 를 96 DPI 로 본 794 x 1123 px 다. 웹 다운로드와 같은 값을 쓴다.
 */

const A4_WIDTH = 794;
const A4_HEIGHT = 1123;
const A4_HEIGHT_WITH_MARGIN = A4_HEIGHT - 96;

export type WorkOrderInput = {
  job: GarmentJob;
  /** 실제로 출력한 도안. 없으면 타일에서 뺀다 */
  designImageDataUrl: string | null;
  /** 에디터 미리보기. 인쇄 면 수만큼 온다 */
  thumbnailDataUrls: string[];
  /** 작업 상세로 가는 QR (data URL) */
  qrDataUrl: string;
  /** 내려받은 디자인 파일명 — 현장에서 파일을 찾을 때 쓴다 */
  designFileName: string;
  /** 전송한 장비 이름 */
  printerName: string;
};

/** `20261211-000001-01(3)` — 주문 안에 디자인이 여러 개면 순번과 총 개수를 붙인다 */
export const formatOrderNumber = (orderNumber: string, itemIndex: number, itemTotal: number): string => {
  if (!itemTotal || itemTotal <= 1) return orderNumber;
  return `${orderNumber}-${String(itemIndex).padStart(2, "0")}(${itemTotal})`;
};

/** HTML 에 값을 끼워 넣기 전 반드시 통과시킨다 */
const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const cell = (label: string, value: string, extra = ""): string => `
  <tr>
    <th>${escapeHtml(label)}</th>
    <td${extra ? ` style="${extra}"` : ""}>${value}</td>
  </tr>`;

export function buildWorkOrderHtml(input: WorkOrderInput): string {
  const { job } = input;
  const watermark = `${job.workOrder.brandName} | ${job.workOrder.tenantName} | ${job.workOrder.printedBy}`;

  // 생산 이미지 + 썸네일. 인쇄 면이 여러 장이면 작업자가 전부 봐야 하므로 모두 싣는다
  const tiles: { url: string; caption: string }[] = [];
  if (input.designImageDataUrl) tiles.push({ url: input.designImageDataUrl, caption: "생산 이미지" });
  input.thumbnailDataUrls.forEach((url, i) => {
    tiles.push({ url, caption: input.thumbnailDataUrls.length > 1 ? `썸네일 ${i + 1}` : "썸네일" });
  });

  // 장수가 늘면 A4 폭(가용 698px)을 넘지 않도록 한 변을 줄인다
  const tileSize = tiles.length > 2 ? 120 : tiles.length > 1 ? 150 : 180;

  const watermarkRow = `
    <span>${escapeHtml(watermark)}</span>
    <span class="strong">⚠ 작업 후 파기 ⚠</span>
    <span>${escapeHtml(job.workOrder.workUrl)}</span>`;

  const rows = [
    cell("주문번호", escapeHtml(formatOrderNumber(job.orderNumber, job.itemIndex, job.itemTotal))),
    cell("상품명", escapeHtml(job.productName)),
    job.optionName
      ? cell(
          "옵션",
          escapeHtml(job.optionName) + (job.needsPlateChange ? " (플레이트 교체)" : ""),
          job.needsPlateChange ? "background:#fff7ed;color:#b45309;font-weight:bold" : ""
        )
      : "",
    cell("수량", `${job.quantity}개`),
    cell("편집번호", escapeHtml(job.wepnpSeqno)),
    input.designFileName ? cell("디자인 파일", `<span class="mono">${escapeHtml(input.designFileName)}</span>`) : "",
    input.printerName ? cell("출력 장비", escapeHtml(input.printerName)) : "",
    `<tr><th class="top">비고</th><td class="note"></td></tr>`,
  ].join("");

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>작업지시서_${escapeHtml(job.orderNumber)}_${escapeHtml(job.wepnpSeqno)}</title>
<style>
  /*
    인쇄 여백은 0 으로 두고 안쪽 padding 으로 잡는다. 드라이버 기본 여백이 끼면
    A4 한 장에 담기지 않고 두 장으로 밀린다.
  */
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    width: ${A4_WIDTH}px;
    height: ${A4_HEIGHT}px;
    padding: 48px;
    background: #fff;
    color: #000;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Malgun Gothic", Roboto, sans-serif;
    position: relative;
  }
  /* 배경색이 있는 칸(표 머리, 경고 배너)이 인쇄에서 빠지지 않게 한다 */
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }

  .wm { position: absolute; display: flex; justify-content: space-between;
        font-size: 11px; color: #dc2626; font-weight: 500; }
  .wm .strong { font-weight: 700; }
  .wm-top { top: 8px; left: 48px; right: 48px; }
  .wm-bottom { bottom: 8px; left: 48px; right: 48px; }
  .wm-left, .wm-right {
    top: 50%; width: ${A4_HEIGHT_WITH_MARGIN}px; height: 20px;
    align-items: center; white-space: nowrap;
  }
  .wm-left  { left: 12px;  transform: rotate(-90deg) translateX(-50%); transform-origin: left center; }
  .wm-right { right: 12px; transform: rotate(90deg)  translateX(50%);  transform-origin: right center; }

  .sheet { display: flex; flex-direction: column; height: 100%; }
  h1 { text-align: center; font-size: 32px; font-weight: bold; margin: 0 0 24px; }
  .sep { border-top: 2px solid #000; margin-bottom: 24px; }

  .plate {
    margin-bottom: 24px; padding: 14px 16px; background: #fde68a;
    border: 2px solid #d97706; border-radius: 8px; text-align: center;
    color: #92400e; font-size: 20px; font-weight: bold;
  }

  table { width: 100%; border-collapse: collapse; font-size: 16px; }
  th, td { padding: 12px 16px; border: 1px solid #ddd; }
  th { background: #f5f5f5; font-weight: bold; width: 120px; text-align: left; }
  th.top { vertical-align: top; }
  td.note { height: 120px; vertical-align: top; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 14px; word-break: break-all; }

  .bottom { margin-top: auto; display: flex; flex-direction: column; align-items: center; gap: 16px; }
  .tiles { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
  .tile { display: flex; flex-direction: column; align-items: center; gap: 8px; }
  .tile img { width: ${tileSize}px; height: ${tileSize}px; object-fit: contain; border: 1px solid #ddd; background: #fafafa; }
  .caption { font-size: 12px; color: #666; }
  .qr img { width: 150px; height: 150px; }
  .qr { display: flex; flex-direction: column; align-items: center; gap: 8px; }
  footer { margin-top: 16px; text-align: center; color: #888; font-size: 12px; }
</style>
</head>
<body>
  <div class="wm wm-top">${watermarkRow}</div>
  <div class="wm wm-left">${watermarkRow}</div>
  <div class="wm wm-right">${watermarkRow}</div>
  <div class="wm wm-bottom">${watermarkRow}</div>

  <div class="sheet">
    <h1>작업지시서</h1>
    <div class="sep"></div>
    ${job.needsPlateChange ? `<div class="plate">⚠ 출력 플레이트 교체 대상 ⚠</div>` : ""}

    <table>${rows}</table>

    <div class="bottom">
      ${
        tiles.length > 0
          ? `<div class="tiles">${tiles
              .map(
                (t) =>
                  `<div class="tile"><img src="${t.url}" alt="${escapeHtml(t.caption)}" /><div class="caption">${escapeHtml(t.caption)}</div></div>`
              )
              .join("")}</div>`
          : ""
      }
      <div class="qr">
        <img src="${input.qrDataUrl}" alt="QR" />
        <div class="caption">작업 상세</div>
      </div>
    </div>

    <footer>생성일시: ${new Date().toLocaleString("ko-KR")}</footer>
  </div>
</body>
</html>`;
}
