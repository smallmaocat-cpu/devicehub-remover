# DeviceHub 清理器 · APK 版

把 KernelSU / Magisk WebUI 里的 DeviceHub 清理器封装为可安装 APK。

- **界面**：9 阶段进度 + 实时日志（`app/src/main/assets/webui/`）。
- **执行**：`MainActivity` 内置 `su -c` 通道，调用 `assets/bin/dh-clean.sh`；无需 root 管理器，但需 root 权限。
- **日志**：默认 `/sdcard/DeviceHub清理日志`，可改。
- **回传**：可选，默认关。填地址并开启后，跑完 POST 日志；`multipart/form-data`（字段 `file`）或 Telegram `sendDocument`。
- **状态**：`state.ini` / `live.log` / `config.conf` 位于 `files/dh/`，经 `DH_BASE`、`MODDIR` 传给脚本。
- **首启**：原生权限说明页 → 点「检测 Root 权限」才执行 `su` → 3 秒后进主界面（未授权为只读）。
- **加固**：release 走 R8 混淆 + 资源收缩，规则见 `app/proguard-rules.pro`（JS 桥已白名单）。

## 目录

```
app/                         安卓工程（Java，无三方依赖，WebView + JS 桥）
app/src/main/assets/webui/   index.html / style.css / app.js / bridge.js
app/src/main/assets/bin/     dh-clean.sh（9 阶段清理核心）
kernelsu-module/             同功能的 KernelSU / Magisk 模块源码
.github/workflows/build-apk.yml   push 即编译并发布 APK
```

## 编译

推 `main`（或 Actions 手动 Run）→ 等 `Build APK` → Releases 取 `DeviceHub-cleaner-v1.0.4.apk`。

本地（JDK 17 + SDK 34）：

```bash
gradle assembleRelease
# app/build/outputs/apk/release/app-release.apk
```

> 本地 `build-apk.sh` 走 aapt2/javac/d8，不含 R8；混淆产物只在 Gradle/CI 路径生成。

## 日志回传

默认关闭，只写本机。设置面板填：

1. **回传地址**，按地址自动识别：
   - 通用接口：可收 `multipart/form-data` 的 URL；文件字段 `file`，附 `device`、`android`、`app`、`log_name`。
   - Telegram：`https://api.telegram.org/bot<TOKEN>/sendDocument` + `chat_id`，以文档形式发送。
2. **清理后自动回传**：开则每轮跑完自动发一次。

手动补发点日志面板「立即回传」。上传在后台线程，连接 15s、读取 60s 超时，失败仅红字提示，不阻塞清理；单份最多 512 KB。留空即关闭。

## 固定签名（建议配）

不配则用 debug keystore，每版签名不同，升级须先卸载（丢设置与旧日志）。

1. 生成：

```bash
keytool -genkeypair -v -keystore release.jks -alias devicehub \
  -keyalg RSA -keysize 2048 -validity 10000
```

2. `base64 -w0 release.jks > release.b64`
3. Settings → Secrets and variables → Actions，加四个：

| Secret | 内容 |
| --- | --- |
| `KEYSTORE_BASE64` | `release.b64` 全部内容 |
| `KEYSTORE_PASSWORD` | 仓库口令 |
| `KEYSTORE_ALIAS` | `devicehub` |
| `KEY_PASSWORD` | key 口令 |

`build.gradle` 见 `KEYSTORE_PATH` 指向的文件存在即用之，否则退回 debug，不配也能构建。

## 说明

- 首启为权限说明页；授权由 Magisk / KernelSU / APatch 弹窗，拒绝则 3 秒后进只读预览。
- 默认目标包 `com.devicehub.agent`，删除前备份至 `files/dh/quarantine/`。
