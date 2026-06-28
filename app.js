// ─── Inline Web Worker (blob URL — works with file:// protocol) ───────────────
const WORKER_CODE = `
self.onmessage = function(e) {
  const { assets, covMatrix, simCount, rf } = e.data;
  const portfolios = [];
  let maxSharpe = null, minVol = null;
  const step = Math.max(1, Math.floor(simCount / 50));

  for (let s = 0; s < simCount; s++) {
    const raw = assets.map(() => Math.random());
    const sum = raw.reduce((a, b) => a + b, 0);
    const weights = {};
    assets.forEach((a, i) => { weights[a.ticker] = raw[i] / sum; });

    let ret = 0;
    assets.forEach(a => { ret += weights[a.ticker] * (a.expectedReturn / 100); });

    let variance = 0;
    assets.forEach(a => {
      assets.forEach(b => {
        variance += weights[a.ticker] * weights[b.ticker] * covMatrix[a.ticker][b.ticker];
      });
    });

    const vol = Math.sqrt(variance);
    const sharpe = (ret - rf) / vol;
    const p = { weights, expectedReturn: ret, volatility: vol, sharpeRatio: sharpe };
    portfolios.push(p);

    if (!maxSharpe || sharpe > maxSharpe.sharpeRatio) maxSharpe = p;
    if (!minVol   || vol   < minVol.volatility)       minVol   = p;

    if (s % step === 0) self.postMessage({ type: 'progress', pct: Math.round(s / simCount * 100) });
  }

  self.postMessage({ type: 'done', portfolios, maxSharpe, minVol });
};
`;

// ─── Global state ──────────────────────────────────────────────────────────────
let assets = [
  { id: "AAPL", ticker: "AAPL", expectedReturn: 16.5, volatility: 21.0 },
  { id: "NVDA", ticker: "NVDA", expectedReturn: 38.0, volatility: 42.0 },
  { id: "META", ticker: "META", expectedReturn: 22.0, volatility: 29.5 },
  { id: "AMZN", ticker: "AMZN", expectedReturn: 18.2, volatility: 24.0 },
  { id: "TSLA", ticker: "TSLA", expectedReturn: 26.0, volatility: 45.0 },
];

let baseCorrelation = {
  AAPL: { AAPL: 1.0, NVDA: 0.45, META: 0.4,  AMZN: 0.5,  TSLA: 0.35 },
  NVDA: { AAPL: 0.45, NVDA: 1.0, META: 0.38, AMZN: 0.42, TSLA: 0.4  },
  META: { AAPL: 0.4,  NVDA: 0.38, META: 1.0, AMZN: 0.48, TSLA: 0.3  },
  AMZN: { AAPL: 0.5,  NVDA: 0.42, META: 0.48, AMZN: 1.0, TSLA: 0.32 },
  TSLA: { AAPL: 0.35, NVDA: 0.4,  META: 0.3,  AMZN: 0.32, TSLA: 1.0 },
};

// Raw price history keyed by ticker: [{ date: 'YYYY-MM-DD', price: number }]
let rawStockData = {};

let simulatedPortfolios = [];
let maxSharpePortfolio  = null;
let minVolPortfolio     = null;
let selectedDoughnutMode = "maxSharpe";
let scatterChartInstance = null;
let doughnutChartInstance = null;
let simWorker = null;

// ─── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  loadSavedData();
  renderAssetTable();
  runSimulation();
});

// ─── Save / Load (localStorage) ────────────────────────────────────────────────
const SAVE_KEY = "frontierquant_saved_state_v1";

