/* 화면 로직. 상태는 메인 프로세스가 들고 있고 여기서는 받은 것만 그린다. */

const $ = (id) => document.getElementById(id);
const api = window.garment;

/** 잉크 모드 — 옷 색으로 고른다 */
const INK_WHITE_GARMENT = 0; // 흰옷: 컬러만
const INK_COLOR_GARMENT = 2; // 컬러옷: 흰색 + 컬러

const setStatus = (el, text, kind = "") => {
  el.textContent = text;
  el.className = "status" + (kind ? " " + kind : "");
};

api.getVersion().then((v) => ($("version").textContent = "v" + v));

// ── 설정 ──────────────────────────────────────────────
let config = null;

async function loadConfig() {
  config = await api.config.get();

  const connected = Boolean(config.apiKey);
  $("auth-card").hidden = connected;
  $("queue-view").hidden = !connected || view !== "queue";
  $("agent-toggle").disabled = !connected;

  const chip = $("conn");
  chip.textContent = connected ? config.tenant || "연결됨" : "연결 안 됨";
  chip.className = "chip " + (connected ? "on" : "off");

  $("garment-enabled").checked = config.garmentEnabled;
  $("work-order-enabled").checked = config.workOrderEnabled;
  $("auto-send").checked = config.autoSend;
  $("watch-enabled").checked = config.watchEnabled;
  $("tenant").value = config.tenant || "";

  $("garment-dispatch").value = config.garmentDispatch;
  $("garment-mode").value = config.garmentMode;
  $("poll-interval").value = config.pollIntervalSec;
  $("device-status-enabled").checked = config.deviceStatusEnabled;
  $("device-status-interval").value = config.deviceStatusIntervalSec;
  $("incoming-dir").value = config.incomingDir;
  $("done-dir").value = config.doneDir;
  $("error-dir").value = config.errorDir;
  $("download-dir").value = config.downloadDir;
  $("log-level").value = config.logLevel;
  $("p-render-dpi").value = config.renderDpi;
  $("extract-diagnostic").checked = config.extractDiagnostic;

  // 장비 설정은 이름만 다를 뿐 전부 config.print 의 값이다. 하나씩 적지 않고 표로 돈다
  for (const [id, key] of Object.entries(PRINT_FIELDS)) {
    const el = $(id);
    const value = config.print[key];
    if (el.type === "checkbox") el.checked = Boolean(value);
    else el.value = String(value);
  }

  renderPrinterChips();
  await loadPrinters();
}

/** 화면 입력칸 ↔ 장비 설정 키. 값 종류는 입력칸 type 으로 가른다 */
const PRINT_FIELDS = {
  "p-cli": "cli",
  "p-ink": "ink",
  "p-resolution": "resolution",
  "p-platen-adult": "platenAdult",
  "p-platen-child": "platenChild",
  "p-platen-size": "platenSize",
  "p-copies": "copies",
  "p-magnification": "magnification",
  "p-size": "size",
  "p-position": "position",
  "p-machine-mode": "machineMode",
  "p-auto-fit": "autoFit",
  "p-auto-center": "autoCenter",
  "p-auto-delete": "autoDelete",
  "p-ink-volume": "inkVolume",
  "p-highlight": "highlight",
  "p-mask": "mask",
  "p-double-print": "doublePrint",
  "p-min-white": "minWhite",
  "p-choke": "choke",
  "p-white-as": "whiteAs",
  "p-eco-mode": "ecoMode",
  "p-material-black": "materialBlack",
  "p-uni-print": "uniPrint",
  "p-multiple": "multiple",
  "p-pause": "pause",
  "p-trans-color": "transColor",
  "p-color-trans": "colorTrans",
  "p-tolerance": "tolerance",
  "p-saturation": "saturation",
  "p-brightness": "brightness",
  "p-contrast": "contrast",
  "p-cyan-balance": "cyanBalance",
  "p-magenta-balance": "magentaBalance",
  "p-yellow-balance": "yellowBalance",
  "p-black-balance": "blackBalance",
};

