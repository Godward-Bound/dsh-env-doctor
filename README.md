# dsh-env-doctor

> 简体中文 | [English](README.en.md)

DSH 插件：一条调用查这台 Windows 机器的现状——配置清单里的端口哪个在监听（PID / 进程名 / 启动时间）、各盘还剩多少、系统 Temp 下 DSH 的 `dsh-*` 快照目录占了多少空间。只读、零依赖、不联网。

DSH 的快照机制会在 Temp 下留下 `dsh-*` 目录，日积月累能把 C 盘吃满——实测见过一台机器一次扫出 182 个 / 6.93 GB，是 C 盘空间的第一大项。这个插件把这件事变成一句话就能问的事。

## 安装

在 DSH 会话里：

```
dsh plugin --profile desktop add github:Godward-Bound/dsh-env-doctor
```

`desktop` 换成你的 profile 名。仅支持 Windows（端口探测用 `netstat -ano` / `wmic` / `tasklist`）。

## 用法

工具名 `env_doctor`，参数 `what`：`ports` / `disk` / `session` / `all`（默认 `all`）。

装好后默认不带端口清单（不猜你机器上在跑什么）。给它一份要盯的端口：在 Plugin Manager 里给实例 config 加 `ports: [3000, 8080]`，或在 profile 的 `cordis.patch.yml` 里加覆盖条目：

```yaml
- id: env-doctor
  name: dsh-env-doctor
  config:
    ports: [3000, 8080]
```

不配 ports 不会崩：`env_doctor(what=ports)` 返回一段「怎么配」的引导。

## 输出示例

`env_doctor(what=ports)` 的真实输出格式（端口与进程名为示例值）：

```
【环境自检】2026-11-21T14:07:26.562Z（耗时 0.4s）
— 端口（活 10/11）
3000 ● node pid=17368 启动=2026-11-21 21:50:55（本地）
5432 ● postgres pid=10000 启动=2026-11-20 23:55:05（本地）
8080 ● my-app pid=20992 启动=2026-11-20 23:54:53（本地）
未监听：3306
```

`disk` 段的真实输出（Temp 内容因机器而异）：

```
— 磁盘
C: 总 100G / 余 7.3G（7%）
D: 总 189G / 余 21.4G（11%）
— Temp（97 项）：合计 534.3M；dsh-* 快照 24 个 / 117.2M
最大 5 项：restore-test 367.4M、dsh-workspace-changes-cH3ke7 20.0M、…
```

`session` 段需要 SurfCore 遥测（`surfcoreStateDir`）：没配就恒 `UNKNOWN`，输出会写明原因——不估、不编。

## Config

| 键 | 默认 | 作用 |
|---|---|---|
| `ports` | `[]` | 要体检的端口清单；空 = 返回配置引导 |
| `drives` | `["C:", "D:", "E:", "F:"]` | 要体检的盘 |
| `tempDir` | 空 = `os.tmpdir()`（路径含 `dsh-` 时自动退回 `%LOCALAPPDATA%\Temp`） | 快照扫描根 |
| `snapshotPrefix` | `"dsh-"` | 快照目录前缀 |
| `surfcoreStateDir` | 空 | SurfCore 遥测目录（session 段数据源）；不配则 session 恒 UNKNOWN |
| `scanFileCap` | `200000` | 递归扫描的文件数防御上限 |

更多细节见 [docs/DETAIL.md](docs/DETAIL.md)。

## License

[MIT](LICENSE) © 2026 Godward-Bound
