#!/usr/bin/env node
// Yakkamon Launchpad mint bot (allowlist stage).
//
// Strategy: loop free eth_call simulation until the on-chain stage opens
// (reverts ErrStageNotStarted before that), and broadcast the real tx only
// once simulation succeeds — so "sent too early" never burns gas.
// Remaining gas-burn risk is only losing the supply race in the ~1-2s window
// between simulation success and inclusion.
//
// Multi-RPC: MINT_RPC accepts a comma-separated endpoint list. Startup
// benchmarks every endpoint (eth_blockNumber RTT from this machine); the
// fastest becomes primary (polling/simulation), the rest are mirrors. At fire
// time the tx is signed ONCE and the raw bytes are broadcast to ALL endpoints
// in parallel (same hash, duplicates ignored — pure propagation speedup).
// Every RPC read goes through failover: a 500/429 on one endpoint falls
// through to the next, so a flaky provider can never kill the run.
//
// Gas: EIP-1559. maxFeePerGas is capped insurance — overpaying vs baseFee is
// refunded, so bumping it is free. The priority tip is the actual queue-jump
// lever. Tune with --tip <gwei> and --bump <percent-of-estimated-maxFee>.
//
// Usage:
//   node mint.mjs                          # dry-run, read-only, loops forever (Ctrl-C to stop)
//   node mint.mjs --from 0xYourWalletAddress     # dry-run for another address (no key needed)
//   node mint.mjs --go                     # REAL broadcast; requires key (.env MINT_PK / --keystore)
//   node mint.mjs --stage 5 --qty 1 --go
//   node mint.mjs --tip 3 --bump 150       # fixed 3 gwei tip overrides auto mode
//   node mint.mjs --self-test              # drill the real fire path with a 0-RON self-transfer
//                                          # sent at --gas, i.e. at the SAME gasLimit as the mint,
//                                          # so it rehearses the mint's balance guarantee
//                                          # (gasLimit × maxFee) while burning only 21000 gas
//                                          # gas is AUTOMATIC by default: tip = live median
//                                          # priority × --tip-boost (2), maxFee = next-block
//                                          # baseFee × --base-boost (200%) + tip, + bump headroom
//   node mint.mjs --max-polls 3            # exit after N simulated polls (for testing)
//
// Private key: never stored by this script. Preferred: put MINT_PK into the
// .env file next to this script (see .env.example) — real env vars take
// precedence over .env. Or inject per-run:  MINT_PK=0x... node mint.mjs --go
// or use an encrypted keystore:  node mint.mjs --go --keystore key.json  (prompts password)
// Note: --go (real broadcast) is CLI-only on purpose, so an .env can never arm it.

import { ethers } from "ethers";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROUTER_DEFAULT = "0xa8e9fdf57bbd991c3f494273198606632769db99"; // MavisLaunchpad proxy
const NFT_DEFAULT = "0x6d1bc5247ca99d917d91ec52dbbb5ef6c2435107"; // Yakkamon
let ROUTER = ROUTER_DEFAULT;
let NFT = NFT_DEFAULT;
const CHAIN_ID = 2020;
const ALLOWLIST_STAGE_TYPE = 2; // execute(2, ...) -> AllowlistStageLogic
const DEFAULT_RPCS = "https://ronin.drpc.org,https://api.roninchain.com/rpc";

// .env lookup: next to the script first (works for source and bundled file),
// then the current working directory (double-click launchers set it for us).
function envCandidates() {
  const list = [];
  try { list.push(fileURLToPath(new URL("./.env", import.meta.url))); } catch { /* non-file context */ }
  list.push(join(process.cwd(), ".env"));
  return [...new Set(list)];
}
function loadEnvFile() {
  for (const path of envCandidates()) {
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    const keys = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (process.env[key] === undefined) process.env[key] = val;
      keys.push(key);
    }
    return { found: true, keys, path };
  }
  return { found: false, keys: [], path: envCandidates()[0] };
}
const envFile = loadEnvFile();

