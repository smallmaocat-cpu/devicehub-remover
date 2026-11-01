# DeviceHub 清理器（KernelSU / Magisk 模块，带 WebUI）

把「一段在黑框里跑的清理脚本」变成可以在手机上点着用、看得懂、留得下记录的东西。

- 9 个运行阶段，WebUI 里实时显示当前阶段、进度和结论
- 每个阶段都能点开看：为什么要这么做、具体做了什么、这次的结果、日志怎么读
- 按自定义目录输出**纯中文自然语言日志**（默认 `/sdcard/DeviceHub清理日志`）
- 删掉的脚本先备份到隔离目录，出问题可以拿回来
- 支持「只报告不删除」模式，先看看到底有什么再动手

## 关于原始脚本的改动

原始脚本是一个死循环：每 6 秒杀一次进程、卸一次应用、删一次目录。直接照搬会有几个问题，本模块做了这些调整：

| 原始写法 | 本模块 | 原因 |
| --- | --- | --- |
| `while true; do ... sleep 6; done` 无条件常驻 | 开机/手动跑一次，**常驻守护改为可选**（默认关） | 每 6 秒扫一遍 `/proc` 和 `pm list packages` 很耗电，也容易和系统进程管理打架 |
| 直接 `rm -f` 删掉别人的启动脚本 | 先复制到 `/data/adb/devicehub-remover/quarantine/<时间>/`，再删 | 关键字可能命中自己写的正常脚本，留个后悔的余地 |
| `find /sdcard /storage ...` 全盘扫描 | 只扫 `/sdcard`（最多 6 层，跳过 Android 目录），不再重复扫 `/storage` | `/storage/emulated/0` 就是 `/sdcard`，扫两遍纯属浪费 |
| 所有输出丢进 /dev/null | 每步写一份中文说明，还额外生成一份总结 | 事后没人知道它到底干了什么 |
| 没有权限/环境判断 | 第 1 阶段先自检，失败就中止 | 避免在错误的前提下一顿乱删 |

## 安装

1. 把 `DeviceHub-清理器-v1.0.0.zip` 传到手机
2. KernelSU / Magisk 管理器 → 模块 → 从本地安装 → 选中 zip → 重启
3. 打开模块卡片进入 WebUI，点「开始清理」

也可以在模块卡片上点「操作」按钮执行一次（输出会直接显示在管理器里）。

## WebUI 能做什么

- **开始清理**：后台启动 `bin/dh-clean.sh --mode=webui`，界面每 0.9 秒读一次状态文件
- **阶段列表**：9 个阶段，颜色区分「已完成 / 无需处理 / 需留意 / 未成功 / 进行中」
- **展开任一阶段**：看到这一步的原理、具体动作、本次结论、以及这一步产生的日志行
- **日志文件**：直接读日志全文，可复制路径
- **设置**：日志目录、只报告模式、开机自动执行、常驻守护与间隔

## 目录结构

```
devicehub-remover/
├── module.prop
├── customize.sh          # 安装时创建配置、设权限
├── service.sh            # 开机等 boot_completed 后执行一次
├── action.sh             # 模块卡片「操作」按钮
├── uninstall.sh
├── bin/dh-clean.sh       # 核心：9 阶段清理
└── webroot/
    ├── index.html
    ├── style.css
    └── app.js
```

运行时数据（不随模块卸载删除到 /sdcard 的部分）：

```
/data/adb/devicehub-remover/
├── config.conf      # 配置
├── state.ini        # 当前阶段/进度/每阶段结论（WebUI 读它）
├── live.log         # 滚动日志（带阶段号）
├── stop.flag        # 停止守护
└── quarantine/      # 被删文件的备份
```

## 配置项

`/data/adb/devicehub-remover/config.conf`，也可以在 WebUI 的设置面板里改：

```ini
TARGET_PKG=com.devicehub.agent
LOG_DIR=/sdcard/DeviceHub清理日志
REPORT_ONLY=0
AUTO_BOOT=1
WATCH=0
WATCH_INTERVAL=6
PATTERN=devicehub|cxx\.360nb\.top|DH_BOOT_URL
```

`LOG_DIR` 可以改成任意可写目录，例如 `/sdcard/Documents/清理记录`。

## 日志长什么样

`/sdcard/DeviceHub清理日志/DeviceHub清理日志-20261101-124501.txt`：

```
2026-11-01 12:45:01  开始了一次清理任务，运行方式：webui。
2026-11-01 12:45:01  开始第2阶段（停止运行中的应用）：用系统命令停掉目标应用，让它没机会在清理过程中重新写文件
2026-11-01 12:45:03  第2阶段结论：已强制停止 com.devicehub.agent（运行中的进程号 14222），复查确认它已经不再运行。
```

以及同目录的 `最近一次清理摘要.txt`：一段时间、总数、逐阶段结论、后续建议。

## 需要留意的两件事

1. **第 4 阶段卸载失败**：说明目标应用开了「设备管理器」或「无障碍」。到 设置 → 安全 → 设备管理器应用 / 无障碍 里取消授权，再跑一次。
2. **第 7 阶段误删**：本模块只删「同时命中关键字」的 `.sh`。万一命中了你自己写的脚本，去 `/data/adb/devicehub-remover/quarantine/<时间>/` 找备份（文件名的 `/` 被替换成 `_`）。

先不放心的话，把设置里的「只报告不删除」打开跑一遍，看看它到底想删什么。
