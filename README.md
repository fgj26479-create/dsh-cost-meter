# 费用计 · dsh-cost-meter

**把每次对话的 token 用量按 DeepSeek 官方公开价格实时折算成人民币费用，显示在每一轮对话的结尾和输入框下方。**

A DeepSeek Harness plugin that prices every turn's token usage in RMB from DeepSeek's
published rate card, in real time.

仓库 · Repository: <https://github.com/fgj26479-create/dsh-cost-meter> · MIT License

---

## 1. 它做什么

| 位置 | 显示内容 | 说明 |
|---|---|---|
| 每轮对话结尾（`conversation.chat.turnTail`） | `¥0.0123  2.50万 tok` | 该轮实际计费请求的人民币费用与 token 数；悬停显示模型、输入/输出拆分 |
| 输入框下方（`conversation.composer.dock`） | `¥0.0384  6.30万 tok  高峰` | 本会话累计费用、累计 token、当前计费时段；**点击**展开完整明细 |

明细面板包含：缓存命中 / 未命中 / 缓存写入 / 输出各自的 token 数、缓存命中率、
高峰与闲时各自的费用、计费请求数、按模型的路由拆分、价格来源与更新时间、
以及未知模型的告警。

计费口径完全依据官方页面：

> 扣减费用 = token 消耗量 × 模型单价

没有调用任何模型；费用由服务商在 `assistant/message` 事件里回传的
`usage` 与本地价格表相乘得到，因此**不额外消耗 token，也不影响提示词**。

---

## 2. 价格来源（动态）

价格**不是硬编码**的。插件同时维护三个层次，并按优先级使用：

1. **官方实时价格**（`sourceKind: "live"`）
   挂载后约 1.2 秒抓取 <https://api-docs.deepseek.com/zh-cn/quick_start/pricing/>，
   解析页面中的模型/价格表格；此后每 `refreshHours` 小时重新抓取。
   该页面是**唯一以人民币报价**的语言版本。
2. **本地缓存**（`sourceKind: "cache"`）
   成功解析的价格表写入 `$DSH_HOME/cost-meter/pricing-cache.json`，重启后直接复用。
3. **内置价格表**（`sourceKind: "bundled"`）
   抓取与解析全部失败时使用，快照抓取于 `2026-09-30`：
   离线也可用，界面会明确标注来源。

英文页 <https://api-docs.deepseek.com/quick_start/pricing/> 以 **USD** 报价，
仅作为主源失败时的兜底，并按 `usdToCny`（默认 7.2）换算，界面上标注为换算结果。

### 高峰 / 闲时

官方按北京时间区分时段，**闲时价格是高峰的一半**：

- **高峰**：周一至周五（不含中国法定节假日）**09:00–12:00** 与 **14:00–18:00**
- **闲时**：其余所有时间，包括周末与法定节假日全天

时段在**每个 usage 样本产生的那一刻**由事件时间戳判定并存入投影状态，
因此历史轮次不会因为后来跨入另一个时段而被错误重算。
中国法定节假日每年不同、无法离线推算，请在配置里用 `holidays` 显式声明；
未声明时该日按高峰计价（**宁可高估，不会低估**）。

### 缓存口径

DeepSeek 只公布「缓存命中 / 缓存未命中」两档输入价，没有单独的缓存写入价，
因此：

```
费用 = (未命中输入 + 缓存写入) × 未命中单价
     + 缓存命中输入          × 命中单价
     + 输出                  × 输出单价
```

缓存写入按未命中价计费是高估方向的安全近似（Anthropic 式缓存写入费在
DeepSeek 侧并不存在）。

---

## 3. 安装

发布在 GitHub：<https://github.com/fgj26479-create/dsh-cost-meter>。

在 DSH 侧栏打开**插件**页，点**添加插件**，填入仓库 spec：

```
github:fgj26479-create/dsh-cost-meter
```

也可以填完整的仓库地址 `https://github.com/fgj26479-create/dsh-cost-meter`。
Host 读出包名、简介和版本后点**安装**，安装完成时点**立即启用**即可，启用后无需重启。

从 GitHub 安装得到的是仓库快照：升级需要卸载后重装新版，修改 `lib/client.js` 也不会热替换到已打开的页面。

### 卸载

在**插件**页打开 **dsh-cost-meter** 的详情页，点**卸载**并确认。

---

## 4. 工作原理

```
session 日志 (assistant/message.usage)
        │
        │  host 半：纯 fold，只存 token 桶 + 计费时段 + 路由
        ▼
ctx.sessionProjections 注册 "costUsage" 单元
        │
        │  wire.view：用*当前*价格表把 token 桶折算成人民币
        ▼
sessionProjections.onChanged → api-session-controller 广播
        │
        ▼
浏览器 projection store → useProjection("costUsage") → 两个槽位组件
```

两个关键设计决定：

1. **金额不进 fold。** 投影状态里只有 token 数与时段标记，人民币金额在
   `wire.view` 里用**当前**价格表现算。这样价格表刷新后整段会话会被重新计价，
   而 fold 依然是可重放、确定性的纯函数——同一个日志在任何时候重放都得到同样的状态。
2. **服务商样本「替换」，重试「累加」。** 与 `dsh-token-meter` 的 `tokenUsage`
   口径一致：同一步骤的流式样本被最终样本替换，`llm/retry-started` 之后的
   新样本则作为第二次计费请求累加。

