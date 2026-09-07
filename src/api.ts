import type { JobTarget, QueueResponse } from "./types";

/**
 * 서버 API 클라이언트.
 *
 * 인증은 기기 인증(device auth) 방식이다. 단말이 코드를 받아 브라우저에서 승인시키고,
 * 승인되면 API 키를 받아 저장한다. 이후 요청은 `Authorization: Bearer` 로만 나간다.
 */

const VERSION = "0.1.0";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const request = async (url: string, init: RequestInit, timeoutMs = 15_000): Promise<Response> => {
  // fetch 는 기본 타임아웃이 없다. 서버가 응답하지 않으면 폴링이 통째로 멈추므로 직접 건다
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      throw new ApiError(`${res.status} ${res.statusText}`, res.status);
    }
    return res;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if ((error as Error).name === "AbortError") throw new ApiError("서버 응답이 없습니다.");
    throw new ApiError((error as Error).message);
  } finally {
    clearTimeout(timer);
  }
};

// ── 기기 인증 ──────────────────────────────────────────

export type AuthRequest = {
  deviceCode: string;
  userCode: string;
  verifyUrl: string;
  /** 초 단위 */
  expiresIn: number;
};

export const requestAuth = async (baseUrl: string, tenant: string): Promise<AuthRequest> => {
  const res = await request(`${baseUrl}/api/printer/auth/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenant, type: "garment" }),
  });
  return (await res.json()) as AuthRequest;
};

export type AuthPoll = { status: "pending" | "approved" | "expired"; apiKey?: string };

export const pollAuth = async (baseUrl: string, deviceCode: string): Promise<AuthPoll> => {
  const res = await request(`${baseUrl}/api/printer/auth/poll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceCode }),
  });
  return (await res.json()) as AuthPoll;
};

// ── 출력 큐 ────────────────────────────────────────────

export class GarmentApi {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string
  ) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "X-Client-Version": VERSION,
    };
  }

  /**
   * 미출력 큐 조회.
   *
   * `garmentEnabled` / `workOrderEnabled` 는 이 단말이 무엇을 할 수 있는지 알린다. 서버는
   * 할 수 있는 갈래만 선점 대상으로 삼는다. 이걸 넘기지 않으면, 지시서만 대기 중인 큐에
   * 지시서를 못 뽑는 단말이 묶여 무한 반복하게 된다.
   */
  async getPendingJobs(opts: {
    limit?: number;
    garmentEnabled: boolean;
    workOrderEnabled: boolean;
  }): Promise<QueueResponse> {
    const params = new URLSearchParams({
      status: "pending",
      limit: String(opts.limit ?? 10),
      garment_enabled: String(opts.garmentEnabled),
      work_order_enabled: String(opts.workOrderEnabled),
    });
    const res = await request(`${this.baseUrl}/api/printer/garment?${params}`, { headers: this.headers() });
    return (await res.json()) as QueueResponse;
  }

  /** 단말 다운로드 완료 보고. 장비 전송은 작업자가 누를 때 따로 보고한다 */
  async markDownloaded(jobId: string, target: JobTarget): Promise<void> {
    await this.report(jobId, "downloaded", { target });
  }

  /** 장비 전송 완료 보고 */
  async markPrinted(jobId: string, target: JobTarget): Promise<void> {
    await this.report(jobId, "printed", { target });
  }

  /** 실패 보고. 사유는 작업자 화면과 서버 이력에 함께 남는다 */
  async markFailed(jobId: string, target: JobTarget, reason: string): Promise<void> {
    await this.report(jobId, "failed", { target, ...(reason ? { reason } : {}) });
  }

  private async report(jobId: string, action: string, body: Record<string, unknown>): Promise<void> {
    await request(
      `${this.baseUrl}/api/printer/garment/${jobId}/${action}`,
      {
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      10_000
    );
  }

  /**
   * 큐 1건 삭제 — 중복·오생성 디자인을 작업자가 걷어낼 때.
   *
   * 복구는 없다. 잘못 지웠으면 관리자 주문 관리의 재출력으로 다시 넣는다.
   * 404 는 서버에 이미 없다는 뜻이므로 호출부가 성공으로 처리한다.
   */
  async deleteJob(jobId: string): Promise<void> {
    await request(`${this.baseUrl}/api/printer/garment/${jobId}`, { method: "DELETE", headers: this.headers() }, 10_000);
  }
}