/** 등록된 장비 목록. × 로 한 대씩 뺀다 */
function renderPrinterChips() {
  const box = $("garment-chips");
  box.innerHTML = "";
  if (config.garmentPrinterNames.length === 0) {
    const empty = document.createElement("span");
    empty.className = "chip-empty";
    empty.textContent = "등록된 장비 없음 (기본 프린터로 보냅니다)";
    box.appendChild(empty);
    return;
  }
  for (const [i, name] of config.garmentPrinterNames.entries()) {
    const chip = document.createElement("span");
    chip.className = "chip-item";
    // 첫 대가 상태 조회와 관리 명령을 받는다. 화면에서도 구분이 돼야 한다
    chip.textContent = i === 0 ? `${name} (대표)` : name;
    const remove = document.createElement("button");
    remove.className = "chip-x";
    remove.textContent = "✕";
    remove.title = "목록에서 빼기";
    remove.addEventListener("click", async () => {
      await save({ garmentPrinterNames: config.garmentPrinterNames.filter((n) => n !== name) });
      renderPrinterChips();
    });
    chip.appendChild(remove);
    box.appendChild(chip);
  }
}

async function loadPrinters() {
  const printers = await api.printers.list();

  // 장비는 목록에 더하는 용도라 고르는 칸을 비워 둔다
  const garment = $("garment-printer");
  garment.innerHTML = "";
  const pick = document.createElement("option");
  pick.value = "";
  pick.textContent = printers.length ? "장비 선택..." : "프린터를 찾지 못했습니다";
  garment.appendChild(pick);

  const workOrder = $("work-order-printer");
  workOrder.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = printers.length ? "기본 프린터" : "프린터를 찾지 못했습니다";
  workOrder.appendChild(none);

  for (const pr of printers) {
    for (const select of [garment, workOrder]) {
      const opt = document.createElement("option");
      opt.value = pr.name;
      opt.textContent = pr.displayName || pr.name;
      select.appendChild(opt);
    }
  }
  workOrder.value = config.workOrderPrinterName || "";
}

const save = async (patch) => (config = await api.config.set(patch));
const savePrint = async (patch) => (config = await api.config.set({ print: { ...config.print, ...patch } }));

/** 숫자 칸이 비면 0 이 아니라 기존 값을 지킨다. 빈 칸으로 설정이 초기화되면 안 된다 */
const asNumber = (raw, fallback) => {
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

$("garment-enabled").addEventListener("change", (e) => save({ garmentEnabled: e.target.checked }));
$("work-order-enabled").addEventListener("change", (e) => save({ workOrderEnabled: e.target.checked }));
$("auto-send").addEventListener("change", (e) => save({ autoSend: e.target.checked }));
$("watch-enabled").addEventListener("change", (e) => save({ watchEnabled: e.target.checked }));
$("work-order-printer").addEventListener("change", (e) => save({ workOrderPrinterName: e.target.value }));
$("garment-dispatch").addEventListener("change", (e) => save({ garmentDispatch: e.target.value }));
$("garment-mode").addEventListener("change", (e) => save({ garmentMode: e.target.value }));
$("poll-interval").addEventListener("change", (e) => save({ pollIntervalSec: asNumber(e.target.value, config.pollIntervalSec) }));
$("device-status-enabled").addEventListener("change", (e) => save({ deviceStatusEnabled: e.target.checked }));
$("device-status-interval").addEventListener("change", (e) =>
  save({ deviceStatusIntervalSec: asNumber(e.target.value, config.deviceStatusIntervalSec) })
);
$("incoming-dir").addEventListener("change", (e) => save({ incomingDir: e.target.value.trim() }));
$("done-dir").addEventListener("change", (e) => save({ doneDir: e.target.value.trim() }));
$("error-dir").addEventListener("change", (e) => save({ errorDir: e.target.value.trim() }));
$("log-level").addEventListener("change", (e) => save({ logLevel: e.target.value }));
$("download-dir").addEventListener("change", (e) => save({ downloadDir: e.target.value.trim() }));
$("p-render-dpi").addEventListener("change", (e) => save({ renderDpi: asNumber(e.target.value, config.renderDpi) }));
$("extract-diagnostic").addEventListener("change", (e) => save({ extractDiagnostic: e.target.checked }));

$("garment-add").addEventListener("click", async () => {
  const name = $("garment-printer").value;
  // 같은 장비를 두 번 넣으면 라운드로빈이 그 대에만 몰린다
  if (!name || config.garmentPrinterNames.includes(name)) return;
  await save({ garmentPrinterNames: [...config.garmentPrinterNames, name] });
  $("garment-printer").value = "";
  renderPrinterChips();
});

/** 값이 숫자인 선택 칸. select 는 문자열을 돌려주므로 따로 가른다 */
const NUMBER_SELECTS = new Set(["p-ink"]);

for (const [id, key] of Object.entries(PRINT_FIELDS)) {
  const el = $(id);
  el.addEventListener("change", (e) => {
    if (el.type === "checkbox") return savePrint({ [key]: e.target.checked });
    if (el.type === "number" || NUMBER_SELECTS.has(id)) {
      return savePrint({ [key]: asNumber(e.target.value, config.print[key]) });
    }
    return savePrint({ [key]: e.target.value.trim() });
  });
}

$("advanced-toggle").addEventListener("click", () => {
  const box = $("advanced");
  box.hidden = !box.hidden;
  $("advanced-toggle").textContent = box.hidden ? "고급 설정 펼치기" : "고급 설정 접기";
  $("advanced-toggle").setAttribute("aria-expanded", String(!box.hidden));
});

for (const btn of document.querySelectorAll("[data-open]")) {
  btn.addEventListener("click", () => api.openFolder(btn.dataset.open));
}

// ── 장비 관리 ── 결과를 로그로 남겨 현장에서 성공 여부를 안다
for (const btn of document.querySelectorAll("[data-device]")) {
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      const result = await api.device.maintenance(btn.dataset.device);
      appendLog(result.ok ? "info" : "error", `${btn.textContent.trim()}: ${result.ok ? "보냈습니다." : result.reason}`);
    } finally {
      btn.disabled = false;
    }
  });
}

