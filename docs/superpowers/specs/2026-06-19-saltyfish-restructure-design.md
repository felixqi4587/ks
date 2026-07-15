# Saltyfish 重构设计（2026-06-19）

## 目标
把 1406rocks 重构为 **咸鱼小队 saltyfish** 多页面 App，全站换成 **animal-island 动森治愈画风**（重度参考 https://github.com/guokaigdg/animal-island-ui + frontend-design），并把"管理者(攻城组织)"与"防守者(普通玩家)"彻底分开——本次**只做防守者向**功能。改名 `felixqi4587.github.io/saltyfish`。

## 页面结构（多页面，共享 app.css + app.js）
- **`index.html` = 🐟 saltyfish 主页**：咸鱼小队搞笑落地页。动森风、可爱卡通咸鱼吉祥物（B 版：奶油+薄荷+暖棕、圆滚滚笑眯眯腮红、躺水洼晒太阳）。导航**只去**两个页：🛡️ 防守 / 🎁 礼包码。
- **`defense.html` = 🛡️ 防守者页（本次重点，公开）**：
  - 玩家填「我到王城行军时间」(mm:ss)。
  - **A 池塘雷达动画**（全局战况，动森配色）+ **B 精确时间轴**（每条敌鲸一行，实时 mm:ss：🟢你发兵时刻[已扣你的行军] → 🔴敌落地 → 🔵补兵补满）+ 文字版「补兵时机尺」(可观察锚点：敌集结剩 N 发兵 / 来袭落地倒计时 N 发兵)。
  - 敌鲸时间：默认用管理发布的；玩家可本机覆盖（仅本机、不影响别人）。
  - **底部管理区（密码门控）**：设敌方鲸鱼(名+行军 mm:ss) + 发布。普通玩家看不到。
- **`gift.html` = 🎁 礼包码页**：维持现有功能（队员名单+自动兑换+Discord 直连+历史），换成动森画风。
- **集结者/攻城组织**（我方鲸鱼集结、炮塔分配、发车顺序、整套 admin 配置）：本次**不做、不显示**。仅把"敌鲸时间设置"保留在防守者页的管理区。

## 关键参数
- `GATHER = 300`（敌集结固定 5:00，不变）。
- `DELTA = 1`（补兵在敌落地后 ≈1 秒到，补满且不早到——由 2 改为 1）。
- 发兵时刻 = 敌落地 + DELTA − 我行军；锚点同现有 refillCue 逻辑（DELTA 用 1）。

## 鉴权 / 安全（沿用 v7）
- 密码不硬编码：经 Worker `POST /auth` 校验、存 sessionStorage、`authedFetch` 注入。本次保持密码 `666`（用户要求先保持）。
- 防守者页公开可看；管理区 + 礼包码页需 666。

## 画风 token（animal-island）
- 主色 mint `#19c8b9`；leaf green `#6fba2c`；sunny yellow `#f5c31c`；coral `#e05a5a`；文字暖棕 `#794f27`；底色奶油 `#f8f8f0`/`#f0e8d8`。
- 圆角 16–24px、2px 描边、柔和阴影、圆体字(Nunito 兜底系统圆体)。大量圆润卡通形状、咸鱼/鱼/叶子/水洼元素。

## 部署 / 改名
- `gh repo rename` 把仓库 `1406rocks` → `saltyfish`（用户授权我做）；更新 `/tmp/1406rocks-deploy` 的 remote；推送后线上变 `felixqi4587.github.io/saltyfish`。页面间用相对链接(index/defense/gift.html)，Worker WBASE 绝对地址不受影响。

## 数据模型 / Worker
- 复用现有 plan 端点与 schema（向后兼容）；防守者管理区只编辑 `enemyWhales`(+可选 `tactics` 提示)。其余字段留空不用。Worker 其它（礼包码/Discord/auth）不动。

## 验收
- 三页都动森风、好看可爱；防守者页雷达+精确时间轴随输入实时重算、DELTA=1；管理区 666 才可设敌鲸并发布；礼包码页功能不回退；线上 `/saltyfish` 可访问、页面互跳正常、无 console error。

## 用户明确指令
- 批准设计，**不再过目 spec**，直接 spec→plan→execute 做到完成。