function saveCurrentData() {
  try {
    const state = {
      assets,
      baseCorrelation,
      rawStockData,
      investAmount: document.getElementById("investAmount").value,
      riskFreeRate: document.getElementById("riskFreeRate").value,
      simCount: document.getElementById("simCount").value,
      dateStart: document.getElementById("dateStart").value || null,
      dateEnd: document.getElementById("dateEnd").value || null,
      dateRangeVisible: !document.getElementById("dateRangePanel").classList.contains("hidden"),
      savedAt: new Date().toISOString(),
    };
    localStorage.setItem(SAVE_KEY, JSON.stringify(state));
    showSaveStatus(`已儲存 ${new Date().toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" })}`);
  } catch (err) {
    console.error("儲存失敗:", err);
    showSaveStatus("儲存失敗", true);
  }
}

function loadSavedData() {
  let raw;
  try {
    raw = localStorage.getItem(SAVE_KEY);
  } catch (err) {
    console.error("讀取儲存資料失敗:", err);
    return;
  }
  if (!raw) return;

  try {
    const state = JSON.parse(raw);
    if (Array.isArray(state.assets) && state.assets.length >= 2) {
      assets = state.assets;
    }
    if (state.baseCorrelation) baseCorrelation = state.baseCorrelation;
    if (state.rawStockData) rawStockData = state.rawStockData;

    if (state.investAmount) document.getElementById("investAmount").value = state.investAmount;
    if (state.riskFreeRate) {
      document.getElementById("riskFreeRate").value = state.riskFreeRate;
      updateRfValue();
    }
    if (state.simCount) document.getElementById("simCount").value = state.simCount;

    if (Object.keys(rawStockData).length > 0) {
      const allDates = Object.values(rawStockData).flatMap(arr => arr.map(e => e.date)).sort();
      const minDate = allDates[0], maxDate = allDates[allDates.length - 1];
      const startInput = document.getElementById("dateStart");
      const endInput   = document.getElementById("dateEnd");
      startInput.min = minDate; startInput.max = maxDate;
      endInput.min   = minDate; endInput.max   = maxDate;
      startInput.value = state.dateStart || minDate;
      endInput.value   = state.dateEnd   || maxDate;
      if (state.dateRangeVisible) document.getElementById("dateRangePanel").classList.remove("hidden");
    }

    if (state.savedAt) {
      const t = new Date(state.savedAt);
      showSaveStatus(`已還原上次儲存 (${t.toLocaleString("zh-TW", { hour: "2-digit", minute: "2-digit", month: "numeric", day: "numeric" })})`);
    }
  } catch (err) {
    console.error("解析儲存資料失敗:", err);
  }
}

function showSaveStatus(text, isError = false) {
  const el = document.getElementById("saveStatusText");
  if (!el) return;
  el.innerText = text;
  el.classList.remove("hidden", "text-emerald-400", "text-rose-400");
  el.classList.add(isError ? "text-rose-400" : "text-emerald-400");
  clearTimeout(showSaveStatus._t);
  showSaveStatus._t = setTimeout(() => el.classList.add("hidden"), 4000);
}

// ─── Reset ─────────────────────────────────────────────────────────────────────
function resetToDefaults() {
  rawStockData = {};
  assets = [
    { id: "AAPL", ticker: "AAPL", expectedReturn: 16.5, volatility: 21.0 },
    { id: "NVDA", ticker: "NVDA", expectedReturn: 38.0, volatility: 42.0 },
    { id: "META", ticker: "META", expectedReturn: 22.0, volatility: 29.5 },
    { id: "AMZN", ticker: "AMZN", expectedReturn: 18.2, volatility: 24.0 },
    { id: "TSLA", ticker: "TSLA", expectedReturn: 26.0, volatility: 45.0 },
  ];
  baseCorrelation = {
    AAPL: { AAPL: 1.0, NVDA: 0.45, META: 0.4,  AMZN: 0.5,  TSLA: 0.35 },
    NVDA: { AAPL: 0.45, NVDA: 1.0, META: 0.38, AMZN: 0.42, TSLA: 0.4  },
    META: { AAPL: 0.4,  NVDA: 0.38, META: 1.0, AMZN: 0.48, TSLA: 0.3  },
    AMZN: { AAPL: 0.5,  NVDA: 0.42, META: 0.48, AMZN: 1.0, TSLA: 0.32 },
    TSLA: { AAPL: 0.35, NVDA: 0.4,  META: 0.3,  AMZN: 0.32, TSLA: 1.0 },
  };
  document.getElementById("dateRangePanel").classList.add("hidden");
  renderAssetTable();
  runSimulation();
}

