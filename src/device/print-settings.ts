/**
 * 장비 인쇄 설정.
 *
 * 파이썬 판 `config.ini [garment_cli]` 를 그대로 옮긴 것이다. 값 이름과 기본값을 바꾸면
 * 현장 출력 품질이 달라지므로 손대지 않는다.
 *
 * 계열이 둘(legacy / pro)이고 유효한 항목이 서로 다르다. 어떤 항목이 어디에 들어가는지는
 * `build-xml.ts` 가 정한다.
 */

export type PrintSettings = {
  /** 사용할 CLI 계열. auto 면 프린터 드라이버명으로 판정한다 */
  cli: "auto" | "legacy" | "pro";

  /** 플레이트 중앙 자동 배치 */
  autoCenter: boolean;
  /** 8자리 위치 코드. 자동 배치를 끄면 이 값이 쓰인다 */
  position: string;
  /**
   * 크기 또는 배율 중 **하나는 반드시 있어야 한다.** 둘 다 비면 CLI 가 -3108 로 거절한다.
   * 그래서 둘 다 비면 배율 1000(=100%)으로 물러선다.
   */
  size: string;
  magnification: string;
  whiteAs: number;

  copies: number;
  machineMode: number;
  resolution: number;
  platenSize: number;

  /** 이미지를 플레이트에 맞춰 줄인다(축소만, 작으면 원본). 가로 중앙·세로 상단 */
  autoFit: boolean;
  /** 성인 기본 / 아동(플레이트 교체 대상) 플레이트 번호 */
  platenAdult: number;
  platenChild: number;

  /** 0=컬러만(흰옷) 1=흰색만 2=흰색+컬러(컬러옷) */
  ink: number;
  ecoMode: boolean;
  highlight: number;
  mask: number;
  inkVolume: number;
  doublePrint: number;
  materialBlack: boolean;
  multiple: boolean;
  transColor: boolean;
  colorTrans: number;
  tolerance: number;
  minWhite: number;
  choke: number;
  pause: boolean;
  saturation: number;
  brightness: number;
  contrast: number;
  cyanBalance: number;
  magentaBalance: number;
  yellowBalance: number;
  blackBalance: number;
  uniPrint: boolean;

  /**
   * 인쇄 후 장비에서 작업을 지울지. **pro 계열 전용 옵션이다.**
   * legacy 에 넘기면 -3301 로 실패하므로 계열을 보고 붙인다.
   */
  autoDelete: boolean;
};

export const DEFAULT_PRINT_SETTINGS: PrintSettings = {
  cli: "auto",
  autoCenter: true,
  position: "00000000",
  size: "",
  // size 가 비어 있으므로 배율로 채운다 (둘 다 비면 CLI 가 거절한다)
  magnification: "1000",
  whiteAs: 0,
  copies: 1,
  machineMode: 0,
  resolution: 1,
  platenSize: 2,
  autoFit: true,
  platenAdult: 2, // 14x16
  platenChild: 3, // 10x12
  ink: 0,
  ecoMode: false,
  highlight: 5,
  mask: 1,
  inkVolume: 5,
  doublePrint: 0,
  materialBlack: false,
  multiple: false,
  transColor: false,
  colorTrans: 0,
  tolerance: 0,
  minWhite: 1,
  choke: 0,
  pause: false,
  saturation: 0,
  brightness: 0,
  contrast: 0,
  cyanBalance: 0,
  magentaBalance: 0,
  yellowBalance: 0,
  blackBalance: 0,
  uniPrint: false,
  autoDelete: false,
};

/** 잉크 모드 — 화면에서 옷 색으로 고른다 */
export const INK_COLOR_ONLY = 0; // 흰옷
export const INK_WHITE_AND_COLOR = 2; // 컬러옷
