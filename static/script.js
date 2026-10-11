/* ==========================================================
   Loan risk check — front-end logic
   ========================================================== */

/* -------- Settings you may want to change -------- */
const CONFIG = {
  // Leave empty when this page is served by the same FastAPI app (recommended).
  // If the UI is hosted separately, put the API URL here, e.g. "https://my-api.onrender.com"
  // When the page is opened from a file or a dev server (Live Server etc.), it
  // automatically falls back to a local API at http://127.0.0.1:8000.
  API_URL: "",
  LOCAL_API: "http://127.0.0.1:8000",
  CURRENCY: "$",
  // Show a "server is waking up" message if the API takes longer than this (ms).
  SLOW_HINT_AFTER: 6000,
};

/* -------- Example applicants -------- */
const PRESETS = {
  strong: {
    person_age: 38, person_income: 96000, person_home_ownership: "MORTGAGE",
    person_emp_length: 11, loan_intent: "HOMEIMPROVEMENT", loan_grade: "A",
    loan_amnt: 9000, loan_int_rate: 7.4, cb_person_default_on_file: "N",
    cb_person_cred_hist_length: 14,
  },
  typical: {
    person_age: 28, person_income: 55000, person_home_ownership: "RENT",
    person_emp_length: 4, loan_intent: "PERSONAL", loan_grade: "B",
    loan_amnt: 10000, loan_int_rate: 11, cb_person_default_on_file: "N",
    cb_person_cred_hist_length: 5,
  },
  risky: {
    person_age: 23, person_income: 24000, person_home_ownership: "RENT",
    person_emp_length: 1, loan_intent: "DEBTCONSOLIDATION", loan_grade: "F",
    loan_amnt: 15000, loan_int_rate: 19.8, cb_person_default_on_file: "Y",
    cb_person_cred_hist_length: 2,
  },
};

const INTENT_LABELS = {
  PERSONAL: "Personal", EDUCATION: "Education", MEDICAL: "Medical",
  VENTURE: "Business", HOMEIMPROVEMENT: "Home improvement",
  DEBTCONSOLIDATION: "Debt consolidation",
};

function resolveApiBase() {
  if (CONFIG.API_URL) return CONFIG.API_URL.replace(/\/$/, "");
  const { protocol, hostname, port } = window.location;
  const devServerPorts = ["5500", "5501", "5502", "3000", "5173", "4173"];
  const isLocal = ["localhost", "127.0.0.1", ""].includes(hostname);
  if (protocol === "file:" || (isLocal && devServerPorts.includes(port))) return CONFIG.LOCAL_API;
  return ""; // same origin
}
const API_BASE = resolveApiBase();

/* -------- Element handles -------- */
const $ = (id) => document.getElementById(id);
const form = $("form");
const submitBtn = $("submitBtn");
const result = $("result");
const needle = $("needle");
const arcGood = $("arcGood");
const arcBad = $("arcBad");
const cutoffG = $("cutoff");
const cutoffTick = $("cutoffTick");
const cutoffText = $("cutoffText");
const pctEl = $("pct");
const pctLabel = $("pctLabel");
const verdictText = $("verdictText");
const verdictNote = $("verdictNote");
const statProb = $("statProb");
const statCut = $("statCut");
const statGap = $("statGap");
const ratioEl = $("ratio");
const ratioText = $("ratioText");
const ratioFill = $("ratioFill");
const apiStatus = $("apiStatus");
const apiStatusText = $("apiStatusText");
const ticksG = $("ticks");
const historySection = $("history");
const historyList = $("historyList");

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ==========================================================
   Gauge geometry
   Centre (160,170). Needle sweeps from -90deg (0%) to +90deg (100%).
   ========================================================== */
const CX = 160, CY = 170;
const angleFor = (p) => -90 + Math.max(0, Math.min(1, p)) * 180;

function setNeedle(p) {
  needle.setAttribute("transform", `rotate(${angleFor(p)} ${CX} ${CY})`);
}

