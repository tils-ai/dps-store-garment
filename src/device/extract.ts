import fs from "node:fs";
import path from "node:path";
import { runOnActive, type CliContext } from "./cli";

/**
 * 인쇄 데이터 추출 진단.
 *
 * 장비로 보낸 것이 실제로 어떤 이미지·설정이었는지는 생성된 인쇄 데이터를 되풀어야
 * 알 수 있다. 출력물이 어긋났을 때 "무엇을 보냈는가" 를 확인하는 유일한 경로다.
 *
 * 파이썬 판은 이것을 매 출력마다 돌렸다. 건마다 원본 + XML + PNG 세 개가 쌓여
 * 디스크를 갉아먹으므로, 여기서는 설정으로 켤 때만 돌린다.
 */
export async function extractPrintData(
  ctx: CliContext,
  dataPath: string,
  outDir: string,
  page: number
): Promise<{ ok: boolean; dir?: string; reason?: string }> {
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const stem = path.join(outDir, `print-data-${stamp}-p${page}`);

    // 원본을 먼저 복사한다. 작업 폴더는 전송이 끝나면 통째로 지워진다
    try {
      fs.copyFileSync(dataPath, `${stem}${path.extname(dataPath)}`);
    } catch (error) {
      // 복사에 실패해도 추출은 시도한다
      ctx.onLog?.("warn", `인쇄 데이터 원본 복사 실패: ${(error as Error).message}`);
    }

    const result = await runOnActive(ctx, ["extract", "-A", dataPath, "-X", `${stem}.xml`, "-I", `${stem}.png`]);
    if (result.code !== 0) return { ok: false, reason: `인쇄 데이터 추출 실패: ${result.description}` };
    return { ok: true, dir: outDir };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}
