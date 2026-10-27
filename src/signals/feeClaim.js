import WebSocket from 'ws';
import { PUMP_PROGRAM, PUMP_AMM, DISC_DIST_FEES, SOLANA_WS_URL } from '../config.js';
import { now, pruneSeen, lamToSol, discMatch, parseDistFees } from '../utils.js';
import { numSetting, boolSetting } from '../db/settings.js';
import { storeSignalEvent } from './trending.js';
import { graduated } from './graduated.js';
import { trending } from './trending.js';
import { buildFeeSnapshot } from '../pipeline/candidateBuilder.js';

export const seenFeeClaims = new Map();
const FEE_SEEN_TTL_MS = 10 * 60 * 1000;
const WS_RECONNECT_MIN_MS = 5_000;
const WS_RECONNECT_MAX_MS = 60_000;
const WS_ALERT_AFTER_MS = 10 * 60 * 1000;
let candidateHandler = null;

// Shared dedup across signal-server and on-chain WS inputs. Returns false if already seen.
export function markFeeClaimSeen(signature, mint) {
  if (!signature || !mint) return true;
  pruneSeen(seenFeeClaims, FEE_SEEN_TTL_MS);
  const key = `${signature}:${mint}`;
  if (seenFeeClaims.has(key)) return false;
  seenFeeClaims.set(key, now());
  return true;
}

export function setCandidateHandler(fn) {
  candidateHandler = fn;
}

export async function handleFeeClaim(fee, signature) {
  const sol = lamToSol(fee.distributed);
  if (sol < numSetting('min_fee_claim_sol', 2)) return;
  const graduatedCoin = graduated.get(fee.mint) || null;
  const trendingToken = boolSetting('trending_enabled', true) ? trending.get(fee.mint) || null : null;
  if (!graduatedCoin && !trendingToken) return;

  if (!markFeeClaimSeen(signature, fee.mint)) return;
  storeSignalEvent(fee.mint, 'fee_claim', 'pump_logs', { signature, fee: buildFeeSnapshot(fee, signature) });
  const route = graduatedCoin && trendingToken
    ? 'fee_graduated_trending'
    : graduatedCoin
      ? 'fee_graduated'
      : 'fee_trending';
  if (candidateHandler) {
    await candidateHandler({
      mint: fee.mint,
      fee,
      signature,
      graduatedCoin,
      trendingToken,
      route,
    });
  }
}

export async function processLog(logInfo) {
  const { signature, logs, err } = logInfo;
  if (err || !logs) return;
  for (const line of logs) {
    if (!line.startsWith('Program data: ')) continue;
    let data;
    try {
      data = Buffer.from(line.slice('Program data: '.length), 'base64');
    } catch {
      continue;
    }
    if (data.length < 8 || !discMatch(data, DISC_DIST_FEES)) continue;
    try {
      await handleFeeClaim(parseDistFees(data), signature);
    } catch (error) {
      console.log(`[fee] parse/alert failed: ${error.message}`);
    }
  }
}

async function alertTelegram(text) {
  try {
    const { sendTelegram } = await import('../telegram/send.js');
    await sendTelegram(text);
  } catch (error) {
    console.log(`[fee] telegram alert failed: ${error.message}`);
  }
}

export function startWebsocket() {
  const wsUrl = SOLANA_WS_URL;
  let ws;
  let pingTimer;
  let retryTimer;
  let alertTimer;
  let delay = WS_RECONNECT_MIN_MS;
  let alerted = false;
  let down = false;
  function connect() {
    ws = new WebSocket(wsUrl);
    ws.on('open', () => {
      console.log('[ws] connected');
      delay = WS_RECONNECT_MIN_MS;
      down = false;
      clearTimeout(alertTimer);
      if (alerted) {
        alerted = false;
        alertTelegram('✅ <b>Fee-claim WS reconnected</b>');
      }
      for (const [id, program] of [[1, PUMP_PROGRAM], [2, PUMP_AMM]]) {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'logsSubscribe',
          params: [{ mentions: [program] }, { commitment: 'confirmed' }],
        }));
      }
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, 30_000);
    });
    ws.on('message', raw => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      const value = msg.params?.result?.value;
      if (msg.method === 'logsNotification' && value) {
        processLog(value).catch(error => console.log(`[ws] process failed: ${error.message}`));
      }
    });
    ws.on('close', () => {
      clearInterval(pingTimer);
      if (!down) {
        down = true;
        alertTimer = setTimeout(() => {
          if (!down || alerted) return;
          alerted = true;
          alertTelegram('🚨 <b>Fee-claim WS down >10min</b> — on-chain fee claims missed; signal-server claims still active.');
        }, WS_ALERT_AFTER_MS);
        alertTimer.unref?.();
      }
      console.log(`[ws] closed, reconnecting in ${Math.round(delay / 1000)}s`);
      retryTimer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, WS_RECONNECT_MAX_MS);
    });
    ws.on('error', error => console.log(`[ws] ${error.message}`));
  }
  connect();
  return {
    stop() {
      clearTimeout(retryTimer);
      clearTimeout(alertTimer);
      clearInterval(pingTimer);
      ws?.removeAllListeners();
      ws?.terminate?.();
    },
  };
}
