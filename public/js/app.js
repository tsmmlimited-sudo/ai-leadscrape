/* ============================================================
   AI LeadScrape Outreach Engine — logika frontendu (Vanilla JS)
   ============================================================ */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const LS = {
  apify: "leadscrape_apify_token",
  gemini: "leadscrape_gemini_key",
  history: "leadscrape_history",
  app: "leadscrape_app_token",
};

const state = {
  leads: [],
  filtered: [],
  activeFilters: new Set(),
  selected: new Set(),   // id-ki firm zaznaczonych do masowej analizy
  view: "cards",
  poll: null,
  timer: null,
  startedAt: 0,
  bulkCancel: false,
};

/* ---------- Klucze API ---------- */

function getKeys() {
  return {
    apify: localStorage.getItem(LS.apify) || "",
    gemini: localStorage.getItem(LS.gemini) || "",
  };
}

/* ---------- Logowanie (gdy włączone hasło) ---------- */

// Dokłada token dostępu (jeśli jest) do nagłówków każdego żądania API.
function withAuth(headers) {
  const h = Object.assign({}, headers || {});
  const token = localStorage.getItem(LS.app);
  if (token) h["x-app-token"] = token;
  return h;
}

// Wywoływane, gdy serwer odrzuci żądanie (401) — pokazuje ekran logowania.
function handleAuthError() {
  localStorage.removeItem(LS.app);
  $("#loginModal").classList.remove("hidden");
  toast("Sesja wygasła — zaloguj się ponownie.", true);
}

async function doLogin() {
  const password = $("#loginPass").value;
  if (!password) { toast("Podaj hasło.", true); return; }
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Błąd logowania.");
    localStorage.setItem(LS.app, data.token);
    $("#loginModal").classList.add("hidden");
    $("#loginPass").value = "";
    toast("Zalogowano.");
  } catch (err) {
    toast(err.message, true);
  }
}

// Sprawdza przy starcie, czy aplikacja wymaga hasła i czy mamy ważny token.
async function checkAuthGate() {
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    if (data.authRequired && !localStorage.getItem(LS.app)) {
      $("#loginModal").classList.remove("hidden");
      return false;
    }
  } catch {
    /* offline / brak serwera — pomijamy bramkę */
  }
  return true;
}

function refreshKeyDot() {
  const { apify, gemini } = getKeys();
  $("#keyDot").classList.toggle("ok", Boolean(apify && gemini));
}

function openSettings() {
  const { apify, gemini } = getKeys();
  $("#apifyTokenInput").value = apify;
  $("#geminiKeyInput").value = gemini;
  $("#settingsModal").classList.remove("hidden");
}

function saveSettings() {
  localStorage.setItem(LS.apify, $("#apifyTokenInput").value.trim());
  localStorage.setItem(LS.gemini, $("#geminiKeyInput").value.trim());
  $("#settingsModal").classList.add("hidden");
  refreshKeyDot();
  toast("Klucze zapisane w przeglądarce.");
}

/* ---------- Toast ---------- */

let toastTimer;
function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("err", isError);
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 3400);
}

/* ---------- Stoper ---------- */

