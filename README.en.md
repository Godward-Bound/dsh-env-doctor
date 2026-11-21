<div align="center">

# 🔍 dsh-env-doctor

**One agent call to check what this Windows box is doing —**
**which ports are listening, how much disk is left, and how much space
DSH's `dsh-*` snapshot folders are wasting under Temp.**

[![Platform](https://img.shields.io/badge/platform-Windows%20only-0078d4)](https://github.com/Godward-Bound/dsh-env-doctor)
[![License](https://img.shields.io/badge/license-MIT-3fb950)](LICENSE)
[![Dependencies](https://img.shields.io/badge/dependencies-zero-3fb950)](https://github.com/Godward-Bound/dsh-env-doctor)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-8a63d2)](https://nodejs.org)
[![Network](https://img.shields.io/badge/network-calls-none-3fb950)](https://github.com/Godward-Bound/dsh-env-doctor)

[简体中文](README.md) · **English**

</div>

---

A DSH plugin (Host-only, no UI) that registers a single read-only agent tool, `env_doctor`.
Zero npm dependencies, no network calls, nothing on your machine is modified.

DSH leaves `dsh-*` snapshot folders under Temp, and they pile up until the C: drive is full —
one machine was scanned at **182 folders / 6.93 GB**, the single largest item on the disk.
This plugin turns that chore into one question.

## 📦 Install

In a DSH session:

```bash
dsh plugin --profile desktop add github:Godward-Bound/dsh-env-doctor
```

> Replace `desktop` with your profile name.
> **Windows only** — port probing uses `netstat -ano`, `wmic` and `tasklist`.

## 🔌 Usage

| `what` | Reports |
|:--|:--|
| `ports` | Configured ports: listening? PID, process name, process start time |
| `disk` | Per-drive total/free · Temp totals · `dsh-*` snapshot count & size · top 5 items |
| `session` | Current session's turns & token usage (from SurfCore telemetry, if configured) |
| `all` *(default)* | Everything above |

Out of the box the plugin ships **no port list** — it won't guess what's running on your machine.
Point it at the ports you care about, in the Plugin Manager (instance config) or in your
profile's `cordis.patch.yml`:

```yaml
- id: env-doctor
  name: dsh-env-doctor
  config:
    ports: [3000, 8080]
```

No ports configured? It won't crash or return an empty table — you get a hint telling you
exactly where to put the list.

## 🖥 Example output

Real `env_doctor(what=ports)` output (labels are Chinese — this is the genuine format;
ports and process names below are examples):

```text
【环境自检】2026-11-21T14:07:26.562Z（耗时 0.4s）
— 端口（活 10/11）
3000 ● node pid=17368 启动=2026-11-21 21:50:55（本地）
5432 ● postgres pid=10000 启动=2026-11-20 23:55:05（本地）
8080 ● my-app pid=20992 启动=2026-11-20 23:54:53（本地）
未监听：3306
```

Real `disk` section (your Temp contents will differ):

```text
— 磁盘
C: 总 100G / 余 7.3G（7%）
D: 总 189G / 余 21.4G（11%）
— Temp（97 项）：合计 534.3M；dsh-* 快照 24 个 / 117.2M
最大 5 项：restore-test 367.4M、dsh-workspace-changes-cH3ke7 20.0M、…
```

> The `session` section needs SurfCore telemetry (`surfcoreStateDir`).
> Without it the section reports `UNKNOWN` **with the reason spelled out** —
> it never guesses and never invents numbers.

## ⚙️ Configuration

| Key | Default | What it does |
|:--|:--|:--|
| `ports` | `[]` | Ports to probe; empty → config hint instead of a scan |
| `drives` | `["C:", "D:", "E:", "F:"]` | Drives to report |
| `tempDir` | empty = `os.tmpdir()`¹ | Root of the snapshot scan |
| `snapshotPrefix` | `"dsh-"` | Prefix that marks a Temp folder as a snapshot |
| `surfcoreStateDir` | empty | SurfCore telemetry dir; unset → session stays `UNKNOWN` |
| `scanFileCap` | `200000` | Safety cap for the recursive scan (flags the result as `partial`) |

¹ If `os.tmpdir()` contains `dsh-` (DSH redirects child-process TEMP into a private folder),
it automatically falls back to `%LOCALAPPDATA%\Temp`. The directory that was actually scanned
is always shown in the output detail.

## 🧠 How it works

- **Ports** — one `netstat -ano` call (~50 ms) → PIDs → one targeted `wmic` query (~0.9 s)
  for names + creation dates; `tasklist` as a name-only fallback. Every subprocess has a
  timeout; the whole call stays under a 5-second budget (ports and disk run in parallel).
- **Disk** — `statfs` per drive + a concurrent recursive size walk over Temp with a
  file-count cap. A few thousand files finish well under a second.
- **Session** — scans SurfCore's `token-usage.jsonl` for the current `sessionId`;
  token values are per-report deltas summed by session.

Strictly read-only, end to end. Full details in [docs/DETAIL.md](docs/DETAIL.md) (Chinese).

## 📄 License

[MIT](LICENSE) © 2026 Godward-Bound
