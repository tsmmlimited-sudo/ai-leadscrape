# ⚡ AI LeadScrape Outreach Engine

Inteligentna maszyna do pozyskiwania leadów B2B: scrapowanie wizytówek Google Maps
(przez **Apify**) + natychmiastowy audyt marketingowy i generowanie ofert sprzedażowych
przez **Google Gemini**.

## Co potrafi

- **Scraping Google Maps** — aktor `compass/crawler-google-places` z `scrapeContacts: true`
  (odwiedza strony firm i wyciąga e-maile oraz linki do social mediów).
- **Tryb asynchroniczny** — aktor startuje w tle, frontend odpytuje status co 4 s,
  pokazując pasek postępu i stoper (brak timeoutów HTTP).
- **Normalizacja leadów** — jeśli „witryna” z wizytówki to w rzeczywistości profil
  Instagram / Facebook / TikTok, system przepisuje go jako social, czyści pole WWW
  i ustawia `hasWebsiteInCard = false`.
- **Widoki i filtry** — kafelki / tabela, filtry „z e-mailem”, „z Instagramem”,
  „ze stroną WWW”, „bez strony WWW”.
- **Eksport** — CSV (UTF-8 BOM dla Excela) oraz JSON.
- **Analiza AI** — model `gemini-3.5-flash` zwraca ustrukturyzowany JSON: mocne strony,
  słabe punkty i gotową, spersonalizowaną wiadomość ofertową po polsku. Kopiowanie jednym kliknięciem.

## Wymagania

- Node.js **18+** (używany jest wbudowany `fetch`).
- Token API Apify oraz klucz API Google Gemini.

## Uruchomienie

```bash
npm install
npm start
```

Aplikacja wystartuje pod adresem **http://localhost:3000**.

Przy pierwszym wejściu pojawi się okno na klucze API — wpisz **Apify Token** i **Gemini API Key**.
Są one zapisywane wyłącznie w `localStorage` Twojej przeglądarki; serwer ich nie przechowuje
(działa jako cienkie proxy, przekazując klucze w nagłówkach `x-apify-token` / `x-gemini-key`).

## Architektura

```
ai-leadscrape/
├── server.js            # Express: proxy Apify + Gemini, normalizacja leadów
├── package.json
└── public/              # statyczny frontend (bez frameworków)
    ├── index.html
    ├── css/style.css
    └── js/app.js
```

### Endpointy API

| Metoda | Ścieżka | Opis |
| --- | --- | --- |
| POST | `/api/scrape/start` | uruchamia aktora Apify (asynchronicznie) |
| GET | `/api/scrape/status/:runId` | status runu (polling) |
| GET | `/api/scrape/results/:datasetId` | pobranie i normalizacja wyników |
| POST | `/api/analyze` | analiza firmy modelem Gemini |

## Uwagi

- Koszty scrapowania nalicza Apify, a analizy — Google (wg cennika `gemini-3.5-flash`).
- Limit wyników jest ograniczony w backendzie do 500 na bezpieczeństwo.
- Scrapuj odpowiedzialnie i zgodnie z regulaminami źródeł oraz przepisami o danych osobowych (RODO).