function startTimer() {
  state.startedAt = Date.now();
  const tick = () => {
    const s = Math.floor((Date.now() - state.startedAt) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    $("#stopwatch").textContent = `${mm}:${ss}`;
  };
  tick();
  state.timer = setInterval(tick, 1000);
}
function stopTimer() { clearInterval(state.timer); }

/* ---------- Scraping ---------- */

async function startScrape() {
  const { apify } = getKeys();
  if (!apify) { toast("Najpierw zapisz token Apify.", true); openSettings(); return; }

  const query = $("#queryInput").value.trim();
  const location = $("#locationInput").value.trim();
  const limit = parseInt($("#limitInput").value, 10) || 20;
  if (!query || !location) { toast("Podaj branżę i lokalizację.", true); return; }

  const btn = $("#searchBtn");
  btn.disabled = true;
  btn.textContent = "Uruchamiam…";

  const skipContacts = $("#skipContacts").checked;

  // UI postępu
  $("#progressPanel").classList.remove("hidden");
  $("#resultsSection").classList.add("hidden");
  state.selected.clear();
  setProgress("Inicjalizacja…", "Uruchamiam aktora Apify", true, 0);
  startTimer();

  try {
    const res = await fetch("/api/scrape/start", {
      method: "POST",
      headers: withAuth({ "Content-Type": "application/json", "x-apify-token": apify }),
      body: JSON.stringify({ query, location, limit, skipContacts }),
    });
    const data = await res.json();
    if (res.status === 401) { handleAuthError(); throw new Error("Wymagane logowanie."); }
    if (!res.ok) throw new Error(data.error || "Błąd uruchomienia.");

    const sub = skipContacts
      ? "Tryb szybki — bez wchodzenia na strony firm"
      : "Aktor odwiedza wizytówki i strony firm";
    setProgress("Scrapuję Google Maps…", sub, true, 0);
    pollStatus(data.runId, data.datasetId, limit);
  } catch (err) {
    failScrape(err.message);
  }
}

function pollStatus(runId, datasetId, limit) {
  const { apify } = getKeys();
  let pct = 8;

  state.poll = setInterval(async () => {
    try {
      const res = await fetch(`/api/scrape/status/${runId}`, { headers: withAuth({ "x-apify-token": apify }) });
      const data = await res.json();
      if (res.status === 401) { clearInterval(state.poll); stopTimer(); handleAuthError(); return; }
      if (!res.ok) throw new Error(data.error || "Błąd statusu.");

      // Heurystyczny pasek postępu na podstawie liczby zebranych pozycji.
      if (typeof data.itemCount === "number" && limit) {
        pct = Math.min(92, Math.round((data.itemCount / limit) * 100));
        setProgress("Scrapuję Google Maps…", `Zebrano ${data.itemCount} z ~${limit} firm`, false, pct);
      } else {
        pct = Math.min(88, pct + 4);
        setProgress("Scrapuję Google Maps…", "Aktor odwiedza wizytówki i strony firm", false, pct);
      }

      if (data.status === "SUCCEEDED") {
        clearInterval(state.poll);
        await fetchResults(datasetId);
      } else if (["FAILED", "ABORTED", "TIMED-OUT"].includes(data.status)) {
        clearInterval(state.poll);
        failScrape(`Aktor zakończył się statusem: ${data.status}`);
      }
    } catch (err) {
      clearInterval(state.poll);
      failScrape(err.message);
    }
  }, 4000); // polling co 4 s
}

async function fetchResults(datasetId) {
  const { apify } = getKeys();
  setProgress("Pobieram wyniki…", "Normalizacja danych leadów", true, 96);
  try {
    const res = await fetch(`/api/scrape/results/${datasetId}`, { headers: withAuth({ "x-apify-token": apify }) });
    const data = await res.json();
    if (res.status === 401) { handleAuthError(); throw new Error("Wymagane logowanie."); }
    if (!res.ok) throw new Error(data.error || "Błąd pobierania wyników.");

    setProgress("Gotowe", `Znaleziono ${data.count} firm`, false, 100);
    stopTimer();
    state.leads = data.leads;
    state.activeFilters.clear();
    $$(".chip").forEach((c) => c.classList.remove("active"));
    applyFilters();

    setTimeout(() => $("#progressPanel").classList.add("hidden"), 900);
    $("#resultsSection").classList.remove("hidden");
    resetSearchBtn();

    if (data.count === 0) toast("Brak wyników — spróbuj innej frazy lub większego limitu.");
  } catch (err) {
    failScrape(err.message);
  }
}

function setProgress(status, sub, indeterminate, pct) {
  $("#progressStatus").textContent = status;
  $("#progressSub").textContent = sub;
  const bar = $("#progressBar");
  bar.classList.toggle("indeterminate", Boolean(indeterminate));
  if (!indeterminate) bar.style.width = `${pct}%`;
  else bar.style.width = "";
}

function failScrape(msg) {
  clearInterval(state.poll);
  stopTimer();
  setProgress("Błąd", msg, false, 0);
  $("#progressBar").classList.remove("indeterminate");
  resetSearchBtn();
  toast(msg, true);
}

function resetSearchBtn() {
  const btn = $("#searchBtn");
  btn.disabled = false;
  btn.textContent = "Uruchom scraping";
}

/* ---------- Filtrowanie ---------- */

function applyFilters() {
  const f = state.activeFilters;
  state.filtered = state.leads.filter((lead) => {
    if (f.has("email") && !lead.flags.email) return false;
    if (f.has("instagram") && !lead.flags.instagram) return false;
    if (f.has("www") && !lead.flags.www) return false;
    if (f.has("nowww") && lead.flags.www) return false;
    return true;
  });
  render();
}

/* ---------- Render ---------- */

function render() {
  $("#resultCount").textContent = state.filtered.length;
  const withEmail = state.filtered.filter((l) => l.flags.email).length;
  const noWww = state.filtered.filter((l) => !l.flags.www).length;
  $("#filterStats").textContent =
    state.filtered.length ? `· ${withEmail} z e-mailem · ${noWww} bez strony WWW` : "";

  const empty = state.filtered.length === 0;
  $("#emptyState").classList.toggle("hidden", !empty);
  $("#selectBar").classList.toggle("hidden", empty);

  if (state.view === "cards") {
    $("#tableView").classList.add("hidden");
    $("#cardsView").classList.toggle("hidden", empty);
    renderCards();
  } else {
    $("#cardsView").classList.add("hidden");
    $("#tableView").classList.toggle("hidden", empty);
    renderTable();
  }
  updateSelectBar();
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function socialBadges(lead) {
  const out = [];
  for (const [k, v] of Object.entries(lead.socials)) {
    if (v) out.push(`<a class="badge social" href="${esc(v)}" target="_blank" rel="noopener">${k}</a>`);
  }
  return out.join("");
}

function renderCards() {
  $("#cardsView").innerHTML = state.filtered
    .map((lead, i) => {
      const rating = lead.rating != null
        ? `<span class="rating">★ ${lead.rating.toFixed(1)} <small>(${lead.reviewsCount})</small></span>`
        : "";
      const website = lead.hasWebsiteInCard
        ? `<div class="meta-row"><span class="ico">🌐</span><a href="${esc(lead.website)}" target="_blank" rel="noopener">${esc(lead.website.replace(/^https?:\/\//, ""))}</a></div>`
        : `<div class="meta-row"><span class="ico">🌐</span><span style="color:var(--bad)">brak dedykowanej strony</span></div>`;
      const email = lead.email
        ? `<div class="meta-row"><span class="ico">✉️</span><a href="mailto:${esc(lead.email)}">${esc(lead.email)}</a></div>`
        : "";
      const phone = lead.phone
        ? `<div class="meta-row"><span class="ico">📞</span>${esc(lead.phone)}</div>`
        : "";

      return `
      <article class="card ${state.selected.has(lead.id) ? "selected" : ""}" data-i="${i}">
        <input type="checkbox" class="card-select" data-sel="${esc(lead.id)}" ${state.selected.has(lead.id) ? "checked" : ""} title="Zaznacz do masowej analizy" />
        <div class="card-head">
          <div>
            <div class="card-name">${esc(lead.name)}</div>
            <div class="card-cat">${esc(lead.category)}</div>
          </div>
          ${rating}
        </div>
        <div class="card-meta">
          ${lead.address ? `<div class="meta-row"><span class="ico">📍</span>${esc(lead.address)}</div>` : ""}
          ${phone}${email}${website}
        </div>
        <div class="badges">
          <span class="badge ${lead.flags.email ? "on" : "off"}">e-mail</span>
          <span class="badge ${lead.flags.www ? "on" : "off"}">WWW</span>
          ${socialBadges(lead)}
        </div>
        <div class="card-foot">
          <button class="btn-ai" data-ai="${i}">✦ Analizuj AI</button>
          ${lead.mapsUrl ? `<a class="btn-link" href="${esc(lead.mapsUrl)}" target="_blank" rel="noopener" title="Otwórz w Mapach">↗</a>` : ""}
        </div>
      </article>`;
    })
    .join("");

  $$("#cardsView [data-ai]").forEach((btn) =>
    btn.addEventListener("click", () => analyze(state.filtered[+btn.dataset.ai], btn))
  );
  $$("#cardsView [data-sel]").forEach((cb) =>
    cb.addEventListener("change", () => toggleSelect(cb.dataset.sel))
  );
}

function renderTable() {
  const rows = state.filtered
    .map((lead, i) => `
      <tr class="${state.selected.has(lead.id) ? "row-selected" : ""}">
        <td class="tbl-check"><input type="checkbox" data-sel="${esc(lead.id)}" ${state.selected.has(lead.id) ? "checked" : ""} /></td>
        <td>${esc(lead.name)}</td>
        <td>${esc(lead.category)}</td>
        <td>${esc(lead.phone)}</td>
        <td class="${lead.flags.email ? "cell-yes" : "cell-no"}">${lead.email ? esc(lead.email) : "—"}</td>
        <td class="${lead.flags.www ? "cell-yes" : "cell-no"}">${lead.flags.www ? "tak" : "nie"}</td>
        <td class="${lead.flags.instagram ? "cell-yes" : "cell-no"}">${lead.flags.instagram ? "tak" : "—"}</td>
        <td>${lead.rating != null ? `★ ${lead.rating.toFixed(1)} (${lead.reviewsCount})` : "—"}</td>
        <td><button class="tbl-ai" data-ai="${i}">Analizuj AI</button></td>
      </tr>`)
    .join("");

  $("#tableView").innerHTML = `
    <table>
      <thead><tr>
        <th></th><th>Nazwa</th><th>Branża</th><th>Telefon</th><th>E-mail</th>
        <th>WWW</th><th>Instagram</th><th>Ocena</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  $$("#tableView [data-ai]").forEach((btn) =>
    btn.addEventListener("click", () => analyze(state.filtered[+btn.dataset.ai], btn))
  );
  $$("#tableView [data-sel]").forEach((cb) =>
    cb.addEventListener("change", () => toggleSelect(cb.dataset.sel))
  );
}

/* ---------- Eksport ---------- */

function exportJson() {
  if (!state.filtered.length) return toast("Brak danych do eksportu.", true);
  download("leady.json", JSON.stringify(state.filtered, null, 2), "application/json");
}

function exportCsv() {
  if (!state.filtered.length) return toast("Brak danych do eksportu.", true);
  const cols = ["name", "category", "address", "phone", "email", "website", "hasWebsiteInCard", "rating", "reviewsCount", "instagram", "facebook", "tiktok", "mapsUrl"];
  const head = cols.join(";");
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = state.filtered.map((l) =>
    [
      l.name, l.category, l.address, l.phone, l.email, l.website,
      l.hasWebsiteInCard ? "tak" : "nie", l.rating ?? "", l.reviewsCount,
      l.socials.instagram, l.socials.facebook, l.socials.tiktok, l.mapsUrl,
    ].map(esc).join(";")
  );
  // UTF-8 BOM, by Excel poprawnie odczytał polskie znaki.
  const csv = "\uFEFF" + [head, ...lines].join("\r\n");
  download("leady.csv", csv, "text/csv;charset=utf-8");
}

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
  toast(`Wyeksportowano ${filename}`);
}

/* ---------- Analiza AI ---------- */

// Wspólny rdzeń: wywołuje Gemini i zwraca dane analizy (rzuca wyjątek przy błędzie).
async function runAnalysis(lead) {
  const { gemini } = getKeys();
  if (!gemini) throw new Error("Brak klucza Gemini.");
  const res = await fetch("/api/analyze", {
    method: "POST",
    headers: withAuth({ "Content-Type": "application/json", "x-gemini-key": gemini }),
    body: JSON.stringify({ company: lead }),
  });
  const data = await res.json();
  if (res.status === 401) { handleAuthError(); throw new Error("Wymagane logowanie."); }
  if (!res.ok) throw new Error(data.error || "Błąd analizy.");
  return data;
}

async function analyze(lead, btn) {
  const { gemini } = getKeys();
  if (!gemini) { toast("Najpierw zapisz klucz Gemini.", true); openSettings(); return; }

  if (btn) btn.disabled = true;
  openDrawer(`
    <div class="ai-loading">
      <div class="spinner"></div>
      <p>Gemini analizuje firmę <strong>${esc(lead.name)}</strong>…</p>
    </div>`);

  try {
    const data = await runAnalysis(lead);
    saveToHistory(lead, data);
    renderAnalysis(lead, data);
  } catch (err) {
    openDrawer(`<div class="ai-loading"><p style="color:var(--bad)">${esc(err.message)}</p></div>`);
    toast(err.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function renderAnalysis(lead, a) {
  const li = (arr) => (arr || []).map((x) => `<li>${esc(x)}</li>`).join("");
  openDrawer(`
    <div class="ai-head">
      <h3>${esc(lead.name)}</h3>
      <p>${esc(lead.category)} · audyt marketingowy AI</p>
    </div>
    <div class="ai-block">
      <h4>Mocne strony</h4>
      <ul class="ai-list strong">${li(a.mocneStrony)}</ul>
    </div>
    <div class="ai-block">
      <h4>Słabe punkty</h4>
      <ul class="ai-list weak">${li(a.slabePunkty)}</ul>
    </div>
    <div class="ai-block">
      <h4>Propozycja wiadomości</h4>
      <div class="outreach-box" id="outreachText">${esc(a.wiadomoscOutreach)}</div>
      <button class="btn btn-primary copy-btn" id="copyOutreach">Kopiuj ofertę</button>
    </div>`);

  $("#copyOutreach").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(a.wiadomoscOutreach);
      toast("Skopiowano ofertę do schowka.");
    } catch {
      toast("Nie udało się skopiować.", true);
    }
  });
}

function openDrawer(html) {
  $("#aiContent").innerHTML = html;
  $("#aiDrawer").classList.remove("hidden");
}
function closeDrawer() { $("#aiDrawer").classList.add("hidden"); }

/* ---------- Zaznaczanie (do masowej analizy) ---------- */

function toggleSelect(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  // odśwież klasy bez pełnego re-renderu
  $$(`[data-sel="${cssEscape(id)}"]`).forEach((cb) => {
    cb.checked = state.selected.has(id);
    const card = cb.closest(".card");
    if (card) card.classList.toggle("selected", state.selected.has(id));
    const row = cb.closest("tr");
    if (row) row.classList.toggle("row-selected", state.selected.has(id));
  });
  updateSelectBar();
}

function cssEscape(s) {
  return String(s).replace(/["\\]/g, "\\$&");
}

function updateSelectBar() {
  const n = state.selected.size;
  $("#selectCount").textContent = n;
  $("#bulkAnalyze").disabled = n === 0;
  const visibleIds = state.filtered.map((l) => l.id);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => state.selected.has(id));
  $("#selectAll").checked = allSelected;
}

function selectAllVisible(check) {
  state.filtered.forEach((l) => {
    if (check) state.selected.add(l.id);
    else state.selected.delete(l.id);
  });
  render();
}

function clearSelection() {
  state.selected.clear();
  render();
}

/* ---------- Historia ofert ---------- */

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(LS.history) || "[]"); }
  catch { return []; }
}

function saveToHistory(lead, analysis) {
  const hist = loadHistory();
  hist.unshift({
    name: lead.name,
    category: lead.category,
    email: lead.email || "",
    mocneStrony: analysis.mocneStrony || [],
    slabePunkty: analysis.slabePunkty || [],
    wiadomoscOutreach: analysis.wiadomoscOutreach || "",
    date: Date.now(),
  });
  localStorage.setItem(LS.history, JSON.stringify(hist.slice(0, 200))); // limit 200
  updateHistCount();
}

function updateHistCount() {
  $("#histCount").textContent = loadHistory().length;
}

function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function openHistory() {
  renderHistoryList();
  $("#historyDrawer").classList.remove("hidden");
}
function closeHistory() { $("#historyDrawer").classList.add("hidden"); }

function renderHistoryList() {
  const hist = loadHistory();
  $("#historySub").textContent = hist.length ? `${hist.length} zapisanych analiz` : "Brak zapisanych analiz";
  if (!hist.length) {
    $("#historyList").innerHTML = `<p class="hist-empty">Tu pojawią się oferty po analizie firm.</p>`;
    return;
  }
  $("#historyList").innerHTML = hist
    .map((h, i) => `
      <div class="hist-item">
        <div class="hist-item-head">
          <strong>${esc(h.name)}</strong>
          <span class="hist-date">${fmtDate(h.date)}</span>
        </div>
        <div class="hist-msg" id="hm${i}">${esc(h.wiadomoscOutreach)}</div>
        <div class="hist-actions">
          <button data-copy="${i}">Kopiuj ofertę</button>
          <button data-exp="${i}">Rozwiń</button>
        </div>
      </div>`)
    .join("");

  $$("#historyList [data-copy]").forEach((b) =>
    b.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(hist[+b.dataset.copy].wiadomoscOutreach); toast("Skopiowano ofertę."); }
      catch { toast("Nie udało się skopiować.", true); }
    })
  );
  $$("#historyList [data-exp]").forEach((b) =>
    b.addEventListener("click", () => {
      const m = $(`#hm${b.dataset.exp}`);
      m.classList.toggle("expanded");
      b.textContent = m.classList.contains("expanded") ? "Zwiń" : "Rozwiń";
    })
  );
}

