/* 화면 로직. 상태는 메인 프로세스가 들고 있고 여기서는 받은 것만 그린다. */

const $ = (id) => document.getElementById(id);
const api = window.garment;

// ── 공통 ──────────────────────────────────────────────
const setStatus = (el, text, kind = "") => {
  el.textContent = text;
  el.className = "status" + (kind ? " " + kind : "");
};

api.getVersion().then((v) => {
  $("version").textContent = "v" + v;
});

// ── 연결 상태 ─────────────────────────────────────────
let config = null;

async function loadConfig() {
  config = await api.config.get();

  const connected = Boolean(config.apiKey);
  $("auth-card").hidden = connected;
  $("run-card").hidden = !connected;

  const chip = $("conn");
  chip.textContent = connected ? config.tenant || "연결됨" : "연결 안 됨";
  chip.className = "chip " + (connected ? "on" : "off");

  $("garment-enabled").checked = config.garmentEnabled;
  $("work-order-enabled").checked = config.workOrderEnabled;
  $("tenant").value = config.tenant || "";

  await loadPrinters();
  updateRunDesc();
}

function updateRunDesc() {
  const roles = [];
  if (config.garmentEnabled) roles.push("디자인 장비 전송");
  if (config.workOrderEnabled) roles.push("작업지시서 인쇄");
  $("run-desc").textContent = roles.length
    ? `이 단말이 맡은 작업: ${roles.join(", ")}`
    : "맡은 작업이 없습니다. 아래 설정에서 하나 이상 켜야 큐를 가져옵니다.";
}

async function loadPrinters() {
  const select = $("work-order-printer");
  const printers = await api.printers.list();
  select.innerHTML = "";

  const none = document.createElement("option");
  none.value = "";
  none.textContent = printers.length ? "기본 프린터" : "프린터를 찾지 못했습니다";
  select.appendChild(none);

  for (const p of printers) {
    const opt = document.createElement("option");
    opt.value = p.name;
    opt.textContent = p.displayName || p.name;
    select.appendChild(opt);
  }
  select.value = config.workOrderPrinterName || "";
}

// ── 인증 ──────────────────────────────────────────────
$("auth-start").addEventListener("click", async () => {
  const tenant = $("tenant").value.trim();
  if (!tenant) {
    setStatus($("auth-status"), "스토어 주소를 입력하세요.", "err");
    return;
  }
  setStatus($("auth-status"), "브라우저에서 승인을 기다리는 중...");
  try {
    const info = await api.auth.start(tenant);
    setStatus($("auth-status"), `브라우저에서 승인해 주세요. 인증 코드: ${info.userCode}`);
  } catch (e) {
    setStatus($("auth-status"), "연결 요청에 실패했습니다: " + (e?.message ?? e), "err");
  }
});

api.auth.onResult(async (result) => {
  if (result.status === "approved") {
    setStatus($("auth-status"), "연결되었습니다.", "ok");
    await loadConfig();
  } else {
    setStatus($("auth-status"), "승인 시간이 지났습니다. 다시 시도하세요.", "err");
  }
});

$("reauth").addEventListener("click", async () => {
  await api.auth.cancel();
  await api.config.set({ apiKey: "" });
  await loadConfig();
});

// ── 설정 ──────────────────────────────────────────────
$("garment-enabled").addEventListener("change", async (e) => {
  config = await api.config.set({ garmentEnabled: e.target.checked });
  updateRunDesc();
});
$("work-order-enabled").addEventListener("change", async (e) => {
  config = await api.config.set({ workOrderEnabled: e.target.checked });
  updateRunDesc();
});
$("work-order-printer").addEventListener("change", async (e) => {
  config = await api.config.set({ workOrderPrinterName: e.target.value });
});

// ── 폴링 ──────────────────────────────────────────────
let running = false;

function renderAgentState() {
  $("agent-toggle").textContent = running ? "정지" : "시작";
  setStatus($("agent-state"), running ? "가져오는 중" : "멈춤", running ? "ok" : "");
}

$("agent-toggle").addEventListener("click", async () => {
  running = running ? await api.agent.stop() : await api.agent.start();
  renderAgentState();
});

api.agent.onState((s) => {
  running = s.running;
  renderAgentState();
});

// ── 대기 목록 ─────────────────────────────────────────
const items = new Map();

function renderQueue() {
  const box = $("queue");
  box.innerHTML = "";
  for (const item of items.values()) {
    const job = item.job;
    const row = document.createElement("div");
    row.className = "item";

    const left = document.createElement("div");
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = `${job.orderNumber} · ${job.wepnpSeqno}`;
    const sub = document.createElement("div");
    sub.className = "sub";
    const parts = [job.productName];
    if (job.optionName) parts.push(job.optionName);
    if (job.quantity > 1) parts.push(`${job.quantity}개`);
    if (job.itemTotal > 1) parts.push(`${job.itemIndex}/${job.itemTotal}`);
    sub.textContent = parts.join(" · ");
    left.append(name, sub);

    const right = document.createElement("div");
    right.className = "sub";
    const roles = [];
    if (item.doGarment) roles.push("디자인");
    if (item.doWorkOrder) roles.push("지시서");
    right.textContent = roles.join(" + ") || "-";

    row.append(left, right);
    box.appendChild(row);
  }
}

api.agent.onReady((item) => {
  items.set(item.job.id, item);
  renderQueue();
});
api.agent.onRemoved((jobId) => {
  items.delete(jobId);
  renderQueue();
});

// ── 로그 ──────────────────────────────────────────────
api.onLog((entry) => {
  const box = $("log");
  const line = document.createElement("div");
  line.className = entry.level;
  const time = document.createElement("time");
  time.textContent = new Date(entry.at).toLocaleTimeString("ko-KR");
  line.append(time, document.createTextNode(entry.message));
  box.appendChild(line);
  // 최근 것이 보이도록 따라 내려간다
  box.scrollTop = box.scrollHeight;
  // 오래된 줄은 걷어낸다 — 오래 켜두면 화면이 무거워진다
  while (box.childElementCount > 300) box.removeChild(box.firstChild);
});

// ── 업데이트 ──────────────────────────────────────────
function renderUpdate(state) {
  const el = $("update-status");
  $("install").hidden = state.status !== "ready";
  $("check").disabled = state.status === "checking" || state.status === "downloading";

  switch (state.status) {
    case "checking":
      setStatus(el, "확인 중...");
      break;
    case "available":
      setStatus(el, `새 버전 ${state.version} 을 받는 중입니다.`);
      break;
    case "downloading":
      setStatus(el, `받는 중... ${state.percent}%`);
      break;
    case "ready":
      setStatus(el, `새 버전 ${state.version} 준비됨. 재시작하면 적용됩니다.`, "ok");
      break;
    case "latest":
      setStatus(el, "최신 버전입니다.");
      break;
    case "error":
      setStatus(el, state.message, "err");
      break;
    default:
      setStatus(el, "");
  }
}

api.update.onState(renderUpdate);
api.update.state().then(renderUpdate);
$("check").addEventListener("click", () => api.update.check().then(renderUpdate));
$("install").addEventListener("click", () => api.update.install());

// ── 시작 ──────────────────────────────────────────────
(async () => {
  await loadConfig();
  const state = await api.agent.state();
  running = state.running;
  for (const item of state.items) items.set(item.job.id, item);
  renderAgentState();
  renderQueue();
})();
