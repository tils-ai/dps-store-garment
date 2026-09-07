import fs from "node:fs";
import path from "node:path";
import type { PrintSettings } from "./print-settings";

/**
 * 인쇄 설정 XML 생성.
 *
 * **요소의 순서와 구성이 계열마다 다르고, 벤더 가이드가 정한 그대로여야 한다.**
 * 순서를 바꾸거나 계열에 없는 요소를 넣으면 CLI 가 거절하거나 조용히 다른 결과를 낸다.
 * 파이썬 판 `xml_builder.py` 를 그대로 옮긴 것이므로 임의로 정리하지 않는다.
 *
 * - legacy: 가이드 정의 순서(byInk → bEcoMode → byResolution)를 따른다
 * - pro: byInk 값에 따라 유효한 요소가 갈린다. 공식 예제와 같은 조건부 구성만 낸다
 */

export type XmlOverrides = Partial<PrintSettings> & {
  /** 대상 계열. pro 면 구성이 달라진다 */
  targetModel?: "legacy" | "pro" | "";
  /** legacy 에서만 byMachineMode 를 넣는다 */
  includeMachineMode?: boolean;
};

const bool = (v: boolean): string => (v ? "true" : "false");

const escapeXml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

export function buildPrintXml(destPath: string, settings: PrintSettings, overrides: XmlOverrides = {}): string {
  const s: PrintSettings = { ...settings, ...overrides };
  const isPro = (overrides.targetModel ?? "") === "pro";
  const ink = Number(s.ink);

  const common: [string, string][] = [
    ["szFileName", ""],
    ["uiCopies", String(s.copies)],
    ["byPlatenSize", String(s.platenSize)],
    ["byInk", String(s.ink)],
    ["byResolution", String(s.resolution)],
  ];

  let elements: [string, string][];

  if (isPro) {
    elements = [...common];
    if (ink === 0) {
      elements.push(
        ["byInkVolume", String(s.inkVolume)],
        ["byDoublePrint", String(s.doublePrint)],
        ["bMultiple", bool(s.multiple)]
      );
    } else if (ink === 1) {
      elements.push(
        ["byHighlight", String(s.highlight)],
        ["byMask", String(s.mask)],
        ["bTransColor", bool(s.transColor)],
        ["colorTrans", String(s.colorTrans)],
        ["byTolerance", String(s.tolerance)]
      );
    } else if (ink === 2) {
      elements.push(
        ["bEcoMode", bool(s.ecoMode)],
        ["byHighlight", String(s.highlight)],
        ["byMask", String(s.mask)],
        ["bMaterialBlack", bool(s.materialBlack)],
        ["bMultiple", bool(s.multiple)],
        ["bTransColor", bool(s.transColor)],
        ["colorTrans", String(s.colorTrans)],
        ["byTolerance", String(s.tolerance)],
        ["byMinWhite", String(s.minWhite)],
        ["byChoke", String(s.choke)],
        ["bPause", bool(s.pause)]
      );
    }
    elements.push(
      ["bySaturation", String(s.saturation)],
      ["byBrightness", String(s.brightness)],
      ["byContrast", String(s.contrast)],
      ["iCyanBalance", String(s.cyanBalance)],
      ["iMagentaBalance", String(s.magentaBalance)],
      ["iYellowBalance", String(s.yellowBalance)],
      ["iBlackBalance", String(s.blackBalance)],
      ["bUniPrint", bool(s.uniPrint)]
    );
  } else {
    // legacy — 가이드 정의 순서 그대로. pro 순서(byInk 뒤 byResolution)와 다르다
    elements = [
      ["szFileName", ""],
      ["uiCopies", String(s.copies)],
      ["byPlatenSize", String(s.platenSize)],
      ["byInk", String(s.ink)],
      ["bEcoMode", bool(s.ecoMode)],
      ["byResolution", String(s.resolution)],
      ["byHighlight", String(s.highlight)],
      ["byMask", String(s.mask)],
      ["byInkVolume", String(s.inkVolume)],
      ["byDoublePrint", String(s.doublePrint)],
      ["bMaterialBlack", bool(s.materialBlack)],
      ["bMultiple", bool(s.multiple)],
      ["bTransColor", bool(s.transColor)],
      ["colorTrans", String(s.colorTrans)],
      ["byTolerance", String(s.tolerance)],
      ["byMinWhite", String(s.minWhite)],
      ["byChoke", String(s.choke)],
      ["bPause", bool(s.pause)],
      ["bySaturation", String(s.saturation)],
      ["byBrightness", String(s.brightness)],
      ["byContrast", String(s.contrast)],
      ["iCyanBalance", String(s.cyanBalance)],
      ["iMagentaBalance", String(s.magentaBalance)],
      ["iYellowBalance", String(s.yellowBalance)],
      ["iBlackBalance", String(s.blackBalance)],
      ["bUniPrint", bool(s.uniPrint)],
    ];

    // pro 규격에는 byMachineMode 가 없다. legacy 에서만 넣고, 위치도 가이드가 정한 자리다
    if (overrides.includeMachineMode !== false) {
      elements.splice(2, 0, ["byMachineMode", String(s.machineMode)]);
    }
  }

  const rootAttrs = isPro
    ? ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"'
    : "";

  const body = elements.map(([tag, value]) => `  <${tag}>${escapeXml(value)}</${tag}>`).join("\n");
  const xml = `<?xml version='1.0' encoding='utf-8'?>\n<GTOPTION${rootAttrs}>\n${body}\n</GTOPTION>`;

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, xml, "utf8");
  return destPath;
}