function clearHistory() {
  if (!loadHistory().length) return;
  if (!confirm("Na pewno wyczyścić całą historię ofert?")) return;
  localStorage.removeItem(LS.history);
  updateHistCount();
  renderHistoryList();
  toast("Historia wyczyszczona.");
}

/* ---------- Masowa analiza ---------- */

async function bulkAnalyze() {
  const { gemini } = getKeys();
  if (!gemini) { toast("Najpierw zapisz klucz Gemini.", true); openSettings(); return; }

  const leads = state.filtered.filter((l) => state.selected.has(l.id));
  if (!leads.length) { toast("Zaznacz najpierw firmy.", true); return; }

  state.bulkCancel = false;
  $("#bulkModal").classList.remove("hidden");
  $("#bulkBar").classList.remove("indeterminate");

  let done = 0, ok = 0, fail = 0;
  for (const lead of leads) {
    if (state.bulkCancel) break;
    $("#bulkStatus").textContent = `Analizuję: ${lead.name}`;
    $("#bulkDetail").textContent = `${done} z ${leads.length} • ${ok} OK • ${fail} błędów`;
    try {
      const data = await runAnalysis(lead);
      saveToHistory(lead, data);
      ok++;
    } catch {
      fail++;
    }
    done++;
    $("#bulkBar").style.width = `${Math.round((done / leads.length) * 100)}%`;
    $("#bulkDetail").textContent = `${done} z ${leads.length} • ${ok} OK • ${fail} błędów`;
  }

  $("#bulkModal").classList.add("hidden");
  $("#bulkBar").style.width = "0%";
  toast(state.bulkCancel ? `Zatrzymano. Zapisano ${ok} ofert.` : `Gotowe: ${ok} ofert (${fail} błędów).`);
  if (ok > 0) openHistory();
}