function parseArgs(argv) {
  const envNum = (key, fallback) => (process.env[key] ? Number(process.env[key]) : fallback);
  const a = {
    stage: envNum("STAGE", 4),
    qty: envNum("QTY", 1),
    go: false,
    poll: envNum("POLL", 800),
    gas: BigInt(process.env.GAS ?? "350000"),
    tip: envNum("GAS_TIP_GWEI", 0), // 0 = auto (live feeHistory premium)
    tipBoost: envNum("GAS_TIP_BOOST", 2), // auto: tip = median priority fee × boost
    tipCapX: envNum("GAS_TIP_CAP", 5), // auto: never bid more than baseFee × this
    baseBoost: envNum("GAS_BASE_BOOST", 200), // auto: maxFee base = next baseFee × 200%
    bump: envNum("GAS_BUMP_PCT", 150), // maxFeePerGas = bump% of computed value
    maxAttempts: envNum("MAX_ATTEMPTS", 5), // fire attempts before giving up
    maxPolls: Infinity,
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--go") a.go = true;
    else if (k === "--stage") a.stage = Number(argv[++i]);
    else if (k === "--qty") a.qty = Number(argv[++i]);
    else if (k === "--poll") a.poll = Number(argv[++i]);
    else if (k === "--gas") a.gas = BigInt(argv[++i]);
    else if (k === "--tip") a.tip = Number(argv[++i]);
    else if (k === "--tip-boost") a.tipBoost = Number(argv[++i]);
    else if (k === "--tip-cap") a.tipCapX = Number(argv[++i]);
    else if (k === "--base-boost") a.baseBoost = Number(argv[++i]);
    else if (k === "--bump") a.bump = Number(argv[++i]);
    else if (k === "--max-polls") a.maxPolls = Number(argv[++i]);
    else if (k === "--max-attempts") a.maxAttempts = Number(argv[++i]);
    else if (k === "--self-test") a.selfTest = true;
    else if (k === "--from") a.from = argv[++i];
    else if (k === "--keystore") a.keystore = argv[++i];
    else if (k === "--rpc") a.rpc = argv[++i];
    else if (k === "--nft") a.nft = argv[++i];
    else if (k === "--router") a.router = argv[++i];
    else throw new Error(`unknown arg ${k}`);
  }
  return a;
}
let args;
try {
  args = parseArgs(process.argv);
} catch (e) {
  console.error(`error: ${e.message}`);
  console.error("usage: node mint.mjs [--go] [--stage N] [--qty N] [--from 0xaddr] [--keystore file] [--rpc url,url]");
  console.error("                    [--poll ms] [--gas N] [--tip gwei] [--tip-boost N] [--base-boost N] [--bump N]");
  console.error("                    [--max-polls N] [--max-attempts N] [--self-test] [--nft 0x..] [--router 0x..]");
  process.exit(1);
}
ROUTER = (args.router ?? process.env.ROUTER_ADDRESS ?? ROUTER_DEFAULT).toLowerCase();
NFT = (args.nft ?? process.env.NFT_ADDRESS ?? NFT_DEFAULT).toLowerCase();

const RPC_LIST = (args.rpc ?? process.env.MINT_RPC ?? DEFAULT_RPCS).split(/[\s,]+/).filter(Boolean);
if (RPC_LIST.length === 0) throw new Error("no RPC endpoint configured");

const gwei = (n) => ethers.parseUnits(String(n), "gwei");
const mkProvider = (url) =>
  new ethers.JsonRpcProvider(url, { chainId: CHAIN_ID, name: "ronin" }, { staticNetwork: true });

// Filled in by main() after the benchmark picks the primary order.
let pool = []; // [primary, ...mirrors] as ethers providers
let provider = null; // primary provider (wallet binding + fire-path default)
let views = null; // router view contract bound to primary
const viewsOn = (p) => new ethers.Contract(ROUTER, viewAbi, p);

// Run fn(provider) against endpoints until one succeeds, starting from the
// last endpoint that worked (sticky). Deterministic chain reverts (e.g. the
// stage being closed) are returned/raised as-is — retrying them on other
// endpoints would only multiply requests.
let sticky = 0;
// A real chain revert carries revert data (string reason or error selector);
// anything else (empty response, HTTP 402/429/500, timeout) is transport-level
// and must fail over to the next endpoint.
const isRevert = (e) => {
  const d = e?.data?.data ?? e?.data;
  return typeof d === "string" && d.length >= 10 && d !== "0x";
};
async function anyPool(fn, what) {
  let lastErr;
  for (let n = 0; n < pool.length; n++) {
    const i = (sticky + n) % pool.length;
    try {
      const r = await fn(pool[i], i);
      sticky = i;
      return r;
    } catch (e) {
      if (isRevert(e)) throw e;
      lastErr = e;
      if (pool.length > 1) console.log(`             (rpc ${i + 1}/${pool.length} failed for ${what}: ${shortErr(e)}, trying next)`);
    }
  }
  throw lastErr;
}
const shortErr = (e) => String(e?.shortMessage ?? e?.message ?? e).slice(0, 90);
// A node-level rejection carries the actionable detail in the raw JSON-RPC
// message ("have 1782282155794747879 want 10029600000000000000"); ethers can
// replace it with a generic shortMessage, so prefer the raw text when present.
const rawErr = (e) => String(e?.info?.error?.message ?? e?.error?.message ?? shortErr(e)).slice(0, 160);

