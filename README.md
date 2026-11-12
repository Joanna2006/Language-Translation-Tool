# Lingua – Language Translation Tool

A modern, responsive translation web app (HTML + CSS + JavaScript) with a small
Node.js backend that talks to a real translation API. API keys stay on the server.

## Features
Text input · Auto-detect source language · Target language · Translate button ·
Output panel · Copy · Swap languages · Clear · Loading animation · Listen (text-to-speech) ·
Character counter · Ctrl+Enter shortcut · Error messages for empty input, API errors and network problems.

## Folder structure
```
translator/
├── server.js            # Node.js backend (static server + /api/translate proxy)
├── package.json
├── .env.example         # Copy to .env and configure
├── .gitignore
├── README.md
└── public/
    ├── index.html       # Page structure
    ├── css/
    │   └── style.css    # Blue & white responsive theme
    └── js/
        └── script.js    # UI logic, fetch calls
```

## Install and run
Requirements: **Node.js 18 or newer** (no npm packages to install).

```bash
cd translator
cp .env.example .env     # Windows: copy .env.example .env
node server.js           # or: npm start
```
Open **http://localhost:3000**. It works immediately with the default free provider (MyMemory, no key).

## API configuration (edit `.env`, then restart the server)

| Provider | `TRANSLATE_PROVIDER` | What you need |
|---|---|---|
| MyMemory (default) | `mymemory` | Nothing. Optionally set `MYMEMORY_EMAIL` to raise the free daily limit. |
| LibreTranslate | `libretranslate` | `LIBRETRANSLATE_URL` and, for libretranslate.com, `LIBRETRANSLATE_API_KEY`. Or self-host it for free: `docker run -p 5000:5000 libretranslate/libretranslate` and set `LIBRETRANSLATE_URL=http://localhost:5000`. |
| Google Cloud Translation | `google` | Enable "Cloud Translation API" in Google Cloud, create an API key, set `GOOGLE_API_KEY`. |

Example (Google):
```
TRANSLATE_PROVIDER=google
GOOGLE_API_KEY=your-key-here
```

## How it works
Browser → `POST /api/translate {text, source, target}` → `server.js` → translation API → response.
The backend validates input, limits text to 5,000 characters, rate-limits to 30 requests/minute per IP,
and splits long text into chunks for MyMemory.

## Troubleshooting
- **"Could not reach the translation service"** – check your internet connection / `LIBRETRANSLATE_URL`.
- **Daily limit reached** – set `MYMEMORY_EMAIL`, wait, or switch provider.
- **A language isn't supported** – self-hosted LibreTranslate supports a subset; use Google or MyMemory for the full list.
- Port in use – change `PORT` in `.env`.