function placeCutoff(t) {
  const a = (angleFor(t) * Math.PI) / 180;           // angle from vertical
  const point = (r) => [CX + r * Math.sin(a), CY - r * Math.cos(a)];
  const [x1, y1] = point(104);
  const [x2, y2] = point(138);
  const [tx, ty] = point(172);
  cutoffTick.setAttribute("x1", x1); cutoffTick.setAttribute("y1", y1);
  cutoffTick.setAttribute("x2", x2); cutoffTick.setAttribute("y2", y2);
  cutoffText.setAttribute("x", tx);
  cutoffText.setAttribute("y", ty + 4);
  cutoffText.textContent = `cutoff ${(t * 100).toFixed(0)}%`;
  cutoffG.setAttribute("opacity", "1");
}

function setZones(t) {
  const cut = Math.max(0, Math.min(1, t)) * 100;
  arcGood.style.strokeDasharray = `${cut} 100`;
  arcBad.style.strokeDasharray = `${100 - cut} 100`;
  arcBad.style.strokeDashoffset = `${-cut}`;
}

/* ==========================================================
   Tiny animation helpers
   ========================================================== */
const easeOutBack = (x) => {
  const c1 = 1.35, c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};
const easeInOut = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

let needleP = 0;           // current needle position (0..1)
let animToken = 0;         // cancels older animations

function tween({ from, to, duration, ease = easeOutBack, onUpdate }) {
  const token = ++animToken;
  if (reduceMotion) {
    onUpdate(to);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const start = performance.now();
    function frame(now) {
      if (token !== animToken) return resolve();
      const k = Math.min(1, (now - start) / duration);
      onUpdate(from + (to - from) * ease(k));
      if (k < 1) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });
}

function moveNeedle(to, duration = 1100, ease = easeOutBack) {
  const from = needleP;
  return tween({
    from, to, duration, ease,
    onUpdate: (v) => { needleP = v; setNeedle(v); },
  });
}

/* "Scanning" wobble while waiting for the API */
let scanning = false;
function startScan() {
  scanning = true;
  const token = ++animToken;
  if (reduceMotion) return;
  const t0 = performance.now();
  (function frame(now) {
    if (!scanning || token !== animToken) return;
    needleP = 0.5 + 0.38 * Math.sin((now - t0) / 260);
    setNeedle(needleP);
    requestAnimationFrame(frame);
  })(t0);
}
function stopScan() { scanning = false; }

/* Count the big percentage up in step with the needle */
function countTo(target, duration = 1100) {
  const from = parseFloat(pctEl.dataset.value || "0");
  if (reduceMotion) {
    pctEl.textContent = `${target.toFixed(1)}%`;
    pctEl.dataset.value = target;
    return;
  }
  const start = performance.now();
  (function frame(now) {
    const k = Math.min(1, (now - start) / duration);
    const v = from + (target - from) * (1 - Math.pow(1 - k, 3));
    pctEl.textContent = `${v.toFixed(1)}%`;
    pctEl.dataset.value = v;
    if (k < 1) requestAnimationFrame(frame);
  })(start);
}

/* Instrument ticks around the arc, every 5% (major every 25%) */
function buildTicks() {
  const NS = "http://www.w3.org/2000/svg";
  for (let i = 0; i <= 20; i++) {
    const a = (angleFor(i / 20) * Math.PI) / 180;
    const major = i % 5 === 0;
    const r1 = 141, r2 = major ? 154 : 148;
    const line = document.createElementNS(NS, "line");
    line.setAttribute("x1", CX + r1 * Math.sin(a));
    line.setAttribute("y1", CY - r1 * Math.cos(a));
    line.setAttribute("x2", CX + r2 * Math.sin(a));
    line.setAttribute("y2", CY - r2 * Math.cos(a));
    if (major) line.setAttribute("class", "major");
    line.style.animationDelay = `${0.5 + i * 0.035}s`;
    ticksG.appendChild(line);
  }
}