const viewAbi = [
  { type: "function", name: "getAllStages", stateMutability: "view", inputs: [{ type: "address" }], outputs: [
    { type: "uint256[][3]", name: "stageIndexes" },
    { type: "tuple", name: "publicStage", components: [
      { type: "tuple", name: "config", components: [
        { type: "uint64", name: "startTime" }, { type: "uint64", name: "endTime" },
        { type: "uint32", name: "maxMintablePerWallet" }, { type: "uint32", name: "maxSupply" },
        { type: "uint64", name: "_reserved" } ] },
      { type: "tuple", name: "paymentInfo", components: [
        { type: "address", name: "currency" }, { type: "uint80", name: "price" }, { type: "uint16", name: "_reserved" } ] } ] },
    { type: "tuple[]", name: "allowListStages", components: [
      { type: "tuple", name: "config", components: [
        { type: "uint64", name: "startTime" }, { type: "uint64", name: "endTime" },
        { type: "uint32", name: "maxMintablePerWallet" }, { type: "uint32", name: "maxSupply" },
        { type: "uint64", name: "_reserved" } ] },
      { type: "tuple", name: "paymentInfo", components: [
        { type: "address", name: "currency" }, { type: "uint80", name: "price" }, { type: "uint16", name: "_reserved" } ] } ] },
    { type: "tuple[]", name: "tokenGatedStages", components: [
      { type: "tuple", name: "config", components: [
        { type: "uint64", name: "startTime" }, { type: "uint64", name: "endTime" },
        { type: "uint32", name: "maxMintablePerWallet" }, { type: "uint32", name: "maxSupply" },
        { type: "uint64", name: "_reserved" } ] },
      { type: "tuple", name: "paymentInfo", components: [
        { type: "address", name: "currency" }, { type: "uint80", name: "price" }, { type: "uint16", name: "_reserved" } ] },
      { type: "address", name: "allowedToken" }, { type: "uint32", name: "limitQtyPerReqToken" },
      { type: "uint64", name: "_reserved" } ] } ] },
  "function getMintedQtyAtStage(address,uint8) view returns (uint256)",
  "function getMintedQtyByUserAtStage(address,uint8,address) view returns (uint256)",
  "function checkIsEligible(address,uint8,address) view returns (bool)",
  "function pausedOf(address) view returns (uint256)",
  "function getTotalMintedOfNFTContract(address) view returns (uint256)",
  // Launch-level ceiling. calcRemainingSupplyForCondStage() returns
  // min(stage.maxSupply - mintedInStage, launchSupply - mintedOnLaunchpad), so a
  // stage's nominal maxSupply is often NOT what you can actually still mint.
  "function getLaunchpadData(address) view returns (address creator, uint8 standard, uint256 launchSupply, bool allowCumulativeLimit, tuple(address recipient, uint16 feeBps, uint8 party, uint256 _reserved)[] allocations, uint256 latestStageIndex)",
];

// Revert set taken from the DEPLOYED MavisLaunchpad / AllowlistStageLogic ABIs.
// Note: these contracts define no ErrSoldOut. Because we mint with
// isMintAllPossible = true, _checkMintQuantity clamps actualQuantity to
// min(requested, remaining) and reverts ErrZeroMintQuantity when that is 0 —
// so "stage sold out" and "your wallet already used its quota" both surface as
// ErrZeroMintQuantity, and the stage/launch ceiling surfaces as
// ErrMaxSupplyExceeded only if the request is not clamped.
const errIf = new ethers.Interface([
  "error ErrStageNotStarted()", "error ErrStageEnded()", "error ErrMinterNotAllowed(address)",
  "error ErrZeroMintQuantity()", "error ErrMaxSupplyExceeded(uint256 remainingSupply, uint256 mintQuantity)",
  "error ErrLimitPerWalletExceeded(uint256 limitPerWallet, uint256 remainMintable, uint256 mintQuantity)",
]);
const mintIf = new ethers.Interface(["function mintAllowList((address,address,uint256,bool,uint8,bytes))"]);
const execIf = new ethers.Interface(["function execute(uint8,bytes)"]);
// Cheapest possible view call, used to prove an endpoint can actually serve
// eth_call before we let it become the primary.
const CALL_PROBE_DATA = new ethers.Interface(["function getAllConstants() view returns (uint256,uint32,uint8,uint64)"]).encodeFunctionData("getAllConstants");

const fmtTime = (sec) => sec >= 2n ** 63n ? "∞" : new Date(Number(sec) * 1000).toLocaleString();
const ron = (wei) => `${ethers.formatEther(wei)} RON`;
const gweiStr = (wei) => `${ethers.formatUnits(wei, "gwei")} gwei`;
// Median of the sampled priority fees. The LAST sample is a trap: a single
// freak block (one wallet overpaying its tip during a mint rush) drags a
// "latest reward" reading to absurd levels — 3980 gwei on Ronin at 16:00 on
// 2026-09-17, which is what blew up the fee estimate that night.
const medianOf = (arr) => {
  if (!arr.length) return 0n;
  const s = [...arr].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  return s[(s.length - 1) >> 1];
};

// Raw-fetch RTT probe: cheap, independent of ethers internals.
async function probeRpc(url) {
  const post = async (method, params = []) => {
    const t0 = performance.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 6000);
    try {
      const r = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: ctl.signal,
      });
      const j = await r.json().catch(() => null);
      return { ms: performance.now() - t0, ok: !!j?.result, result: j?.result, err: j?.error?.message ?? `HTTP ${r.status}` };
    } catch (e) {
      return { ms: performance.now() - t0, ok: false, err: e.cause?.code ?? e.name };
    } finally { clearTimeout(timer); }
  };
  const id = await post("eth_chainId");
  if (!id.ok) return { url, ok: false, err: id.err };
  if (id.result?.toLowerCase() !== "0x7e4") return { url, ok: false, err: `wrong chain ${id.result}` };
  const rtts = [];
  for (let i = 0; i < 2; i++) {
    const r = await post("eth_blockNumber");
    if (r.ok) rtts.push(r.ms);
  }
  if (rtts.length === 0) return { url, ok: false, err: "blockNumber probe failed" };
  // Latency on eth_blockNumber says nothing about eth_call — and eth_call is the
  // entire workload of this bot. dRPC answered blockNumber in ~250ms while
  // failing EVERY eth_call with HTTP 500 (2026-09-17), so it kept being ranked
  // as the fastest endpoint and then wasted a failed attempt on every read.
  const probe = await post("eth_call", [{ to: ROUTER, data: CALL_PROBE_DATA }, "latest"]);
  const readOk = probe.ok && typeof probe.result === "string" && probe.result.length > 2;
  return { url, ok: true, ms: Math.min(...rtts), readOk, readErr: readOk ? "" : String(probe.err) };
}