// ─── Excel import ──────────────────────────────────────────────────────────────
function triggerXlsxImport() {
  document.getElementById("xlsxFileInput").value = "";
  document.getElementById("xlsxFileInput").click();
}

async function handleXlsxFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });

  const newRawData = {};
  const skipSheetNames = ["BUTTON", "按鈕", "SETTINGS", "設定"];

  for (const sheetName of workbook.SheetNames) {
    if (skipSheetNames.some(s => sheetName.trim().toUpperCase() === s.toUpperCase())) continue;

    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true });
    if (!rows || rows.length === 0) continue;

    // Format A: wide layout — repeating "股票代號" labels across columns (e.g. 抓股價.xlsm DATA sheet)
    const isFormatA = (rows[0] || []).some(cell => typeof cell === "string" && cell.trim() === "股票代號");

    if (isFormatA) {
      parseFormatASheet(rows, newRawData);
    } else {
      // Format B: legacy layout — one sheet per ticker, col 0 = date, col 1 = close price
      const ticker = sheetName.trim().toUpperCase();
      const entries = rows.slice(1)
        .map(r => ({ date: parseExcelDate(r[0]), price: parseFloat(r[1]) }))
        .filter(e => e.date && !isNaN(e.price) && e.price > 0);
      if (entries.length >= 2) newRawData[ticker] = entries;
    }
  }

  if (Object.keys(newRawData).length < 2) {
    alert("至少需要 2 檔有效股票資料（每股票格式：日期欄 + 收盤價欄；支援「股票代號」寬版並排格式，或每股票一張工作表的舊格式）。");
    return;
  }

  rawStockData = newRawData;

  // Determine overall date range across all stocks
  const allDates = Object.values(rawStockData).flatMap(arr => arr.map(e => e.date)).sort();
  const minDate  = allDates[0];
  const maxDate  = allDates[allDates.length - 1];

  const startInput = document.getElementById("dateStart");
  const endInput   = document.getElementById("dateEnd");
  startInput.min = minDate; startInput.max = maxDate; startInput.value = minDate;
  endInput.min   = minDate; endInput.max   = maxDate; endInput.value   = maxDate;

  document.getElementById("dateRangePanel").classList.remove("hidden");

  recalculateFromRawData();
}

// Parse the wide "股票代號" block layout: every block is [label/date col][ticker/price col][blank spacer]
// Row 0 = "股票代號" labels + ticker names, Row 1 = "日期"/"收盤價" headers, Row 2 = blank, Row 3+ = data
function parseFormatASheet(rows, target) {
  const labelRow = rows[0] || [];
  let maxCols = 0;
  rows.forEach(r => { if (r && r.length > maxCols) maxCols = r.length; });

  for (let col = 0; col < maxCols; col++) {
    if (!(typeof labelRow[col] === "string" && labelRow[col].trim() === "股票代號")) continue;

    const tickerCol = col + 1;
    const tickerRaw = labelRow[tickerCol];
    const ticker = (tickerRaw === undefined || tickerRaw === null) ? "" : tickerRaw.toString().trim().toUpperCase();
    if (!ticker) continue;

    const entries = [];
    for (let r = 3; r < rows.length; r++) {
      const row = rows[r];
      if (!row) continue;
      const date  = parseExcelDate(row[col]);
      const price = parseFloat(row[tickerCol]);
      if (date && !isNaN(price) && price > 0) entries.push({ date, price });
    }

    if (entries.length >= 2) {
      // If the same ticker appears in multiple blocks/sheets, keep the longer series
      if (!target[ticker] || entries.length > target[ticker].length) {
        target[ticker] = entries;
      }
    }
  }
}

