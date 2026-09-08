import fs from "node:fs";
import path from "node:path";

/**
 * 감시 폴더.
 *
 * 서버 큐와 별개로, 다른 시스템이 폴더에 떨궈 놓은 파일도 출력할 수 있어야 한다.
 * 파이썬 판 `watcher.py` 와 같은 자리다.
 *
 * 복사가 끝나기 전에 집으면 잘린 파일을 출력한다. Windows 는 큰 파일을 조금씩 쓰거나
 * 임시 이름으로 만든 뒤 rename 하므로, **크기가 멈출 때까지 기다린 다음** 넘긴다.
 */

/**
 * 받아들일 확장자.
 *
 * 장비로 나가는 것은 PNG 뿐이다. 다른 형식을 집어 대기 목록에 올리면 작업자가 전송을
 * 눌렀을 때에야 실패를 본다. 폴더에서 집을 때 걸러 두는 편이 낫다.
 */
const ACCEPTED = new Set([".png"]);

/** 크기 확인 간격(ms)과 몇 번 연속 같아야 안정으로 볼지 */
const STABLE_INTERVAL_MS = 500;
const STABLE_COUNT = 3;
/** 안정화를 기다리는 상한(ms). 넘으면 포기한다 */
const STABLE_TIMEOUT_MS = 30_000;

export type WatcherEvents = {
  /** 안정화가 끝난 파일 하나 */
  onFile: (filePath: string) => void | Promise<void>;
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class IncomingWatcher {
  private watcher: fs.FSWatcher | null = null;
  /** 처리 중인 파일 — 같은 파일을 두 번 집지 않게 막는다 */
  private readonly busy = new Set<string>();
  private dir = "";

  constructor(private readonly events: WatcherEvents) {}

  get watching(): boolean {
    return this.watcher !== null;
  }

  get directory(): string {
    return this.dir;
  }

  start(dir: string): void {
    if (this.watcher && this.dir === dir) return;
    this.stop();
    if (!dir) return;

    try {
      fs.mkdirSync(dir, { recursive: true });
      // rename 은 생성·삭제·이름변경을 모두 뜻한다. 존재 여부는 집을 때 다시 확인한다
      this.watcher = fs.watch(dir, { persistent: false }, (_event, name) => {
        if (name) this.consider(path.join(dir, name.toString()));
      });
      this.dir = dir;
      this.log("info", `감시 폴더를 봅니다: ${dir}`);

      // 앱이 꺼져 있는 동안 들어온 파일은 이벤트가 오지 않는다. 시작할 때 한 번 훑는다
      for (const name of fs.readdirSync(dir)) this.consider(path.join(dir, name));
    } catch (error) {
      this.log("error", `감시 폴더를 열 수 없습니다: ${(error as Error).message}`);
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    this.dir = "";
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    this.events.onLog?.(level, message);
  }

  private consider(filePath: string): void {
    if (!ACCEPTED.has(path.extname(filePath).toLowerCase())) return;
    if (this.busy.has(filePath)) return;

    this.busy.add(filePath);
    void this.handle(filePath).finally(() => this.busy.delete(filePath));
  }

  private async handle(filePath: string): Promise<void> {
    try {
      if (!(await this.waitForStable(filePath))) {
        this.log("warn", `복사가 끝나지 않아 건너뜁니다: ${path.basename(filePath)}`);
        return;
      }
      this.log("info", `감시 폴더에서 집었습니다: ${path.basename(filePath)}`);
      await this.events.onFile(filePath);
    } catch (error) {
      this.log("error", `감시 폴더 처리 실패: ${path.basename(filePath)} — ${(error as Error).message}`);
    }
  }

  /** 크기가 연속으로 같아질 때까지 기다린다 */
  private async waitForStable(filePath: string): Promise<boolean> {
    let previous = -1;
    let stable = 0;
    let missing = 0;

    for (let waited = 0; waited < STABLE_TIMEOUT_MS; waited += STABLE_INTERVAL_MS) {
      let size = -1;
      try {
        size = fs.statSync(filePath).size;
      } catch {
        // 임시 파일이 rename 으로 사라지는 중일 수 있다. 몇 번은 봐준다
        if (++missing > 5) return false;
        await sleep(STABLE_INTERVAL_MS);
        continue;
      }

      missing = 0;
      if (size > 0 && size === previous) {
        if (++stable >= STABLE_COUNT) return true;
      } else {
        stable = 0;
      }
      previous = size;
      await sleep(STABLE_INTERVAL_MS);
    }
    return false;
  }
}
