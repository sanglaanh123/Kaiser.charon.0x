# Kaiser.Charon.0x

![node](https://img.shields.io/badge/node-22-339933?style=flat-square&logo=node.js&logoColor=white)
![chain](https://img.shields.io/badge/network-solana-9945ff?style=flat-square)
![mode](https://img.shields.io/badge/execution-dry__run-c9a227?style=flat-square)
![license](https://img.shields.io/badge/license-none%20%C2%B7%20personal%20project-555?style=flat-square)

A Telegram bot that screens Solana pump.fun tokens, filters them through a configurable strategy, scores entries with the Jev classifier (TypeSafe System One), and executes through Jupiter. It runs in three modes: `dry_run` (paper trading against a simulated SOL wallet, stored in SQLite), `confirm` (Telegram approve/reject buttons), and `live` (real swaps).

> Fork of [kaiserern/Kaiser.charon](https://github.com/kaiserern/Kaiser.charon), itself a fork of [yunus-0x/charon](https://github.com/yunus-0x/charon). Original idea and codebase by yunus-0x; much of the execution-path hardening by kaiserern. Older fix history lives in the upstream repos.

Jump to: [What this fork changes](#what-this-fork-changes) · [Quick start](#quick-start) · [Configuration](#configuration) · [How it runs](#how-it-runs) · [Telegram commands](#telegram-commands) · [Notes](#notes-and-caveats) · [Security](#security)

## What this fork changes

- **Single Jupiter client.** All Jupiter traffic goes through `jupiterFetch` in `src/enrichment/jupiter.js`. Free-tier limits are modelled directly: a main bucket (1 RPS / 60 RPM) for `/order`, `/quote`, price and token lookups, a separate bucket for `/execute`, and a best-effort bucket for `datapi`. A priority queue serves exits first, then entries, then enrichment. Tunable with `JUP_MAIN_RPS`, `JUP_MAIN_RPM`, `JUP_DATAPI_RPS`; `JUP_FORCE_FALLBACK` forces the GMGN path for debugging. `fetchTokenMarket` falls back to GMGN when Jupiter data is unavailable.
- **Jev replaces the LLM chain.** Jev returns a verdict (PASS / WATCH / BUY), a rug score and a momentum score. `llm_min_confidence` is now P(BUY) x 100 and must be recalibrated in `dry_run`; `jev_max_rug` caps the rug score for a BUY.
- **Live money-path fixes.** An entry gate runs before the swap, so a filled swap is never orphaned. `FAILED_ENTRY` rows no longer overwrite history. Partial take-profit banks `realized_partial_sol` and PnL includes it. Live sells are clamped to the wallet balance, the live entry price comes from the actual fill, and an entry lock prevents double entries.
- **Paper wallet** (new in this fork). `dry_run` tracks a simulated SOL balance derived from positions. It starts at `paper_starting_balance_sol`, keeps the same reserve as live (`LIVE_MIN_SOL_RESERVE`), models a per-leg fee (15,000 lamports) and ATA rent locked until close, and rejects entries with `paper_insufficient_balance` when the available balance is too low. `/paper_reset [sol]` starts a new epoch (refused while paper positions are open); `/status` shows the wallet.
- **One route gate.** `allowed_routes` is the only route filter. Routes that are not allowed are stored as data-only signal events and never traded. Dead signal sources were removed.
- **Fee claims.** Fee-claim signals come from the signal server and from an on-chain WebSocket listener (`FEE_CLAIM_WS_ENABLED`; needs `SOLANA_WS_URL` or `HELIUS_API_KEY`).
- **pump.fun access.** Graduated and pre-graduation scanning use the pump.fun REST API, with an optional local Cloudflare sidecar (`CHARON_CF_FETCH_URL`) for hosts that get blocked.
- **Observability.** `/status` shows Jupiter budget usage; `/pnl` is computed from the database.

## Quick start

Requirements: Node.js 22.13 or newer (Node 26 works) and a Telegram bot token. The database uses the built-in `node:sqlite` module, so there is nothing to compile for it; on Node 22 it prints a one-time `ExperimentalWarning`, which is harmless. `canvas` (used for the Telegram cards) ships prebuilds; if your platform has none, install `build-essential python3 pkg-config libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev` first.

```bash
git clone https://github.com/sanglaanh123/Kaiser.charon.0x.git
cd Kaiser.charon.0x
npm install
cp .env.example .env     # then edit
npm test                 # offline tests, no network or keys needed
npm start
```

Minimal `.env` for `dry_run`:

```bash
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...   # from @BotFather
TELEGRAM_CHAT_ID=your_chat_id
SIGNAL_SERVER_URL=https://api.thecharon.xyz/api
SIGNAL_SERVER_KEY=your_signal_key
JUPITER_API_KEY=your_jupiter_key       # required; free tier works
GMGN_API_KEY=your_gmgn_key             # or GMGN_ENABLED=false
TYPESAFE_API_KEY=your_typesafe_key     # or ENABLE_JEV=false
TRADING_MODE=dry_run
```

`dry_run` needs no wallet and no RPC. `confirm` and `live` additionally need `SOLANA_PRIVATE_KEY` and an RPC (`HELIUS_API_KEY` or `SOLANA_RPC_URL`). Startup fails with an error naming any missing variable. The SQLite database is created at `DB_PATH` on first run.

The signal server key is issued by the upstream maintainers; see [yunus-0x/charon](https://github.com/yunus-0x/charon).

## Configuration

Two places:

1. **`.env`**: API keys, RPC URLs, feature flags, mode. Restart to apply.
2. **SQLite `settings` / `strategies`**: strategy parameters, read on use (hot). Edit from `/menu`, `/setfilter` and `/stratset` in Telegram, no restart. Settings are seeded with `INSERT OR IGNORE`, so an existing database keeps its stored values even if the code default changes.

Key settings and their code defaults:

| Setting | Default | Notes |
|---|---|---|
| `allowed_routes` | `single_source,multi_source,fee_graduated,fee_trending,trending,trenches_completed,pumpportal_graduated,dip_sniper,dip_dip_buy,dip_smart_money,dip_degen` | Seeded list; an empty value allows all routes. Review it against your own results. |
| `max_open_positions` | `3` (`MAX_OPEN_POSITIONS`) | Each open position costs quote calls every tick; 3 or fewer fits the free Jupiter budget. |
| `min_liquidity_usd` | `6000` | Read at filter time; not seeded in the settings table. |
| `llm_min_confidence` | `75` | P(BUY) x 100 from Jev. Per-strategy overrides exist (sniper seeds `40`). Recalibrate in `dry_run`. |
| `jev_max_rug` | `0.35` | Maximum Jev rug score for a BUY. |
| `paper_starting_balance_sol` | `1` | Paper wallet starting balance (part of the paper-wallet change). |
| `LIVE_MIN_SOL_RESERVE` (env) | `0.02` | SOL kept back from sizing; the paper wallet uses the same reserve. |
| `JUP_MAIN_RPS` / `JUP_MAIN_RPM` (env) | `1` / `60` | Free tier. On the Jupiter Developer plan ($25/mo, 10 RPS) set `10` / `600`. |

Optional subsystems are controlled by flags: `GMGN_ENABLED`, `PUMPPORTAL_ENABLED` (uses `PUMPPORTAL_API_KEY`), `PREGRAD_ENABLED`, `ENABLE_JEV` (needs `TYPESAFE_API_KEY`), `FEE_CLAIM_WS_ENABLED`, `TRENDING_ENABLED`. See `.env.example` for the full list.

Four built-in strategies are seeded: Sniper (default), Dip Buy, Smart Money and Degen (no Jev). Switch with `/strategy`.

## How it runs

```
SIGNAL SOURCES                              INGRESS GATE
├── Signal Server (api.thecharon.xyz)  ─┐
├── PumpPortal WebSocket              ─┤
├── GMGN Trenches                     ─┤
├── Jupiter trending (GMGN fallback)  ─┼──→ routeAllowed()
├── pump.fun graduated / pregrad      ─┤    allowed_routes only,
│   (REST + CF sidecar)               ─┤    before enrichment,
└── Fee claims: signal server         ─┘    costs zero API calls
    + on-chain WS listener

PIPELINE
  signal → cheapPrefilter() → buildCandidate()
  → enrichment: fetchTokenMarket (Jupiter → GMGN fallback)
    through one rate-limited Jupiter client (1 RPS free tier,
    priority queue: exits first, then entries, then enrichment)
  → filterCandidate() → preScore() → momentumFilter()
  → decision: Jev classifier (verdict / rug / momentum), cached in decision_cache
  → dry-run position | Telegram confirm | live swap
    (Jupiter /swap/v2/order + /execute, signed locally)

EXECUTION LOOP (10s)
  monitorPositions() → Jupiter sell quote (fill-to-fill)
  → SL / TP / trailing / max-hold
  → close → SQLite → Telegram card
  dry_run only: paper wallet (balance from positions, reserve,
  per-leg fee, ATA rent) gates entries before they open
```

Exits are quote-first: a position is priced on an executable sell quote. If quoting fails, it is valued at a labelled mark fallback instead of being skipped, so every exit rule still evaluates.

### Optional: pump.fun Cloudflare sidecar

If your host gets `403 Just a moment` from `frontend-api-v3.pump.fun`, the pregrad scanner and graduation detection cannot reach the REST API directly. They fall back to a local daemon that fetches through headless Chromium. Retrying harder does not help; this is Cloudflare, not rate limiting.

```bash
python3 -m venv /opt/charon-cf/venv
/opt/charon-cf/venv/bin/pip install playwright==1.63.0
/opt/charon-cf/venv/bin/playwright install chromium
# run your fetch daemon (e.g. /opt/charon-cf/fetchd.py) under systemd, loopback only
```

The daemon script itself is not shipped in this repo; the bot side is `src/enrichment/cfFetch.js`, which only expects `GET {CHARON_CF_FETCH_URL}/fetch?url=<target>` to answer `{ "body": <target JSON> }` (400 = target rejected, 502 = challenge not cleared).

It binds `127.0.0.1:8799`, serves `GET /fetch?url=<target>` with a host allowlist, and holds no credentials or wallet keys. Override with `CHARON_CF_FETCH_URL`. Without it, the two routes that need pump.fun REST stay dark; everything else runs.

## Telegram commands

Registered with Telegram (`setMyCommands`):

| Command | Purpose |
|---|---|
| `/menu` | Main menu: strategies, settings, positions |
| `/strategy` | Show or switch strategy |
| `/stratset <id> <key> <value>` | Set a strategy config value |
| `/positions` | List positions |
| `/candidate <mint>` | Show a candidate by mint |
| `/filters` | Show current filters |
| `/setfilter` | Set a filter value |
| `/status` | Bot mode, Jupiter rate-limit usage, paper wallet |
| `/pnl` | Realised PnL from the database (live vs paper) |
| `/paper_reset [sol]` | Start a new paper wallet epoch, optionally with a new starting balance (refused while paper positions are open) |
| `/learn` | Run the manual learning report |
| `/lessons` | Show active screening lessons |
| `/walletadd`, `/walletremove`, `/wallets` | Manage saved wallets for exposure/PnL |

Handled but not listed in the Telegram command menu: `/report` (daily report).

## Notes and caveats

- **Paper fills are an estimate.** They use executable Jupiter quotes plus modelled fees and ATA rent, but not sandwiching, landing latency, priority fees or wallet state. Expect live to be worse.
- **Jev thresholds need recalibration.** `llm_min_confidence` and `jev_max_rug` have different meanings than the old LLM settings; tune them in `dry_run` before going live.
- **The free Jupiter budget limits concurrency.** At 1 RPS, more than about 3 open positions starves entries and enrichment. Exits are prioritised, so exits stay timely at the cost of everything else.
- **Route quality changes over time.** A route that worked can decay. Judge routes by exit-reason breakdown and per-route results, not the total.
- **GMGN rate limits are strict.** Do not set `GMGN_REQUEST_DELAY_MS` below 2500.
- **Disk.** The database and WAL grow quickly under load; rotate logs and check free space before a `VACUUM`.
- **Memecoins mostly go to zero.** This is a personal project with no support or guarantee, and not financial advice.

## Security

- Use a dedicated trading wallet funded with only what you can lose. Never use your main wallet.
- Never commit `.env`; it is gitignored. `.env.example` holds placeholders only. If something real appears in the repo, treat it as leaked and rotate it.
- `SOLANA_PRIVATE_KEY` is needed only for `confirm` and `live`. `dry_run` runs without any wallet key.
- `*.sqlite` and `*.log` files contain trade history and chat identifiers and are gitignored.
- Before pushing, scan for secrets: `git grep -nE "sk-[A-Za-z0-9]{20,}|[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}|PRIVATE_KEY *= *\["`