function onDateRangeChange() {
  if (Object.keys(rawStockData).length === 0) return;
  recalculateFromRawData();
}

function recalculateFromRawData() {
  const start = document.getElementById("dateStart").value;
  const end   = document.getElementById("dateEnd").value;

  const dailyReturns = {};
  const newAssets    = [];

  for (const [ticker, entries] of Object.entries(rawStockData)) {
    const filtered = entries.filter(e => e.date >= start && e.date <= end);
    if (filtered.length < 2) continue;

    const prices  = filtered.map(e => e.price);
    const returns = [];
    for (let i = 1; i < prices.length; i++) {
      returns.push(Math.log(prices[i] / prices[i - 1]));
    }
    dailyReturns[ticker] = returns;

    const n        = returns.length;
    const mean     = returns.reduce((s, r) => s + r, 0) / n;
    const annRet   = parseFloat((mean * 252 * 100).toFixed(1));
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
    const annVol   = parseFloat((Math.sqrt(variance * 252) * 100).toFixed(1));

    newAssets.push({ id: ticker, ticker, expectedReturn: annRet, volatility: annVol });
  }

  if (newAssets.length < 2) {
    alert("所選日期範圍內數據不足，請拉大範圍。");
    return;
  }

  // Build real correlation matrix from filtered price history
  const newCorr = {};
  newAssets.forEach(a => {
    newCorr[a.ticker] = {};
    newAssets.forEach(b => {
      newCorr[a.ticker][b.ticker] = pearsonCorr(dailyReturns[a.ticker], dailyReturns[b.ticker]);
    });
  });

  assets         = newAssets;
  baseCorrelation = newCorr;
  renderAssetTable();
  runSimulation();
}

// Convert Excel date serial (e.g. 45831.66) or date string to 'YYYY-MM-DD'
function parseExcelDate(raw) {
  const num = parseFloat(raw);
  if (!isNaN(num) && num > 1000) {
    const days = Math.floor(num);
    const ms   = (days - 25569) * 86400 * 1000;
    const d    = new Date(ms);
    const y    = d.getUTCFullYear();
    const m    = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day  = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  const d = new Date(raw);
  return isNaN(d) ? null : d.toISOString().split("T")[0];
}

function pearsonCorr(a, b) {
  const n    = Math.min(a.length, b.length);
  const mA   = a.slice(0, n).reduce((s, x) => s + x, 0) / n;
  const mB   = b.slice(0, n).reduce((s, x) => s + x, 0) / n;
  let num = 0, dA = 0, dB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - mA, db = b[i] - mB;
    num += da * db; dA += da * da; dB += db * db;
  }
  return dA && dB ? num / Math.sqrt(dA * dB) : 0;
}

// ─── Utilities ─────────────────────────────────────────────────────────────────
const currencyFormatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function getInvestmentAmount() {
  const val = parseFloat(document.getElementById("investAmount").value);
  return isNaN(val) || val <= 0 ? 10000 : val;
}
function updateInvestmentAmount() { updateDoughnutChart(); renderComparisonTable(); }
function updateRfValue() {
  document.getElementById("rfValue").innerText = document.getElementById("riskFreeRate").value + "%";
}

// ─── Asset table ───────────────────────────────────────────────────────────────
function renderAssetTable() {
  document.getElementById("assetTableBody").innerHTML = assets.map(asset => `
    <tr class="hover:bg-slate-900/30">
      <td class="py-2.5 font-bold text-white uppercase">${asset.ticker}</td>
      <td class="py-2.5">
        <div class="flex items-center space-x-1">
          <input type="number" step="0.5" value="${asset.expectedReturn}"
            onchange="updateAssetParam('${asset.id}','expectedReturn',this.value)"
            class="w-14 bg-slate-900 border border-slate-700 text-white rounded p-0.5 text-center text-xs">
          <span>%</span>
        </div>
      </td>
      <td class="py-2.5">
        <div class="flex items-center space-x-1">
          <input type="number" step="0.5" value="${asset.volatility}"
            onchange="updateAssetParam('${asset.id}','volatility',this.value)"
            class="w-14 bg-slate-900 border border-slate-700 text-white rounded p-0.5 text-center text-xs">
          <span>%</span>
        </div>
      </td>
      <td class="py-2.5 text-center">
        <button onclick="deleteAsset('${asset.id}')" class="text-rose-500 hover:text-rose-400 transition">
          <i class="fa-regular fa-trash-can"></i>
        </button>
      </td>
    </tr>
  `).join("");
}

