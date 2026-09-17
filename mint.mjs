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
    gas: BigInt(process.env.GAS ?? "420000"),
    tip: envNum("GAS_TIP_GWEI", 0), // 0 = auto (live feeHistory premium)
    tipBoost: envNum("GAS_TIP_BOOST", 2), // auto: tip = live median priority × boost
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
const args = parseArgs(process.argv);
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
];

const errIf = new ethers.Interface([
  "error ErrStageNotStarted()", "error ErrStageEnded()", "error ErrSoldOut()",
  "error ErrMinterNotAllowed(address)",
]);
const mintIf = new ethers.Interface(["function mintAllowList((address,address,uint256,bool,uint8,bytes))"]);
const execIf = new ethers.Interface(["function execute(uint8,bytes)"]);

const fmtTime = (sec) => sec >= 2n ** 63n ? "∞" : new Date(Number(sec) * 1000).toLocaleString();
const ron = (wei) => `${ethers.formatEther(wei)} RON`;

// Raw-fetch RTT probe: cheap, independent of ethers internals.
async function probeRpc(url) {
  const post = async (method) => {
    const t0 = performance.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 6000);
    try {
      const r = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }), signal: ctl.signal,
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
  return { url, ok: true, ms: Math.min(...rtts) };
}

async function selectPrimary() {
  console.log(`benchmarking ${RPC_LIST.length} rpc endpoint(s) ...`);
  const probes = await Promise.all(RPC_LIST.map(probeRpc));
  const alive = probes.filter((p) => p.ok).sort((a, b) => a.ms - b.ms);
  for (const p of probes) {
    console.log(p.ok
      ? `  ✓ ${String(Math.round(p.ms)).padStart(5)} ms  ${p.url}`
      : `  ✗ ${String(p.err).padEnd(22)}  ${p.url}`);
  }
  if (alive.length === 0) throw new Error("all configured RPC endpoints failed");
  return alive.map((p) => p.url);
}

