#!/system/bin/sh
# DeviceHub 清理器 · 开机阶段执行
MODDIR=${0%/*}
BASE=/data/adb/devicehub-remover
CONF=$BASE/config.conf

[ -f "$CONF" ] || exit 0

conf_get() { grep -m1 "^$1=" "$CONF" 2>/dev/null | cut -d= -f2- | tr -d '\r'; }

AUTO_BOOT=$(conf_get AUTO_BOOT)
[ -n "$AUTO_BOOT" ] || AUTO_BOOT=1
[ "$AUTO_BOOT" = "1" ] || exit 0

# 等系统启动完成，避免与服务启动阶段抢资源
i=0
while [ "$(getprop sys.boot_completed 2>/dev/null)" != "1" ] && [ "$i" -lt 90 ]; do
  sleep 2
  i=$((i + 1))
done
sleep 10

# 放到后台执行，不阻塞开机流程
sh "$MODDIR/bin/dh-clean.sh" --mode=boot >/dev/null 2>&1 &