function updateAssetParam(id, field, value) {
  const a = assets.find(a => a.id === id);
  if (a) a[field] = parseFloat(value) || 0;
  updateCorrelationHeatmap();
}

function deleteAsset(id) {
  if (assets.length <= 2) { alert("投資組合至少需包含 2 檔股票！"); return; }
  assets = assets.filter(a => a.id !== id);
  renderAssetTable();
  runSimulation();
}

// ─── Manual add modal ──────────────────────────────────────────────────────────
function openAddAssetModal() {
  document.getElementById("addAssetModal").classList.remove("hidden");
  document.getElementById("modalError").classList.add("hidden");
  document.getElementById("modalTicker").value = "";
  document.getElementById("modalReturn").value = "";
  document.getElementById("modalVol").value    = "";
}
function closeModal() { document.getElementById("addAssetModal").classList.add("hidden"); }
function showModalError(msg) {
  document.getElementById("modalErrorText").innerText = msg;
  document.getElementById("modalError").classList.remove("hidden");
}
function submitNewAsset() {
  const ticker = document.getElementById("modalTicker").value.trim().toUpperCase();
  const ret    = parseFloat(document.getElementById("modalReturn").value);
  const vol    = parseFloat(document.getElementById("modalVol").value);
  if (!ticker)             { showModalError("請填寫股票代號！"); return; }
  if (isNaN(ret)||isNaN(vol)) { showModalError("預期報酬與波動度不可空白！"); return; }
  if (assets.some(a => a.ticker === ticker)) { showModalError("此股票代號已存在！"); return; }

  assets.push({ id: ticker, ticker, expectedReturn: ret, volatility: vol });
  baseCorrelation[ticker] = { [ticker]: 1.0 };
  assets.forEach(a => {
    if (a.ticker !== ticker) {
      baseCorrelation[ticker][a.ticker] = 0.35;
      if (!baseCorrelation[a.ticker]) baseCorrelation[a.ticker] = {};
      baseCorrelation[a.ticker][ticker] = 0.35;
    }
  });
  closeModal();
  renderAssetTable();
  runSimulation();
}

// ─── Simulation (Web Worker) ───────────────────────────────────────────────────
function runSimulation() {
  if (simWorker) { simWorker.terminate(); simWorker = null; }

  const simCount = parseInt(document.getElementById("simCount").value);
  const rf       = parseFloat(document.getElementById("riskFreeRate").value) / 100;

  const covMatrix = {};
  assets.forEach(a => {
    covMatrix[a.ticker] = {};
    assets.forEach(b => {
      const corr = baseCorrelation[a.ticker]?.[b.ticker] ?? (a.ticker === b.ticker ? 1.0 : 0.35);
      covMatrix[a.ticker][b.ticker] = corr * (a.volatility / 100) * (b.volatility / 100);
    });
  });

  const blob      = new Blob([WORKER_CODE], { type: "application/javascript" });
  const workerUrl = URL.createObjectURL(blob);
  simWorker       = new Worker(workerUrl);

  setSimulationLoading(true);

  simWorker.onmessage = function(e) {
    if (e.data.type === "progress") {
      updateProgressBar(e.data.pct);
    } else if (e.data.type === "done") {
      URL.revokeObjectURL(workerUrl);
      simWorker             = null;
      simulatedPortfolios   = e.data.portfolios;
      maxSharpePortfolio    = e.data.maxSharpe;
      minVolPortfolio       = e.data.minVol;
      setSimulationLoading(false);
      updateKPIs();
      renderComparisonTable();
      updateCorrelationHeatmap();
      renderCharts();
    }
  };

  simWorker.postMessage({ assets, covMatrix, simCount, rf });
}

