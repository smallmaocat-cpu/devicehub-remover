#!/system/bin/sh
# DeviceHub 清理器 · KernelSU 模块卡片上的「操作」按钮
MODDIR=${0%/*}
BASE=/data/adb/devicehub-remover
export MODDIR

echo "=== DeviceHub 清理器 · 立即执行 ==="
sh "$MODDIR/bin/dh-clean.sh" --mode=action --no-watch
echo
echo "=== 最近日志 ==="
tail -n 40 "$BASE/live.log" 2>/dev/null | sed 's/^S[0-9]*|//'
echo
echo "完整日志: $(grep -m1 '^log_file=' "$BASE/state.ini" 2>/dev/null | cut -d= -f2-)"