async function resolveSender() {
  if (args.from) return { address: args.from, signer: null };
  if (args.keystore) {
    const rl = createInterface({ input, output });
    const password = await rl.question("keystore password: ");
    rl.close();
    const json = readFileSync(args.keystore, "utf8");
    const signer = await ethers.Wallet.fromEncryptedJson(json, password, null, (pct) => {
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

// Poll every alive endpoint for the receipt; avoids betting on one provider.
async function waitReceipt(hash, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    for (const p of pool) {
      try {
        const rc = await p.getTransactionReceipt(hash);
        if (rc) return rc;
      } catch { /* next provider */ }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

// The real fire path: fee -> nonce -> sign once -> broadcast raw to all
// endpoints -> wait receipt. Shared by the mint and --self-test.
//
// Gas is automatic by default: at fire time it reads the live eth_feeHistory
// (last 5 blocks) and prices tip as real-time-median-priority × tipBoost, and
// maxFee as next-block predicted baseFee × baseBoost + tip — so it always
// pays a premium over the live market without manual numbers. --tip overrides
// the tip with a fixed value; overpaid maxFee is refunded by EIP-1559 anyway.
async function fireRaw(signer, address, txFields) {
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
      const rewardLive = rewards.length ? rewards[rewards.length - 1] : 0n;
      tip = rewardLive > 0n ? rewardLive * BigInt(Math.round(args.tipBoost * 100)) / 100n : gwei(1);
      if (tip < gwei(1)) tip = gwei(1);
      maxFee = (baseNext * BigInt(args.baseBoost) / 100n + tip) * BigInt(args.bump) / 100n;
      if (maxFee <= tip * 2n) maxFee = tip * 3n;
      console.log(`gas       : auto tip ${ethers.formatUnits(tip, "gwei")} gwei (live median ${ethers.formatUnits(rewardLive, "gwei")} gwei × ${args.tipBoost}), maxFee ${ethers.formatUnits(maxFee, "gwei")} gwei (next baseFee ${ethers.formatUnits(baseNext, "gwei")} gwei × ${args.baseBoost}% + tip, × ${args.bump}%)`);
    } catch {
      const fee = await anyPool((p) => p.getFeeData(), "getFeeData");
      tip = (fee.maxPriorityFeePerGas && fee.maxPriorityFeePerGas > 0n) ? fee.maxPriorityFeePerGas : gwei(1);
      maxFee = (fee.maxFeePerGas ?? gwei(50)) * BigInt(args.bump) / 100n;
      console.log(`gas       : auto fell back to rpc suggestion (tip ${ethers.formatUnits(tip, "gwei")} gwei)`);
    }
  }
  if (maxFee <= tip) maxFee = tip * 2n;
  const nonce = await anyPool((p) => p.getTransactionCount(address, "pending"), "getNonce");
  const signed = await signer.signTransaction({
    ...txFields, nonce, chainId: CHAIN_ID, type: 2, maxFeePerGas: maxFee, maxPriorityFeePerGas: tip,
  });
  const hash = ethers.keccak256(signed);
  await Promise.allSettled(pool.map((p) => p.send("eth_sendRawTransaction", [signed])));
  console.log(`tx sent    : ${hash} (broadcast to ${pool.length} endpoints)`);
  const rc = await waitReceipt(hash, 180_000);
  return { rc, hash };
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

  const [all, totalMinted, paused] = await Promise.all([
    anyPool((p) => viewsOn(p).getAllStages(NFT), "getAllStages"),
    anyPool((p) => viewsOn(p).getTotalMintedOfNFTContract(NFT), "getTotalMinted"),
    anyPool((p) => viewsOn(p).pausedOf(NFT), "pausedOf"),
  ]);
  console.log(`collection : minted ${totalMinted}, paused ${paused}`);

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

  console.log(`stage ${args.stage}     : ${fmtTime(startTime)} -> ${fmtTime(endTime)} (local time)`);
  console.log(`             price ${ron(price)}, per-wallet limit ${maxMintablePerWallet}, `);
  console.log(`             stage supply ${maxSupply}, minted in stage ${mintedInStage}`);
  console.log(`             you minted ${mintedByUser}, eligible ${eligible}`);
  if (eligible === false) throw new Error("address is NOT on the on-chain allowlist for this stage; tx would revert");
  if (mintedByUser + BigInt(args.qty) > BigInt(maxMintablePerWallet))
    throw new Error("requested qty exceeds this wallet's per-stage limit; tx would revert");

  const value = price * BigInt(args.qty);
  const inner = mintIf.encodeFunctionData("mintAllowList", [[NFT, address, BigInt(args.qty), true, args.stage, "0x00"]]);
  const calldata = execIf.encodeFunctionData("execute", [ALLOWLIST_STAGE_TYPE, inner]);
  const need = value + args.gas * gwei(0.05); // rough 50 gwei ceiling sanity
  if (balance < need) throw new Error(`balance ${ron(balance)} likely too low for value+gas (~${ron(need)})`);

  console.log(`gas plan   : ${args.tip ? `fixed tip ${args.tip} gwei (--tip override)` : `auto premium: tip = live median × ${args.tipBoost}, baseFee × ${args.baseBoost}%`} (+${args.bump}% headroom, overpay refunded)`);
  console.log(`calldata   : to ${ROUTER}, value ${ron(value)}`);
  console.log(`             ${calldata}`);
  console.log(`mode       : ${args.go ? "GO — will broadcast on first successful simulation" : "DRY — simulation only, nothing is sent"}`);
  if (!args.go) console.log(`tip        : at open time rerun with --go and your key. Ctrl-C to stop.\n`);
  else console.log(`tip        : armed. fires within ~${args.poll}ms after the stage opens. Ctrl-C to abort.\n`);

  if (args.selfTest) {
    if (!signer) throw new Error("--self-test sends a real (tiny) tx and needs a key: fill MINT_PK in .env");
    console.log("self-test  : firing a 0-RON self-transfer through the real fire path ...");
    const { rc, hash } = await fireRaw(signer, address, { to: address, value: 0n, gasLimit: 21000n });
    if (!rc) { console.log(`no receipt — check https://app.roninchain.com/tx/${hash}`); return; }
    const burned = ron(rc.gasUsed * (rc.effectiveGasPrice ?? 0n));
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
  const STOP = new Set(["ErrStageEnded", "ErrSoldOut", "ErrMinterNotAllowed"]);
  const STOP_HINT = {
    ErrSoldOut: "stage supply exhausted",
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
    const { rc, hash } = await fireRaw(signer, address, { to: ROUTER, data: calldata, value, gasLimit: args.gas });

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