/* Count a stat cell up to its value */
function countText(el, to, format, duration = 1100) {
  if (reduceMotion) { el.textContent = format(to); return; }
  const start = performance.now();
  (function frame(now) {
    const k = Math.min(1, (now - start) / duration);
    el.textContent = format(to * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(frame);
  })(start);
}

/* ==========================================================
   API connection chip (also wakes a sleeping Render server)
   ========================================================== */
const STATUS_TEXT = {
  checking: "Connecting to API…",
  waking: "Waking the server… this can take a minute",
  online: "API online",
  offline: "API unreachable · click to retry",
};
function setApiStatus(state) {
  apiStatus.dataset.state = state;
  apiStatusText.textContent = STATUS_TEXT[state];
}
async function pingApi() {
  setApiStatus("checking");
  const timer = setTimeout(() => setApiStatus("waking"), 3500);
  try {
    // Any HTTP response means the server is reachable, even a 404.
    await fetch(`${API_BASE}/health`, { method: "GET" });
    setApiStatus("online");
  } catch (_) {
    setApiStatus("offline");
  } finally {
    clearTimeout(timer);
  }
}
apiStatus.addEventListener("click", pingApi);

/* ==========================================================
   Page-load moment: one sweep of the needle
   ========================================================== */
async function introSweep() {
  await moveNeedle(1, 850, easeInOut);
  await moveNeedle(0, 750, easeInOut);
}

/* ==========================================================
   Form helpers
   ========================================================== */
const fmtMoney = (n) =>
  CONFIG.CURRENCY + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });

function fillForm(values) {
  Object.entries(values).forEach(([name, val]) => {
    const radios = form.querySelectorAll(`input[type="radio"][name="${name}"]`);
    if (radios.length) {
      radios.forEach((r) => { r.checked = r.value === String(val); });
    } else if (form.elements[name]) {
      form.elements[name].value = val;
    }
  });
  clearErrors();
  updateRatio();
  // Flash every control so the person can see what changed.
  form.querySelectorAll(".control, .seg").forEach((el, i) => {
    el.classList.remove("flash");
    void el.offsetWidth;
    el.style.animationDelay = `${i * 35}ms`;
    el.classList.add("flash");
  });
}

function readForm() {
  const f = new FormData(form);
  const num = (k) => parseFloat(f.get(k));
  const int = (k) => parseInt(f.get(k), 10);
  const income = num("person_income");
  const amount = num("loan_amnt");
  return {
    person_age: int("person_age"),
    person_income: income,
    person_home_ownership: f.get("person_home_ownership"),
    person_emp_length: num("person_emp_length"),
    loan_intent: f.get("loan_intent"),
    loan_grade: f.get("loan_grade"),
    loan_amnt: amount,
    loan_int_rate: num("loan_int_rate"),
    // The model expects the loan-to-income ratio, so it is calculated here.
    loan_percent_income: Math.round((amount / income) * 100) / 100,
    cb_person_default_on_file: f.get("cb_person_default_on_file"),
    cb_person_cred_hist_length: int("cb_person_cred_hist_length"),
  };
}

function updateRatio() {
  const income = parseFloat(form.person_income.value);
  const amount = parseFloat(form.loan_amnt.value);
  if (income > 0 && amount > 0) {
    const ratio = amount / income;
    const heavy = ratio >= 0.4;
    ratioText.innerHTML =
      `The loan is <strong>${(ratio * 100).toFixed(0)}%</strong> of annual income.` +
      (heavy ? " That is a heavy load relative to income." : "");
    ratioEl.dataset.level = heavy ? "high" : "ok";
    const fill = Math.min(1, ratio / 0.8);              // bar is full at 80% of income
    ratioFill.style.width = `${fill * 100}%`;
    ratioFill.style.backgroundPosition = `${fill * 100}% 0`;
  } else {
    ratioText.textContent = "Enter income and loan amount to see the loan-to-income ratio.";
    ratioEl.dataset.level = "";
    ratioFill.style.width = "0";
  }
}