$("device-log").addEventListener("click", async () => {
  const btn = $("device-log");
  btn.disabled = true;
  appendLog("info", "장비 로그를 받는 중입니다. 시간이 걸릴 수 있습니다.");
  try {
    const result = await api.device.collectLog();
    if (result.ok) appendLog(result.reason ? "warn" : "info", result.reason ?? `장비 로그 저장: ${result.dir}`);
    else appendLog("error", `장비 로그 받기 실패: ${result.reason}`);
  } finally {
    btn.disabled = false;
  }
});

// ── 화면 전환 ─────────────────────────────────────────
let view = "queue";

function setView(next) {
  view = next;
  const connected = Boolean(config?.apiKey);
  $("queue-view").hidden = next !== "queue" || !connected;
  $("settings-view").hidden = next !== "settings";
  $("nav-settings").textContent = next === "settings" ? "출력 대기" : "설정";
}

$("nav-settings").addEventListener("click", () => setView(view === "settings" ? "queue" : "settings"));

// ── 인증 ──────────────────────────────────────────────
$("auth-start").addEventListener("click", async () => {
  const tenant = $("tenant").value.trim();
  if (!tenant) return setStatus($("auth-status"), "스토어 주소를 입력하세요.", "err");
  setStatus($("auth-status"), "브라우저에서 승인을 기다리는 중...");
  try {
    const info = await api.auth.start(tenant);
    setStatus($("auth-status"), `브라우저에서 승인해 주세요. 인증 코드: ${info.userCode}`);
  } catch (e) {
    setStatus($("auth-status"), "연결 요청에 실패했습니다: " + (e?.message ?? e), "err");
  }
});

api.auth.onResult(async (r) => {
  if (r.status === "approved") {
    setStatus($("auth-status"), "연결되었습니다.", "ok");
    await loadConfig();
    setView("queue");
  } else {
    setStatus($("auth-status"), "승인 시간이 지났습니다. 다시 시도하세요.", "err");
  }
});

$("reauth").addEventListener("click", async () => {
  await api.auth.cancel();
  await api.config.set({ apiKey: "" });
  await loadConfig();
  setView("queue");
});

// ── 폴링 ──────────────────────────────────────────────
let running = false;

function renderAgentState() {
  $("agent-toggle").textContent = running ? "정지" : "시작";
  $("stat-agent").textContent = running ? "가져오는 중" : "멈춤";
}

