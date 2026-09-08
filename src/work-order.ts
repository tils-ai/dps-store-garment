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
 *
 * 양식은 관리자 화면에서 내려받는 지시서와 같다. 한쪽만 고치면 같은 주문의 지시서가
 * 어느 경로로 나왔는지에 따라 달라 보인다.
 *
 * 기준 치수는 A4 를 96 DPI 로 본 794 x 1123 px 다.
 */

const A4_WIDTH = 794;
const A4_HEIGHT = 1123;

export type WorkOrderInput = {
  job: GarmentJob;
  /** 실제로 출력한 도안. 없으면 그 칸을 뺀다 */
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

/**
 * 세트 주문 여부와 순번.
 *
 * 예전에는 주문번호 뒤에 `-01(3)` 을 붙여 세트를 구분했다. 작업자가 그 괄호 숫자를
 * 주문번호의 일부로 읽어 「몇 장 중 몇 번째인지」가 눈에 들어오지 않았다.
 * 주문번호와 세트 순번을 아예 다른 자리에 둔다.
 */
export const getSetInfo = (itemIndex: number, itemTotal: number) => {
  const total = itemTotal && itemTotal > 0 ? itemTotal : 1;
  return {
    /** 지시서가 2장 이상 나오는 주문만 세트다. 한 장짜리 주문에는 SET 영역을 넣지 않는다 */
    isSet: total > 1,
    index: itemIndex,
    total,
    label: `SET ${itemIndex} / ${total}`,
    description: `총 ${total}개 중 ${itemIndex}번째 작업`,
  };
};

/** 주문일시 표기: `2026. 08. 03. 14:52`. 서버가 안 주면 그 줄을 뺀다 */
export const formatOrderedAt = (raw?: string): string => {
  if (!raw) return "";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "";
  const date = d.toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" });
  const time = d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${date} ${time}`;
};

/** HTML 에 값을 끼워 넣기 전 반드시 통과시킨다 */
const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** 이미지 한 칸 — 완성 예시와 생산 이미지는 쓰임이 달라 좌우로 가른다 */
const pane = (caption: string, urls: string[], note = ""): string => `
  <div class="pane">
    <div class="pane-imgs">
      ${urls.map((url) => `<img src="${url}" alt="${escapeHtml(caption)}" style="max-width:${Math.floor(100 / urls.length)}%" />`).join("")}
    </div>
    <div class="pill">${escapeHtml(caption)}</div>
    ${note ? `<div class="note">${escapeHtml(note)}</div>` : ""}
  </div>`;

export function buildWorkOrderHtml(input: WorkOrderInput): string {
  const { job } = input;
  const watermark = `${job.workOrder.brandName} | ${job.workOrder.tenantName} | ${job.workOrder.printedBy}`;
  const set = getSetInfo(job.itemIndex, job.itemTotal);
  const orderedAt = formatOrderedAt(job.workOrder.orderedAt);

  const watermarkRow = `
    <span>${escapeHtml(watermark)}</span>
    <span class="strong">⚠ 작업 후 파기 ⚠</span>
    <span>${escapeHtml(job.workOrder.workUrl)}</span>`;

  const panes: string[] = [];
  if (input.thumbnailDataUrls.length > 0) {
    panes.push(pane("완성 예시 이미지", input.thumbnailDataUrls, "* 실제 출력 색상과 약간의 차이가 있을 수 있습니다."));
  }
  if (input.designImageDataUrl) panes.push(pane("생산 이미지", [input.designImageDataUrl]));

  // 상단 밴드 — 세트면 SET 순번을, 한 장짜리면 그 사실을 밝힌다
  const band = set.isSet
    ? `<div class="band">
        <div class="band-mark">
          <div class="band-title">🛒 세트 주문</div>
          <div class="band-sub">동일 주문의 여러 디자인 중<br />현재 작업지시서입니다.</div>
        </div>
        <div class="band-set">
          <div class="band-set-label">${set.label}</div>
          <div class="band-set-desc">(${set.description})</div>
        </div>
        <div class="band-order">
          <div class="band-order-label">주문번호</div>
          <div class="band-order-value">${escapeHtml(job.orderNumber)}</div>
          ${orderedAt ? `<div class="band-order-time">주문일시 : ${escapeHtml(orderedAt)}</div>` : ""}
        </div>
      </div>`
    : `<div class="band">
        <div class="band-mark">
          <div class="band-title">📋 단일 주문</div>
          <div class="band-sub">이 주문의 작업지시서는<br />이 1장이 전부입니다.</div>
        </div>
        <div class="band-single">
          <div>
            <div class="band-order-label">주문번호</div>
            <div class="band-single-value">${escapeHtml(job.orderNumber)}</div>
          </div>
          ${orderedAt ? `<div class="band-single-time">주문일시<br /><span>${escapeHtml(orderedAt)}</span></div>` : ""}
        </div>
      </div>`;

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
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { margin: 0; padding: 0; }
  body {
    width: ${A4_WIDTH}px;
    height: ${A4_HEIGHT}px;
    padding: 30px 40px;
    background: #fff;
    color: #000;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Malgun Gothic", Roboto, sans-serif;
    position: relative;
  }

  /* 워터마크는 위아래만. 좌우 세로 워터마크는 본문 폭을 갉아먹어 표와 이미지가 눌렸다 */
  .wm { position: absolute; left: 40px; right: 40px; display: flex; justify-content: space-between;
        font-size: 10px; color: #dc2626; font-weight: 500; }
  .wm .strong { font-weight: 700; }
  .wm-top { top: 10px; }
  .wm-bottom { bottom: 10px; }

  .sheet { display: flex; flex-direction: column; height: 100%; }

  .band { display: flex; align-items: stretch; border: 2px solid #000; }
  .band-mark { width: 205px; background: #000; color: #fff; padding: 10px 14px;
               display: flex; flex-direction: column; justify-content: center; }
  .band-title { font-size: 22px; font-weight: 800; letter-spacing: -0.5px; }
  .band-sub { font-size: 11px; line-height: 1.45; margin-top: 5px; }
  .band-set { flex: 1; background: #f5f5f5; border-right: 2px solid #000;
              display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 8px; }
  .band-set-label { font-size: 34px; font-weight: 800; line-height: 1.1; }
  .band-set-desc { font-size: 13px; margin-top: 2px; }
  .band-order { width: 215px; padding: 10px 14px; display: flex; flex-direction: column; justify-content: center; }
  .band-order-label { font-size: 11px; color: #444; }
  .band-order-value { font-size: 19px; font-weight: 800; letter-spacing: -0.3px; }
  .band-order-time { margin-top: 6px; padding-top: 5px; border-top: 1px solid #ddd; font-size: 11px; color: #555; }
  .band-single { flex: 1; padding: 10px 18px; display: flex; align-items: center; justify-content: space-between; }
  .band-single-value { font-size: 26px; font-weight: 800; letter-spacing: -0.3px; }
  .band-single-time { text-align: right; font-size: 11px; color: #555; }
  .band-single-time span { font-size: 14px; color: #000; }

  .sep { border-top: 3px solid #000; margin-top: 12px; }
  h1 { text-align: center; font-size: 30px; font-weight: 800; margin: 14px 0 0; }
  .subtitle { text-align: center; font-size: 13px; color: #555; margin: 4px 0 14px; }

  .plate {
    margin-bottom: 12px; padding: 10px 14px; background: #fde68a;
    border: 2px solid #d97706; border-radius: 8px; text-align: center;
    color: #92400e; font-size: 18px; font-weight: bold;
  }

  /* 짧은 값은 두 쌍씩 한 줄에 담는다. 한 항목씩 쌓으면 표가 지면 절반을 먹는다 */
  table { width: 100%; border-collapse: collapse; font-size: 15px; table-layout: fixed; }
  th, td { padding: 9px 14px; border: 1px solid #ddd; word-break: break-all; }
  th { background: #f5f5f5; font-weight: bold; width: 110px; text-align: left; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  .muted { color: #888; }
  .plate-cell { background: #fff7ed; color: #b45309; font-weight: bold; }

  /* 이미지 영역 — 남는 세로를 전부 쓴다 */
  .panes { flex: 1; min-height: 0; display: flex; border: 1px solid #ddd; border-top: none; }
  .pane { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center;
          justify-content: center; gap: 8px; padding: 12px; }
  .pane + .pane { border-left: 1px solid #ddd; }
  .pane-imgs { flex: 1; min-height: 0; width: 100%; display: flex; align-items: center;
               justify-content: center; gap: 8px; }
  .pane-imgs img { max-height: 100%; object-fit: contain; }
  .pill { background: #000; color: #fff; border-radius: 8px; padding: 5px 16px; font-size: 13px; font-weight: 700; }
  .note { font-size: 10px; color: #666; }

  .bottom { margin-top: 10px; display: flex; align-items: center; gap: 14px; border: 1px solid #bbb; padding: 10px 14px; }
  .qr { display: flex; align-items: center; gap: 10px; }
  .qr img { width: 84px; height: 84px; }
  .qr-text { width: 145px; font-size: 11px; color: #555; line-height: 1.5; }
  .qr-text b { display: block; font-size: 14px; color: #000; margin-bottom: 4px; }
  .set-info { flex: 1; border-left: 1px solid #ccc; padding-left: 14px; }
  .set-info-title { font-size: 13px; font-weight: bold; }
  .set-info-row { display: flex; align-items: center; gap: 14px; margin-top: 6px; }
  .set-info-box { background: #f1f1f1; border-radius: 6px; padding: 5px 16px; text-align: center; }
  .set-info-label { font-size: 22px; font-weight: 800; line-height: 1.15; }
  .set-info-desc { font-size: 11px; }
  .set-info-note { font-size: 11px; color: #333; line-height: 1.6; }
</style>
</head>
<body>
  <div class="wm wm-top">${watermarkRow}</div>
  <div class="wm wm-bottom">${watermarkRow}</div>

  <div class="sheet">
    ${band}
    <div class="sep"></div>

    <h1>작업지시서</h1>
    <div class="subtitle">아래와 같이 상품을 제작해 주세요.</div>

    ${job.needsPlateChange ? `<div class="plate">⚠ 출력 플레이트 교체 대상 ⚠</div>` : ""}

    <table>
      <tr>
        <th>상품명</th><td>${escapeHtml(job.productName)}</td>
        <th>편집번호</th><td>${escapeHtml(job.wepnpSeqno)}</td>
      </tr>
      <tr>
        <th>옵션</th>
        <td${job.needsPlateChange ? ` class="plate-cell"` : ""}>${escapeHtml(job.optionName || "-")}${job.needsPlateChange ? " (플레이트 교체)" : ""}</td>
        <th>수량</th><td>${job.quantity}개</td>
      </tr>
      <tr>
        <th>디자인 파일</th>
        <td colspan="3" class="mono">${escapeHtml(input.designFileName || "-")}</td>
      </tr>
      ${input.printerName ? `<tr><th>출력 장비</th><td colspan="3">${escapeHtml(input.printerName)}</td></tr>` : ""}
      <tr><th>비고</th><td colspan="3" class="muted">-</td></tr>
    </table>

    ${panes.length > 0 ? `<div class="panes">${panes.join("")}</div>` : `<div style="flex:1"></div>`}

    <div class="bottom">
      <div class="qr">
        <img src="${input.qrDataUrl}" alt="QR" />
        <div class="qr-text"><b>작업 상세 QR</b>QR 코드를 스캔하면<br />상세 주문 정보를 확인할 수 있습니다.</div>
      </div>
      ${
        set.isSet
          ? `<div class="set-info">
              <div class="set-info-title">세트 주문 정보</div>
              <div class="set-info-row">
                <div class="set-info-box">
                  <div class="set-info-label">${set.label}</div>
                  <div class="set-info-desc">(${set.description})</div>
                </div>
                <div class="set-info-note">
                  ⓘ 이 작업지시서는 동일 주문(${escapeHtml(job.orderNumber)})의<br />${set.total}개 작업 중 ${set.index}번째 작업입니다.
                </div>
              </div>
            </div>`
          : ""
      }
    </div>
  </div>
</body>
</html>`;
}
