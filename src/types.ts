/** 서버(`GET /api/printer/garment`)가 돌려주는 출력 큐 1건. */
export type GarmentJob = {
  id: string;
  orderNumber: string;
  productName: string;
  optionName: string | null;
  /**
   * 편집번호. 다면 디자인이면 뒤에 면 번호가 붙는다 (예: `10281429-001`).
   * 파일명과 작업지시서에 그대로 쓰므로 같은 편집번호의 면들이 구분된다.
   */
  wepnpSeqno: string;
  quantity: number;
  /** 출력 플레이트 교체 대상 — 작업지시서에 경고로 표기한다 */
  needsPlateChange: boolean;
  /** 같은 주문 안에서 몇 번째 디자인인지 / 총 몇 개인지 */
  itemIndex: number;
  itemTotal: number;
  /**
   * 디자인 파일 주소.
   *
   * 장비로 나가는 것은 **PNG 뿐이다.** 다만 `designFileType` 에 `PDF` 가 적혀 오는 건이
   * 있는데(디자인을 아직 못 받아 기본값이 남은 행), 그 값은 믿지 않고 내려받은 파일의
   * 앞머리로 판별한다. PNG 이 아니면 출력하지 않고 실패로 보고한다.
   */
  designFileUrl: string;
  designFileType: string;
  /** 두 갈래 중 아직 처리되지 않은 쪽. 자기 토글이 켜져 있고 pending 인 것만 처리한다 */
  garmentPending: boolean;
  workOrderPending: boolean;
  workOrder: {
    tenantName: string;
    brandName: string;
    printedBy: string;
    workUrl: string;
    /** 에디터 미리보기 (인쇄 면 수만큼). 작업지시서에 생산 이미지와 나란히 싣는다 */
    thumbnailUrls: string[];
    /** 주문일시(ISO). 지시서 상단 밴드에 적는다. 구버전 서버는 주지 않는다 */
    orderedAt?: string;
  };
  createdAt: string;
};

export type QueueResponse = {
  jobs: GarmentJob[];
  /** 이 단말이 곧 가져갈 큐가 더 남았는지. true 면 백오프 없이 바로 다시 묻는다 */
  hasMore: boolean;
  /** 서버가 지정한 폴링 간격(초). null 이면 기본값을 쓴다 */
  pollInterval: number | null;
};

/** 두 갈래 작업. 상태 보고는 각각 따로 올린다 */
export type JobTarget = "garment" | "workOrder";

/** 로컬 출력 대기 항목. 다운로드까지 끝나고 작업자 전송을 기다리는 상태 */
export type ReadyItem = {
  job: GarmentJob;
  /** 내려받은 디자인 파일 경로 */
  downloadPath: string;
  /** 작업지시서에 실을 썸네일 경로들 */
  thumbnailPaths: string[];
  /** 아직 전송하지 않은 갈래 */
  doGarment: boolean;
  doWorkOrder: boolean;
  status: "ready" | "printing" | "failed" | "done";
  errorReason: string;
  /** 어느 장비로 보냈는지. 여러 대를 물린 단말에서 짝을 찾을 때 쓴다 */
  printerName?: string;
  /**
   * 감시 폴더에서 집어 온 건인지.
   *
   * 서버 큐에 없는 건이므로 다운로드·완료·실패 보고를 올리면 404 가 난다. 상태 보고를
   * 건너뛰어야 하는 자리를 이 값으로 가른다.
   */
  local?: boolean;
  /**
   * 카드에 보여줄 미리보기 (data URL).
   *
   * 화면은 로컬 파일 경로를 그대로 못 읽으므로 메인 프로세스가 만들어 내려준다.
   * 원본은 300DPI 라 그대로 실으면 목록이 무거워져 작은 판으로 줄여 담는다.
   */
  thumbUrl?: string | null;
};
