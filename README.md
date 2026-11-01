# DeviceHub 清理器 · APK 版

把原来只跑在 KernelSU / Magisk WebUI 里的「DeviceHub 清理器」，做成一个可以直接安装的安卓 App。

- **界面**：沿用原来的 9 阶段进度界面（`app/src/main/assets/webui/`），显示每个阶段在做什么、这次结论如何、实时日志。
- **执行**：`MainActivity` 内置 `su -c` 通道，调用 `assets/bin/dh-clean.sh`，不需要 root 管理器也能用（当然要 root 权限才删得动东西）。
- **日志**：默认写到 `/sdcard/DeviceHub清理日志`，纯中文自然语言，可在 App 设置里改成任意可写目录。
- **日志回传**：可选功能，默认关闭。在设置里填「回传地址」并打开「清理后自动回传」，每次清理跑完会把日志文本 POST 到该地址；留空则什么都不发，日志只留本机。支持通用 `multipart/form-data`（字段名 `file`）和 Telegram Bot `sendDocument` 两种接收方式，日志面板另有「立即回传」按钮可手动补发。
- **状态**：`state.ini` / `live.log` / `config.conf` 在 App 私有目录 `files/dh/` 下，通过 `DH_BASE`、`MODDIR` 环境变量传给脚本。
- **首启引导页**：第一次打开不是直接进 WebUI，而是先弹原生权限说明页——写明 Root 只用于「扫描 DeviceHub 相关文件」和「写入并保存清理日志」，点「检测 Root 权限」才真正执行 `su`；检测结束后无论成功失败都倒计时 3 秒自动进入主界面（未授权进只读模式）。

## 目录

```
app/                         安卓工程（Java，无第三方依赖，WebView + JS 桥）
app/src/main/assets/webui/   index.html / style.css / app.js / bridge.js
app/src/main/assets/bin/     dh-clean.sh（9 阶段清理核心）
kernelsu-module/             同一份功能的 KernelSU / Magisk 模块源码
.github/workflows/build-apk.yml   GitHub Actions：push 即编译并发布 APK
```

## 编译

不用本地环境，交给 GitHub Actions：

1. 推送代码到 `main` 分支（或在 Actions 页面点 Run workflow）；
2. 等 `Build APK` 跑完；
3. 从 Releases 页下载 `DeviceHub-cleaner-v1.0.3.apk`，或从 Actions 产物里下。

本地编译（有 JDK 17 + Android SDK 34 时）：

```bash
gradle assembleRelease
# 输出 app/build/outputs/apk/release/app-release.apk
```

## 日志回传（v1.0.3 新增）

默认关闭，日志只写本机、不发任何请求。要用就在 App 设置面板里填：

1. **回传地址**，两种填法按地址自动识别：
   - 通用接口：任意能收 `multipart/form-data` 的 URL。文件字段名 `file`，同时附带 `device`、`android`、`app`、`log_name` 四个文本字段。
   - Telegram：填 `https://api.telegram.org/bot<你的TOKEN>/sendDocument`，再在「chat_id」里填目标会话 ID，会以「文档 + 说明」的形式发过去。
2. **清理后自动回传**：打开后，每次清理跑完（成功或失败）自动发一次。

不想自动也可以在日志面板点「立即回传」，手动发当前这一份。上传在后台线程执行，连接 15 秒、读取 60 秒超时，失败只在面板上显示红字，不影响清理进程；单份日志最多发前 512 KB。

回传内容就是日志文件本身的文本，不附加任何其它数据。地址留空等于功能彻底关闭。

## 固定签名（可选，但建议配上）

不配的话 CI 用 debug keystore，每次构建签名都不一样，安卓会认为是不同的应用，用户每次升级都得先卸载（卸载会丢设置和旧日志）。

配一次，以后一直用：

1. 本地生成 keystore（只需要做一次）：

```bash
keytool -genkeypair -v -keystore release.jks -alias devicehub \
  -keyalg RSA -keysize 2048 -validity 10000
```

2. 转成 base64：`base64 -w0 release.jks > release.b64`
3. 仓库 Settings → Secrets and variables → Actions，加四个 Secret：

| Secret | 内容 |
| --- | --- |
| `KEYSTORE_BASE64` | `release.b64` 的全部内容 |
| `KEYSTORE_PASSWORD` | 生成时设的仓库口令 |
| `KEYSTORE_ALIAS` | `devicehub` |
| `KEY_PASSWORD` | key 口令（一般和仓库口令相同） |

`app/build.gradle` 发现 `KEYSTORE_PATH` 指向的文件存在就用它签，否则退回 debug，所以不配也能正常构建。

> 注意：v1.0.2 及更早版本的签名已经找不回来了，从旧版升到 v1.0.3 仍需卸载一次；v1.0.3 之后就能一直覆盖升级。

## 说明

- APK 默认用 debug keystore 签名，可以直接安装；长期分发请按上面的「固定签名」配好 Secret。
- 第一次启动会先显示权限说明页，点「检测 Root 权限」后由 Magisk / KernelSU / APatch 弹出授权窗口；允许后界面才能执行操作，拒绝则 3 秒后进入只读预览模式。
- 脚本默认对 `com.devicehub.agent` 动手，删除前都会先备份到 `files/dh/quarantine/`。
