# kvk 战况地图主导化布局（v7 layout）— 设计委员会合成方案

4 设计视角(信息层级/单手移动/指挥实战/极简) Workflow 并行提案 → 合成。用户批准原案（含指挥模式隐藏站点头部/导航、发射键吸底）。

## 承诺数字（390×844）
- 指挥模式：#situation 首屏占比 ~48%（高 ~405px）；0px 滚动可开火（firedock 吸底）；指挥台折叠态 ~260px（原 650px+）
- 玩家模式：#situation 首屏 ~44%，整卡首屏可见；雷达渲染高 +54%（viewBox 96→150）

## 机制
- 双模式 = `body.cmdmode`（openCmd 加 / lockCmd 删），物理 DOM 只搬 #youChip（上移至 #fillCard 后）。否决 CSS order 方案（a11y/焦点序/动画债）。
- staged 沙漏横幅删除 → sticky #chrome 内第二行 #stagedLine 一行字「🛡️ 你是{k}{r} · 待命」（i18n staged_line），震动沿用 onState 既有逻辑；live 后大 phero 照旧接管。
- #console 压缩：删 ①②③ 说明行；roster 改横滑单行（排序 已选→ready→掉线）；syncPill+fire+cancel 打包 .firedock sticky bottom（cancel 无指令时 display:none；键盘 focusin 时 dock 取消吸底）；#cdefense 改 <details> 默认折叠（id 全保留）。
- 指挥模式隐藏 .top/.viewtabs/.astat.on/#stagedLine；youChip 压缩保留（改行军唯一入口）。
- astat on 态 6s 自动隐藏（warn 常显可点）。

## 尺寸要点
radar viewBox 360×150、CY=66、ringR 12+…*52、legend y145；删 .pond svg 104px 全局帽 → .situation .pond svg max-height 200px；.situation flex 列 min-height clamp(300px,44svh,420px)（cmdmode 320/48svh/460）+ .pond flex:1 居中；.lane 加高（列 84/1fr/56、行高 34、轨 30、点 16/17）；.top/.viewtabs/#viewToggle cmdmode 压缩或隐藏；body.cmdmode .toast bottom 130px。

## 删除
.phero.staged CSS + paintHero ⏳ 分支；KT staged_main/weak→staged_line、cstep1..3；#cstep1..3 DOM+renderStatics set()；cancel 灰占位。

## 风险
sticky 红键误触（双击确认兜底+键盘避让）；空房大水塘（接受）；v8 staged 断言迁 #stagedLine；指挥模式无导航/切语言（退出恢复）。

改动：kvk.html / app.css(~45行) / kvk.js(~25行)；防守页内部不动；受保护 id 全保留。
