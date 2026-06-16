/**
 * AI LeadScrape Outreach Engine — serwer Express
 * -----------------------------------------------
 * Architektura monolityczna: backend = cienkie proxy do zewnętrznych API,
 * frontend = statyczne pliki w /public.
 *
 * Klucze API (Apify Token, Gemini Key) NIE są przechowywane na serwerze.
 * Przychodzą z przeglądarki w nagłówkach przy każdym żądaniu i są używane
 * tylko do przekazania dalej (Apify / Google). To świadoma decyzja — model
 * "bring your own key", zgodny z zapisem kluczy w localStorage po stronie klienta.
 */

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Apify używa w ścieżce URL tyldy zamiast ukośnika: compass~crawler-google-places
const APIFY_ACTOR_ID = "compass~crawler-google-places";
const APIFY_BASE = "https://api.apify.com/v2";

// Najnowszy szybki i ekonomiczny model Gemini (rodzina 3.x, wersja GA).
const GEMINI_MODEL = "gemini-3.5-flash";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ============================================================
 *  LOGIKA BIZNESOWA — czyszczenie i normalizacja leada
 * ============================================================ */

const SOCIAL_DOMAINS = {
  instagram: ["instagram.com", "instagr.am"],
  facebook: ["facebook.com", "fb.com", "fb.me", "m.facebook.com"],
  tiktok: ["tiktok.com"],
  linkedin: ["linkedin.com", "lnkd.in"],
  youtube: ["youtube.com", "youtu.be"],
  twitter: ["twitter.com", "x.com"],
};

