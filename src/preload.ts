import { contextBridge, ipcRenderer } from "electron";

/**
 * 렌더러에 노출하는 최소 API.
 *
 * `contextIsolation` 을 켠 상태에서 필요한 것만 건넨다. 렌더러가 Node 에 직접 닿지 않게
 * 하려는 것이므로, 여기서 창구를 넓히지 않는다.
 */
contextBridge.exposeInMainWorld("garment", {
  getVersion: (): Promise<string> => ipcRenderer.invoke("app:version"),

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