/* ---------- Validation ---------- */
function messageFor(input) {
  const v = input.validity;
  if (v.valueMissing) return "Enter a value.";
  if (v.badInput) return "Enter a number.";
  if (v.rangeUnderflow || v.rangeOverflow) {
    const min = input.min !== "" ? input.min : null;
    const max = input.max !== "" ? input.max : null;
    if (min !== null && max !== null) return `Enter a value from ${min} to ${max}.`;
    if (min !== null) return `Enter a value of ${min} or more.`;
    return `Enter a value of ${max} or less.`;
  }
  if (v.stepMismatch) return "Enter a whole number.";
  return input.validationMessage;
}

function clearErrors() {
  form.querySelectorAll(".field.invalid").forEach((f) => f.classList.remove("invalid"));
  form.querySelectorAll(".err").forEach((e) => (e.textContent = ""));
}

function validate() {
  clearErrors();
  let firstBad = null;

  form.querySelectorAll("input[type='number']").forEach((input) => {
    if (!input.checkValidity()) {
      const field = input.closest(".field");
      field.classList.add("invalid");
      const err = form.querySelector(`.err[data-for="${input.name}"]`);
      if (err) err.textContent = messageFor(input);
      firstBad = firstBad || input;
    }
  });

  ["person_home_ownership", "loan_grade", "cb_person_default_on_file"].forEach((name) => {
    const radios = form.querySelectorAll(`input[name="${name}"]`);
    if (![...radios].some((r) => r.checked)) {
      radios[0].closest(".field").classList.add("invalid");
      firstBad = firstBad || radios[0];
    }
  });

  if (firstBad) {
    firstBad.focus({ preventScroll: false });
    return false;
  }
  return true;
}

/* ==========================================================
   Result panel states
   ========================================================== */
function setState(state, { label, note } = {}) {
  result.dataset.state = state;
  result.classList.remove("landed");
  if (label) verdictText.textContent = label;
  if (note !== undefined) verdictNote.textContent = note;
}

function showResult(payload, data) {
  const p = Number(data.default_probability);
  const t = Number(data.threshold);
  const high = Number(data.default_prediction) === 1;
  const gap = Math.abs(p - t) * 100;

  setZones(t);
  placeCutoff(t);

  moveNeedle(p, 1300, easeOutBack);
  countTo(p * 100, 1300);
  pctLabel.textContent = "Default probability";

  setState(high ? "high" : "low", {
    label: data.result || (high ? "High risk" : "Low risk"),
    note: high
      ? `The probability is ${gap.toFixed(1)} points above the model's cutoff, so this loan is flagged as high risk.`
      : `The probability is ${gap.toFixed(1)} points below the model's cutoff, so this loan is not flagged.`,
  });
  // Re-trigger the little "land" animation on the verdict pill.
  void result.offsetWidth;
  result.classList.add("landed");

  countText(statProb, p * 100, (v) => `${v.toFixed(1)}%`);
  countText(statCut, t * 100, (v) => `${v.toFixed(1)}%`);
  countText(statGap, gap, (v) => `${high ? "+" : "−"}${v.toFixed(1)} pts`);

  addHistory(payload, p, high);
}

function showError(message) {
  moveNeedle(0, 600, easeInOut);
  pctEl.textContent = "—";
  pctEl.dataset.value = 0;
  setState("error", { label: "Couldn't check", note: message });
}

/* ---------- Recent checks ---------- */
const history = [];

function addHistory(payload, p, high) {
  history.unshift({ payload, p, high });
  if (history.length > 5) history.pop();
  renderHistory();
}

function renderHistory() {
  historySection.hidden = history.length === 0;
  historyList.innerHTML = "";
  history.forEach((item, i) => {
    const li = document.createElement("li");
    li.style.setProperty("--i", i);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = item.high ? "high" : "low";
    btn.setAttribute("aria-label", `Load check ${i + 1} back into the form`);
    btn.innerHTML =
      `<span class="h-dot"></span>` +
      `<span class="h-main">${fmtMoney(item.payload.loan_amnt)} <span class="h-sub">· ${
        INTENT_LABELS[item.payload.loan_intent] || item.payload.loan_intent
      } · grade ${item.payload.loan_grade}</span></span>` +
      `<span class="h-pct">${(item.p * 100).toFixed(1)}%</span>`;
    btn.addEventListener("click", () => {
      fillForm(item.payload);
      form.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    });
    li.appendChild(btn);
    historyList.appendChild(li);
  });
}