---

## 5. 配置

`cordis.patch.yml` 里的 `config` 全部可选，缺省值即为下表：

| 键 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 关闭后不注册投影，界面上不显示任何内容 |
| `pricingUrl` | 官方中文价格页 | 主价格源（人民币报价） |
| `fallbackPricingUrl` | 官方英文价格页 | 兜底价格源（美元报价，需换算） |
| `usdToCny` | `7.2` | 美元兜底源的换算汇率 |
| `refreshHours` | `6` | 重新抓取价格表的间隔（小时） |
| `fetchTimeoutMs` | `8000` | 单次抓取超时 |
| `fallbackModel` | `deepseek-flash` | 价格表中查不到的模型按此价格估算，并在界面告警 |
| `holidays` | `[]` | 中国法定节假日（北京时间 `YYYY-MM-DD`），这些日期按闲时计价 |
| `maxTurns` | `60` | 投影中保留的最近轮次数量（决定逐轮费用的可追溯范围） |
| `maxRoutes` | `12` | 会话内保留的路由数量上限 |
| `cache` | `true` | 是否把解析到的价格表写入 `$DSH_HOME` 缓存 |

修改配置后，`set_plugin` 只写 `disabled`；改配置请编辑 `cordis.patch.yml`
中的 `config`，或在插件管理页面打开该插件的配置页。

---

## 6. 文件

| 文件 | 作用 |
|---|---|
| `package.json` | bundle 清单：`dsh.bundle.patch` + `dsh.client`（`platform: web`）、图标、显示元数据 |
| `cordis.patch.yml` | 插入 `cost-meter` 行及默认配置 |
| `lib/index.js` | **host 半**：价格引擎驱动、`costUsage` 投影单元。**零 import**（只用 `node:` 内建） |
| `lib/pricing.js` | 价格核心：内置价格表、HTML 解析、时段判定、金额计算。纯函数、无副作用 |
| `lib/client.js` | **client 半**：classic-script 模块、两个槽位组件、插件自有样式 |
| `icon.svg` / `locale/*.json` | 插件管理页面的图标与中英文标题说明 |
| `test/` | 测试与校验脚本（不随插件运行） |

Host 半与 client 半都**不引入任何 Harness 包**：host 只用 Node 内建，
client 只 `require('react')`（外壳静态模块表内的模块）。因此这个包
**没有任何依赖、没有构建步骤**——`lib/client.js` 是手写的 classic script，
直接符合模块加载器的 `window.__ModuleLoader__.load({ id, factory })` 协议。

---

## 7. 验证

```powershell
cd dsh-cost-meter
node test\pricing.test.mjs          # 13 项：内置表、实时 HTML 解析、时段、金额
node test\projection.test.mjs       # 13 项：host fold、重试替换、时段、别名、状态修复
node test\client.render.test.mjs    # 11 项：用真实 React 渲染两个槽位组件
node test\manifest.check.mjs        # 11 项：清单、patch、图标、locale、require 白名单
node test\live-pricing.check.mjs    # 一次性：抓取真实价格页并打印解析结果
```

`client.render.test.mjs` 需要一份临时的 React：

```powershell
mkdir tmp\rendertest; cd tmp\rendertest
npm install --cache ..\..\tmp\npm-cache react@18 react-dom@18
```

缺失时会打印 `SKIP` 而不是失败。

已核对的线上事实：

- `application: applied`，`warnings: []`，无需重启。
- `Config.listConfigs` 可见 `include:cost-meter` 行。
- `Slots.listSubTree` 可见两个占用者且 `active: true`：
  `conversation.composer.dock` → `cost-meter-session`(order 20)、
  `conversation.chat.turnTail` → `cost-meter-turn`(order 40)。
- 两个槽位的 `standardProps` 都包含 `useProjection`，与组件读取方式一致。
- 安装后 2 秒，host 半真实抓取并解析了官方页面，写出
  `$DSH_HOME/cost-meter/pricing-cache.json`（`sourceKind: "live"`，
  数值与内置快照完全一致）——证明 host 半在真实进程内确实运行。

---

## 8. 已知限制

- **是估算，不是账单。** 费用按官方公开单价与服务商回传的 `usage` 计算，
  不含任何优惠、赠送额度、阶梯或汇率调整；实际扣费以账单为准。界面里明确写了这一点。
- **中国法定节假日需要手工声明。** 无法离线推算，未声明时按高峰计价。
- **语言模型路由之外的费用不含在内。** 例如语音转写、图像附件产生的
  独立计费项不在本插件口径内。
- **逐轮费用只覆盖最近 `maxTurns` 轮。** 更早的轮次仍计入会话总额，
  但不再显示逐轮数字。
- **价格刷新在下一个事件后可见。** 浏览器只在投影状态变化时收到推送，
  因此价格表刷新本身不会主动重绘；页面重新加载或下一次 usage 事件后
  整段会话会按新价格重新显示。
- **缓存写入按未命中价计费。** DeepSeek 未公布单独的缓存写入价，
  这是高估方向的安全近似。
- **GitHub 安装没有源码热替换。** 安装的是仓库快照，改完代码要卸载重装才会生效；
  本地 `link:` 开发安装才有 client-hmr 的热替换。

---

## 9. 许可证

MIT，见 [LICENSE](LICENSE)。
