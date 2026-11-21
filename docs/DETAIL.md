# dsh-env-doctor · 环境自检

## 是什么

一个 Host-only 插件，注册一个工具 `env_doctor`。一次调用回答四个问题：

1. **ports** —— 配置清单里的端口，哪个在监听、PID、进程名、进程启动时间。
2. **disk** —— 各盘 total/free；系统 Temp 下 `dsh-*` 快照的个数与总大小；Temp 总和与最大的 5 个子项。
3. **session** —— 当前会话的轮数与 token 消耗（数据来自 SurfCore 遥测，按 sessionId 匹配；没配遥测目录就恒 UNKNOWN）。
4. **all** —— 以上全部（默认）。

## 参数

`what`：`ports` / `disk` / `session` / `all`（默认 `all`）。

## 快速开始

装好后 `env_doctor` 默认不带端口清单（不猜你机器上在跑什么）。给它一份要盯的端口：

- 在 Plugin Manager 里给这个实例的 config 加 `ports: [3000, 8080]`；或
- 在 profile 的 `cordis.patch.yml` 里加覆盖条目：

  ```yaml
  - id: env-doctor
    name: dsh-env-doctor
    config:
      ports: [3000, 8080]
  ```

不配 ports 也不会崩：`env_doctor(what=ports)` 返回一段「怎么配」的引导。

## 口径（读输出之前先看这段）

- **进程启动时间**来自 wmic 定点查询（一次调用同时拿进程名与创建时间）。wmic 超时或失败时，进程名回退 `tasklist`，启动时间标 `UNKNOWN`（原因写在该行末尾）。
- **Temp 根**：显式配了 `tempDir` 就用它；否则用 `os.tmpdir()`。若 `os.tmpdir()` 的路径里含 `dsh-`（DSH 会把子进程的 TEMP 重定向到自己的私有目录），自动退回 `%LOCALAPPDATA%\Temp`。最终扫了哪个目录，输出 detail 里会写。
- **快照扫描**递归全 Temp（几千文件量级，亚秒完成）。防御性上限：20 万文件，触顶后该项标 `partial`（口径写进 detail）。
- **session 数据**按 sessionId 匹配 SurfCore 遥测文件（`token-usage.jsonl` 的 `sid`/`turn`/`b` 字段）。没配 `surfcoreStateDir`、当前会话不走桥接遥测、或遥测里没有该会话的行，字段标 `UNKNOWN` 并写明原因——**不估、不编**。
- 遥测里 `b` 是**每次上报的增量**（不是累计），所以 token 消耗 = 按 sid 求和。

## Config（可配）

| 键 | 默认 | 说明 |
|---|---|---|
| `ports` | `[]` | 要体检的端口清单；空 = 返回配置引导 |
| `drives` | C/D/E/F | 要体检的盘 |
| `tempDir` | 空 = `os.tmpdir()`（含 `dsh-` 时退回 `%LOCALAPPDATA%\Temp`） | 快照扫描根 |
| `snapshotPrefix` | `dsh-` | 快照目录前缀 |
| `surfcoreStateDir` | 空 | SurfCore 遥测目录；不配则 session 段恒 UNKNOWN |
| `scanFileCap` | 200000 | 递归扫描的文件数上限 |

用户路径（ports / tempDir / surfcoreStateDir）集中在 Config，代码里不散落。

## 零依赖

只用 Node 内置模块（`node:fs` / `node:fs/promises` / `node:child_process` / `node:path` / `node:os`）。Schemastery 从宿主加载，加载失败则 Config 不导出，一切走 `cordis.patch.yml` 的 config 与内置默认值，功能不降级。

## 平台与性能预算

端口探测用 `netstat -ano` / `wmic` / `tasklist`，仅支持 Windows。单次调用目标 < 5 秒：netstat（~50ms）+ wmic 定点查（~0.9s）与磁盘递归（~0.4s）**并行**；全部子进程带超时，超时按降级路径出数，不空转。
