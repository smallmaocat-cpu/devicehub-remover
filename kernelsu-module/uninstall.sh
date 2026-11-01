#!/system/bin/sh
# DeviceHub 清理器 · 卸载时清理运行时数据（保留 /sdcard 上已生成的日志）
rm -rf /data/adb/devicehub-remover 2>/dev/null
