#!/system/bin/sh
# DeviceHub 清理器 · 安装脚本（由 KernelSU / Magisk 安装器调用）
SKIPUNZIP=0

ui_print "- DeviceHub 清理器 v1.0.0 正在安装"

MODDIR_PATH="$MODPATH"
BASE=/data/adb/devicehub-remover

ui_print "- 创建配置目录 $BASE"
mkdir -p "$BASE" 2>/dev/null

if [ ! -f "$BASE/config.conf" ]; then
  ui_print "- 写入默认配置（首次安装）"
  cat > "$BASE/config.conf" <<'EOF'
# DeviceHub 清理器 配置
# 要清理的目标包名
TARGET_PKG=com.devicehub.agent
# 自然语言日志输出目录（可改成任意目录，例如 /sdcard/Documents/清理日志）
LOG_DIR=/sdcard/DeviceHub清理日志
# 只报告不删除：1 表示只记录发现的东西，不真正删除
REPORT_ONLY=0
# 开机后是否自动执行一次清理
AUTO_BOOT=1
# 常驻守护：1 表示清理完成后持续按间隔复查并把新出现的东西再清掉
WATCH=0
# 守护间隔（秒）
WATCH_INTERVAL=6
# 判断一个脚本是否属于 DeviceHub 的关键字（基本正则）
PATTERN=devicehub|cxx\.360nb\.top|DH_BOOT_URL
EOF
else
  ui_print "- 检测到已有配置，保留原有设置"
fi

ui_print "- 设置文件权限"
set_perm_recursive "$MODDIR_PATH" 0 0 0755 0644
set_perm_recursive "$MODDIR_PATH/bin" 0 0 0755 0755
set_perm "$MODDIR_PATH/service.sh" 0 0 0755
set_perm "$MODDIR_PATH/uninstall.sh" 0 0 0755
set_perm "$MODDIR_PATH/action.sh" 0 0 0755
set_perm "$MODDIR_PATH/customize.sh" 0 0 0755
set_perm "$MODDIR_PATH/bin/dh-clean.sh" 0 0 0755

ui_print "- 完成。重启后生效，或直接打开模块卡片里的 WebUI 手动执行一次。"
ui_print "- 日志默认输出到 /sdcard/DeviceHub清理日志"
