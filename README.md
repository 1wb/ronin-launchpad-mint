# ronin-launchpad-mint

Ronin Launchpad 白名单场次直连合约 mint 工具(默认配置为 Yakkamon Genesis Mint,可用 `--nft`/`--router` 指向同架构的其他场次)。不走 marketplace 前端,由本机私钥签名直接发交易,到点自动开火。

> ⚠️ 免责声明:仅供个人已获白名单额度的 mint 使用,请遵守 Ronin/项目方条款。私钥只在本机内存中使用,作者不对任何损失负责。

## 小白三步上手

1. 安装 [Node.js LTS](https://nodejs.org/)(一路下一步;macOS/Linux 用系统包管理器或官网安装包);
2. 从 **[Releases 页面](https://github.com/1wb/ronin-launchpad-mint/releases)** 下载最新版 zip 并解压(内置免安装单文件,无需 `npm install`;也可绿色 Code → Download ZIP 自行下载源码);
3. 启动:
   - **Windows**:双击 `start.bat`;
   - **macOS / Linux**:终端执行 `bash start.sh`(或 `chmod +x start.sh` 后双击);

   按提示粘贴私钥、选模式:
   - `[1] 试跑` = 只读模拟,不发交易,验证一切正常;
   - `[2] 实弹` = 到点自动开火(会花 gas,约 0.007 RON)。

私钥只保存在本机 `.env`(已排除出 git),不经过任何服务器。建议开抢前 5 分钟用 `[1]` 确认显示 `waiting: ErrStageNotStarted`(=一切就绪等开窗),再切 `[2]` 挂机。

## 原理

前端只是交易构造器,launchpad 的全部校验都在链上。mint 链路:

```
你(EOA) ──execute(2, bytes)──▶ MavisLaunchpad 路由(delegatecall)
                                  └─▶ AllowlistStageLogic.mintAllowList
                                        校验:时间窗→供应量→每钱包限购→msg.value→链上白名单
                                        └─▶ Yakkamon.mintLaunchpad(to, qty, data)  // MINT_ROLE
```

| 合约 | 地址 |
|---|---|
| Yakkamon (NFT) | `0x6d1bc5247ca99d917d91ec52dbbb5ef6c2435107` |
| MavisLaunchpad 路由(mint 入口) | `0xa8e9fdf57bbd991c3f494273198606632769db99` |
| AllowlistStageLogic(白名单场逻辑) | `0x4a9Db5f7aDE442B368bb6F4aBAbf1a2214B8BC59` |

合约均已验证源码,可在 [explorer.roninchain.com](https://explorer.roninchain.com/address/0xa8e9fdf57bbd991c3f494273198606632769db99) 查阅。

**省 gas 策略**:到点前循环用 `eth_call` 做链上模拟(只读、永远免费),阶段未开会持续返回 `ErrStageNotStarted`;模拟一通过立即广播真实交易。因此"提前发被拒退回"的 gas 浪费为零。残余风险只剩开抢 1~2 秒内额度被抢空的竞态(约 0.005 RON/次)。

链上没有服务器签名/验证码等链下风控,白名单资格存链上 mapping(可用合约的 `checkIsEligible` 自查);绕过前端绕不过合约校验,抢的只是开抢瞬间速度。

## 快速开始(命令行用户)

```bash
npm install
cp .env.example .env      # 然后编辑 .env
```

`.env` 最少只需填一行:

```
MINT_PK=0x你的私钥        # 必须是白名单地址的私钥,资格绑定地址,不能换钱包
```

其余可选项见 [.env.example](.env.example)(RPC / STAGE / QTY / POLL / GAS / NFT_ADDRESS / ROUTER_ADDRESS)。优先级:**命令行参数 > 真实环境变量 > .env > 默认值**。

不想 npm install?仓库自带打包好的单文件 `dist/mint.cjs`(已内置依赖),`node dist/mint.cjs` 直接跑。指向其他 Launchpad 场次:`node mint.mjs --nft 0x... --router 0x... --stage N`。

## 使用

**第一步,平时先 dry-run(只读,不发交易,无需私钥):**

```bash
node mint.mjs --from 0x000000000000000000000000000000000000dEaD
```

启动时会从链上读取并打印:阶段时间窗(本机时区)、价格、限购、已 mint 数、你的白名单资格、余额、完整 calldata;然后循环模拟,显示 `waiting: ErrStageNotStarted` 属正常。Ctrl-C 退出。

**第二步,开抢前挂上真实模式:**

```bash
# Git Bash
MINT_PK=0x... node mint.mjs --go
# 或填好 .env 后直接
node mint.mjs --go
```

```powershell
# PowerShell(不用 .env 时)
$env:MINT_PK="0x..."; node mint.mjs --go
```

模拟通过即自动广播,成功后打印交易链接(如 `https://app.roninchain.com/tx/0x...`)。

**常用参数**(也可写进 `.env`):

| 参数 | 默认 | 说明 |
|---|---|---|
| `--stage N` | 4 | 4=Yakkamon Hunters,5=Public Trainers |
| `--qty N` | 1 | 本次 mint 数量 |
| `--poll ms` | 800 | 模拟轮询间隔(RPC 限频 30/s、100/min,别低于 400) |
| `--gas N` | 350000 | gasLimit,实测 mint 约 27~29 万,留约 20% 余量(它同时决定余额担保,见下) |
| `--tip N` | 自动 | 固定 tip(gwei);**默认不填即自动模式**:实时中位优先费 × `--tip-boost` |
| `--tip-boost N` | 2 | 自动:tip = **中位**优先费 × N(跟随行情自动加价) |
| `--tip-cap N` | 5 | 自动:tip 硬上限 = 下一块 baseFee × N,防单块天价小费带偏 |
| `--base-boost N` | 200 | 自动:maxFee 的 base 分量 = 下一块预测 baseFee × N% |
| `--bump N` | 150 | maxFee 再乘 N% 余量 |
| `--rpc urls` | `.env` | 逗号分隔多端点,启动测速,最快者做主 |
| `--keystore f.json` | - | 加密 keystore 代替明文私钥(会提示输密码) |
| `--max-attempts N` | 5 | 开火次数上限,达 quota 或判定无意义重试即停 |
| `--max-polls N` | ∞ | 跑 N 次模拟后退出(测试用) |
| `--nft 0x..` | Yakkamon | NFT 合约地址(同架构其他场次) |
| `--router 0x..` | MavisLaunchpad | Launchpad 路由地址 |

## 成功/失败检测(目标驱动循环)

目标是**链上读取的每钱包限购**(本场景为 1):每轮先查 `getMintedQtyByUserAtStage`,达到 quota 立即停。交易上链 status=1 后回查链上数量,并从收据日志解出拿到的 **tokenId**。

上链后 revert 的交易会在**同一区块重放**,还原真实原因:`ErrZeroMintQuantity`(抢空,或你自己的名额已用完)/ `ErrStageEnded`(窗口关闭)/ `ErrMinterNotAllowed`(不在白名单)判为"重试无意义"直接停止并说明;超时未上链、未知错误则自动换 nonce 重试,`--max-attempts`(默认 5)次封顶。即使还在等开窗,模拟一旦变成这几种原因也会立即停止等待并告知,不会傻等。

> 注意:这套合约里**没有 `ErrSoldOut`**。因为脚本用 `isMintAllPossible = true` 发送,售罄时合约把实际铸造量夹到 0 并回滚 `ErrZeroMintQuantity` —— 所以"卖完了"和"你的配额已用完"是同一个错误码,提示语会把两种可能都写出来。

## RPC 与 gas 调优

**多 RPC**:脚本启动时对本机到各端点做 `eth_blockNumber` 延迟实测(2 次取最小),最快者做模拟/轮询主端点;开火时**签名一次、向所有存活端点并行广播** `eth_sendRawTransaction`(同一笔交易同一 hash,链上自动去重,纯提速无副作用)。

2026-09-17 本机实测:

| 端点 | 延迟 | 备注 |
|---|---|---|
| `https://lb.drpc.live/ronin/<key>` | ~216-227ms | dRPC 账号 key,已入 `.env` |
| `https://ronin.drpc.org` | ~230-257ms | dRPC 公共,免 key |
| `https://api.roninchain.com/rpc` | ~950-1010ms | Sky Mavis 官方公共,限频 30/s、100/min |
| `https://api-gateway.skymavis.com/rpc` | 需 key | 官方网关,[developers.skymavis.com](https://developers.skymavis.com) 免费注册 |
| `https://ronin-mainnet.g.alchemy.com/v2/<key>` | 需启用 | Alchemy 支持 Ronin,但要在 [dashboard](https://dashboard.alchemy.com) 该 app 的 Networks 里手动启用 |
| `ronin.lgns.net` / onfinality / blastapi / ankr 无 key | ✗ | 连接重置 / 已停运 / 403 |

**gas 自动加价(默认)**:开火瞬间读取链上 `eth_feeHistory`(最近 5 块)实时行情,自动定价——

- **tip(插队杠杆)= 实时成交优先费的「中位数」× `--tip-boost`(默认 2 倍)**:注意取的是中位数而不是"最新一块",因为只需一笔天价小费就能把最新值带偏(2026-09-17 16:00 实测:五块的优先费是 `1, 1, 1, 1, 3980` gwei,取最新值会一路算出 23880 gwei 的 maxFee);另有 `--tip-cap`(默认 5)兜底,即 tip 不超过下一块 baseFee 的 5 倍;
- **maxFee = 下一块预测 baseFee × `--base-boost`(默认 200%)+ tip,再 × `--bump`(150%)余量**:防开抢瞬间 baseFee 跳升被拒;
- **余额担保(重要)**:EIP-1559 只退还「实际用量」多付的部分,但交易进内存池的硬性条件是 `余额 ≥ gasLimit × maxFee + value`。maxFee 被抬高会让交易**根本进不了池**——节点直接回 `insufficient funds`,连上链竞争的机会都没有。所以签名前会按余额把 maxFee/tip 钳到付得起的水平并打印;若钳完仍低于当前 baseFee,脚本会带着明确原因**拒绝发交易**而不是白扔一笔废交易。想留更多余量就调低 `--gas`(它同时压低担保)。
- `--tip 3` 可切换为固定值覆盖自动;极端情况下 feeHistory 不可用时自动退回 RPC 建议值。

实测示例(2026-09-17):`auto tip 2.0 gwei (live median 1.0 gwei × 2), maxFee 63.0 gwei (next baseFee 20.0 gwei × 200% + tip, × 150%)`。免费场单笔成本约 0.007 RON,自动加价只多 ~0.001 RON。

## 阶段速查(2026-09-17 链上实测)

| 阶段 | 链上 index | 时间 | 价格 | 限购 | 备注 |
|---|---|---|---|---|---|
| Top Trainers / OG Trainers | 1 / 2 | 已结束 | 0 | - | |
| Ronin Wave | 3 | 已结束 | 0 | - | 白名单场 |
| Yakkamon Hunters | 4 | 09-17 16:00 → 09-18 08:00 | 0 | 1 | 白名单场,名义限量 5000(受 launch 总上限约束,见下) |
| Public Trainers | 5 | 09-18 08:00 起 | 0 | - | 白名单场 |
| Public Stage | 255 | 09-19 08:00 起 | - | - | **public 类型,本脚本不支持** |

> **阶段上限 ≠ 实际可铸数量**。合约 `calcRemainingSupplyForCondStage()` 取 `min(阶段剩余, launch 总剩余)`,而 launch 总剩余 = `launchSupply - 已铸`。以 Yakkamon 为例:launch 总供给 10000,前三波已铸 5963,所以第四波名义 5000、实际只剩 **4037**;第五波名义 10000 也要和第四波抢这同一份余额。脚本启动时会打印 `collection : minted … of launch supply …` 和 `actually mintable here: …` 两行,以它为准。

以上时间/价格以脚本启动时链上读取为准。已知错误含义:`ErrStageNotStarted` 没开窗(继续等);`ErrStageEnded` 已结束;`ErrZeroMintQuantity` 抢空或你的配额已用完;`ErrMaxSupplyExceeded` / `ErrLimitPerWalletExceeded` 供给或限购已满;`ErrMinterNotAllowed` 不在白名单。除第一个外都会直接停止并说明原因。

## 边界与安全

- **只支持 allowlist 型阶段**(白名单校验类)。Public Stage(255)走另一套函数,脚本会显式拒绝而不是发错交易。
- `--go` 只能通过命令行给出,`.env` 永远无法武装真实发射,防止误触。
- `.env` 是明文私钥,等于钱包本身:已进 [.gitignore](.gitignore),但仍不要提交、不要外传;介意明文就用 `--keystore`。私钥不落日志、不打印、脚本退出即失忆。
- 白名单绑定地址,导出私钥时认准 你自己的白名单地址;用无痕窗口操作,用完可清空 `.env` 里的 `MINT_PK=`。
- gas 余额自查:一笔失败 revert 约损耗 0.005 RON,启动时余额不足会直接拒绝。
- 防误提交:`.gitignore` 排除 `.env` 系列与 `*.key`;另有 `hooks/pre-commit` 作为第二层保险,提交前扫描「私钥形状的 MINT_PK」与「带 key 的私有 RPC 地址」,本仓库已启用(`git config core.hooksPath hooks`,克隆后可选启用)。

## 文件

```
mint.mjs        脚本本体(单文件源码,可读、可审计)
dist/mint.cjs   打包单文件(已内置依赖,免 npm install,node dist/mint.cjs 直接跑)
start.bat / start.sh  Windows / macOS·Linux 启动器(试跑/实弹选择)
.env            本机私密配置(含私钥,勿外传,不进 git)
.env.example    配置模板(只含公共节点)
.gitignore      排除 .env 系列 / *.key / key.json / node_modules
.gitattributes  统一换行符(*.sh/*.mjs/hooks 用 LF)
hooks/pre-commit 提交前私密信息检查(git config core.hooksPath hooks 启用)
```
