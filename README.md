<div align="center">

# 🔍 dsh-env-doctor

**一条调用，看清这台 Windows 机器现在的状态**
**哪些端口在监听 · 各盘还剩多少 · DSH 的快照在 Temp 里占了多少**

[![Platform](https://img.shields.io/badge/platform-Windows%20only-0078d4)](https://github.com/Godward-Bound/dsh-env-doctor)
[![License](https://img.shields.io/badge/license-MIT-3fb950)](LICENSE)
[![Dependencies](https://img.shields.io/badge/dependencies-zero-3fb950)](https://github.com/Godward-Bound/dsh-env-doctor)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-8a63d2)](https://nodejs.org)
[![Network](https://img.shields.io/badge/network-calls-none-3fb950)](https://github.com/Godward-Bound/dsh-env-doctor)

**简体中文** · [English](README.en.md)

</div>

---

DSH 插件（Host-only，无界面）：注册一个只读工具 `env_doctor`。零依赖、不联网、不改主机任何东西。

DSH 每次会话动作都在 Temp 下落一个 `dsh-*` 快照目录，从不自动回收，日积月累能把 C 盘吃满——实测见过一台机器一次扫出 **182 个 / 6.93 GB**，是那块盘上的第一大项。这个插件把这件事变成一句话就能问清楚的事。

## 📦 安装

在 DSH 会话里：

```bash
dsh plugin --profile desktop add github:Godward-Bound/dsh-env-doctor
```

> 桌面版没有 `dsh` 命令时，也可以走 DSH 的 **Settings → Plugins** 搜索安装，或让 agent 调 `plugin_manager install_bundle`，target 传本仓库地址。

> 想锁定版本就用 `github:Godward-Bound/dsh-env-doctor#<commit-sha>`。官方发布文档建议锁 commit，避免上游后续推送悄悄改变实际运行内容。

> `desktop` 换成你的 profile 名。
> **仅支持 Windows**——端口探测走 `netstat -ano` / `wmic` / `tasklist`。

## 🔌 用法

工具名 `env_doctor`，参数 `what`：

| `what` | 报告什么 |
|:--|:--|
| `ports` | 配置里的端口哪些在监听：PID、进程名、进程启动时间 |
| `disk` | 各盘总量/余量 · Temp 合计 · `dsh-*` 快照个数与大小 · 最大 5 项 |
| `session` | 本会话轮数与 token 消耗（读 SurfCore 遥测，需配置） |
| `all`（默认） | 以上全部 |

装好之后**默认不带端口清单**——它不猜你机器上跑着什么。要盯哪些端口，在 Plugin Manager 的实例 config 里加，或在 profile 的 `cordis.patch.yml` 里加覆盖条目：

```yaml
- id: env-doctor
  name: dsh-env-doctor
  config:
    ports: [3000, 8080]
```

没配 ports 也不会崩、不会返回空表——它会告诉你这段配置该写在哪。

## 🖥 输出示例

`env_doctor(what=ports)` 的真实格式（端口与进程名是示例值）：

```text
【环境自检】2026-11-21T14:07:26.562Z（耗时 0.4s）
— 端口（活 10/11）
3000 ● node pid=17368 启动=2026-11-21 21:50:55（本地）
5432 ● postgres pid=10000 启动=2026-11-20 23:55:05（本地）
8080 ● my-app pid=20992 启动=2026-11-20 23:54:53（本地）
未监听：3306
```

`disk` 段的真实格式（Temp 内容因机器而异）：

```text
— 磁盘
C: 总 100G / 余 7.3G（7%）
D: 总 189G / 余 21.4G（11%）
— Temp（97 项）：合计 534.3M；dsh-* 快照 24 个 / 117.2M
最大 5 项：restore-test 367.4M、dsh-workspace-changes-cH3ke7 20.0M、…
```

> `session` 段需要 SurfCore 遥测（`surfcoreStateDir`）。没配就恒为 `UNKNOWN`，**并把原因写在输出里**——不估、不编。

## 🧠 原理

- **端口**：一次 `netstat -ano`（约 50 ms）拿到 PIDs → 一次定点 `wmic`（约 0.9 s）拿进程名与创建时间；`tasklist` 作为只读名称的兜底。每个子进程都有超时，端口与磁盘并行跑，整次调用控制在 5 秒内。
- **磁盘**：各盘 `statfs` + 对 Temp 的一次并发递归统计，带文件数上限。几千个文件不到一秒。
- **会话**：按 `sessionId` 扫 SurfCore 的 `token-usage.jsonl`，token 按每次上报的增量累加。

全程只读。细节见 [docs/DETAIL.md](docs/DETAIL.md)。

## ⚙️ 配置

| 键 | 默认 | 作用 |
|:--|:--|:--|
| `ports` | `[]` | 要体检的端口；空 = 返回配置引导 |
| `drives` | `["C:", "D:", "E:", "F:"]` | 要体检的盘 |
| `tempDir` | 空 = `os.tmpdir()`¹ | 快照扫描根 |
| `snapshotPrefix` | `"dsh-"` | 认作快照的目录前缀 |
| `surfcoreStateDir` | 空 | SurfCore 遥测目录；不配则 session 恒 `UNKNOWN` |
| `scanFileCap` | `200000` | 递归扫描的文件数上限（超了标 `partial`） |

¹ 若 `os.tmpdir()` 路径里含 `dsh-`（DSH 会把子进程的 TEMP 重定向到私有目录），自动退回 `%LOCALAPPDATA%\Temp`。实际扫的是哪个目录，输出里会写明。

## 📄 License

[MIT](LICENSE) © 2026 Godward-Bound
