import { contextBridge, ipcRenderer } from "electron";

/**
 * 렌더러에 노출하는 최소 API.
 *
 * `contextIsolation` 을 켠 상태에서 필요한 것만 건넨다. 렌더러가 Node 에 직접 닿지 않게
 * 하려는 것이므로, 여기서 창구를 넓히지 않는다.
 */
/** 구독 헬퍼 — 해제 함수를 돌려준다 */
const on = (channel: string, cb: (payload: unknown) => void) => {
  const handler = (_e: unknown, payload: unknown) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
};

contextBridge.exposeInMainWorld("garment", {
  getVersion: (): Promise<string> => ipcRenderer.invoke("app:version"),

  config: {
    get: () => ipcRenderer.invoke("config:get"),
    set: (patch: unknown) => ipcRenderer.invoke("config:set", patch),
    path: () => ipcRenderer.invoke("config:path"),
  },

  auth: {
    /** 스토어 식별자로 인증 시작. 브라우저가 열리고 승인되면 auth:result 가 온다 */
    start: (tenant: string) => ipcRenderer.invoke("auth:start", tenant),
    cancel: () => ipcRenderer.invoke("auth:cancel"),
    onResult: (cb: (payload: unknown) => void) => on("auth:result", cb),
  },

  agent: {
    start: () => ipcRenderer.invoke("agent:start"),
    stop: () => ipcRenderer.invoke("agent:stop"),
    state: () => ipcRenderer.invoke("agent:state"),
    onState: (cb: (payload: unknown) => void) => on("agent:state", cb),
    onReady: (cb: (payload: unknown) => void) => on("queue:ready", cb),
    onChanged: (cb: (payload: unknown) => void) => on("queue:changed", cb),
    onRemoved: (cb: (payload: unknown) => void) => on("queue:removed", cb),
  },

  device: {
    /** 장비로 전송. ink 는 옷 색(0=흰옷, 2=컬러옷) */
    send: (jobId: string, ink?: number) => ipcRenderer.invoke("device:send", jobId, ink),
    /** 장비 상태 (LAN 연결일 때만. 아니면 null = 오프라인) */
    status: () => ipcRenderer.invoke("device:status"),
    onStatus: (cb: (payload: unknown) => void) => on("device:status", cb),
    /** 관리 명령 (순환·클리닝·잠금). LAN 연결 장비 전용 */
    maintenance: (command: string) => ipcRenderer.invoke("device:maintenance", command),
    /** 장비 로그를 내려받아 이력 CSV 로 푼다 */
    collectLog: () => ipcRenderer.invoke("device:log"),
  },

  queue: {
    /** 큐에서 삭제 (중복·오생성 건 걷어내기) */
    delete: (jobId: string) => ipcRenderer.invoke("queue:delete", jobId),
  },

  openFolder: (kind: "download" | "incoming" | "logs" | "config") => ipcRenderer.invoke("open:folder", kind),

  workOrder: {
    /** 작업지시서 인쇄 */
    print: (jobId: string) => ipcRenderer.invoke("workorder:print", jobId),
    /** 실물 대조용 PDF 저장 (검증 중에만 쓴다) */
    preview: (jobId: string) => ipcRenderer.invoke("workorder:preview", jobId),
  },

  printers: {
    list: () => ipcRenderer.invoke("printers:list"),
  },

  onLog: (cb: (payload: unknown) => void) => on("log", cb),

  update: {
    /** 지금 상태 조회 (창을 새로 그렸을 때 복원용) */
    state: () => ipcRenderer.invoke("update:state"),
    /** 수동 확인 버튼 */
    check: () => ipcRenderer.invoke("update:check"),
    /** 받아둔 업데이트 적용 (재시작) */
    install: () => ipcRenderer.invoke("update:install"),
    /** 상태 변화 구독 */
    onState: (cb: (state: unknown) => void) => {
      const handler = (_e: unknown, state: unknown) => cb(state);
      ipcRenderer.on("update:state", handler);
      return () => ipcRenderer.off("update:state", handler);
    },
  },
});
