# opencode-delegate — Documento di requisiti

**Versione:** 1.0
**Data:** 22 agosto 2026
**Destinatario:** coding assistant incaricato dell'implementazione
**Piattaforma target:** macOS (Apple Silicon e Intel), Node.js ≥ 18

---

## 1. Obiettivo

Costruire un plugin per **Claude Code** che esponga **opencode** come subagente di prima classe: Claude (Opus) delega task di implementazione a opencode, che li esegue in isolamento, e Claude ne verifica il risultato prima di accettarlo.

Il valore è economico e cognitivo: il lavoro meccanico e voluminoso viene eseguito da modelli open a basso costo tramite l'abbonamento **opencode Go**, mentre Claude resta orchestratore, revisore e decisore.

### 1.1 Cosa deve succedere, in concreto

1. L'utente (o Claude stesso) invoca il subagente `@opencode-delegate:opencode`.
2. Il subagente interroga il catalogo modelli e **sceglie il modello in base alla difficoltà del task**.
3. Delega a opencode in modo asincrono, dentro una git worktree isolata.
4. Monitora l'avanzamento, gestisce le richieste di permesso, intercetta i blocchi.
5. Verifica il diff prodotto e riporta un giudizio onesto al thread principale.

---

## 2. Non-goal

Fuori scope per la v1. Non implementare:

- Esecuzione di opencode su macchine remote o in container.
- Deleghe parallele multiple sullo stesso repository.
- Integrazione ACP (`opencode acp`): Claude Code non è un client ACP.
- UI, dashboard, notifiche desktop.
- Auto-merge del lavoro di opencode: il merge resta una decisione umana o di Claude nel thread principale.
- Gestione di provider opencode diversi da `opencode-go` (l'architettura non deve però impedirlo: il provider è un campo di configurazione).

---

## 3. Vincoli architetturali

Questi vincoli sono decisioni già prese. Non rinegoziarli senza segnalarlo.

| # | Vincolo | Motivazione |
|---|---------|-------------|
| V1 | Il subagente accede a opencode **esclusivamente tramite tool MCP**, mai tramite Bash | Confinamento per costruzione: il subagente non può fare altro che delegare e leggere |
| V2 | Il server MCP è **un singolo file Node senza dipendenze npm** | Evita `package.json` + lockfile e l'installazione automatica delle dipendenze del plugin, con i suoi timeout e modalità di fallimento |
| V3 | L'isolamento usa `isolation: "worktree"` nativo di Claude Code | L'harness crea e distrugge la worktree; niente `git worktree add` manuale |
| V4 | La delega è **bloccante** in v1 (`background: false`) | Molto più semplice da debuggare; il passaggio a background è previsto in fase 2 |
| V5 | Tutta la conoscenza sui modelli vive in **un unico file JSON**, non nel codice | Il catalogo Go cambia spesso; l'aggiornamento deve essere un'edit di JSON |
| V6 | Il server MCP non deve mai scrivere dentro i file di configurazione dell'utente (`~/.config/opencode/opencode.json`, `opencode.json` di progetto) | Il plugin deve essere rimovibile senza residui |

---

## 4. Struttura del plugin

```
opencode-delegate/
├── .claude-plugin/
│   └── plugin.json
├── .mcp.json
├── config/
│   └── models.json          ← IL file da editare per aggiornare i modelli
├── mcp/
│   └── server.mjs           ← server MCP, zero dipendenze
├── agents/
│   └── opencode.md          ← definizione del subagente
└── README.md
```

### 4.1 `.claude-plugin/plugin.json`

```json
{
  "name": "opencode-delegate",
  "displayName": "opencode Delegate",
  "version": "1.0.0",
  "description": "Delega task di implementazione a opencode e ne verifica il risultato",
  "license": "MIT"
}
```

### 4.2 `.mcp.json`

```json
{
  "mcpServers": {
    "oc": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs"],
      "env": {
        "OC_MODELS_CONFIG": "${CLAUDE_PLUGIN_ROOT}/config/models.json"
      }
    }
  }
}
```

I tool risulteranno esposti con nomi scoped nella forma
`mcp__plugin_opencode-delegate_oc__<tool>`.
Questi nomi vanno usati **testualmente** nel campo `tools` del frontmatter dell'agent: se sbagliati, l'agent si carica ma resta senza strumenti e fallisce in silenzio.

---

## 5. `config/models.json` — requisito centrale

È il file che l'utente edita per aggiornare il catalogo, i tier e lo sforzo di ragionamento. Deve essere **autoesplicativo**, con un campo `use` in italiano per ogni modello che descrive quando sceglierlo.

### 5.1 Schema

```jsonc
{
  "version": 1,
  "provider": "opencode-go",

  "defaults": {
    "tier": 1,
    "timeoutSec": 900,
    "agent": "build"
  },

  // Politica di reasoning effort.
  //   "max"     → per ogni modello si usa la variante più profonda disponibile (DEFAULT RICHIESTO)
  //   "perTier" → si usa la mappa perTier qui sotto
  //   "off"     → nessuna variante, modello base
  "effortPolicy": {
    "mode": "max",
    "perTier": { "0": "off", "1": "high", "2": "max", "3": "max" }
  },

  // Ordine di preferenza globale per la risoluzione della variante.
  // Il primo id presente nel catalogo live del modello vince.
  "variantPreference": {
    "max":  ["max", "xhigh", "high", "deep", "thinking"],
    "high": ["high", "medium", "thinking"],
    "off":  []
  },

  "models": [
    {
      "id": "mimo-v2.5",
      "tier": 0,
      "use": "Trasformazioni puramente sintattiche: rename di massa, format, fix di import, boilerplate ripetitivo. Nessun giudizio richiesto.",
      "cost": { "in": 0.14, "out": 0.28 }
    },
    {
      "id": "kimi-k2.7-code",
      "tier": 1,
      "default": true,
      "use": "Default per la maggior parte delle deleghe. Serve capire il codice esistente ma non progettarlo: scrittura test, refactor su file singolo, porting.",
      "cost": { "in": 0.95, "out": 4.00 }
    },
    {
      "id": "minimax-m3",
      "tier": 1,
      "use": "Alternativa al default. Buono su task descritti in modo verboso.",
      "cost": { "in": 0.30, "out": 1.20 }
    },
    {
      "id": "deepseek-v4-flash",
      "tier": 1,
      "use": "Batch grossi ed economici. Attenzione alle fasce orarie DeepSeek (vedi §5.4).",
      "cost": { "in": 0.22, "out": 0.66 },
      "offPeakOnly": false
    },
    {
      "id": "glm-5.2",
      "tier": 2,
      "use": "Refactor multi-file con dipendenze tra loro, migrazioni con edge case da individuare.",
      "cost": { "in": 1.40, "out": 4.40 }
    },
    {
      "id": "deepseek-v4-pro",
      "tier": 2,
      "use": "Complesso con buon ragionamento sul codice.",
      "cost": { "in": 1.32, "out": 3.96 }
    },
    {
      "id": "kimi-k3",
      "tier": 3,
      "use": "Molto complesso. CARO: ~110 richieste ogni 5 ore. Se stai per sceglierlo, valuta se il task vada delegato affatto.",
      "cost": { "in": 3.00, "out": 15.00 }
    }
  ],

  "excluded": [
    {
      "id": "muse-spark-1.2-contributor",
      "reason": "I prompt e le completion vengono usati per addestrare futuri modelli Meta. Vietato su codice di lavoro."
    }
  ],

  "budget": {
    "per5h": 12,
    "perWeek": 30,
    "perMonth": 60,
    "note": "I limiti Go sono in dollari, non in richieste. Un task su kimi-k3 costa circa 12 volte lo stesso task su kimi-k2.7-code."
  }
}
```

### 5.2 Requisiti funzionali sul file

- **RF-1** — Il server legge `models.json` all'avvio e a ogni chiamata del tool `models` se il file è cambiato (confronto `mtime`). Editare il file non deve richiedere il riavvio di Claude Code.
- **RF-2** — Un JSON malformato non deve mandare in crash il server MCP. Deve produrre un errore leggibile nel risultato del tool, indicando file e posizione dell'errore.
- **RF-3** — I modelli in `excluded` non devono **mai** comparire tra quelli selezionabili, e il tool `delegate` deve rifiutarli con un errore esplicito anche se richiesti direttamente.
- **RF-4** — Un modello presente nel catalogo live ma assente da `models.json` va comunque esposto dal tool `models`, marcato `"tier": null, "unclassified": true`, così che l'aggiunta di nuovi modelli Go sia visibile senza aggiornare il file.
- **RF-5** — Un modello presente in `models.json` ma assente dal catalogo live va marcato `"available": false` e non deve essere selezionabile.

### 5.3 Risoluzione modello + variante — algoritmo obbligatorio

Questo è il punto più delicato dell'implementazione.

Il riferimento a un modello in opencode ha la forma `provider/model` con variante opzionale dopo `#`, per esempio `opencode-go/glm-5.2#high`. Le varianti sono sovrapposizioni di parametri sulla richiesta, tipicamente usate per l'effort di ragionamento, **e i nomi disponibili dipendono dal modello**: non si può assumere che `low`, `high` o `max` esistano ovunque. Una variante inesistente **fa fallire la risoluzione del modello**, non ricade silenziosamente sul modello base.

Ne segue l'algoritmo:

```
risolvi(modelId, effortRichiesto):
  1. leggi le varianti disponibili per modelId dal catalogo live
     (GET /config/providers, oppure GET /provider — vedi §11)
  2. lista = variantPreference[effortRichiesto]
  3. per ogni v in lista:
        se v esiste tra le varianti del modello → ritorna "provider/modelId#v"
  4. se il modello ha customVariant in models.json → inietta la variante
     via config a runtime (§5.5) e ritorna "provider/modelId#<customVariant.id>"
  5. altrimenti → ritorna "provider/modelId" (modello base) e includi nel
     risultato del tool il campo effortApplied: "none", con motivo
```

- **RF-6** — Non inviare mai una variante non verificata contro il catalogo live.
- **RF-7** — Il risultato di `delegate` deve sempre riportare `modelRef` effettivamente usato e `effortApplied` (`"max"` / `"high"` / `"none"`), così che Claude sappia con cosa ha lavorato.
- **RF-8** — La risoluzione va cachata per 10 minuti, invalidata se `models.json` cambia.

### 5.4 Nota su DeepSeek

Le fasce di picco DeepSeek sono 01:00–04:00 e 06:00–10:00 UTC; nelle altre ore il prezzo è dimezzato. In ora italiana (CEST) il picco cade 03:00–06:00 e 08:00–12:00. Il tool `models` deve calcolare a runtime se il momento corrente è off-peak e includere il flag `offPeakNow: true|false` nella descrizione dei modelli DeepSeek, così che Claude possa preferirli nel pomeriggio.

### 5.5 Varianti custom iniettate a runtime

Per i modelli senza variante nel catalogo ma il cui provider accetta `reasoningEffort`, `models.json` può dichiarare:

```jsonc
{
  "id": "glm-5.2",
  "customVariant": {
    "id": "oc-max",
    "settings": { "reasoningEffort": "high" }
  }
}
```

Il server deve iniettare queste definizioni **senza toccare i file dell'utente**, passando la configurazione inline all'avvio del processo `opencode serve` tramite la variabile d'ambiente `OPENCODE_CONFIG_CONTENT`.

- **RF-9** — Verificare sperimentalmente se `OPENCODE_CONFIG_CONTENT` **sostituisce** o **fonde** la configurazione utente. Se sostituisce, ripiegare su un file temporaneo passato con `OPENCODE_CONFIG`, generato includendo la config utente esistente. Documentare l'esito nel README.

---

## 6. Tool MCP — contratti

Protocollo JSON-RPC 2.0 su stdio, un messaggio per riga. Metodi da implementare: `initialize`, `tools/list`, `tools/call`. Ogni altro metodo con `id` risponde `-32601`.

Ogni tool accetta `cwd` (obbligatorio): è la directory di lavoro, cioè la worktree corrente del subagente. Determina l'istanza di opencode server da usare.

### 6.1 `models`

Elenca i modelli disponibili con tier, uso consigliato, costo e disponibilità.

**Input:** `{ cwd: string }`
**Output:**
```jsonc
{
  "available": [
    { "model": "opencode-go/kimi-k2.7-code", "tier": 1, "default": true,
      "use": "...", "variants": ["high","max"], "cost": {...}, "available": true }
  ],
  "excluded": [ { "model": "...", "reason": "..." } ],
  "effortPolicy": "max",
  "budget": { "per5h": 12, "...": "..." },
  "hint": "Parti dal tier più basso plausibile..."
}
```

- **RF-10** — Il tool deve essere invocabile **anche dal thread principale**, non solo dal subagente, così che Opus possa scegliere il modello e passarlo esplicitamente alla delega.

### 6.2 `delegate`

**Input:**
```jsonc
{
  "task": "string, obbligatorio",     // obiettivo + file in scope + criteri + comando di test
  "cwd": "string, obbligatorio",
  "model": "string, opzionale",       // es. "opencode-go/glm-5.2"; default = models.json
  "effort": "max|high|off, opzionale" // default = effortPolicy.mode
}
```

**Comportamento:**
1. Assicura un server opencode attivo per `cwd` (§7).
2. Risolve modello e variante (§5.3).
3. `POST /session` per creare la sessione.
4. `POST /session/:id/prompt_async` con il task **più il contratto operativo** (§9).
5. Registra il task nello stato persistente.

**Output:** `{ sessionID, modelRef, effortApplied, cwd, startedAt }`

### 6.3 `wait`

**Input:** `{ sessionID, cwd, timeoutSec? }` (default da `models.json`)

Polling ogni 5 secondi. Ritorna quando si verifica **una** di queste condizioni:

| Condizione | Output |
|---|---|
| Sessione idle/completa | `{ done: true, status, todo, files, last }` |
| Richiesta di permesso pendente | `{ needsInput: true, kind: "permission", permissionID, title }` |
| Timeout | `{ done: false, timeout: true, ...snapshot }` |

### 6.4 `status`

Snapshot istantaneo senza attesa. Stesso payload di `wait` ma senza bloccare.
Aggrega: `GET /session/status`, `GET /session/:id/todo`, `GET /session/:id/diff`, `GET /session/:id/message?limit=2`.

- **RF-11** — Il tool restituisce i dati grezzi che riceve, con parsing minimo. Se un endpoint risponde 404 (drift di schema), il campo corrispondente vale `null` e il tool non fallisce.

### 6.5 `respond`

**Input:** `{ sessionID, cwd, permissionID, response: "once"|"always"|"reject" }`
Chiama `POST /session/:id/permissions/:permissionID`.

### 6.6 `abort`

**Input:** `{ sessionID, cwd }` → `POST /session/:id/abort`.

---

## 7. Gestione del server opencode

- **RF-12** — Un'istanza `opencode serve` **per directory di lavoro**, avviata on-demand, in ascolto solo su `127.0.0.1`.
- **RF-13** — Porta derivata deterministicamente dall'hash della `cwd` nel range 4100–4499.
- **RF-14** — Avvio detached, stdout/stderr su `~/.opencode-delegate/serve-<porta>.log`. Health check su `GET /global/health` con polling di 500 ms fino a 30 secondi; oltre, errore leggibile che cita il path del log.
- **RF-15** — Stato persistente in `~/.opencode-delegate/tasks.json`: per ogni delega `{ id, cwd, port, modelRef, effortApplied, task, startedAt }`.
- **RF-16** — Nessuna terminazione automatica dei server all'uscita della sessione Claude Code (una delega potrebbe essere ancora in corso). Fornire nel README il comando di pulizia manuale: `pkill -f "opencode serve"`.

---

## 8. Gestione permessi e richieste di input

Quattro canali distinti, gestiti separatamente.

### 8.1 Prevenzione: permessi espliciti allo spawn

Passare `OPENCODE_PERMISSION` all'avvio del server con allow/deny espliciti e **nessuna zona grigia** (ogni `ask` in headless è un deadlock):

```json
{
  "edit": "allow",
  "webfetch": "allow",
  "bash": {
    "*": "allow",
    "git push*": "deny",
    "git commit*": "deny",
    "rm -rf*": "deny",
    "sudo*": "deny"
  }
}
```

- **RF-17** — Verificare il formato esatto contro la documentazione permessi di opencode prima di considerarlo funzionante: una chiave sbagliata non impedisce l'avvio del server, il problema emerge solo al primo `edit` bloccato. Aggiungere un test di fumo che deleghi una modifica banale a un file e verifichi che venga applicata senza intervento.

### 8.2 Intercettazione: listener SSE

- **RF-18** — Sottoscrivere `GET /event` per ogni server attivo, con riconnessione automatica ogni 2 secondi in caso di caduta.
- **RF-19** — Sugli eventi di permesso: auto-approvare (`always`) i comandi read-only e di test riconosciuti da whitelist regex; auto-rifiutare (`reject`) i pattern distruttivi; **mettere tutto il resto in coda pendente** e farlo emergere da `wait` come `needsInput`.
- **RF-20** — La whitelist e la blacklist devono stare in `models.json` sotto una chiave `permissions`, non nel codice.

### 8.3 Escalation: contratto di output

Vedi §9. Le domande di chiarimento non devono essere poste in chat (nessuno le legge): devono materializzarsi come `STATUS: BLOCKED` nel file di report.

### 8.4 Regola di escalation

L'unica cosa che deve arrivare all'utente è `STATUS: BLOCKED`, cioè la mancanza di contesto di dominio. Permessi e ambiguità tecniche li risolve il subagente.

---

## 9. Contratto operativo iniettato nel prompt

Il server appende a ogni task delegato questo blocco, con `${cwd}` sostituito:

```
## Regole operative
- Lavora SOLO dentro ${cwd}. NON committare, NON pushare, NON cambiare branch.
- A fine lavoro scrivi .oc-report.md la cui PRIMA RIGA deve essere esattamente una di:
  STATUS: DONE      — completato e testato
  STATUS: PARTIAL   — parzialmente fatto, elenca sotto cosa manca
  STATUS: BLOCKED   — non posso procedere, scrivi sotto LA DOMANDA precisa
- Sotto: file toccati, cosa hai fatto, cosa NON hai fatto, test eseguiti e loro output.
- Non chiedere nulla in chat: nessuno la legge. Se hai un dubbio → STATUS: BLOCKED.
```

- **RF-21** — Il testo del contratto deve stare in `models.json` sotto la chiave `contract`, per poterlo affinare senza toccare il codice.

---

## 10. `agents/opencode.md`

```markdown
---
name: opencode
description: Esegue implementazione meccanica e voluminosa delegandola a opencode in una worktree isolata. Usare per refactor ripetitivi, scrittura di test, boilerplate, migrazioni di sintassi, porting. NON usare per decisioni architetturali o debugging che richiede giudizio.
model: haiku
maxTurns: 12
isolation: worktree
tools: mcp__plugin_opencode-delegate_oc__models, mcp__plugin_opencode-delegate_oc__delegate, mcp__plugin_opencode-delegate_oc__wait, mcp__plugin_opencode-delegate_oc__status, mcp__plugin_opencode-delegate_oc__respond, mcp__plugin_opencode-delegate_oc__abort, Read, Glob, Grep
---
```

Il corpo del prompt di sistema deve coprire, in quest'ordine:

1. **Ruolo** — supervisore, non esecutore. Non scrive codice.
2. **Scelta del modello** — se il chiamante ha indicato un modello, usarlo senza discutere. Altrimenti chiamare `models` e scegliere per tier:
   - tier 0: nessun giudizio richiesto, trasformazione sintattica
   - tier 1: default, serve capire il codice ma non progettarlo
   - tier 2: più file con dipendenze, edge case da individuare
   - tier 3: quasi mai; se lo si sta scegliendo, fermarsi e riportare che il task probabilmente non va delegato
   - Nel dubbio scendere di un tier: un fallimento su tier 1 costa meno di un successo su tier 3 e lo si scopre in due minuti.
3. **Scrittura del task** — deve contenere obiettivo, file in scope, criteri di accettazione verificabili, comando di test. Se la richiesta ricevuta è vaga, renderla specifica **prima** di delegare.
4. **Ciclo** — `delegate` → `wait` → verifica.
5. **Verifica obbligatoria** — leggere `.oc-report.md` **e** leggere i file elencati in `files`. Non fidarsi mai del report da solo.
6. **Gestione input** — `needsInput` di tipo permesso: decide il subagente con `respond` (approva read-only e test, rifiuta git remoto, cancellazioni fuori scope, download-ed-esegui; nel dubbio `reject`). `STATUS: BLOCKED`: non inventare il contesto mancante, riportare la domanda testuale e fermarsi. `STATUS: PARTIAL`: riportare cosa manca, non rilanciare in automatico. Timeout: `abort` e riportare il fallimento, mai lasciare appeso.
7. **Report finale** — cosa è stato fatto, cosa no, cosa va rivisto a mano, e un giudizio esplicito: diff accettabile o da rifare.
8. **Limite di retry** — massimo un ritentativo, e solo salendo di un tier.

---

## 11. Punti da verificare in fase di implementazione

opencode è in migrazione verso un'API v2 e la documentazione riporta forme diverse a seconda della versione. **Non assumere: verificare contro `http://127.0.0.1:<porta>/doc` della versione installata**, e documentare l'esito nel README.

| # | Da verificare | Perché conta |
|---|---|---|
| P1 | Forma del selettore modello nel body di `/session/:id/message` e `/prompt_async`: `{ providerID, modelID }` oppure `{ providerID, model }` | Sbagliarlo fa fallire ogni delega |
| P2 | Se la variante si passa dentro il selettore o come stringa `provider/model#variant` | Requisito reasoning effort |
| P3 | Endpoint del catalogo con le varianti per modello: `/config/providers` o `/provider` | Requisito §5.3 |
| P4 | Prefisso `/api/` degli endpoint nella versione installata | 404 su tutto se sbagliato |
| P5 | Valori accettati da `POST /session/:id/permissions/:permissionID` (`once` / `always` / `reject`) | 400 sulle risposte ai permessi |
| P6 | Forma dei campi negli eventi SSE di permesso (`sessionID`, `permissionID`, annidamento) | Il listener non aggancia nulla |
| P7 | Semantica di `OPENCODE_CONFIG_CONTENT`: sostituisce o fonde | §5.5 |
| P8 | Formato di `OPENCODE_PERMISSION` | §8.1 |

---

## 12. Criteri di accettazione

L'implementazione è completa quando tutti questi passano su macOS, verificati manualmente e documentati.

**Installazione**
- **CA-1** — `claude --plugin-dir ./opencode-delegate` carica il plugin senza errori in `claude --debug`.
- **CA-2** — `/agents` mostra `opencode-delegate:opencode` con tutti e sei i tool MCP effettivamente assegnati.

**Catalogo**
- **CA-3** — Invocare `models` dal thread principale restituisce i modelli con tier, uso e varianti disponibili.
- **CA-4** — Aggiungere un modello a `models.json` lo rende visibile alla chiamata successiva **senza riavviare Claude Code**.
- **CA-5** — Un `models.json` volutamente malformato produce un errore leggibile, non un crash del server MCP.
- **CA-6** — Un modello in `excluded` richiesto esplicitamente a `delegate` viene rifiutato con motivo.

**Reasoning effort**
- **CA-7** — Con `effortPolicy.mode: "max"`, `delegate` riporta `effortApplied: "max"` e un `modelRef` con suffisso `#variante` per almeno un modello che ha varianti nel catalogo.
- **CA-8** — Per un modello **senza** varianti, `delegate` non fallisce: usa il modello base e riporta `effortApplied: "none"` con motivo.
- **CA-9** — Passando `effort: "off"` esplicitamente, il `modelRef` non contiene `#`.

**Ciclo di delega**
- **CA-10** — Delega end-to-end su un repo di prova ("aggiungi un test per la funzione X"): la worktree contiene il diff, `.oc-report.md` esiste e inizia con `STATUS:`.
- **CA-11** — `wait` ritorna entro il timeout con `done: true` e `files` popolato.
- **CA-12** — Un task volutamente ambiguo produce `STATUS: BLOCKED` e il subagente riporta la domanda al thread principale **senza inventare la risposta**.
- **CA-13** — `abort` su una sessione in corso la interrompe entro 10 secondi.
- **CA-14** — Un comando negato (es. il modello tenta `git push`) viene rifiutato automaticamente e la sessione prosegue o si ferma pulita, senza deadlock.

**Robustezza**
- **CA-15** — Se `opencode` non è installato o il server non parte, il tool restituisce un errore che cita il path del file di log.
- **CA-16** — Due deleghe su due repository diversi usano porte diverse e non interferiscono.

---

## 13. Fase 2 (non implementare ora, ma non precludere)

- `background: true` sull'agent per delega non bloccante, con il task panel di Claude Code come superficie di monitoraggio. Attenzione: la coda dei permessi pendenti vive in memoria del server MCP e non sopravvive alla sessione, quindi una richiesta di permesso su una delega in background resta appesa lato opencode.
- Monitor del plugin (`monitors/monitors.json`) che consuma lo stream SSE e spinge notifiche in sessione, così Claude reagisce al "task finito" senza polling.
- Deleghe parallele su worktree multiple con un tool `list` che aggrega lo stato di tutte.
- Tracking del consumo cumulativo contro i limiti Go, con warning quando ci si avvicina alla soglia delle 5 ore.

---

## 14. Nota sul costo — leggere prima di implementare

Il requisito "reasoning effort al massimo per ogni modello" è implementato come richiesto, ma va compreso il trade-off: i token di ragionamento sono token di **output**, e l'output costa da 3 a 5 volte l'input. Su un task di tier 0 il ragionamento profondo è spreco puro e consuma il budget di 12 dollari ogni 5 ore molto più in fretta.

Per questo `effortPolicy` prevede il modo `perTier`: la raccomandazione, dopo la prima settimana d'uso reale, è passare a `perTier` con `{"0": "off", "1": "high", "2": "max", "3": "max"}` e confrontare la qualità dei diff. Se non peggiorano, il consumo cala in modo sensibile.

Il modo `max` resta il default della v1 come da richiesta.