function setSimulationLoading(loading) {
  const btn      = document.getElementById("runSimBtn");
  const bar      = document.getElementById("simProgressWrap");
  if (loading) {
    btn.disabled  = true;
    btn.innerHTML = '<i class="fa-solid fa-circle-notch animate-spin mr-1.5"></i> 計算中...';
    btn.classList.add("opacity-60", "cursor-not-allowed");
    bar.classList.remove("hidden");
  } else {
    btn.disabled  = false;
    btn.innerHTML = '<i class="fa-solid fa-play mr-1.5"></i> 開始計算';
    btn.classList.remove("opacity-60", "cursor-not-allowed");
    bar.classList.add("hidden");
    updateProgressBar(0);
  }
}

function updateProgressBar(pct) {
  document.getElementById("simProgressBar").style.width = pct + "%";
  document.getElementById("simProgressText").innerText  = pct < 100 ? `模擬中… ${pct}%` : "完成！";
}

// ─── KPI cards ─────────────────────────────────────────────────────────────────
function updateKPIs() {
  document.getElementById("msSharpe").innerText = maxSharpePortfolio.sharpeRatio.toFixed(3);
  document.getElementById("msReturn").innerText = (maxSharpePortfolio.expectedReturn * 100).toFixed(1) + "%";
  document.getElementById("msVol").innerText    = (maxSharpePortfolio.volatility * 100).toFixed(1) + "%";
  document.getElementById("gmvVol").innerText   = (minVolPortfolio.volatility * 100).toFixed(1) + "%";
  document.getElementById("gmvReturn").innerText= (minVolPortfolio.expectedReturn * 100).toFixed(1) + "%";
  document.getElementById("gmvSharpe").innerText= minVolPortfolio.sharpeRatio.toFixed(3);
}

// ─── Comparison table ──────────────────────────────────────────────────────────
function renderComparisonTable() {
  const total = getInvestmentAmount();
  const fmt   = (p, cls) => Object.entries(p.weights)
    .map(([t, w]) => `${t}: <span class="font-bold ${cls}">${(w*100).toFixed(1)}%</span> <span class="text-slate-400 text-[10px]">(${currencyFormatter.format(w*total)})</span>`)
    .join(", ");

  document.getElementById("comparisonTableBody").innerHTML = `
    <tr class="hover:bg-slate-900 border-b border-slate-800">
      <td class="py-3 pl-2 font-bold text-amber-400 flex items-center"><i class="fa-solid fa-crown mr-1.5"></i> 最大夏普組合</td>
      <td class="py-3 font-semibold text-white">${(maxSharpePortfolio.expectedReturn*100).toFixed(2)}%</td>
      <td class="py-3 font-semibold text-white">${(maxSharpePortfolio.volatility*100).toFixed(2)}%</td>
      <td class="py-3 text-amber-400 font-bold">${maxSharpePortfolio.sharpeRatio.toFixed(3)}</td>
      <td class="py-3 text-right pr-2 text-slate-300 text-[11px]">${fmt(maxSharpePortfolio,"text-amber-400")}</td>
    </tr>
    <tr class="hover:bg-slate-900">
      <td class="py-3 pl-2 font-bold text-emerald-400 flex items-center"><i class="fa-solid fa-shield-halved mr-1.5"></i> 最小波動組合 (GMV)</td>
      <td class="py-3 font-semibold text-white">${(minVolPortfolio.expectedReturn*100).toFixed(2)}%</td>
      <td class="py-3 font-semibold text-white">${(minVolPortfolio.volatility*100).toFixed(2)}%</td>
      <td class="py-3 text-emerald-400 font-bold">${minVolPortfolio.sharpeRatio.toFixed(3)}</td>
      <td class="py-3 text-right pr-2 text-slate-300 text-[11px]">${fmt(minVolPortfolio,"text-emerald-400")}</td>
    </tr>`;
}