/** Zwraca nazwę platformy social, jeśli URL należy do domeny społecznościowej; inaczej null. */
function detectSocialPlatform(url) {
  if (!url) return null;
  let host;
  try {
    host = new URL(url.startsWith("http") ? url : `https://${url}`).hostname.toLowerCase();
  } catch {
    host = String(url).toLowerCase();
  }
  host = host.replace(/^www\./, "");
  for (const [platform, domains] of Object.entries(SOCIAL_DOMAINS)) {
    if (domains.some((d) => host === d || host.endsWith(`.${d}`) || host.includes(d))) {
      return platform;
    }
  }
  return null;
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (Array.isArray(v) && v.length) return v[0];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/**
 * Przekształca surowy rekord z aktora Apify w czysty, jednolity obiekt leada.
 *
 * Kluczowa reguła: jeśli "witryna" z wizytówki Google to w istocie profil
 * społecznościowy (Instagram/Facebook/TikTok...), traktujemy go jako social,
 * czyścimy pole WWW i ustawiamy hasWebsiteInCard = false.
 */
function normalizeLead(raw) {
  const socials = {
    instagram: "",
    facebook: "",
    tiktok: "",
    linkedin: "",
    youtube: "",
    twitter: "",
  };

  // 1) Social media wyciągnięte bezpośrednio przez aktora (scrapeContacts: true).
  const apifySocialFields = {
    instagram: raw.instagrams,
    facebook: raw.facebooks,
    tiktok: raw.tiktoks,
    linkedin: raw.linkedIns,
    youtube: raw.youtubes,
    twitter: raw.twitters,
  };
  for (const [platform, arr] of Object.entries(apifySocialFields)) {
    const link = firstNonEmpty(arr);
    if (link) socials[platform] = link;
  }

  // 2) Analiza pola "website" z wizytówki.
  const rawWebsite = firstNonEmpty(raw.website, raw.webResults, raw.url && raw.website);
  let website = rawWebsite;
  let hasWebsiteInCard = Boolean(rawWebsite);

  const platformFromWebsite = detectSocialPlatform(rawWebsite);
  if (platformFromWebsite) {
    // Witryna jest tak naprawdę profilem social → przepisujemy i czyścimy WWW.
    if (!socials[platformFromWebsite]) socials[platformFromWebsite] = rawWebsite;
    website = "";
    hasWebsiteInCard = false;
  }

  const emails = Array.isArray(raw.emails) ? raw.emails.filter(Boolean) : [];
  const email = firstNonEmpty(emails);

  return {
    id: raw.placeId || raw.fid || raw.cid || `${raw.title}-${raw.address}`,
    name: raw.title || "(brak nazwy)",
    category: raw.categoryName || firstNonEmpty(raw.categories) || "",
    address: raw.address || "",
    city: raw.city || "",
    phone: raw.phone || firstNonEmpty(raw.phones) || "",
    email,
    emails,
    website,                       // dedykowana strona WWW (pusta jeśli to był social)
    hasWebsiteInCard,              // czy w wizytówce była PRAWDZIWA strona WWW
    rating: typeof raw.totalScore === "number" ? raw.totalScore : null,
    reviewsCount: typeof raw.reviewsCount === "number" ? raw.reviewsCount : 0,
    mapsUrl: raw.url || "",
    socials,
    // Flagi 0/1 dla szybkiego filtrowania i eksportu (zgodnie ze specyfikacją).
    flags: {
      www: hasWebsiteInCard ? 1 : 0,
      email: email ? 1 : 0,
      instagram: socials.instagram ? 1 : 0,
      facebook: socials.facebook ? 1 : 0,
      tiktok: socials.tiktok ? 1 : 0,
    },
  };
}

/* ============================================================
 *  API: SCRAPOWANIE (proxy do Apify, tryb asynchroniczny)
 * ============================================================ */

function getApifyToken(req) {
  return req.header("x-apify-token") || "";
}

// 1) Start aktora — zwraca natychmiast (bez czekania na zakończenie).
app.post("/api/scrape/start", async (req, res) => {
  const token = getApifyToken(req);
  if (!token) return res.status(400).json({ error: "Brak tokenu Apify (nagłówek x-apify-token)." });

  const { query, location, limit, skipContacts } = req.body || {};
  if (!query || !location) {
    return res.status(400).json({ error: "Wymagane pola: branża (query) i lokalizacja (location)." });
  }

  const max = Math.max(1, Math.min(Number(limit) || 20, 500));
  const wantContacts = !skipContacts; // domyślnie pobieramy kontakty

  const input = {
    searchStringsArray: [String(query).trim()],
    locationQuery: String(location).trim(),
    maxCrawledPlacesPerSearch: max,
    language: "pl",
    countryCode: "pl",
    scrapeContacts: wantContacts,   // <-- aktor odwiedza strony firm i wyciąga e-maile + social
    skipClosedPlaces: false,
    maximumLeadsEnrichmentRecords: wantContacts ? max : 0,
  };

  try {
    // Uruchomienie BEZ waitForFinish => natychmiastowa odpowiedź, brak timeoutów HTTP.
    const r = await fetch(`${APIFY_BASE}/acts/${APIFY_ACTOR_ID}/runs?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });

    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({
        error: data?.error?.message || "Apify odrzucił żądanie uruchomienia aktora.",
      });
    }

    const run = data.data;
    return res.json({
      runId: run.id,
      datasetId: run.defaultDatasetId,
      status: run.status,
    });
  } catch (err) {
    return res.status(502).json({ error: `Nie udało się połączyć z Apify: ${err.message}` });
  }
});

// 2) Status działającego runu — odpytywane co 4 s przez frontend.
app.get("/api/scrape/status/:runId", async (req, res) => {
  const token = getApifyToken(req);
  if (!token) return res.status(400).json({ error: "Brak tokenu Apify." });

  try {
    const r = await fetch(
      `${APIFY_BASE}/actor-runs/${encodeURIComponent(req.params.runId)}?token=${encodeURIComponent(token)}`
    );
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: "Nie udało się pobrać statusu runu." });

    const run = data.data;
    return res.json({
      status: run.status,                                   // READY | RUNNING | SUCCEEDED | FAILED | ...
      datasetId: run.defaultDatasetId,
      itemCount: run.stats?.itemCount ?? null,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    });
  } catch (err) {
    return res.status(502).json({ error: `Błąd połączenia z Apify: ${err.message}` });
  }
});

// 3) Wyniki — pobranie i normalizacja datasetu po zakończeniu runu.
app.get("/api/scrape/results/:datasetId", async (req, res) => {
  const token = getApifyToken(req);
  if (!token) return res.status(400).json({ error: "Brak tokenu Apify." });

  try {
    const r = await fetch(
      `${APIFY_BASE}/datasets/${encodeURIComponent(req.params.datasetId)}/items?token=${encodeURIComponent(
        token
      )}&clean=true&format=json`
    );
    if (!r.ok) return res.status(r.status).json({ error: "Nie udało się pobrać wyników datasetu." });

    const items = await r.json();
    const leads = (Array.isArray(items) ? items : []).map(normalizeLead);
    return res.json({ count: leads.length, leads });
  } catch (err) {
    return res.status(502).json({ error: `Błąd pobierania wyników: ${err.message}` });
  }
});

/* ============================================================
 *  API: ANALIZA AI (proxy do Google Gemini)
 * ============================================================ */

const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    mocneStrony: { type: "array", items: { type: "string" } },
    slabePunkty: { type: "array", items: { type: "string" } },
    wiadomoscOutreach: { type: "string" },
  },
  required: ["mocneStrony", "slabePunkty", "wiadomoscOutreach"],
};

function buildPrompt(company) {
  const s = company.socials || {};
  const socialList =
    Object.entries(s)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(", ") || "brak";

  return `Jesteś ekspertem ds. marketingu i sprzedaży B2B. Przeanalizuj poniższą firmę z wizytówki Google Maps pod kątem jej obecności online i przygotuj materiał do oferty współpracy (np. tworzenie strony, prowadzenie social media, pozycjonowanie, reklamy).

DANE FIRMY:
- Nazwa: ${company.name}
- Branża/kategoria: ${company.category || "nieznana"}
- Adres: ${company.address || "brak"}
- Telefon: ${company.phone || "brak"}
- E-mail: ${company.email || "brak"}
- Dedykowana strona WWW: ${company.hasWebsiteInCard ? company.website : "BRAK (firma nie ma własnej strony)"}
- Profile społecznościowe: ${socialList}
- Ocena Google: ${company.rating ?? "brak"} (${company.reviewsCount || 0} opinii)

ZADANIE:
Zwróć obiekt JSON z trzema polami:
1. "mocneStrony" — tablica 2–4 konkretnych mocnych stron firmy (np. wysoka ocena, dużo opinii, aktywny Instagram).
2. "slabePunkty" — tablica 2–4 słabych punktów w obecności online (np. brak strony www, mało opinii, brak Instagrama, brak e-maila kontaktowego).
3. "wiadomoscOutreach" — gotowa, spersonalizowana wiadomość ofertowa po polsku (3–5 zdań), zwracająca się do firmy po nazwie, nawiązująca do konkretnych słabych punktów i proponująca pomoc. Ton: profesjonalny, ciepły, bez nachalności. Bez nagłówka "Temat:".

Pisz wyłącznie po polsku. Bądź konkretny i opieraj się na powyższych danych.`;
}

app.post("/api/analyze", async (req, res) => {
  const key = req.header("x-gemini-key") || "";
  if (!key) return res.status(400).json({ error: "Brak klucza Gemini (nagłówek x-gemini-key)." });

  const company = req.body?.company;
  if (!company || !company.name) return res.status(400).json({ error: "Brak danych firmy do analizy." });

  const payload = {
    contents: [{ role: "user", parts: [{ text: buildPrompt(company) }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: ANALYSIS_SCHEMA,
      temperature: 0.7,
    },
  };

  try {
    const r = await fetch(`${GEMINI_BASE}/models/${GEMINI_MODEL}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key,
      },
      body: JSON.stringify(payload),
    });

    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({
        error: data?.error?.message || "Gemini odrzucił żądanie analizy.",
      });
    }

    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Awaryjnie: wytnij blok JSON, gdyby model dodał otoczkę.
      const match = text.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : null;
    }

    if (!parsed) return res.status(502).json({ error: "Nie udało się sparsować odpowiedzi AI." });

    return res.json({
      mocneStrony: parsed.mocneStrony || [],
      slabePunkty: parsed.slabePunkty || [],
      wiadomoscOutreach: parsed.wiadomoscOutreach || "",
    });
  } catch (err) {
    return res.status(502).json({ error: `Błąd połączenia z Gemini: ${err.message}` });
  }
});

/* ============================================================ */

app.get("/api/health", (_req, res) => res.json({ ok: true, model: GEMINI_MODEL, actor: APIFY_ACTOR_ID }));

// Domyślnie nasłuch na "::" = IPv6 (dual-stack łapie też IPv4) — wymagane przez subdomeny mikr.us.
// Gdyby IPv6 było niedostępne, automatycznie przełączamy się na IPv4 (0.0.0.0).
const HOST = process.env.HOST || "::";

function startServer(host) {
  const server = app.listen(PORT, host, () => {
    console.log(`\n  ⚡ AI LeadScrape Outreach Engine`);
    console.log(`  → nasłuch na ${host === "::" ? "[::]" : host}:${PORT}\n`);
  });
  server.on("error", (err) => {
    if (err.code === "EAFNOSUPPORT" && host === "::") {
      console.warn("  ⚠ IPv6 niedostępne — przełączam na IPv4 (0.0.0.0)");
      startServer("0.0.0.0");
    } else {
      console.error(`  ✖ Błąd nasłuchu: ${err.message}`);
      process.exit(1);
    }
  });
}

startServer(HOST);