$("agent-toggle").addEventListener("click", async () => {
  running = running ? await api.agent.stop() : await api.agent.start();
  renderAgentState();
});

api.agent.onState((s) => {
  running = s.running;
  renderAgentState();
});

// ── 장비 상태 ─────────────────────────────────────────
const DEVICE_LABEL = {
  ready: "준비됨",
  printing: "출력 중",
  standby: "대기",
  init: "초기화 중",
  menu: "메뉴 조작 중",
  error: "오류",
  unknown: "알 수 없음",
};

function renderDevice(status) {
  const el = $("stat-device");
  const stat = el.parentElement;
  if (!status) {
    // 조회를 꺼 뒀는지, 장비가 안 잡히는지를 구분해 준다. 둘은 대응이 다르다
    // (상태 조회는 LAN 연결 장비에서만 된다 — USB 연결이나 꺼진 상태면 오프라인)
    el.textContent = config && !config.deviceStatusEnabled ? "조회 꺼짐" : "오프라인";
    stat.classList.remove("danger");
    return;
  }
  const detail = status.errors.length
    ? ` — ${status.errors[0]}`
    : status.warnings.length
      ? ` — ${status.warnings[0]}`
      : status.currentFile
        ? ` · ${status.currentFile}`
        : "";
  el.textContent = (DEVICE_LABEL[status.state] ?? status.state) + detail;
  stat.classList.toggle("danger", status.state === "error");
}

api.device.onStatus(renderDevice);
api.device.status().then(renderDevice);

// ── 확인 모달 ─────────────────────────────────────────
let confirmResolve = null;

function confirmAsk(title, message, okLabel = "삭제") {
  $("confirm-title").textContent = title;
  $("confirm-message").textContent = message;
  $("confirm-ok").textContent = okLabel;
  $("confirm").hidden = false;
  return new Promise((resolve) => (confirmResolve = resolve));
}

const closeConfirm = (value) => {
  $("confirm").hidden = true;
  confirmResolve?.(value);
  confirmResolve = null;
};

$("confirm-ok").addEventListener("click", () => closeConfirm(true));
$("confirm-cancel").addEventListener("click", () => closeConfirm(false));

// ── 대기 목록 ─────────────────────────────────────────
const items = new Map();
let filter = "ready";

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    filter = tab.dataset.filter;
    for (const t of document.querySelectorAll(".tab")) t.classList.toggle("on", t === tab);
    renderQueue();
  });
}

/** 전송 중은 대기 탭에서 함께 보여준다 — 방금 누른 건이 사라지면 안 된다 */
const groupOf = (item) => (item.status === "printing" ? "ready" : item.status);

function renderStats() {
  const counts = { ready: 0, printing: 0, done: 0, failed: 0 };
  for (const item of items.values()) counts[item.status] = (counts[item.status] ?? 0) + 1;
  $("stat-ready").textContent = counts.ready;
  $("stat-printing").textContent = counts.printing;
  $("stat-done").textContent = counts.done;
  $("stat-failed").textContent = counts.failed;
}

