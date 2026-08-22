# OpenCode API 1.18.21 — esito probe T0

Data: 2026-08-22 · Server di prova: `opencode serve --port 4198/4199`, repo scratchpad.
Schema OpenAPI congelato: [`opencode-api-1.18.21.json`](./opencode-api-1.18.21.json).
Eventi SSE campione: [`oc-events-sample.json`](./oc-events-sample.json), [`perm-asked.json`](./perm-asked.json).

## P1 — Selettore modello in `prompt_async`

**Risolto.** Campo annidato obbligatorio:

```jsonc
{
  "parts": [{ "type": "text", "text": "..." }],
  "model": { "providerID": "opencode", "modelID": "glm-5.2" }
}
```

Stringa piatta (`"model": "opencode/glm-5.2"`) → `400 BadRequest`:
`Expected object | null, got "opencode/glm-5.2" at ["model"]`.

## P2 — Dove viaggia la variante

**Risolto, ipotesi forte confermata.** La variante è un **campo top-level del body,
fratello di `model`** — né dentro l'oggetto model, né suffisso `#`:

```jsonc
{ "parts": [...], "model": {...}, "variant": "max" }
```

Verificato live con `x-preview-f-free` + `variant: "max"`: il messaggio assistant
registra `"variant": "max"` e risponde correttamente.

⚠️ **Il server NON valida la variante**: submit con `"variante-fasulla-999"` →
`204` accettato, **fallback silenzioso al modello base**, risposta comunque
corretta (il messaggio registra la stringa fasulla ma nessun errore). Conseguenza:
la validazione contro le varianti reali del catalogo **deve stare nel client**
(`resolve.mjs`), mai delegata al server. `effortApplied` va calcolato da noi.

## P5 — Risposta ai permessi

**Risolto, verificato live end-to-end.**

- Elenco pendenti: `GET /permission` → array:
  ```jsonc
  [{
    "id": "per_...",
    "sessionID": "ses_...",
    "permission": "bash",
    "patterns": ["echo PERM-TEST-DONE"],
    "metadata": { "command": "echo PERM-TEST-DONE" },
    "always": ["echo *"],                       // pattern suggeriti per "always"
    "tool": { "messageID": "msg_...", "callID": "call_..." }
  }]
  ```
- Risposta: `POST /session/{sessionID}/permissions/{permissionID}`
  body `{ "response": "once" | "always" | "reject" }` → `200 true`.
  Dopo la risposta la sessione prosegue (verificato: comando eseguito).
- Alternativa globale: `POST /permission/{requestID}/reply`
  body `{ "reply": "once"|"always"|"reject", "message"? }`.

## P6 — Eventi SSE su `GET /event`

**Risolto.** Formato `text/event-stream`, righe `data: {json}\n\n`.

Tipi osservati live: `server.connected`, `server.heartbeat`,
`session.created|updated|status|diff|error|idle`, `message.updated`,
`message.part.updated`, `permission.v2.asked|replied`.

- `session.status` → `{ sessionID, status: { type: "busy" | ... } }`
- ⚠️ Lo schema OpenAPI descrive `EventPermissionV2Asked.properties` come
  `{id, sessionID, action, resources[], save[], source}` ma **l'evento reale usa**
  `{id, sessionID, permission, patterns[], metadata{command}, always[], tool}`.
  Fa fede l'evento reale (vedi `perm-asked.json`). Il parser non deve fidarsi
  dello schema per i permessi.

## P7 — `OPENCODE_CONFIG_CONTENT`

**Risolto.** **Fonde**, non sostituisce: le chiavi utente (`username`, `mcp`,
`lsp`, …) restano; le nostre chiavi si applicano sopra i default. Con
`{"permission":{"edit":"deny","webfetch":"allow"}}` il risultato è
`permission: {"edit":"deny","webfetch":"allow","*":"allow","compress":"allow"}`.

## P8 — `OPENCODE_PERMISSION` con chiave sbagliata

**Risolto — fallimento silenzioso confermato.** Chiave malformata
(`"chiave-sbagliata-xyz": {"foo":"bar"}`): **il processo parte e
`/global/health` risponde healthy**, ma ogni lettura della config fallisce:
`GET /config` → `400 {"name":"BadRequest","data":{"message":"Expected
PermissionActionConfig, got \"bar\" at [\"permission\"][\"chiave-sbagliata-xyz\"][\"foo\"]"}}`.
Server degradato. Obbligatorio validare il JSON generato prima dello spawn
(la whitelist vive già in `models.json`, quindi validiamo a load-time).

## Ritrovamenti extra

- **`/session/{sessionID}/status` NON esiste** (fallback HTML della SPA).
  Endpoint corretto: `GET /session/status` → mappa `{sessionID: {type}}`.
- Messaggi: `GET /session/{id}/message` →
  `[{ info: { role, modelID, providerID, variant?, error?, cost, tokens }, parts: [...] }]`.
- Errore a livello messaggio: `info.error = { name: "APIError", data: { message,
  statusCode, isRetryable, responseBody } }` — visto `CreditsError 401`
  (saldo esaurito) su glm-5.2.
- `POST /prompt_async` risponde `204 No Content`. `POST /abort` → `200`.

## Recupero catalogo modelli (punto critico segnalato)

Due fonti producono lo stesso JSON:

1. **CLI**: `opencode models opencode --verbose` — blocchi `opencode/<id>`
   seguiti da JSON pretty-print. Il parsing ingenuo (regex/split righe) si
   rompe sui blocchi annidati; serve **brace-counting**. Validato: 62/62 modelli.
2. **HTTP (preferita)**: `GET /config/providers` →
   `{ providers: [{ id, name, source, env, key, options, models: { <id>: <stesso
   JSON del CLI> } }], default }` — strutturato, zero parsing.

Decisione: `catalog.mjs` a runtime usa **solo** `/config/providers`;
`sync-models.mjs` supporta `--live` (endpoint HTTP) con fallback al parse CLI.

### Dati verificati (tabella del piano confermata)

| id | varianti | costo in/out |
|---|---|---|
| `mimo-v2.5-free` | nessuna | 0 / 0 |
| `nemotron-3.5-lightning-free` | nessuna | 0 / 0 |
| `kimi-k2.7-code` | **nessuna** (CA-8) | 0.95 / 4.00 |
| `minimax-m3` | nessuna | 0.30 / 1.20 |
| `deepseek-v4-flash` | low, high, max | 0.14 / 0.28 |
| `deepseek-v4-pro` | high, max | 1.74 / 3.84 |
| `glm-5.2` | high, max (niente customVariant) | 1.40 / 4.40 |
| `kimi-k3` | max | 3.00 / 15.00 |
| `qwen3.5-plus` | high, max | 0.20 / 1.20 |
| `qwen3.6-plus` | high, max | 0.50 / 3.00 |
| `muse-spark-1.2-contributor-free` | minimal…xhigh | 0 / 0 |

Il catalogo completo conta **62 modelli** (famiglie claude/gpt/gemini/grok…
su Zen): tutto ciò che non è curato entra come `tier: null, unclassified: true`.

### Contratto finale del body prompt (P1+P2)

`buildModelSelector(modelId, variant)` produce:

```jsonc
{ "model": { "providerID": "opencode", "modelID": "<id>" },
  "variant": "<variante|null - omessa se null>" }
```