// ─── Correlation heatmap ───────────────────────────────────────────────────────
function updateCorrelationHeatmap() {
  const el = document.getElementById("correlationHeatmap");
  if (!el) return;
  const tickers = assets.map(a => a.ticker);

  let html = '<table class="w-full text-xs font-mono border-separate border-spacing-1">';
  html += "<thead><tr><th></th>" + tickers.map(t => `<th class="text-slate-400 uppercase pb-1 px-1">${t}</th>`).join("") + "</tr></thead><tbody>";

  tickers.forEach(row => {
    html += `<tr><td class="text-slate-400 uppercase font-bold pr-2 text-right whitespace-nowrap">${row}</td>`;
    tickers.forEach(col => {
      const corr  = baseCorrelation[row]?.[col] ?? (row === col ? 1.0 : 0.35);
      const bg    = corrToColor(corr);
      const color = Math.abs(corr) > 0.55 ? "#f8fafc" : "#1e293b";
      html += `<td class="py-1.5 px-1 text-center rounded" style="background:${bg};color:${color}">${corr.toFixed(2)}</td>`;
    });
    html += "</tr>";
  });

  html += "</tbody></table>";
  html += `
    <div class="flex items-center justify-center gap-2 mt-3 text-[10px] text-slate-400">
      <span class="text-blue-400 font-bold">■</span> 負相關
      <div class="w-20 h-2 rounded" style="background:linear-gradient(to right,#3b82f6,#f8fafc,#dc2626)"></div>
      正相關 <span class="text-red-400 font-bold">■</span>
    </div>`;

  el.innerHTML = html;
}

function corrToColor(corr) {
  corr = Math.max(-1, Math.min(1, corr));
  if (corr >= 0) {
    return `rgb(${Math.round(248+(220-248)*corr)},${Math.round(250+(38-250)*corr)},${Math.round(252+(38-252)*corr)})`;
  } else {
    const t = -corr;
    return `rgb(${Math.round(248+(37-248)*t)},${Math.round(250+(99-250)*t)},${Math.round(252+(235-252)*t)})`;
  }
}

// ─── Doughnut chart ────────────────────────────────────────────────────────────
function switchDoughnutData(mode) {
  selectedDoughnutMode = mode;
  const activeClass   = "text-[10px] bg-emerald-600/20 text-emerald-400 px-2 py-0.5 rounded border border-emerald-500/30";
  const inactiveClass = "text-[10px] bg-slate-900 text-slate-400 px-2 py-0.5 rounded border border-slate-800";
  document.getElementById("btnSelectMaxSharpe").className = mode === "maxSharpe" ? activeClass : inactiveClass;
  document.getElementById("btnSelectGmv").className       = mode === "gmv"       ? activeClass : inactiveClass;
  updateDoughnutChart();
}

function updateDoughnutChart() {
  if (!doughnutChartInstance) return;
  const p      = selectedDoughnutMode === "maxSharpe" ? maxSharpePortfolio : minVolPortfolio;
  const labels = Object.keys(p.weights);
  const data   = Object.values(p.weights).map(w => parseFloat((w*100).toFixed(1)));
  const total  = getInvestmentAmount();
  const colors = doughnutChartInstance.data.datasets[0].backgroundColor;

  doughnutChartInstance.data.labels = labels;
  doughnutChartInstance.data.datasets[0].data = data;
  doughnutChartInstance.update();

  document.getElementById("weightDetailList").innerHTML = labels.map((label, i) => `
    <div class="flex items-center justify-between text-xs bg-slate-900/60 p-2 px-3 rounded border border-slate-800">
      <span class="flex items-center text-slate-300 font-bold uppercase">
        <span class="w-2.5 h-2.5 rounded-full mr-2" style="background:${colors[i%colors.length]}"></span>${label}
      </span>
      <div class="text-right">
        <span class="font-bold text-white mr-2">${data[i]}%</span>
        <span class="text-slate-400 text-[11px] font-mono bg-slate-950 px-1.5 py-0.5 rounded border border-slate-800">${currencyFormatter.format(total*data[i]/100)}</span>
      </div>
    </div>`).join("");
}

