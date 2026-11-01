# DeviceHub 清理器 · APK 版

把原来只跑在 KernelSU / Magisk WebUI 里的「DeviceHub 清理器」，做成一个可以直接安装的安卓 App。

- **界面**：沿用原来的 9 阶段进度界面（`app/src/main/assets/webui/`），显示每个阶段在做什么、这次结论如何、实时日志。
- **执行**：`MainActivity` 内置 `su -c` 通道，调用 `assets/bin/dh-clean.sh`，不需要 root 管理器也能用（当然要 root 权限才删得动东西）。
- **日志**：默认写到 `/sdcard/DeviceHub清理日志`，纯中文自然语言，可在 App 设置里改成任意可写目录。
- **状态**：`state.ini` / `live.log` / `config.conf` 在 App 私有目录 `files/dh/` 下，通过 `DH_BASE`、`MODDIR` 环境变量传给脚本。

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
3. 从 Releases 页下载 `DeviceHub-清理器-v1.0.0.apk`，或从 Actions 产物里下。

本地编译（有 JDK 17 + Android SDK 34 时）：

```bash
gradle assembleRelease
# 输出 app/build/outputs/apk/release/app-release.apk
```

## 说明

- APK 用 debug keystore 签名，可以直接安装；要上架或长期分发请换自己的签名。
- 第一次运行时系统会弹 root 授权（Magisk / KernelSU / APatch 都会弹），允许后界面才能执行操作；拒绝授权则界面进入预览模式。
- 脚本默认对 `com.devicehub.agent` 动手，删除前都会先备份到 `files/dh/quarantine/`。
