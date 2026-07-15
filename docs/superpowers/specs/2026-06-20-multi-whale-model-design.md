# 多敌鲸时间模型重构（2026-06-20）

## 背景 / 问题
现有 defense.html 把多条敌鲸画在**同一条共享时间轴**上（全局 `window.__W1`、所有鲸共用 `GATHER=300` 的集结带从同一 0 点开始），**隐含"所有敌鲸同时开集结"**。现实里敌鲸开集结时间不一定相同（远的可能先开、近的后开），所以共享轴的 x 位置互相比较是误导。

关键发现：上一轮把发兵 cue 改成「**发车后 X**」(= `em + DELTA − R`)，这个值**相对每条鲸自己的发车那一刻**计算，**本来就独立、不依赖同时开集结**。只有"画面（时间尺共享轴 + 雷达共享时钟）"还在假设同时。

用户打法：**通常只关心/只帮第一条到来的敌鲸的 refill**，一次只担一条。

## 决策（用户已确认）
1. **每条敌鲸各自独立**：每条是自包含单元（集结5:00→它的行军→落地→你补满），cue 相对它自己发车。多条之间不靠 x 位置比较。配置只填各自行军时间，**无"谁先开/偏移"字段**。
2. **大图（雷达）聚焦一条、可切换**：大图只动画"当前聚焦"的那条（默认第一条）；上方一排芯片切换聚焦；只 1 条时芯片省略。

## 设计

### ① 默认数量 = 1
- 线上已发布 plan 改成 1 条（敌A 1:10）。
- 代码各兜底/seed 已是 1 条即可：管理解锁 fallback `[{敌A,1,10}]`、雷达 fallback、`seedLocalIfEmpty`（复制 cloud→现在 1 条）、空态。
- 用户点「＋ 加敌鲸」加更多（管理区 / 个人区，逻辑不变）。

### ② 时间尺：每条按自己时钟独立缩放
- 废弃全局 `window.__W1`/`vmap`/`invmap`/`pct`。改为传 `w1` 参数：
  - `w1For(c) = c.refillAt + max(45, (c.refillAt−GATHER)*0.5)`（每条自己的尾段）。
  - `vmapW(t,w1)` / `invmapW(p,w1)` / `pctW(t,w1)`（GVIS=0.25 不变：集结占每条自己的 1/4）。
- `renderStrips()`：每条 `c=calc(e)`、`w1=w1For(c)`，用 `pctW(_,w1)` 算 sx/lx/rx。每条卡片自包含。
- 多于 1 条时，面板顶部一行小提示「每条各自独立 · 相对它自己发车，点上方芯片切换大图」。

### ③ 大图：聚焦一条
- `focusIdx`（默认 0，pickEnemies/rebuild 时 clamp 到范围）。
- `rebuild()` 只为 `enemies[focusIdx]`（无则 fallback 1 条）建雷达：城堡/护盾/兵营 + **单条**敌鱼 dot/aura/cd/补兵泡。`anim.w1=w1For(focusedCalc)`，`anim.keys`=该条 send/land/refill 排序。
- `renderAnim(t,curKey,ts)`：动画该聚焦鲸（集结光环/飞行/落地 impact/护盾/补兵泡 + fx 停顿提示）；把 **focused 那条时间尺**的 `.head` 用 `pctW(t,anim.w1)` 移动、加 `fx-send/fx-land/fx-refill`；其余条静态（不画 head）。
- `frame()`：`anim.p` 在聚焦鲸时钟上推进（`invmapW(p,anim.w1)`），停顿状态机不变。
- `scrub` 映射到聚焦鲸时钟。

### ④ 芯片切换
- `#whaleChips`（雷达上方）：每条一个芯片 `🔴敌X`，`on`=聚焦；点击 `focusIdx=i; refocus()`。`enemies.length<=1` 时隐藏。
- `refocus()` = `rebuild()+renderStrips()+renderChips()`，重置 `playing=true/lastTs=null`。
- `rebuildAll()` = `rebuild()+renderStrips()+renderChips()`。

### ⑤ cue 大字卡（erow）
- 每条的「他发车后 X 发兵」卡片全列出（不受聚焦影响）。

### ⑥ 配置（管理+个人）
- 不变；默认 1 条；每条仍只填 分:秒 行军。`seedLocalIfEmpty` 复制 cloud（现在 1 条）。
- 发布即时生效 + 自动切「用管理发布的」（上一轮已修，保留）。

## i18n
- 新增 `d_indep_note`（zh「每条各自独立 · 相对它自己发车，点芯片切换大图」/ en「each independent · relative to its own launch; tap a chip to switch」）。
- 芯片名用敌鲸名（数据）。其余复用现有 key。

## 受影响文件
- `1406rocks/defense.html`：mapping 函数（全局→带 w1）、renderStrips、rebuild、renderAnim、frame、scrub、新增 renderChips/refocus/focusIdx、HTML 加 `#whaleChips`、scoped CSS 加 `.wchip`/`.wchip.on`、独立提示。
- `1406rocks/app.js`：i18n 加 `d_indep_note`（zh+en）。
- 线上 plan：republish 成 1 条（敌A 1:10）。
- 资源 `?v` 升到 v13（app.js 改了）。

## 验收
- 默认进页面 = 1 条敌鲸，大图+时间尺+大字全套、无芯片。
- 加第 2 条：出现 2 个芯片；点芯片大图切到那条并动画；两条时间尺各自独立缩放（各自集结带=自己那条 1/4）、聚焦那条有移动游标、另一条静态；两条大字 cue 都在。
- 时间正确性不变（calc 不动）；发布即时生效；中英文 OK；无 console error；线上 `/saltyfish` 刷新生效。

## 用户指令
- "写spec然后开做，直到完成。"（批准设计，直接 spec→实现→验证→部署到完成）