async function selectPrimary() {
  console.log(`benchmarking ${RPC_LIST.length} rpc endpoint(s) ...`);
  const probes = await Promise.all(RPC_LIST.map(probeRpc));
  const alive = probes.filter((p) => p.ok);
  // Readable endpoints first (they become primary + the sticky start), then the
  // transport-only ones, which are still useful as parallel broadcast mirrors.
  const ranked = [
    ...alive.filter((p) => p.readOk).sort((a, b) => a.ms - b.ms),
    ...alive.filter((p) => !p.readOk).sort((a, b) => a.ms - b.ms),
  ];
  for (const p of probes) {
    if (!p.ok) { console.log(`  ✗ ${String(p.err).padEnd(30)}  ${p.url}`); continue; }
    console.log(p.readOk
      ? `  ✓ ${String(Math.round(p.ms)).padStart(5)} ms  ${p.url}`
      : `  ⚠ ${String(Math.round(p.ms)).padStart(5)} ms  ${p.url}  ← eth_call 失败(${String(p.readErr).slice(0, 40)}),只作广播镜像`);
  }
  const broken = alive.filter((p) => !p.readOk).length;
  if (broken) console.log(`             ${broken} 个端点读不通(读请求会自动跳过它们);想更干净就把它们从 MINT_RPC 里删掉`);
  if (ranked.length === 0) throw new Error("all configured RPC endpoints failed");
  return ranked.map((p) => p.url);
}

async function resolveSender() {
  if (args.from) return { address: args.from, signer: null };
  if (args.keystore) {
    const rl = createInterface({ input, output });
    const password = await rl.question("keystore password: ");
    rl.close();
    const json = readFileSync(args.keystore, "utf8");
    // ethers v6: fromEncryptedJson(json, password, progress?) — the callback is
    // the 3rd arg (v5's 4th-arg callback silently breaks the whole feature).
    const signer = await ethers.Wallet.fromEncryptedJson(json, password, (pct) => {
      output.write(`\rdecrypting ${pct}%`);
    });
    output.write("\n");
    return { address: signer.address, signer: signer.connect(provider) };
  }
  let pkRaw = process.env.MINT_PK?.trim();
  if (!pkRaw) {
    // first-run wizard: novice users may not have a .env yet
    if (!process.stdin.isTTY) {
      throw new Error("no key: fill MINT_PK in .env (see .env.example), or pass --from 0x... for dry-run");
    }
    const rl = createInterface({ input, output });
    console.log("首次使用向导:也可以随时直接编辑 .env 文件填写。");
    const answer = (await rl.question("粘贴钱包私钥 (0x...): ")).trim();
    if (!answer) { rl.close(); throw new Error("未输入私钥,退出。"); }
    const save = (await rl.question("把私钥保存到 .env 方便下次使用? (y/N): ")).trim().toLowerCase();
    rl.close();
    if (save === "y" || save === "yes") {
      const path = envFile.found ? envFile.path : envCandidates().at(-1);
      let text = existsSync(path) ? readFileSync(path, "utf8") : "";
      text = /^MINT_PK=.*$/m.test(text)
        ? text.replace(/^MINT_PK=.*$/m, `MINT_PK=${answer}`)
        : (text ? text.replace(/\n?$/, "\n") : "") + `MINT_PK=${answer}\n`;
      writeFileSync(path, text);
      console.log(`已保存到 ${path}(.gitignore 已排除,不会进 git;文件是明文,注意保管)`);
    }
    pkRaw = answer;
  }
  const pk = pkRaw.startsWith("0x") ? pkRaw : "0x" + pkRaw;
  const signer = new ethers.Wallet(pk, provider);
  return { address: signer.address, signer };
}

function decodeRevert(e) {
  const data = e?.data?.data ?? e?.data ?? e?.info?.error?.data;
  if (typeof data !== "string" || data.length < 10) return e?.shortMessage ?? e?.message ?? "unknown";
  try { return errIf.parseError(data).fragment.name; } catch { return `revert ${data.slice(0, 10)}`; }
}

// Does ANY endpoint know this hash at all (mined or still pending)?
// If nobody does, the raw tx was never accepted into a mempool and waiting for
// a receipt is pointless — that is a 180s stall we hit for real once.
async function txKnownAnywhere(hash) {
  for (const p of pool) {
    try { if (await p.getTransaction(hash)) return true; } catch { /* next provider */ }
  }
  return false;
}