/* ---------- Inicjalizacja ---------- */

async function init() {
  refreshKeyDot();

  $("#searchBtn").addEventListener("click", startScrape);
  $$("#queryInput, #locationInput").forEach((el) =>
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") startScrape(); })
  );

  $("#settingsBtn").addEventListener("click", openSettings);
  $("#settingsSave").addEventListener("click", saveSettings);
  $("#settingsCancel").addEventListener("click", () => $("#settingsModal").classList.add("hidden"));
  $("#settingsModal").addEventListener("click", (e) => {
    if (e.target.id === "settingsModal") $("#settingsModal").classList.add("hidden");
  });

  // Logowanie
  $("#loginBtn").addEventListener("click", doLogin);
  $("#loginPass").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });

  $("#filters").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    const f = chip.dataset.filter;
    // WWW i bez-WWW wykluczają się wzajemnie.
    if (f === "www" && state.activeFilters.has("nowww")) state.activeFilters.delete("nowww");
    if (f === "nowww" && state.activeFilters.has("www")) state.activeFilters.delete("www");
    chip.classList.toggle("active");
    if (state.activeFilters.has(f)) state.activeFilters.delete(f);
    else state.activeFilters.add(f);
    $$(".chip").forEach((c) => c.classList.toggle("active", state.activeFilters.has(c.dataset.filter)));
    applyFilters();
  });

  $("#viewToggle").addEventListener("click", (e) => {
    const v = e.target.closest(".vt");
    if (!v) return;
    state.view = v.dataset.view;
    $$(".vt").forEach((b) => b.classList.toggle("active", b === v));
    render();
  });

  $("#exportCsv").addEventListener("click", exportCsv);
  $("#exportJson").addEventListener("click", exportJson);

  // Historia
  updateHistCount();
  $("#historyBtn").addEventListener("click", openHistory);
  $("#historyClose").addEventListener("click", closeHistory);
  $("#historyDrawer").addEventListener("click", (e) => { if (e.target.id === "historyDrawer") closeHistory(); });
  $("#clearHistory").addEventListener("click", clearHistory);

  // Zaznaczanie + masowa analiza
  $("#selectAll").addEventListener("change", (e) => selectAllVisible(e.target.checked));
  $("#clearSelect").addEventListener("click", clearSelection);
  $("#bulkAnalyze").addEventListener("click", bulkAnalyze);
  $("#bulkCancel").addEventListener("click", () => { state.bulkCancel = true; });

  $("#aiClose").addEventListener("click", closeDrawer);
  $("#aiDrawer").addEventListener("click", (e) => { if (e.target.id === "aiDrawer") closeDrawer(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeDrawer();
      closeHistory();
      $("#settingsModal").classList.add("hidden");
    }
  });

  // Bramka hasła (jeśli włączona) — dopiero potem ewentualnie prosimy o klucze.
  const authOk = await checkAuthGate();
  if (authOk) {
    const { apify, gemini } = getKeys();
    if (!apify || !gemini) setTimeout(openSettings, 400);
  }
}

document.addEventListener("DOMContentLoaded", init);
