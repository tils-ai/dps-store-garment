/*
  디자인 파일 → 장비용 PNG 변환.

  파이썬 판은 pdf2image(+poppler)와 Pillow 로 했다. 여기서는 브라우저가 이미 가진
  캔버스와 pdf.js 로 한다. poppler 번들이 없어지고 설치본이 가벼워진다.

  ⚠️ 서버가 주는 파일이 확장자와 다를 수 있다. `designFileType` 이 PDF 라고 적혀 있어도
  실제로는 PNG 인 경우가 있어, **바이트 앞머리로 판별**한다.
*/

const pdfjs = require("pdfjs-dist/legacy/build/pdf.mjs");

/** 알파가 이보다 낮으면 배경으로 보고 지운다 */
const ALPHA_CUTOFF = 8;

/**
 * 파일 앞머리로 실제 형식을 판별한다.
 *
 * 확장자와 서버가 알려준 타입은 둘 다 틀릴 수 있다. 실제 바이트만 믿는다.
 */
function detectKind(bytes) {
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return "pdf"; // %PDF
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    return "zip"; // PK
  }
  return "unknown";
}

/**
 * 알파 배경을 정확한 흰색으로 합성한다.
 *
 * 장비 CLI 의 기본 설정(-W 0)은 **정확한 RGB(255,255,255) 만** 투명으로 본다. 안티앨리어싱
 * 으로 '거의 흰색'이 된 배경 픽셀은 잉크로 분사되므로 미리 정확한 흰색으로 만든다.
 *
 * 다만 임계값으로 알파를 이진화하면 도안 본체의 반투명 그라데이션까지 두 색으로 뭉개진다.
 * 그래서 **임계는 거의 투명한 배경을 지우는 데만 쓰고**, 나머지는 실제 알파로 정상 합성한다.
 */
function flattenToWhite(ctx, width, height) {
  const image = ctx.getImageData(0, 0, width, height);
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] < ALPHA_CUTOFF ? 0 : d[i + 3];
    const k = a / 255;
    d[i] = Math.round(d[i] * k + 255 * (1 - k));
    d[i + 1] = Math.round(d[i + 1] * k + 255 * (1 - k));
    d[i + 2] = Math.round(d[i + 2] * k + 255 * (1 - k));
    d[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
}

const canvasToPngBytes = (canvas) =>
  new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? blob.arrayBuffer().then((b) => resolve(new Uint8Array(b))) : reject(new Error("PNG 변환 실패"))),
      "image/png"
    );
  });

/** PDF 를 면마다 PNG 로. 렌더 배율은 요청한 DPI 로 맞춘다 */
async function renderPdf(bytes, dpi) {
  const doc = await pdfjs.getDocument({ data: bytes, disableWorker: true }).promise;
  const pages = [];

  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    // pdf.js 의 기본 배율은 72dpi 기준이다
    const viewport = page.getViewport({ scale: dpi / 72 });

    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    await page.render({ canvasContext: ctx, viewport, background: "transparent" }).promise;

    // PDF 를 래스터화한 결과는 흰 배경 평탄화를 거친다 (위 설명 참조)
    flattenToWhite(ctx, canvas.width, canvas.height);

    pages.push({
      bytes: await canvasToPngBytes(canvas),
      width: canvas.width,
      height: canvas.height,
      dpi,
    });
  }
  return pages;
}

/**
 * 이미 이미지인 파일.
 *
 * **픽셀을 손대지 않는다.** 디자이너가 의도한 값을 그대로 넘기고, CLI 가 확실히 읽는
 * 형식으로만 담아 다시 낸다. 파이썬 판도 원본 PNG/JPG 는 색·알파를 건드리지 않았다.
 */
async function passThroughImage(bytes, mime) {
  const blob = new Blob([bytes], { type: mime });
  const bitmap = await createImageBitmap(blob);

  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  return [{ bytes: await canvasToPngBytes(canvas), width: canvas.width, height: canvas.height, dpi: null }];
}

/** 메인 프로세스가 부르는 진입점 */
window.convertDesign = async (buffer, dpi) => {
  const bytes = new Uint8Array(buffer);
  const kind = detectKind(bytes);

  switch (kind) {
    case "pdf":
      return renderPdf(bytes, dpi);
    case "png":
      return passThroughImage(bytes, "image/png");
    case "jpeg":
      return passThroughImage(bytes, "image/jpeg");
    case "zip":
      // 압축 파일은 쓰지 않기로 정해져 있다. 들어오면 사람이 알아야 한다
      throw new Error("압축 파일은 처리하지 않습니다.");
    default:
      throw new Error("알 수 없는 파일 형식입니다.");
  }
};
