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
   * ⚠️ 서버 칼럼 이름이 `designFileUrl` 이고 타입이 `PDF` 라고 적혀 있어도 **실제로는
   * PNG 일 수 있다.** 출력 파일 종류는 상대 시스템 설정이 정하며 우리는 그 값을 볼 수 없다.
   * 확장자와 실제 바이트로 판별한다.
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
  /**
   * 카드에 보여줄 미리보기 (data URL).
   *
   * 화면은 로컬 파일 경로를 그대로 못 읽으므로 메인 프로세스가 만들어 내려준다.
   * 원본은 300DPI 라 그대로 실으면 목록이 무거워져 작은 판으로 줄여 담는다.
   */
  thumbUrl?: string | null;
};
