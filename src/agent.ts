import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { GarmentApi } from "./api";
import { cliStatePath, diagnosticsDir, getConfig, primaryPrinter, printerPool, vendorDir, workDir } from "./config";
import type { AppConfig } from "./config";
import { sendToDevice } from "./device";
import { printHtml, saveHtmlAsPdf } from "./printer";
import type { GarmentJob, ReadyItem } from "./types";
import { buildWorkOrderHtml } from "./work-order";
import { fileToDataUrl, makeQrDataUrl, makeThumbnail } from "./work-order-assets";

/**
 * 폴링 에이전트.
 *
 * 서버에서 출력 큐를 받아 디자인과 썸네일을 내려받고, 작업자가 전송을 누를 때까지
 * 대기 목록에 쌓는다. 장비 전송과 인쇄는 이후 단계에서 붙인다.
 */

/** 큐가 비었을 때 폴링을 늦추는 상한(초). 서버와 네트워크를 아낀다 */
/** 내려받기 실패 시 즉시 다시 시도하는 횟수 */
const FETCH_RETRIES = 1;

/** 빈 응답이 [n]번 이어지면 [초] 간격으로 늦춘다 (파이썬 판과 같은 표) */
const BACKOFF_STEPS: [number, number][] = [
  [3, 10],
  [6, 20],
  [10, 30],
];

/**
 * 완료 이력을 몇 건까지 남길지.
 *
 * 다 지우면 방금 무엇을 보냈는지 확인할 수 없고, 무한정 쌓으면 화면이 무거워진다.
 */
const DONE_KEEP = 30;

export type AgentEvents = {
  onReady?: (item: ReadyItem) => void;
  onItemChanged?: (item: ReadyItem) => void;
  onRemoved?: (jobId: string) => void;
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
  onStateChange?: (running: boolean) => void;
};

export class Agent {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private emptyCount = 0;
  /** 이미 받아 둔 건을 다시 받지 않기 위한 표식 */
  private readonly ready = new Map<string, ReadyItem>();
  /** 전송 중인 건 — 같은 건을 두 번 보내지 않게 막는다 */
  private readonly sending = new Set<string>();
  /**
   * 장비별 실행 줄.
   *
   * 같은 장비에 두 건을 동시에 밀면 벤더 CLI 와 장비가 엉킨다. 장비마다 줄을 하나씩 두어
   * **한 건씩 차례로** 보내되, 장비가 여럿이면 서로 다른 줄이라 동시에 나간다.
   * 파이썬 판이 프린터당 워커 스레드를 하나씩 띄우던 것과 같은 구조다.
   */
  private readonly lanes = new Map<string, Promise<unknown>>();
  /** 라운드로빈 커서 */
  private laneCursor = 0;

  constructor(private readonly events: AgentEvents = {}) {}

  get isRunning(): boolean {
    return this.running;
  }

  snapshot(): ReadyItem[] {
    return [...this.ready.values()];
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.emptyCount = 0;
    this.events.onStateChange?.(true);
    this.log("info", "폴링을 시작합니다.");
    void this.tick();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.events.onStateChange?.(false);
    this.log("info", "폴링을 멈췄습니다.");
  }

