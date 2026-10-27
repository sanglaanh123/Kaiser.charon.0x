# Charon — Solana Pump.fun Trading Bot

> Fork by [Kai](https://github.com/kaiserern) dari [yunus-0x/charon](https://github.com/yunus-0x/charon). Bot Telegram buat screening & trading token pump.fun via Jupiter. Support dry run (paper), confirm (approve button), dan live execution.

## Arsitektur
```
SIGNAL SOURCES (pilih salah satu/semua):
├── Signal Server (api.thecharon.xyz) — HTTP polling, token fresh
├── PumpPortal WebSocket — real-time graduated + pre-grad token
├── Jupiter Trending — poll >= 60s, fallback ke GMGN trending
├── GMGN Trenches — bonding curve tokens
├── Pump.fun graduated + pregrad — REST (+ CF sidecar kalo kena Cloudflare)
└── Fee Claims — dari signal server + listener on-chain (WS)

INGRESS GATE: allowed_routes (satu-satunya gate route, sebelum enrichment)

PIPELINE (setiap token):
  Signal → cheapPrefilter() → buildCandidate()
  → enrichment: fetchTokenMarket (Jupiter → fallback GMGN)
    lewat 1 client Jupiter ber-rate-limit (free tier 1 RPS, priority queue: exit dulu)
  → filterCandidate() → preScoreCandidate() → momentumFilter()
  → Jev (classifier TypeSafe: verdict/rug/momentum) → WATCH/PASS/BUY
  → createDryRunPosition() / createLivePosition()

EXECUTION (looping):
  monitorPositions() → quote exit / mark exit / TP / SL / trailing
  → close position → log ke DB → send exit card Telegram
  Live: Jupiter /swap/v2/order + /execute, tx di-sign lokal
```

## Prasyarat
- **Node.js 20+** (gw pake 22)
- **Native build tools**: `build-essential python3 pkg-config libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev`
- **Systemd** (buat production supervisor) atau pm2

## Quick Start (5 menit)

```bash
# 1. Clone
git clone https://github.com/kaiserern/Kaiser.charon.git
cd Kaiser.charon

# 2. Install
npm install
# Kalo gagal di better-sqlite3/canvas → install build tools dulu (lihat Prasyarat)

# 3. Setup env
cp .env.example .env
nano .env

# 4. Check syntax
npm run check

# 5. Run
npm start
```

## .env Minimal untuk Dry Run
```bash
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234gh
TELEGRAM_CHAT_ID=<your_chat_id>

SIGNAL_SERVER_URL=https://api.thecharon.xyz/api
SIGNAL_SERVER_KEY=your_signal_key_here

JUPITER_API_KEY=your_jupiter_key      # wajib (free tier pun butuh key)
GMGN_API_KEY=your_gmgn_key            # atau GMGN_ENABLED=false

# Dry run default — ga butuh wallet, ga butuh RPC
TRADING_MODE=dry_run
MAX_OPEN_POSITIONS=3

# Jev (TypeSafe System One) — pengganti LLM
ENABLE_JEV=true
TYPESAFE_API_KEY=your_typesafe_key

# Opsional: nyalain listener fee-claim on-chain
# HELIUS_API_KEY=your_helius_key
# atau SOLANA_WS_URL=wss://mainnet.helius-rpc.com/?api-key=KEY
```

RPC (`HELIUS_API_KEY` / `SOLANA_RPC_URL`) + `SOLANA_PRIVATE_KEY` cuma wajib kalo `TRADING_MODE=live` atau `confirm`. Kalo ada yg kurang, bot langsung error dan nyebut nama var-nya.

Budget Jupiter free tier = 1 RPS, jadi `max_open_positions` ≤ 3 aman. Upgrade ke Jupiter Developer ($25/bln, 10 RPS) → set `JUP_MAIN_RPS=10` dan `JUP_MAIN_RPM=600`.

## Konfigurasi
**Dua tempat setting:**
1. **`.env`** — API keys, RPC URLs, mode. Restart bot kalo ganti.
2. **SQLite (`charon.sqlite`)** — semua parameter strategi. **Hot-reload**, ganti via Telegram `/menu` tanpa restart.

Strategy parameters yang sering di-tune:
- `position_size_sol` — size per entry
- `tp_percent` / `sl_percent` — take profit / stop loss
- `trailing_enabled` / `trailing_percent` — trailing stop
- `max_open_positions` — max concurrent positions
- `llm_min_confidence` — threshold BUY dari Jev = P(BUY)×100 (bukan skor self-rated LLM; kalibrasi ulang di dry_run)
- `jev_max_rug` — batas rug score Jev buat BUY
- `momentum_threshold` — threshold ML momentum filter (0.0-1.0)
- `min_mcap_usd` / `max_mcap_usd` — market cap bounds

## 4 Strategi Bawaan
| Strategi | Mode Entry | LLM | Kapan dipake |
|---|---|---|---|
| **Sniper** (default) | immediate | ✅ | Token fresh graduate, fast entry |
| **Dip Buy** | wait_for_dip | ✅ | Token trending turun, beli pas koreksi |
| **Smart Money** | immediate | ✅ | Multi-source confirmation, higher confidence |
| **Degen** | immediate | ❌ | Low cap, high volume, full auto |

Aktifkan strategi via SQLite: `UPDATE strategies SET enabled = 1 WHERE id = 'sniper'`

## Pipeline Detail

### 1. Signal Sources
Semua sumber sinyal dikonversi ke objek `signals` seragam:
```js
{ mint, route, hasFeeClaim, hasGraduated, hasTrending, ... }
```
Satu token bisa masuk dari multiple source → dedup via `seenSignalCandidates` + DB check.

### 2. buildCandidate()
Enrichment pake `fetchTokenMarket`: Jupiter dulu, fallback GMGN (`JUP_FORCE_FALLBACK=1` buat maksa GMGN) + GMGN (holder count, total fees, dev info) + saved wallets. Semua call Jupiter lewat 1 client ber-rate-limit (bucket main 1 RPS / 60 RPM, execute tanpa throttle, datapi 2 RPS) dengan priority queue: exit > entry > enrichment. `cheapPrefilter()` buang token jelek sebelum nyentuh network.

### 3. filterCandidate()
Gate wajib sebelum Jev. Cek: mcap, holders, fee claim, max holder %, ATH distance, rug ratio, bundler rate. Parameter diatur per-strategi. Candidate yg gagal → status `filtered` + alasan.

### 4. preScoreCandidate() + momentumFilter()
Pre-scoring 0-100 (mcap growth, volume, holder growth, age). ML momentum model `predict_momentum.py` — opsional, skip kalo model ga ada.

### 5. Jev Decision
Ngumpulin candidate sampe `llm_candidate_pick_count` atau `llm_candidate_max_age_ms` → Jev (TypeSafe System One, classifier — bukan LLM generatif). Return: verdict BUY/WATCH/PASS, rug, momentum. `llm_min_confidence` = P(BUY)×100. Rug > `jev_max_rug` → ga BUY. Aktif kalo `ENABLE_JEV=true` + `TYPESAFE_API_KEY`.

Cache (tabel `decision_cache`): BUY decisions gak diproses ulang dalam 10 menit, WATCH/PASS dalam 60 menit. Invalidasi kalo mcap berubah >20% atau holders >30%.

Route gate: setting `allowed_routes` (comma-separated, empty = all) is the single source of truth. Default excludes `dual_source`, `fee_graduated_trending`, `pumpfun_pregrad`, `graduated_trending` (Lesson #3 — consistently unprofitable).

### 6. Position Creation
- **Dry run**: `dry_run_positions` table, simulate buy + track HWM
- **Confirm**: Kirim approve/reject button ke Telegram
- **Live**: Execute swap via Jupiter `/swap/v2/order` + `/execute`, tx di-sign lokal. Ada entry gate + entry lock, swap yg udah filled ga pernah di-orphan (`recordFailedEntry`), partial TP dicatat di `realized_partial_sol`

### 7. Position Monitoring
Loop `POSITION_CHECK_MS` (default 10s):
- Track HWM (high water mark)
- Trailing stop: arm pas > trailing_percent profit, narrow pas > peak threshold
- Quote-first exit (dry run): harga dari Jupiter quote, bukan mark
- Stop loss, take profit, max hold time
- Exit → close position → send exit card Telegram

## Live Execution
Kalo mau live, tambahin di `.env`:
```bash
TRADING_MODE=live
SOLANA_PRIVATE_KEY=[1,2,3,...]  # atau base58 string
JUPITER_API_KEY=your_jupiter_key
```

Gunakan wallet terpisah yg isinya cuma modal trading. Jangan nyampur sama main wallet.

## Systemd Service
```ini
# /etc/systemd/system/charon.service
[Unit]
Description=Charon Trading Bot
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/projects/charon
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=10
StandardOutput=append:/home/ubuntu/projects/charon/charon.log
StandardError=append:/home/ubuntu/projects/charon/charon.log

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable charon --now
sudo journalctl -u charon -f
```

## Commands Telegram
- `/menu` — main menu (strategi, setting, positions, backtest)
- `/positions` — list all open positions
- `/daily` — daily PnL report
- `/settings` — view/edit semua parameter strategi
- `/status` — mode, open positions, pemakaian Jupiter (req/60s vs limit, 429, datapi backoff, queue)
- `/pause` / `/resume` — pause/resume trading

## Directories
```
charon/
├── src/
│   ├── app.js           # Main orchestration
│   ├── config.js         # Env + constants
│   ├── pipeline/         # Enrich → filter → Jev → position
│   ├── execution/        # Position monitor + Jupiter router
│   ├── signals/          # Semua signal sources
│   ├── enrichment/       # Jupiter client, market (Jupiter→GMGN), GMGN, wallets
│   ├── db/               # SQLite connection, queries
│   ├── telegram/         # Bot commands, send, format, cards
│   ├── visuals/          # Canvas card rendering
│   ├── learning/         # Auto-learning + lesson system
│   └── liveExecutor.js   # Wallet + RPC connection
├── migrations/           # SQL migrations
├── scripts/              # Backtest + analysis scripts
├── backtest/             # Backtest results + reports
├── models/               # ML models (momentum_model.pkl)
└── logs/                 # Logs
```

## Troubleshooting
| Masalah | Cek |
|---|---|
| `better-sqlite3` / `canvas` gagal build | Install native deps (lihat Prasyarat) |
| `X is required` pas start | Pesan error nyebut var yg kurang (`TELEGRAM_BOT_TOKEN`, `JUPITER_API_KEY`, `GMGN_API_KEY`, `TYPESAFE_API_KEY`; live/confirm: `SOLANA_PRIVATE_KEY` + RPC) |
| Bot start tapi ga ada sinyal | `SIGNAL_SERVER_KEY` valid? Cek log `[bot]` |
| Jev ga manggil | `ENABLE_JEV` bukan `false`? `TYPESAFE_API_KEY` ada? |
| Jupiter 429 | Cek `/status`. Kurangin `max_open_positions`, atau kalo udah paid plan naikin `JUP_MAIN_RPS` / `JUP_MAIN_RPM` |
| Fee claim WS off (`[fee] WS listener off`) | Set `SOLANA_WS_URL` atau `HELIUS_API_KEY` |
| GMGN error | Rate limit — jangan turunin `GMGN_REQUEST_DELAY_MS` di bawah 2500 |
| Dry run jalan tapi PnL jelek | It works as designed — paper fills ga kena slippage. Live bakal 20-50% worse |
| `quote-first` exit error 429 | Jupiter rate limit — fallback ke mark price |
| DB locked / slow | WAL mode udah on? `journal_mode = WAL` |

## Honest notes
- Trading memecoin = high risk. Most go to zero. Edge bot ini: 1-2 good runners nutupin 7-8 small losses.
- `dry_run` PnL looks better than reality — paper execution ga kena slippage atau sandwich.
- Jangan commit `.env`. Udah di-gitignore.
- Fork ini di-maintain pribadi, bukan produk. Kerja → untung; ga kerja → ya udah.
- Ini bukan sinyal grup, bukan financial advice.