/* ==========================================================
   API call
   ========================================================== */
async function callApi(payload) {
  const res = await fetch(`${API_BASE}/predict`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      if (Array.isArray(body.detail)) {
        detail = body.detail
          .map((d) => `${(d.loc || []).slice(1).join(".")}: ${d.msg}`)
          .join("; ");
      } else if (typeof body.detail === "string") {
        detail = body.detail;
      }
    } catch (_) { /* response was not JSON */ }

    const err = new Error(detail || `The server returned an error (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/* ==========================================================
   Events
   ========================================================== */
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!validate()) return;

  const payload = readForm();

  submitBtn.disabled = true;
  submitBtn.classList.add("loading");
  setState("loading", { label: "Checking…", note: "Sending the application to the model." });
  pctEl.textContent = "…";
  pctEl.dataset.value = 0;
  statProb.textContent = statCut.textContent = statGap.textContent = "—";
  startScan();

  if (window.matchMedia("(max-width: 960px)").matches) {
    result.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  }

  const slowTimer = setTimeout(() => {
    verdictNote.textContent =
      "Still working. On free hosting the server can take up to a minute to wake up after being idle.";
  }, CONFIG.SLOW_HINT_AFTER);

  const minWait = new Promise((r) => setTimeout(r, reduceMotion ? 0 : 900));

  try {
    const [data] = await Promise.all([callApi(payload), minWait]);
    stopScan();
    showResult(payload, data);
  } catch (err) {
    await minWait;
    stopScan();
    const offline = err instanceof TypeError;
    if (offline) setApiStatus("offline");
    const where = API_BASE || window.location.origin;
    showError(
      offline
        ? `Couldn't reach the API at ${where}. Make sure the server is running (uvicorn main:app --reload), or set API_URL in script.js.`
        : `${err.message} Check the values and try again.`
    );
  } finally {
    clearTimeout(slowTimer);
    submitBtn.disabled = false;
    submitBtn.classList.remove("loading");
  }
});

document.querySelectorAll("[data-preset]").forEach((btn) => {
  btn.addEventListener("click", () => fillForm(PRESETS[btn.dataset.preset]));
});

["person_income", "loan_amnt"].forEach((name) =>
  form.elements[name].addEventListener("input", updateRatio)
);

// Clear a field's error as soon as the person edits it.
form.addEventListener("input", (e) => {
  const field = e.target.closest(".field");
  if (field && field.classList.contains("invalid")) {
    field.classList.remove("invalid");
    const err = field.querySelector(".err");
    if (err) err.textContent = "";
  }
});

/* ==========================================================
   Init
   ========================================================== */
/* Click ripple on the main button */
submitBtn.addEventListener("pointerdown", (e) => {
  if (reduceMotion || submitBtn.disabled) return;
  const rect = submitBtn.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height) * 2;
  const dot = document.createElement("span");
  dot.className = "ripple-dot";
  dot.style.width = dot.style.height = `${size}px`;
  dot.style.left = `${e.clientX - rect.left - size / 2}px`;
  dot.style.top = `${e.clientY - rect.top - size / 2}px`;
  submitBtn.appendChild(dot);
  dot.addEventListener("animationend", () => dot.remove());
});

/* Soft light on the result panel that follows the cursor */
result.addEventListener("pointermove", (e) => {
  const r = result.getBoundingClientRect();
  result.style.setProperty("--mx", `${e.clientX - r.left}px`);
  result.style.setProperty("--my", `${e.clientY - r.top}px`);
});

document.querySelectorAll("[data-currency]").forEach((el) => (el.textContent = CONFIG.CURRENCY));
buildTicks();
fillForm(PRESETS.typical);
setNeedle(0);
setTimeout(introSweep, 700);   // let the page entrance finish first
pingApi();