function buildCard(item) {
  const job = item.job;
  const card = document.createElement("div");
  card.className = "job " + item.status;

  // 삭제 — 전송 중과 완료에서는 숨긴다. 전송 중에 지우면 결과를 반영할 대상이 사라진다
  if (item.status === "ready" || item.status === "failed") {
    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "✕";
    del.title = "큐에서 삭제";
    del.addEventListener("click", async () => {
      const ok = await confirmAsk(
        "디자인 삭제",
        `${job.orderNumber} · ${job.wepnpSeqno}\n\n되돌릴 수 없습니다. 잘못 지웠다면 관리자 주문 관리의 재출력으로 다시 보낼 수 있습니다.`
      );
      if (ok) await api.queue.delete(job.id);
    });
    card.appendChild(del);
  }

  if (item.thumbUrl) {
    const img = document.createElement("img");
    img.className = "thumb";
    img.src = item.thumbUrl;
    card.appendChild(img);
  } else {
    const box = document.createElement("div");
    box.className = "thumb no-thumb";
    box.textContent = "🖼";
    card.appendChild(box);
  }

  const title = document.createElement("div");
  title.className = "title";
  title.textContent = job.itemTotal > 1 ? `${job.orderNumber} #${job.itemIndex}/${job.itemTotal}` : job.orderNumber;
  card.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = job.productName + (job.optionName ? ` · ${job.optionName}` : "");
  card.appendChild(meta);

  const chips = document.createElement("div");
  chips.className = "chips";
  if (item.doWorkOrder) chips.appendChild(tag("📄 지시서", "info"));
  if (job.needsPlateChange) chips.appendChild(tag("👶 플레이트 교체", "warn"));
  if (job.quantity > 1) chips.appendChild(tag(`×${job.quantity}`));
  if (chips.childElementCount) card.appendChild(chips);

  // 옷 색을 고른다. 잉크 모드가 여기서 갈린다
  if (item.status === "ready" || item.status === "failed") {
    const ink = document.createElement("div");
    ink.className = "ink";
    ink.appendChild(inkButton("흰옷 출력", "primary", job.id, INK_WHITE_GARMENT));
    ink.appendChild(inkButton("컬러옷 출력", "alt", job.id, INK_COLOR_GARMENT));
    card.appendChild(ink);
  }

  const state = document.createElement("div");
  state.className = "state";
  if (item.status === "printing") state.textContent = "⟳ 전송 중";
  else if (item.status === "failed") {
    state.className = "state err";
    state.textContent = item.errorReason || "전송 실패 · 다시 시도";
  } else if (item.status === "done") {
    state.className = "state ok";
    state.textContent = "✅ 전송 완료";
  }
  if (state.textContent) card.appendChild(state);

  return card;
}

const tag = (text, kind = "") => {
  const el = document.createElement("span");
  el.className = "tag" + (kind ? " " + kind : "");
  el.textContent = text;
  return el;
};

const inkButton = (label, cls, jobId, ink) => {
  const btn = document.createElement("button");
  btn.className = cls;
  btn.textContent = label;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    await api.device.send(jobId, ink);
  });
  return btn;
};

function renderQueue() {
  const box = $("queue");
  box.innerHTML = "";
  for (const item of items.values()) {
    if (groupOf(item) !== filter) continue;
    box.appendChild(buildCard(item));
  }
  renderStats();
}

const upsert = (item) => {
  const prev = items.get(item.job.id);
  // 썸네일은 한 번 만들어 두고 재사용한다. 매번 다시 읽으면 목록이 깜빡인다
  item.thumbUrl = prev?.thumbUrl ?? null;
  items.set(item.job.id, item);
  renderQueue();
};

api.agent.onReady(upsert);
api.agent.onChanged(upsert);
api.agent.onRemoved((jobId) => {
  items.delete(jobId);
  renderQueue();
});

// ── 로그 ──────────────────────────────────────────────
// 메인 프로세스가 밀어주는 것과 화면에서 직접 남기는 것이 같은 상자에 쌓인다
function appendLog(level, message, at = Date.now()) {
  const box = $("log");
  const line = document.createElement("div");
  line.className = level;
  const time = document.createElement("time");
  time.textContent = new Date(at).toLocaleTimeString("ko-KR");
  line.append(time, document.createTextNode(message));
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
  // 오래 켜두면 화면이 무거워진다
  while (box.childElementCount > 300) box.removeChild(box.firstChild);
}

api.onLog((entry) => appendLog(entry.level, entry.message, entry.at));

// ── 업데이트 ──────────────────────────────────────────
function renderUpdate(state) {
  const el = $("update-status");
  $("install").hidden = state.status !== "ready";
  $("check").disabled = state.status === "checking" || state.status === "downloading";

  const text = {
    checking: "확인 중...",
    available: `새 버전 ${state.version} 을 받는 중입니다.`,
    downloading: `받는 중... ${state.percent}%`,
    ready: `새 버전 ${state.version} 준비됨. 재시작하면 적용됩니다.`,
    latest: "최신 버전입니다.",
    error: state.message,
  }[state.status];

  setStatus(el, text ?? "", state.status === "ready" ? "ok" : state.status === "error" ? "err" : "");
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
  for (const item of state.items) upsert(item);
  renderAgentState();
  setView("queue");
})();
