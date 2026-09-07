import fs from "node:fs";
import path from "node:path";
import { GarmentApi } from "./api";
import { getConfig } from "./config";
import { printHtml, saveHtmlAsPdf } from "./printer";
import type { GarmentJob, ReadyItem } from "./types";
import { buildWorkOrderHtml } from "./work-order";
import { fileToDataUrl, makeQrDataUrl } from "./work-order-assets";

/**
 * 폴링 에이전트.
 *
 * 서버에서 출력 큐를 받아 디자인과 썸네일을 내려받고, 작업자가 전송을 누를 때까지
 * 대기 목록에 쌓는다. 장비 전송과 인쇄는 이후 단계에서 붙인다.
 */

/** 큐가 비었을 때 폴링을 늦추는 상한(초). 서버와 네트워크를 아낀다 */
const MAX_BACKOFF_SEC = 30;

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

  private log(level: "info" | "warn" | "error", message: string): void {
    this.events.onLog?.(level, message);
  }

  /** 다음 폴링까지 기다릴 시간. 빈 응답이 이어지면 점점 늦춘다 */
  private nextDelaySec(base: number, hasMore: boolean): number {
    // 가져갈 것이 남았다고 서버가 알려주면 늦추지 않는다. 늦추면 밀린 건이 더 밀린다
    if (hasMore) return 0;
    if (this.emptyCount <= 1) return base;
    return Math.min(base * Math.min(this.emptyCount, 6), MAX_BACKOFF_SEC);
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
      this.log("info", `건너뜀 — 이 단말이 맡은 작업이 없습니다: ${job.orderNumber}`);
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
      this.ready.set(job.id, item);

      // 서버에 다운로드 완료를 알려 다른 단말이 같은 건을 가져가지 않게 한다
      if (doGarment) await this.report(api, job.id, "garment");
      if (doWorkOrder) await this.report(api, job.id, "workOrder");

      this.log("info", `대기 목록에 담았습니다: ${label}`);
      this.events.onReady?.(item);
    } catch (error) {
      const reason = (error as Error).message;
      this.log("error", `다운로드 실패: ${label} — ${reason}`);
      // 서버가 이 건을 다시 대기로 돌려 다른 단말이나 다음 폴링에서 재시도하게 한다
      if (doGarment) await api.markFailed(job.id, "garment", reason).catch(() => undefined);
      if (doWorkOrder) await api.markFailed(job.id, "workOrder", reason).catch(() => undefined);
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
      // 생산 이미지는 실제로 출력한 도안이다. 이미지가 아닌 형식(PDF 등)이면 칸을 비운다
      designImageDataUrl: fileToDataUrl(item.downloadPath),
      thumbnailDataUrls: item.thumbnailPaths.map(fileToDataUrl).filter((v): v is string => v !== null),
      qrDataUrl: await makeQrDataUrl(item.job.workOrder.workUrl),
      designFileName: path.basename(item.downloadPath),
      printerName: config.garmentPrinterName,
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

  /** 파일 하나를 내려받아 저장하고 경로를 돌려준다 */
  private async fetchFile(url: string, dest: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length === 0) throw new Error("빈 파일");
      fs.writeFileSync(dest, buffer);
      return dest;
    } finally {
      clearTimeout(timer);
    }
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