// ─── Scatter + doughnut charts ─────────────────────────────────────────────────
function renderCharts() {
  const sharpes = simulatedPortfolios.map(p => p.sharpeRatio);
  const maxS = Math.max(...sharpes), minS = Math.min(...sharpes), sRange = maxS - minS;

  const datasets = [
    {
      label: "最大夏普組合 (Max Sharpe)",
      data: [{ x: maxSharpePortfolio.volatility*100, y: maxSharpePortfolio.expectedReturn*100 }],
      backgroundColor: "#f59e0b", borderColor: "#ffffff", borderWidth: 2,
      pointStyle: "star", pointRadius: 13, pointHoverRadius: 15, order: 1,
    },
    {
      label: "最小波動組合 (GMV)",
      data: [{ x: minVolPortfolio.volatility*100, y: minVolPortfolio.expectedReturn*100 }],
      backgroundColor: "#10b981", borderColor: "#ffffff", borderWidth: 2,
      pointStyle: "circle", pointRadius: 11, pointHoverRadius: 13, order: 2,
    },
    {
      label: "模擬資產組合",
      data: simulatedPortfolios.map(p => ({ x: p.volatility*100, y: p.expectedReturn*100, sharpe: p.sharpeRatio })),
      backgroundColor: simulatedPortfolios.map(p => {
        const r = sRange > 0 ? (p.sharpeRatio - minS) / sRange : 0.5;
        return `hsla(${220 - r*120},85%,55%,0.4)`;
      }),
      pointRadius: 3, pointHoverRadius: 6, order: 3,
    },
  ];

  const ctx = document.getElementById("frontierScatterChart").getContext("2d");
  if (scatterChartInstance) {
    scatterChartInstance.data.datasets = datasets;
    scatterChartInstance.update();
  } else {
    scatterChartInstance = new Chart(ctx, {
      type: "scatter", data: { datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom", labels: { usePointStyle: true, font: { size: 11, family: "Noto Sans TC" }, color: "#94a3b8", filter: item => item.text !== "模擬資產組合" } },
          tooltip: { callbacks: { label: ctx => {
            const p = ctx.raw;
            return ctx.datasetIndex === 2
              ? `回報: ${p.y.toFixed(2)}%, 風險: ${p.x.toFixed(2)}%, 夏普: ${p.sharpe.toFixed(3)}`
              : `${ctx.dataset.label} → 回報: ${p.y.toFixed(2)}%, 風險: ${p.x.toFixed(2)}%`;
          }}},
        },
        scales: {
          x: { title: { display: true, text: "年化波動度 (Risk, %)", color: "#94a3b8" }, grid: { color: "rgba(51,65,85,0.3)" }, ticks: { color: "#94a3b8" } },
          y: { title: { display: true, text: "預期報酬率 (Return, %)", color: "#94a3b8" }, grid: { color: "rgba(51,65,85,0.3)" }, ticks: { color: "#94a3b8" } },
        },
      },
    });
  }

  const ctxD = document.getElementById("weightDoughnutChart").getContext("2d");
  if (doughnutChartInstance) {
    updateDoughnutChart();
  } else {
    doughnutChartInstance = new Chart(ctxD, {
      type: "doughnut",
      data: { labels: [], datasets: [{ data: [], backgroundColor: ["#6366f1","#ec4899","#f59e0b","#10b981","#3b82f6","#8b5cf6","#14b8a6","#ef4444"], borderWidth: 2, borderColor: "#0f172a" }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, cutout: "65%" },
    });
    updateDoughnutChart();
  }
}