// Poll every alive endpoint for the receipt; avoids betting on one provider.
// Returns { rc, dropped }: rc is null when nothing landed in time, and dropped
// is true when the hash is unknown everywhere (never accepted, or evicted).
async function waitReceipt(hash, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  const started = Date.now();
  let probed = false;
  while (Date.now() < deadline) {
    for (const p of pool) {
      try {
        const rc = await p.getTransactionReceipt(hash);
        if (rc) return { rc, dropped: false };
      } catch { /* next provider */ }
    }
    if (!probed && Date.now() - started > 12_000) {
      probed = true; // one probe per attempt is enough
      if (!(await txKnownAnywhere(hash))) {
        console.log(`tx         : no endpoint knows ${hash} after 12s — the tx was never accepted`);
        return { rc: null, dropped: true };
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { rc: null, dropped: false };
}

// The real fire path: fee -> affordability clamp -> nonce -> sign once ->
// broadcast raw to all endpoints -> wait receipt. Shared by the mint and --self-test.
//
// Gas is automatic by default: at fire time it reads the live eth_feeHistory
// (last 5 blocks) and prices tip as the MEDIAN priority fee × tipBoost, capped
// at next-block baseFee × --tip-cap, and maxFee as predicted baseFee × baseBoost
// + tip (× bump headroom). --tip overrides the tip with a fixed value.
//
// The clamp exists because EIP-1559 refunds overpayment of the gas you actually
// use, but the tx pool still demands balance >= gasLimit × maxFeePerGas + value.
// An inflated maxFee can therefore make the tx UNAFFORDABLE, and then every
// endpoint rejects it with "insufficient funds" and it never reaches a mempool.
async function fireRaw(signer, address, txFields) {
  const gasLimit = BigInt(txFields.gasLimit);
  const value = BigInt(txFields.value ?? 0n);
  const balance = await anyPool((p) => p.getBalance(address), "getBalance");
  const baseNow = (await anyPool((p) => p.getBlock("latest"), "getBlock")).baseFeePerGas ?? 0n;

  let tip, maxFee;
  if (args.tip) {
    tip = gwei(args.tip);
    const fee = await anyPool((p) => p.getFeeData(), "getFeeData");
    maxFee = (fee.maxFeePerGas ?? gwei(50)) * BigInt(args.bump) / 100n;
    if (maxFee <= tip) maxFee = tip * 2n;
    console.log(`gas       : fixed tip ${args.tip} gwei (--tip), maxFee = estimate × ${args.bump}%`);
  } else {
    try {
      const fh = await anyPool((p) => p.send("eth_feeHistory", ["0x5", "latest", [50]]), "feeHistory");
      const baseFees = fh.baseFeePerGas.map(BigInt);
      const baseNext = baseFees[baseFees.length - 1]; // predicted next-block baseFee
      const rewards = (fh.reward ?? []).map((r) => BigInt(r[0])).filter((x) => x > 0n);
      const medianReward = medianOf(rewards);
      const latestReward = rewards.length ? rewards[rewards.length - 1] : 0n;
      tip = medianReward > 0n ? medianReward * BigInt(Math.round(args.tipBoost * 100)) / 100n : gwei(1);
      if (tip < gwei(1)) tip = gwei(1);
      const tipCeil = baseNext * BigInt(args.tipCapX);
      let capped = false;
      if (tipCeil > 0n && tip > tipCeil) { tip = tipCeil; capped = true; }
      maxFee = (baseNext * BigInt(args.baseBoost) / 100n + tip) * BigInt(args.bump) / 100n;
      if (maxFee <= tip * 2n) maxFee = tip * 3n;
      console.log(`gas       : auto tip ${gweiStr(tip)} (median ${gweiStr(medianReward)} × ${args.tipBoost}${capped ? `, capped at baseFee × ${args.tipCapX}` : ""}; last block sampled ${gweiStr(latestReward)})`);
      console.log(`             maxFee ${gweiStr(maxFee)} (next baseFee ${gweiStr(baseNext)} × ${args.baseBoost}% + tip, × ${args.bump}%)`);
    } catch {
      const fee = await anyPool((p) => p.getFeeData(), "getFeeData");
      tip = (fee.maxPriorityFeePerGas && fee.maxPriorityFeePerGas > 0n) ? fee.maxPriorityFeePerGas : gwei(1);
      maxFee = (fee.maxFeePerGas ?? gwei(50)) * BigInt(args.bump) / 100n;
      console.log(`gas       : auto fell back to rpc suggestion (tip ${gweiStr(tip)})`);
    }
  }
  if (maxFee <= tip) maxFee = tip * 2n;

  // Clamp to what the balance can actually guarantee (balance >= gasLimit×maxFee + value).
  if (gasLimit * maxFee + value > balance) {
    const affordable = balance > value ? (balance - value) / gasLimit : 0n;
    console.log(`gas       : maxFee ${gweiStr(maxFee)} on gasLimit ${gasLimit} needs a ${ron(gasLimit * maxFee + value)} guarantee, wallet holds ${ron(balance)}`);
    if (affordable <= baseNow) {
      throw new Error(
        `balance ${ron(balance)} only allows maxFee ${gweiStr(affordable)} at gasLimit ${gasLimit}, ` +
        `which is below the current baseFee ${gweiStr(baseNow)} — the tx could never be mined. ` +
        `Top up RON or lower --gas (currently ${gasLimit}).`
      );
    }
    if (affordable <= tip) {
      throw new Error(
        `balance ${ron(balance)} allows at most ${gweiStr(affordable)} of maxFee at gasLimit ${gasLimit}, ` +
        `which cannot carry the ${gweiStr(tip)} tip you asked for. Lower --tip/--tip-boost or lower --gas.`
      );
    }
    maxFee = affordable;
    if (tip >= maxFee) tip = maxFee / 2n;
    console.log(`gas       : clamped to maxFee ${gweiStr(maxFee)} / tip ${gweiStr(tip)} so the wallet can cover it`);
  }

  const nonce = await anyPool((p) => p.getTransactionCount(address, "pending"), "getNonce");
  const signed = await signer.signTransaction({
    ...txFields, nonce, chainId: CHAIN_ID, type: 2, maxFeePerGas: maxFee, maxPriorityFeePerGas: tip,
  });
  const hash = ethers.keccak256(signed);
  // Collect the broadcast results: a silent Promise.allSettled() here once hid
  // "insufficient funds" from all 7 endpoints and the script waited 180s for a
  // transaction that had never entered any mempool.
  const results = await Promise.allSettled(pool.map((p) => p.send("eth_sendRawTransaction", [signed])));
  const accepted = results.filter((r) => r.status === "fulfilled").length;
  if (accepted === 0) {
    const why = [...new Set(results.map((r) => (r.status === "rejected" ? rawErr(r.reason) : "")).filter(Boolean))];
    console.log(`tx REJECTED: all ${pool.length} endpoints refused the raw tx — nothing was broadcast`);
    for (const w of why.slice(0, 3)) console.log(`             ${w}`);
    return { rc: null, hash, rejected: true, dropped: false };
  }
  console.log(`tx sent    : ${hash} (accepted by ${accepted}/${pool.length} endpoints)`);
  const { rc, dropped } = await waitReceipt(hash, 180_000);
  return { rc, hash, rejected: false, dropped };
}

async function main() {
  const rpcUrls = await selectPrimary();
  pool = rpcUrls.map(mkProvider); // pool[0] is the fastest = primary
  provider = pool[0];
  views = viewsOn(pool[0]);

  const { address, signer } = await resolveSender();
  if (args.go && !signer) throw new Error("--go requires a real key (.env MINT_PK or --keystore)");

  console.log(`rpc        : primary ${rpcUrls[0]}`);
  if (rpcUrls.length > 1) console.log(`             + ${rpcUrls.length - 1} broadcast mirror(s), all reads failover`);
  console.log(`config     : .env ${envFile.found ? `loaded (${envFile.keys.join(", ") || "empty"})` : "not found"}, key from: ${
    args.from ? "--from (read-only)" : args.keystore ? "keystore"
    : process.env.MINT_PK?.trim() ? (envFile.keys.includes("MINT_PK") ? ".env file" : "environment")
    : "none (dry-run only)"}`);
  console.log(`wallet     : ${address}${signer ? " (key loaded, --go armed)" : " (dry-run, read-only)"}`);

  const balance = await anyPool((p) => p.getBalance(address), "getBalance");
  console.log(`balance    : ${ron(balance)}`);
  if (args.go && balance === 0n) throw new Error("wallet has no RON for gas");

  const [all, totalMinted, paused, launch] = await Promise.all([
    anyPool((p) => viewsOn(p).getAllStages(NFT), "getAllStages"),
    anyPool((p) => viewsOn(p).getTotalMintedOfNFTContract(NFT), "getTotalMinted"),
    anyPool((p) => viewsOn(p).pausedOf(NFT), "pausedOf"),
    anyPool((p) => viewsOn(p).getLaunchpadData(NFT), "getLaunchpadData"),
  ]);
  const launchSupply = BigInt(launch.launchSupply);
  const launchLeft = launchSupply > totalMinted ? launchSupply - totalMinted : 0n;
  console.log(`collection : minted ${totalMinted} of launch supply ${launchSupply} (${launchLeft} left for all stages), paused ${paused}`);

  const [publicIdxs, allowIdxs, gatedIdxs] = all.stageIndexes;
  const allowIndexList = allowIdxs.map(Number);
  const pos = allowIndexList.indexOf(args.stage);
  if (pos < 0) {
    throw new Error(
      `stage ${args.stage} is not an allowlist stage (allowlist stages: ${allowIndexList.join(", ")}, ` +
      `public stage: ${publicIdxs.map(Number).join(", ")}, token-gated: ${gatedIdxs.map(Number).join(", ")}). ` +
      `This script only handles allowlist stages.`
    );
  }
  const stage = all.allowListStages[pos];
  const { startTime, endTime, maxMintablePerWallet, maxSupply } = stage.config;
  const price = stage.paymentInfo.price;

  const [mintedInStage, mintedByUser] = await Promise.all([
    anyPool((p) => viewsOn(p).getMintedQtyAtStage(NFT, args.stage), "getMintedQtyAtStage"),
    anyPool((p) => viewsOn(p).getMintedQtyByUserAtStage(NFT, args.stage, address), "getMintedQtyByUser"),
  ]);
  let eligible = null;
  try { eligible = await anyPool((p) => viewsOn(p).checkIsEligible(NFT, args.stage, address), "checkIsEligible"); }
  catch { /* not allowlist */ }

  const stageLeft = maxSupply > mintedInStage ? maxSupply - mintedInStage : 0n;
  const usableLeft = stageLeft < launchLeft ? stageLeft : launchLeft; // exactly what the contract computes
  console.log(`stage ${args.stage}     : ${fmtTime(startTime)} -> ${fmtTime(endTime)} (local time)`);
  console.log(`             price ${ron(price)}, per-wallet limit ${maxMintablePerWallet}, `);
  console.log(`             stage supply ${maxSupply}, minted in stage ${mintedInStage}`);
  console.log(`             actually mintable here: ${usableLeft} = min(stage left ${stageLeft}, launch left ${launchLeft})`);
  console.log(`             you minted ${mintedByUser}, eligible ${eligible}`);
  // Hard stops only when actually firing. In dry-run these stay diagnostics: the
  // simulation loop reports the same problem as a real revert reason
  // (ErrMinterNotAllowed / ErrZeroMintQuantity), which is more useful than a
  // pre-flight abort — and lets you dry-run an address you don't control.
  const gate = (msg) => {
    if (args.go) throw new Error(msg);
    console.log(`warning    : ${msg} — dry-run, still simulating to show the real revert`);
  };
  if (eligible === false) gate("address is NOT on the on-chain allowlist for this stage; a real tx would revert");
  if (mintedByUser + BigInt(args.qty) > BigInt(maxMintablePerWallet))
    gate("requested qty exceeds this wallet's per-stage limit; a real tx would revert");

  const value = price * BigInt(args.qty);
  const inner = mintIf.encodeFunctionData("mintAllowList", [[NFT, address, BigInt(args.qty), true, args.stage, "0x00"]]);
  const calldata = execIf.encodeFunctionData("execute", [ALLOWLIST_STAGE_TYPE, inner]);
  const need = value + args.gas * gwei(0.05); // rough 50 gwei ceiling sanity
  if (balance < need) gate(`balance ${ron(balance)} likely too low for value+gas (~${ron(need)})`);

  console.log(`gas plan   : ${args.tip ? `fixed tip ${args.tip} gwei (--tip override)` : `auto premium: tip = live median × ${args.tipBoost}, baseFee × ${args.baseBoost}%`} (+${args.bump}% headroom, overpay refunded)`);
  console.log(`calldata   : to ${ROUTER}, value ${ron(value)}`);
  console.log(`             ${calldata}`);
  console.log(`mode       : ${args.go ? "GO — will broadcast on first successful simulation" : "DRY — simulation only, nothing is sent"}`);
  if (!args.go) console.log(`tip        : at open time rerun with --go and your key. Ctrl-C to stop.\n`);
  else console.log(`tip        : armed. fires within ~${args.poll}ms after the stage opens. Ctrl-C to abort.\n`);

  if (args.selfTest) {
    if (!signer) throw new Error("--self-test sends a real (tiny) tx and needs a key: fill MINT_PK in .env");
    console.log(`self-test  : firing a 0-RON self-transfer at gasLimit ${args.gas} — the same limit the mint uses, so this rehearses its balance guarantee (only 21000 gas is actually burned) ...`);
    const fired = await fireRaw(signer, address, { to: address, value: 0n, gasLimit: args.gas });
    if (fired.rejected) { console.log("SELF-TEST ✗ : every endpoint refused the tx (reason above) — nothing was sent"); process.exitCode = 1; return; }
    if (fired.dropped) { console.log("SELF-TEST ✗ : the tx never reached any mempool"); process.exitCode = 1; return; }
    const { rc, hash } = fired;
    if (!rc) { console.log(`no receipt — check https://app.roninchain.com/tx/${hash}`); return; }
    const burned = ron(rc.gasUsed * (rc.gasPrice ?? rc.effectiveGasPrice ?? 0n)); // ethers v6: receipt.gasPrice
    console.log(rc.status === 1
      ? `SELF-TEST ✓ : fire path fully working (fee burned: ${burned})`
      : `SELF-TEST ✗ : tx landed but status ${rc.status}`);
    return;
  }

  // ---- goal-driven loop: stop only when the on-chain minted count hits the
  // wallet quota (e.g. limit 1 -> stop after 1 confirmed mint). On-chain
  // reverts are replayed at their block to report the exact reason; hopeless
  // reasons (sold out / window closed / not allowlisted) stop, the rest retry.
  const target = Number(maxMintablePerWallet);
  const maxAttempts = args.maxAttempts;
  const STOP = new Set(["ErrStageEnded", "ErrZeroMintQuantity", "ErrMaxSupplyExceeded", "ErrLimitPerWalletExceeded", "ErrMinterNotAllowed"]);
  const STOP_HINT = {
    ErrZeroMintQuantity: "no supply left for this wallet: stage/launch sold out, or your per-stage quota is already used",
    ErrMaxSupplyExceeded: "stage/launch supply exhausted",
    ErrLimitPerWalletExceeded: "this wallet already reached its per-stage limit",
    ErrStageEnded: "mint window closed",
    ErrMinterNotAllowed: "address is not on this stage's allowlist",
  };
  const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const zeroAddrTopic = "0x" + "0".repeat(64);

  const mintedNow = async () => {
    try { return Number(await anyPool((p) => viewsOn(p).getMintedQtyByUserAtStage(NFT, args.stage, address), "mintedNow")); }
    catch { return -1; } // a failed quota read must never abort the loop
  };

  // replay the reverted tx at its own block to recover the revert reason
  const decodeLandRevert = async (blockNumber) => {
    const tag = "0x" + blockNumber.toString(16);
    let last = "unknown (replay failed on every endpoint)";
    for (const p of pool) {
      try {
        await p.call({ to: ROUTER, data: calldata, from: address }, tag);
        return "unexpected: replay succeeded";
      } catch (e) {
        const d = e?.data?.data ?? e?.data;
        if (typeof d === "string" && d.length >= 10) return decodeRevert(e);
        last = shortErr(e);
      }
    }
    return last;
  };

  let minted = Number(mintedByUser);
  let attempts = 0;
  let polls = 0;
  let lastReason = "";

  if (minted >= target) { console.log(`\nquota already met: minted ${minted}/${target} — nothing to do.`); return; }

  while (attempts < maxAttempts) {
    // phase 1: free simulation until the stage accepts us
    let simOk = false;
    while (polls < args.maxPolls) {
      polls++;
      try {
        await anyPool((p) => p.call({ to: ROUTER, data: calldata, from: address }), "simulate");
        simOk = true; break;
      } catch (e) {
        const reason = decodeRevert(e);
        if (STOP.has(reason)) {
          console.log(`\nstopped before firing: ${reason} (${STOP_HINT[reason]}) — retrying cannot help.`);
          return;
        }
        if (reason !== lastReason) { console.log(`[${new Date().toLocaleTimeString()}] waiting: ${reason}`); lastReason = reason; }
      }
      await new Promise((r) => setTimeout(r, args.poll));
    }
    if (!simOk) break; // maxPolls reached while waiting

    // phase 2: fire
    attempts++;
    console.log(`\n[${new Date().toLocaleTimeString()}] attempt ${attempts}/${maxAttempts}: simulation OK — broadcasting`);
    if (!signer) { console.log("(dry-run: would broadcast now)"); return; }
    const fired = await fireRaw(signer, address, { to: ROUTER, data: calldata, value, gasLimit: args.gas });
    // A refused or vanished broadcast must not be mistaken for "waiting for a
    // slow block": re-price immediately with fresh fee data and fire again.
    if (fired.rejected) {
      console.log(`attempt ${attempts}: every endpoint refused the broadcast — re-pricing and retrying`);
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    if (fired.dropped) {
      console.log(`attempt ${attempts}: tx never entered a mempool — re-pricing and retrying`);
      continue;
    }
    const { rc, hash } = fired;

    // phase 3: verify against the on-chain quota
    if (!rc) {
      console.log(`attempt ${attempts}: no receipt after 180s — tx may still land; re-checking quota in 5s ...`);
      await new Promise((r) => setTimeout(r, 5000));
      minted = await mintedNow();
      if (minted >= target) { console.log(`\nMINTED ✓ ${minted}/${target} (late landing) — https://app.roninchain.com/tx/${hash}`); return; }
      console.log(`quota still ${Math.max(minted, 0)}/${target}; if the old tx lands late the retry will simply revert on quota — safe.`);
      continue;
    }
    console.log(`receipt    : status ${rc.status} block ${rc.blockNumber} gas ${rc.gasUsed} — https://app.roninchain.com/tx/${hash}`);
    if (rc.status === 1) {
      minted = await mintedNow();
      if (minted >= target) {
        const ids = rc.logs
          .filter((l) => l.address.toLowerCase() === NFT.toLowerCase()
            && l.topics[0] === transferTopic && l.topics[1] === zeroAddrTopic)
          .map((l) => BigInt(l.topics[3]).toString());
        console.log(`\nMINTED ✓ ${minted}/${target} — quota met, stopping.${ids.length ? " tokenId: " + ids.join(", ") : ""}`);
        return;
      }
      console.log(`landed OK but quota shows ${Math.max(minted, 0)}/${target} — retrying`);
      continue;
    }
    const reason = await decodeLandRevert(rc.blockNumber);
    console.log(`REVERTED ✗ : on-chain reason = ${reason}`);
    if (STOP.has(reason)) {
      console.log(`${STOP_HINT[reason] ?? ""} — retrying cannot help, stopping.`);
      return;
    }
    console.log(`retrying (${attempts}/${maxAttempts} attempts used) ...`);
  }
  console.log(`\nstopped: ${attempts} attempt(s) used, on-chain quota ${Math.max(minted, 0)}/${target}. Check https://app.roninchain.com/address/${address}`);
}

main().catch((e) => { console.error("error:", e.message ?? e); process.exitCode = 1; });