  /**
   * 대기 목록을 파일에 남긴다.
   *
   * 앱이 꺼지거나 죽어도 이미 받아 둔 건이 사라지면 안 된다. 서버는 그 건들을 READY 로
   * 보고 다시 내려주지 않으므로, 로컬 기록을 잃으면 영영 출력되지 않는다.
   */
  private persist(): void {
    try {
      const dest = this.storePath();
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.tmp`;
      const plain = [...this.ready.values()].map(({ thumbUrl: _thumb, ...rest }) => rest);
      fs.writeFileSync(tmp, JSON.stringify(plain, null, 2), "utf8");
      fs.renameSync(tmp, dest);
    } catch (error) {
      this.log("warn", `대기 목록 저장 실패: ${(error as Error).message}`);
    }
  }

  /** 저장해 둔 대기 목록을 되살린다. 파일이 실제로 남아 있는 것만 */
  restore(): ReadyItem[] {
    try {
      const saved = JSON.parse(fs.readFileSync(this.storePath(), "utf8")) as ReadyItem[];
      for (const item of saved) {
        // 파일이 지워졌으면 되살려도 출력할 수 없다
        if (!item?.job?.id || !fs.existsSync(item.downloadPath)) continue;
        item.thumbnailPaths = (item.thumbnailPaths ?? []).filter((p) => fs.existsSync(p));
        // 전송 중에 앱이 꺼졌으면 다시 누를 수 있게 대기로 되돌린다
        if (item.status === "printing") item.status = "ready";
        // 썸네일은 저장하지 않는다. data URL 을 파일에 담으면 목록 파일이 수십 MB 가 된다
        item.thumbUrl = null;
        this.ready.set(item.job.id, item);
        void makeThumbnail(item.downloadPath)
          .then((url) => {
            item.thumbUrl = url;
            this.events.onItemChanged?.(item);
          })
          .catch(() => undefined);
      }
      if (this.ready.size > 0) this.log("info", `대기 목록 ${this.ready.size}건을 되살렸습니다.`);
    } catch {
      // 파일이 없거나 깨졌다. 빈 목록으로 시작한다
    }
    return this.snapshot();
  }

  /** 완료 이력이 상한을 넘으면 오래된 것부터 걷어낸다 */
  private evictOldDone(): void {
    const done = [...this.ready.values()].filter((it) => it.status === "done");
    if (done.length <= DONE_KEEP) return;
    for (const item of done.slice(0, done.length - DONE_KEEP)) {
      this.ready.delete(item.job.id);
      // 이력에서 빠지는 건의 파일도 함께 지운다. 고객 도안을 단말에 쌓아두지 않는다
      for (const file of [item.downloadPath, ...item.thumbnailPaths]) {
        try {
          fs.rmSync(file, { force: true });
        } catch {
          // 지우지 못해도 목록에서는 빠졌다
        }
      }
      this.events.onRemoved?.(item.job.id);
    }
    this.persist();
  }

  private storePath(): string {
    return path.join(getConfig().downloadDir, "ready.json");
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    this.events.onLog?.(level, message);
  }

  /**
   * 다음 폴링까지 기다릴 시간. 빈 응답이 이어지면 점점 늦춘다.
   *
   * 구간은 파이썬 판(`_BACKOFF_THRESHOLDS`)과 같은 값이다. 한가한 매장이 서버를 계속
   * 두드리지 않으면서, 주문이 들어오는 시간대에는 기본 간격을 유지한다.
   */
  private nextDelaySec(base: number, hasMore: boolean): number {
    // 가져갈 것이 남았다고 서버가 알려주면 늦추지 않는다. 늦추면 밀린 건이 더 밀린다
    if (hasMore) return 0;
    for (const [threshold, seconds] of [...BACKOFF_STEPS].reverse()) {
      if (this.emptyCount >= threshold) return seconds;
    }
    return base;
  }

  private schedule(seconds: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), Math.max(0, seconds) * 1000);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    const config = getConfig();
    if (!config.apiKey) {
      this.log("warn", "API 키가 없습니다. 먼저 인증하세요.");
      this.stop();
      return;
    }

    const api = new GarmentApi(config.baseUrl, config.apiKey);
    let delay = config.pollIntervalSec;

    try {
      const res = await api.getPendingJobs({
        garmentEnabled: config.garmentEnabled,
        workOrderEnabled: config.workOrderEnabled,
      });

      // 서버가 간격을 지정하면 그쪽을 따른다 (매장별로 다르게 운영한다)
      if (res.pollInterval && res.pollInterval > 0) delay = res.pollInterval;

      if (res.jobs.length === 0) {
        this.emptyCount += 1;
      } else {
        this.emptyCount = 0;
        for (const job of res.jobs) {
          if (!this.running) break;
          await this.download(api, job);
        }
      }

      this.schedule(this.nextDelaySec(delay, res.hasMore));
    } catch (error) {
      this.emptyCount += 1;
      this.log("error", `큐 조회 실패: ${(error as Error).message}`);
      // 서버가 잠깐 죽어도 앱은 계속 돌아야 한다. 늦춰서 다시 시도한다
      this.schedule(this.nextDelaySec(delay, false));
    }
  }

  /** 디자인과 썸네일을 내려받고 대기 목록에 넣는다 */
  private async download(api: GarmentApi, job: GarmentJob): Promise<void> {
    if (this.ready.has(job.id)) return;

    const config = getConfig();
    fs.mkdirSync(config.downloadDir, { recursive: true });

    // 이 단말이 맡은 갈래만 처리한다. 토글이 꺼진 갈래는 다른 단말이 가져가도록 둔다
    const doGarment = config.garmentEnabled && job.garmentPending;
    const doWorkOrder = config.workOrderEnabled && job.workOrderPending;
    if (!doGarment && !doWorkOrder) {
      // 사유를 밝혀야 한다. "건너뜀"만 남으면 토글을 잘못 꺼 둔 것인지, 다른 단말이
      // 이미 가져간 것인지, 서버가 맡지 않은 갈래를 내려보낸 것인지 구분할 수 없다
      this.log("info", `건너뜀 (${skipReason(config, job)}): ${job.orderNumber}`);
      return;
    }

    const label = `${job.orderNumber} ${job.wepnpSeqno}`;
    try {
      const downloadPath = await this.fetchFile(
        job.designFileUrl,
        path.join(config.downloadDir, designFileName(job, job.designFileUrl))
      );

      // 썸네일은 작업지시서 부가 정보다. 실패해도 출력은 계속한다 — 받은 것만 싣는다
      const thumbnailPaths: string[] = [];
      if (doWorkOrder) {
        for (const [i, url] of job.workOrder.thumbnailUrls.entries()) {
          try {
            thumbnailPaths.push(
              await this.fetchFile(url, path.join(config.downloadDir, thumbFileName(job, i + 1, url)))
            );
          } catch {
            this.log("warn", `썸네일 ${i + 1} 다운로드 실패 — 지시서에서 생략합니다: ${label}`);
          }
        }
      }

      const item: ReadyItem = {
        job,
        downloadPath,
        thumbnailPaths,
        doGarment,
        doWorkOrder,
        status: "ready",
        errorReason: "",
      };
      // 카드 미리보기 — 원본은 300DPI 라 작은 판으로 줄여 담는다
      item.thumbUrl = await makeThumbnail(downloadPath).catch(() => null);

      this.ready.set(job.id, item);
      this.persist();

      // 서버에 다운로드 완료를 알려 다른 단말이 같은 건을 가져가지 않게 한다
      if (doGarment) await this.report(api, job.id, "garment");
      if (doWorkOrder) await this.report(api, job.id, "workOrder");

      this.log("info", `대기 목록에 담았습니다: ${label}`);
      this.events.onReady?.(item);

      // 자동 전송이 켜져 있으면 곧장 보낸다. 기본은 꺼짐이다 —
      // 옷 색(잉크 모드)을 작업자가 골라야 하고, 잘못 들어온 건도 그대로 나가기 때문이다
      if (config.autoSend) {
        void this.sendToPrinter(job.id);
      }
    } catch (error) {
      const reason = (error as Error).message;
      this.log("error", `다운로드 실패: ${label} — ${reason}`);
      // 서버가 이 건을 다시 대기로 돌려 다른 단말이나 다음 폴링에서 재시도하게 한다
      if (doGarment) await api.markFailed(job.id, "garment", reason).catch(() => undefined);
      if (doWorkOrder) await api.markFailed(job.id, "workOrder", reason).catch(() => undefined);
    }
  }

  /**
   * 감시 폴더에서 집은 파일을 대기 목록에 넣는다.
   *
   * 서버 큐에 없는 건이라 상태 보고를 올리지 않는다. 작업지시서에 쓸 주문 정보도 없으므로
   * 장비 전송만 맡는다. 원본은 다시 집히지 않도록 done/error 로 옮긴다.
   */
  async addLocalFile(filePath: string): Promise<{ ok: boolean; reason?: string }> {
    const config = getConfig();
    const name = path.basename(filePath);

    try {
      if (!config.garmentEnabled) throw new Error("이 단말은 장비 전송을 맡지 않습니다.");

      fs.mkdirSync(config.downloadDir, { recursive: true });
      // 원본을 그대로 쓰면 감시 폴더를 비울 수 없다. 사본을 두고 원본은 옮긴다
      const downloadPath = uniquePath(path.join(config.downloadDir, name));
      fs.copyFileSync(filePath, downloadPath);

      const job: GarmentJob = {
        id: `local:${crypto.randomUUID()}`,
        orderNumber: path.parse(name).name,
        productName: "감시 폴더",
        optionName: null,
        wepnpSeqno: "",
        quantity: 1,
        needsPlateChange: false,
        itemIndex: 1,
        itemTotal: 1,
        designFileUrl: "",
        designFileType: path.extname(name).replace(".", "").toUpperCase(),
        garmentPending: true,
        workOrderPending: false,
        workOrder: { tenantName: "", brandName: "", printedBy: "", workUrl: "", thumbnailUrls: [] },
        createdAt: new Date().toISOString(),
      };

      const item: ReadyItem = {
        job,
        downloadPath,
        thumbnailPaths: [],
        doGarment: true,
        doWorkOrder: false,
        status: "ready",
        errorReason: "",
        local: true,
      };
      item.thumbUrl = await makeThumbnail(downloadPath).catch(() => null);

      this.ready.set(job.id, item);
      this.persist();
      this.events.onReady?.(item);
      this.archive(filePath, "done");

      if (config.autoSend) void this.sendToPrinter(job.id);
      return { ok: true };
    } catch (error) {
      const reason = (error as Error).message;
      this.log("error", `감시 폴더 파일을 담지 못했습니다: ${name} — ${reason}`);
      this.archive(filePath, "error");
      return { ok: false, reason };
    }
  }

  /** 집은 원본을 치운다. 남겨두면 다음 훑기에서 또 집는다 */
  private archive(filePath: string, kind: "done" | "error"): void {
    try {
      const config = getConfig();
      const dir = kind === "done" ? config.doneDir : config.errorDir;
      const dest = uniquePath(path.join(dir || path.join(path.dirname(filePath), kind), path.basename(filePath)));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(filePath, dest);
    } catch (error) {
      this.log("warn", `원본 파일을 옮기지 못했습니다: ${(error as Error).message}`);
    }
  }

  /**
   * 작업지시서를 인쇄한다. 작업자가 전송을 누를 때 호출한다.
   *
   * 지시서를 먼저, 디자인을 나중에 보낸다. 순서를 바꾸면 옷이 먼저 나오고 그 옷이
   * 어느 주문인지 적힌 종이가 늦게 나와 현장에서 짝이 어긋난다.
   */
  async printWorkOrder(jobId: string): Promise<{ ok: boolean; reason?: string }> {
    const item = this.ready.get(jobId);
    if (!item) return { ok: false, reason: "이미 없는 항목입니다." };
    if (!item.doWorkOrder) return { ok: true };

    const config = getConfig();
    const api = new GarmentApi(config.baseUrl, config.apiKey);
    const label = `${item.job.orderNumber} ${item.job.wepnpSeqno}`;

    try {
      const result = await printHtml(await this.renderWorkOrder(item), config.workOrderPrinterName);
      if (!result.ok) throw new Error(result.reason);

      item.doWorkOrder = false;
      this.persist();
      this.events.onItemChanged?.(item);
      await api.markPrinted(jobId, "workOrder").catch(() => undefined);
      this.log("info", `작업지시서 출력 완료: ${label}`);
      return { ok: true };
    } catch (error) {
      const reason = (error as Error).message;
      item.status = "failed";
      item.errorReason = reason;
      this.events.onItemChanged?.(item);
      await api.markFailed(jobId, "workOrder", reason).catch(() => undefined);
      this.log("error", `작업지시서 출력 실패: ${label} — ${reason}`);
      return { ok: false, reason };
    }
  }

  /**
   * 장비로 전송한다. 작업자가 옷 색을 골라 누를 때 호출한다.
   *
   * 지시서를 먼저, 장비를 나중에 보낸다. 순서를 바꾸면 옷이 먼저 나오고 그 옷이 어느
   * 주문인지 적힌 종이가 늦게 나와 현장에서 짝이 어긋난다.
   */
  async sendToPrinter(jobId: string, ink?: number): Promise<{ ok: boolean; reason?: string }> {
    const item = this.ready.get(jobId);
    if (!item) return { ok: false, reason: "이미 없는 항목입니다." };
    if (this.sending.has(jobId)) return { ok: false, reason: "이미 전송 중입니다." };

    const config = getConfig();
    const api = new GarmentApi(config.baseUrl, config.apiKey);
    const label = `${item.job.orderNumber} ${item.job.wepnpSeqno}`;
    const printerName = this.nextPrinter(config);

    this.sending.add(jobId);
    item.status = "printing";
    item.errorReason = "";
    item.printerName = printerName;
    this.events.onItemChanged?.(item);

    // 이 장비의 줄에 세운다. 앞 건이 끝나야 시작한다
    return this.onLane(printerName, async () => {
      try {
        // 지시서가 남아 있으면 먼저 뽑는다
        if (item.doWorkOrder) {
          const wo = await this.printWorkOrder(jobId);
          if (!wo.ok) throw new Error(wo.reason ?? "작업지시서 출력 실패");
        }

        if (item.doGarment) {
          const result = await sendToDevice({
            designPath: item.downloadPath,
            printerName,
            settings: config.print,
            ink,
            needsPlateChange: item.job.needsPlateChange,
            quantity: item.job.quantity,
            workDir: workDir(),
            diagnosticsDir: diagnosticsDir(),
            cliStatePath: cliStatePath(),
            cliPaths: resolveCliPaths(config),
            renderDpi: config.renderDpi,
            extractDiagnostic: config.extractDiagnostic,
            mode: config.garmentMode,
            onLog: (level, message) => this.log(level, `${label} — ${message}`),
          });
          if (!result.ok) throw new Error(result.reason);

          item.doGarment = false;
          if (!item.local) await api.markPrinted(jobId, "garment").catch(() => undefined);
          this.log("info", `장비 전송 완료: ${label}${printerName ? ` → ${printerName}` : ""}`);
        }

        // 두 갈래가 모두 끝나면 완료로 옮긴다
        item.status = item.doGarment || item.doWorkOrder ? "ready" : "done";
        this.persist();
        this.events.onItemChanged?.(item);
        if (item.status === "done") this.evictOldDone();
        return { ok: true };
      } catch (error) {
        const reason = (error as Error).message;
        item.status = "failed";
        item.errorReason = reason;
        this.events.onItemChanged?.(item);
        // 서버가 READY 로 두므로 작업자가 다시 누를 수 있다
        if (item.doGarment && !item.local) await api.markFailed(jobId, "garment", reason).catch(() => undefined);
        this.log("error", `장비 전송 실패: ${label} — ${reason}`);
        return { ok: false, reason };
      } finally {
        this.sending.delete(jobId);
      }
    });
  }

  /**
   * 다음 건을 맡길 장비를 고른다.
   *
   * 라운드로빈이면 번갈아, `single` 이면 첫 대만. 목록이 비면 빈 이름 — 기본 프린터로 간다.
   */
  private nextPrinter(config: AppConfig): string {
    const pool = printerPool(config);
    const name = pool[this.laneCursor % pool.length];
    this.laneCursor = (this.laneCursor + 1) % pool.length;
    return name;
  }

  /**
   * 장비 줄에 세워 차례로 실행한다.
   *
   * 앞 건이 실패해도 뒤 건은 돌아야 하므로 성공·실패 모두 이어 붙인다. 줄을 무한정
   * 늘리지 않도록, 실행이 끝나면 결과를 버린 약속만 남긴다.
   */
  private onLane<T>(printerName: string, task: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(printerName) ?? Promise.resolve();
    const run = previous.then(task, task);
    this.lanes.set(
      printerName,
      run.then(
        () => undefined,
        () => undefined
      )
    );
    return run;
  }

  /**
   * 큐에서 지운다 — 중복·오생성 디자인을 걷어낼 때.
   *
   * 서버 삭제가 성공해야 로컬에서도 지운다. 로컬만 지우면 다음 폴링에서 같은 건이 다시
   * 내려온다. 404 는 서버에 이미 없다는 뜻이므로 성공으로 본다.
   */
  async deleteItem(jobId: string): Promise<{ ok: boolean; reason?: string }> {
    const item = this.ready.get(jobId);
    if (!item) return { ok: false, reason: "이미 없는 항목입니다." };
    if (this.sending.has(jobId)) return { ok: false, reason: "전송 중인 항목은 삭제할 수 없습니다." };

    const config = getConfig();
    const api = new GarmentApi(config.baseUrl, config.apiKey);
    const label = `${item.job.orderNumber} ${item.job.wepnpSeqno}`;

    try {
      // 감시 폴더에서 집은 건은 서버 큐에 없다. 로컬만 정리한다
      if (!item.local) await api.deleteJob(jobId);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 404) {
        this.log("error", `큐 삭제 실패: ${label} — ${(error as Error).message}`);
        return { ok: false, reason: (error as Error).message };
      }
      this.log("info", `큐 삭제 — 서버에 이미 없어 로컬만 정리합니다: ${label}`);
    }

    this.ready.delete(jobId);
    this.persist();
    // 내려받은 디자인과 썸네일도 함께 지운다. 남기면 고객 도안이 단말에 쌓인다
    for (const file of [item.downloadPath, ...item.thumbnailPaths]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // 지우지 못해도 큐에서는 빠졌다
      }
    }
    this.log("info", `큐에서 삭제했습니다: ${label}`);
    this.events.onRemoved?.(jobId);
    return { ok: true };
  }

  /**
   * 실물 대조용 미리보기 — 지시서를 PDF 로 떨군다.
   *
   * reportlab 좌표에서 HTML 로 옮기면 여백·배율이 틀어질 수 있다. 인쇄물을 현행과
   * 견줘 볼 수 있어야 하므로 검증 중에는 이 경로를 쓴다. 운영 흐름에는 끼지 않는다.
   */
  async previewWorkOrder(jobId: string): Promise<{ ok: boolean; path?: string; reason?: string }> {
    const item = this.ready.get(jobId);
    if (!item) return { ok: false, reason: "이미 없는 항목입니다." };

    const config = getConfig();
    const dest = path.join(config.downloadDir, `${item.job.orderNumber}_${item.job.wepnpSeqno}_지시서미리보기.pdf`);
    const result = await saveHtmlAsPdf(await this.renderWorkOrder(item), dest);
    if (!result.ok) return { ok: false, reason: result.reason };

    this.log("info", `지시서 미리보기 저장: ${dest}`);
    return { ok: true, path: dest };
  }

  /** 지시서 HTML 조립 — 인쇄와 미리보기가 같은 것을 쓴다 */
  private async renderWorkOrder(item: ReadyItem): Promise<string> {
    const config = getConfig();
    return buildWorkOrderHtml({
      job: item.job,
      // 생산 이미지는 실제로 출력한 도안(PNG)이다. 읽지 못하면 칸을 비운다
      designImageDataUrl: fileToDataUrl(item.downloadPath),
      thumbnailDataUrls: item.thumbnailPaths.map(fileToDataUrl).filter((v): v is string => v !== null),
      qrDataUrl: await makeQrDataUrl(item.job.workOrder.workUrl),
      designFileName: path.basename(item.downloadPath),
      // 아직 배정 전이면 대표 장비 이름을 싣는다. 지시서에 빈 칸을 두지 않는다
      printerName: item.printerName || primaryPrinter(config),
    });
  }

  private async report(api: GarmentApi, jobId: string, target: "garment" | "workOrder"): Promise<void> {
    try {
      await api.markDownloaded(jobId, target);
    } catch (error) {
      // 보고가 실패해도 파일은 이미 받았다. 서버의 stuck 회수가 정리하므로 여기서 멈추지 않는다
      this.log("warn", `다운로드 완료 보고 실패(${target}): ${(error as Error).message}`);
    }
  }

  /**
   * 파일 하나를 내려받아 저장하고 경로를 돌려준다.
   *
   * 실패하면 **한 번 즉시 다시 시도한다.** 매장 회선이 끊겼다 붙는 일이 잦은데, 그때마다
   * 다음 폴링(최대 30초)까지 기다리면 작업자가 장비 앞에서 서 있게 된다.
   */
  private async fetchFile(url: string, dest: string): Promise<string> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length === 0) throw new Error("빈 파일");
        fs.writeFileSync(dest, buffer);
        return dest;
      } catch (error) {
        lastError = error as Error;
        if (attempt < FETCH_RETRIES) this.log("warn", `내려받기 실패 — 다시 시도합니다: ${lastError.message}`);
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError ?? new Error("내려받기 실패");
  }
}

/**
 * 건너뛴 사유 한 줄.
 *
 * 토글을 꺼 둔 것과 다른 단말이 이미 가져간 것은 화면에서 똑같아 보인다. 현장에서
 * "왜 안 나오냐"를 가르는 것이 이 문장이라 사유를 나눠 적는다.
 */
function skipReason(
  config: { garmentEnabled: boolean; garmentPrinterNames: string[]; workOrderEnabled: boolean; workOrderPrinterName: string },
  job: GarmentJob
): string {
  const garmentOff = !(config.garmentEnabled && config.garmentPrinterNames.length > 0);
  const workOrderOff = !(config.workOrderEnabled && config.workOrderPrinterName);

  if (job.garmentPending && garmentOff && job.workOrderPending && workOrderOff) {
    return "양쪽 모두 이 단말이 맡지 않음 — 다른 단말 처리 대기";
  }
  if (job.garmentPending && garmentOff && !job.workOrderPending) return "장비 전송을 이 단말이 맡지 않음";
  if (job.workOrderPending && workOrderOff && !job.garmentPending) return "작업지시서를 이 단말이 맡지 않음";
  if (!job.garmentPending && !job.workOrderPending) return "이미 다른 단말이 가져감";
  return `사유 불명 (장비=${job.garmentPending}/지시서=${job.workOrderPending})`;
}

/**
 * 벤더 CLI 경로.
 *
 * 설정에 적어 두면 그것을 쓰고, 없으면 설치본 안의 vendor 폴더에서 찾는다.
 * 파일명은 제품을 특정할 수 없는 중립 이름이다.
 */
function resolveCliPaths(config: { cliLegacyPath: string; cliProPath: string }): { legacy: string; pro: string } {
  const dir = vendorDir();
  return {
    legacy: config.cliLegacyPath || path.join(dir, "cli_legacy.exe"),
    pro: config.cliProPath || path.join(dir, "cli_pro.exe"),
  };
}

/** 같은 이름이 있으면 뒤에 번호를 붙인다. 덮어쓰면 아직 출력하지 않은 건이 사라진다 */
function uniquePath(target: string): string {
  if (!fs.existsSync(target)) return target;
  const dir = path.dirname(target);
  const { name, ext } = path.parse(target);
  for (let n = 1; ; n++) {
    const candidate = path.join(dir, `${name}_${n}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

/** 파일명에 쓸 수 없는 문자를 걷어낸다 */
const safe = (value: string): string => value.replace(/[\\/:*?"<>|]/g, "_");

const extFromUrl = (url: string): string => {
  const clean = url.split("?")[0];
  const ext = path.extname(clean).toLowerCase();
  return ext && ext.length <= 5 ? ext : ".bin";
};

/**
 * 디자인 파일명.
 *
 * 파이썬 판과 같은 규칙을 쓴다. 주문번호·아이템순번·편집번호가 들어가 있어야 현장에서
 * done/error 폴더를 열었을 때 어떤 건인지 알아볼 수 있다.
 */
const designFileName = (job: GarmentJob, url: string): string =>
  `${safe(job.orderNumber)}_${String(job.itemIndex).padStart(2, "0")}_${safe(job.wepnpSeqno)}_디자인${extFromUrl(url)}`;

const thumbFileName = (job: GarmentJob, n: number, url: string): string =>
  `${safe(job.orderNumber)}_${String(job.itemIndex).padStart(2, "0")}_${safe(job.wepnpSeqno)}_썸네일${n}${extFromUrl(url)}`;
