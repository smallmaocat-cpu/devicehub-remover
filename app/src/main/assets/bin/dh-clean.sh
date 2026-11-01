#!/system/bin/sh
# ============================================================
# DeviceHub 清理器 · 分阶段清理核心脚本
#   调用方式：sh dh-clean.sh [--mode=webui|boot|action|once]
#                          [--report-only] [--no-watch]
#
# 运行期间持续写入两个文件：
#   /data/adb/devicehub-remover/state.ini  给 WebUI 显示阶段进度
#   /data/adb/devicehub-remover/live.log   给 WebUI 显示的滚动日志
# 同时按配置把「纯中文自然语言日志」写到 LOG_DIR。
# ============================================================

BASE=${DH_BASE:-/data/adb/devicehub-remover}
MODDIR=${MODDIR:-/data/adb/modules/devicehub-remover}
CONF=$BASE/config.conf
STATE=$BASE/state.ini
LIVE=$BASE/live.log
STOPFLAG=$BASE/stop.flag
QROOT=$BASE/quarantine
S_TOTAL=9
T0=$(date +%s)
RUN_ID=$(date +%Y%m%d-%H%M%S)

MODE=once
FORCE_REPORT=0
NOWATCH=0
for a in "$@"; do
  case "$a" in
    --mode=*) MODE=${a#--mode=} ;;
    --report-only) FORCE_REPORT=1 ;;
    --no-watch) NOWATCH=1 ;;
  esac
done

conf_get() {
  [ -f "$CONF" ] || return 0
  grep -m1 "^$1=" "$CONF" 2>/dev/null | cut -d= -f2- | tr -d '\r'
}

TARGET_PKG=$(conf_get TARGET_PKG)
[ -n "$TARGET_PKG" ] || TARGET_PKG=com.devicehub.agent
LOG_DIR=$(conf_get LOG_DIR)
[ -n "$LOG_DIR" ] || LOG_DIR=/sdcard/DeviceHub清理日志
REPORT_ONLY=$(conf_get REPORT_ONLY)
[ -n "$REPORT_ONLY" ] || REPORT_ONLY=0
WATCH=$(conf_get WATCH)
[ -n "$WATCH" ] || WATCH=0
WATCH_INTERVAL=$(conf_get WATCH_INTERVAL)
[ -n "$WATCH_INTERVAL" ] || WATCH_INTERVAL=6
PATTERN=$(conf_get PATTERN)
[ -n "$PATTERN" ] || PATTERN='devicehub|cxx\.360nb\.top|DH_BOOT_URL'

[ "$FORCE_REPORT" = "1" ] && REPORT_ONLY=1
[ "$NOWATCH" = "1" ] && WATCH=0
[ "$MODE" = "webui" ] || [ "$MODE" = "action" ] || [ "$MODE" = "boot" ] || MODE=once

mkdir -p "$BASE" 2>/dev/null
mkdir -p "$LOG_DIR" 2>/dev/null
if [ ! -d "$LOG_DIR" ] || [ ! -w "$LOG_DIR" ]; then
  LOG_DIR=$BASE/logs
  mkdir -p "$LOG_DIR" 2>/dev/null
fi
LOGFILE="$LOG_DIR/DeviceHub清理日志-$RUN_ID.txt"

# 停掉上轮实例（含守护），避免叠加
RUNPID_FILE=$BASE/run.pid
if [ -f "$RUNPID_FILE" ]; then
  OLDPID=$(cat "$RUNPID_FILE" 2>/dev/null)
  if [ -n "$OLDPID" ] && kill -0 "$OLDPID" 2>/dev/null; then
    echo stop > "$STOPFLAG" 2>/dev/null
    sleep 1
    kill -9 "$OLDPID" 2>/dev/null
  fi
  rm -f "$RUNPID_FILE" 2>/dev/null
fi
echo $$ > "$RUNPID_FILE" 2>/dev/null

rm -f "$STOPFLAG" 2>/dev/null
: > "$LIVE" 2>/dev/null
: > "$LOGFILE" 2>/dev/null

# ---------- 状态字段 ----------
STATUS=running
cur_s=0
cur_name=准备中
PCT=0
MSG=正在准备
WATCHR=0
TOTAL_FOUND=0
TOTAL_REMOVED=0
TOTAL_SKIP=0
TOTAL_FAIL=0

now_str() { date '+%Y-%m-%d %H:%M:%S'; }

say() {
  t=$(now_str)
  echo "S$cur_s|$t|$1" >> "$LIVE" 2>/dev/null
  echo "$t  $1" >> "$LOGFILE" 2>/dev/null
}

flush() {
  {
    printf 'run_id=%s\n' "$RUN_ID"
    printf 'mode=%s\n' "$MODE"
    printf 'status=%s\n' "$STATUS"
    printf 'stage=%s\n' "$cur_s"
    printf 'stage_name=%s\n' "$cur_name"
    printf 'stage_total=%s\n' "$S_TOTAL"
    printf 'percent=%s\n' "$PCT"
    printf 'elapsed=%s\n' "$(( $(date +%s) - T0 ))"
    printf 'message=%s\n' "$MSG"
    printf 'log_file=%s\n' "$LOGFILE"
    printf 'report_only=%s\n' "$REPORT_ONLY"
    printf 'watching=%s\n' "$WATCHR"
    printf 'target=%s\n' "$TARGET_PKG"
    i=1
    while [ "$i" -le "$S_TOTAL" ]; do
      eval "st=\${s${i}_status:-pending}"
      eval "nt=\${s${i}_note:-}"
      eval "fo=\${s${i}_found:-0}"
      eval "rm=\${s${i}_removed:-0}"
      printf 's%s_status=%s\n' "$i" "$st"
      printf 's%s_note=%s\n' "$i" "$nt"
      printf 's%s_found=%s\n' "$i" "$fo"
      printf 's%s_removed=%s\n' "$i" "$rm"
      i=$((i + 1))
    done
  } > "$STATE.new" 2>/dev/null && mv -f "$STATE.new" "$STATE" 2>/dev/null
}

# ---------- 阶段控制 ----------
begin() { # $1 阶段号  $2 阶段名  $3 一句话说明
  cur_s=$1
  cur_name=$2
  MSG=$3
  PCT=$(( ($1 - 1) * 100 / S_TOTAL ))
  eval "s${1}_status=running"
  eval "s${1}_found=0"
  eval "s${1}_removed=0"
  eval "s${1}_note="
  {
    printf '\n'
    printf '────────────────────────────────────────────\n'
    printf '第%s阶段 · %s\n' "$1" "$2"
    printf '────────────────────────────────────────────\n'
  } >> "$LOGFILE" 2>/dev/null
  say "开始第${1}阶段（${2}）：${3}"
  flush
}

finish_stage() { # $1 阶段号  $2 结论 ok|skip|warn|fail  $3 中文结论
  eval "s${1}_status=$2"
  eval "s${1}_note=\$3"
  PCT=$(( $1 * 100 / S_TOTAL ))
  case "$2" in
    ok) TOTAL_REMOVED=$((TOTAL_REMOVED + 1)) ;;
    skip) TOTAL_SKIP=$((TOTAL_SKIP + 1)) ;;
    warn) TOTAL_FAIL=$((TOTAL_FAIL + 1)) ;;
  esac
  say "第${1}阶段结论：$3"
  flush
}

set_counts() { # $1 阶段号  $2 发现数  $3 处理数
  eval "s${1}_found=$2"
  eval "s${1}_removed=$3"
  flush
}

pkg_installed() {
  pm list packages 2>/dev/null | grep -qx "package:$TARGET_PKG"
}

q_copy() { # $1 待隔离文件，返回 0 表示已备份
  d="$QROOT/$RUN_ID"
  mkdir -p "$d" 2>/dev/null || return 1
  n=$(echo "$1" | tr '/' '_')
  cp -f "$1" "$d/$n" 2>/dev/null || return 1
  return 0
}

# ---------- 日志开头 ----------
{
  echo "DeviceHub 清理日志"
  echo "生成时间：$(now_str)"
  echo "运行方式：$MODE"
  echo "设备型号：$(getprop ro.product.brand 2>/dev/null) $(getprop ro.product.model 2>/dev/null)"
  echo "系统版本：Android $(getprop ro.build.version.release 2>/dev/null)（API $(getprop ro.build.version.sdk 2>/dev/null)）"
  echo "目标：$TARGET_PKG"
  if [ "$REPORT_ONLY" = "1" ]; then
    echo "工作模式：只报告（不删除）"
  else
    echo "工作模式：清理（删除前备份到 $QROOT/$RUN_ID）"
  fi
  echo "日志：$LOG_DIR"
  echo "=============================================================================="
} >> "$LOGFILE" 2>/dev/null

cur_s=0
say "清理任务启动，mode=$MODE。"

# ============================================================
# 第 1 阶段：环境自检
# ============================================================
begin 1 环境自检 "root / 系统 / 目标包 / 日志目录"

UID_NOW=$(id -u 2>/dev/null)
ENV_DESC=""
if [ "$UID_NOW" = "0" ]; then
  ENV_DESC="设备已获得最高权限（root）"
else
  ENV_DESC="当前权限不足，uid=$UID_NOW"
fi

KSU_DESC=""
if [ -d /data/adb/ksu ]; then
  KV=$(cat /data/adb/ksu/version 2>/dev/null)
  KSU_DESC="由 KernelSU 管理$([ -n "$KV" ] && echo "（版本 $KV）")"
elif [ -d /data/adb/magisk ]; then
  KSU_DESC="由 Magisk 管理"
elif [ -d /data/adb/ap ]; then
  KSU_DESC="由 APatch 管理"
fi

if pkg_installed; then
  PKG_DESC="目标应用 $TARGET_PKG 当前处于已安装状态"
else
  PKG_DESC="$TARGET_PKG 不在应用列表（已清理或未安装）"
fi

if [ -d "$LOG_DIR" ] && [ -w "$LOG_DIR" ]; then
  LOG_DESC="日志会写入 $LOG_DIR"
else
  LOG_DESC="日志目录 $LOG_DIR 不可写，已改用 $BASE/logs"
fi

KSU_PART=""
[ -n "$KSU_DESC" ] && KSU_PART="，$KSU_DESC"

set_counts 1 0 0
if [ "$UID_NOW" != "0" ]; then
  finish_stage 1 fail "$ENV_DESC，中止。确认模块已在 root 管理器中启用"
  STATUS=failed
  MSG=权限不足，清理中止
  flush
  say "任务中止：没有 root 权限，后面的阶段全部跳过。"
  WATCH=0
  PCT=100
else
  finish_stage 1 ok "$ENV_DESC$KSU_PART。$PKG_DESC。$LOG_DESC。"
fi

# ============================================================
# 第 2 阶段：停止正在运行的应用
# ============================================================
if [ "$STATUS" != "failed" ]; then
begin 2 停止运行中的应用 "停进程，防清理中回写"

STOPPED_NO=""
if pkg_installed; then
  PID_BEFORE=$(pidof "$TARGET_PKG" 2>/dev/null)
  am force-stop "$TARGET_PKG" 2>/dev/null
  if command -v killall >/dev/null 2>&1; then
    killall -9 "$TARGET_PKG" 2>/dev/null
  fi
  sleep 1
  PID_AFTER=$(pidof "$TARGET_PKG" 2>/dev/null)
  if [ -n "$PID_BEFORE" ]; then
    STOPPED_NO="（运行中的进程号 $PID_BEFORE）"
  fi
  set_counts 2 1 1
  if [ -n "$PID_AFTER" ]; then
    finish_stage 2 warn "$TARGET_PKG 已停止$STOPPED_NO，但被拉起（PID $PID_AFTER），疑似守护进程，见 S3。"
  else
    finish_stage 2 ok "已强制停止 $TARGET_PKG$STOPPED_NO，复查确认它已经不再运行。"
  fi
else
  finish_stage 2 skip "目标应用本来就没有安装，不需要停止，跳过。"
fi
fi

# ============================================================
# 第 3 阶段：结束常驻守护进程
# ============================================================
if [ "$STATUS" != "failed" ]; then
begin 3 结束常驻守护进程 "按名扫 devicehub 守护，逐个 kill"

SELF_PID=$$
KILLED=0
KILLED_LIST=""
SCANNED=0
for proc in /proc/[0-9]*; do
  [ -r "$proc/cmdline" ] || continue
  pid=${proc##*/}
  [ "$pid" = "$SELF_PID" ] && continue
  [ "$pid" = "$PPID" ] && continue
  SCANNED=$((SCANNED + 1))
  cmd=$(tr '\000' ' ' < "$proc/cmdline" 2>/dev/null)
  case "$cmd" in
    *devicehub-device*|*devicehub-watchdog*|*devicehub-agent*)
      if kill -9 "$pid" 2>/dev/null; then
        KILLED=$((KILLED + 1))
        KILLED_LIST="$KILLED_LIST $pid"
      fi
      ;;
  esac
done

sleep 1
LEFT=0
for proc in /proc/[0-9]*; do
  [ -r "$proc/cmdline" ] || continue
  [ "${proc##*/}" = "$SELF_PID" ] && continue
  [ "${proc##*/}" = "$PPID" ] && continue
  cmd=$(tr '\000' ' ' < "$proc/cmdline" 2>/dev/null)
  case "$cmd" in
    *devicehub-device*|*devicehub-watchdog*|*devicehub-agent*) LEFT=$((LEFT + 1)) ;;
  esac
done

set_counts 3 "$KILLED" "$KILLED"
if [ "$KILLED" -eq 0 ] && [ "$LEFT" -eq 0 ]; then
  finish_stage 3 skip "$SCANNED 个进程中未见 devicehub 守护。"
elif [ "$LEFT" -eq 0 ]; then
  PIDPART=""
  [ -n "$KILLED_LIST" ] && PIDPART="（进程号${KILLED_LIST}）"
  finish_stage 3 ok "扫描 $SCANNED 进程，结束 $KILLED 个 devicehub 守护$PIDPART。"
else
  PIDPART=""
  [ -n "$KILLED_LIST" ] && PIDPART="（进程号${KILLED_LIST}）"
  finish_stage 3 warn "结束 $KILLED 个$PIDPART，仍有 $LEFT 个在跑，可能被重新拉起。"
fi
fi

# ============================================================
# 第 4 阶段：卸载目标应用
# ============================================================
if [ "$STATUS" != "failed" ]; then
begin 4 卸载目标应用 "pm uninstall 当前用户；处理设备管理器 / 无障碍保护"

if pkg_installed; then
  if [ "$REPORT_ONLY" = "1" ]; then
    set_counts 4 1 0
    finish_stage 4 skip "$TARGET_PKG 仍安装；report-only，未卸载。"
  else
    am force-stop "$TARGET_PKG" 2>/dev/null
    UN_OUT=$(pm uninstall --user 0 "$TARGET_PKG" 2>&1)
    sleep 1
    if pkg_installed; then
      pm clear "$TARGET_PKG" >/dev/null 2>&1
      pm uninstall --user 0 "$TARGET_PKG" >/dev/null 2>&1
      sleep 1
    fi
    if pkg_installed; then
      set_counts 4 1 0
      finish_stage 4 fail "卸载 $TARGET_PKG 失败（$UN_OUT）。多为设备管理器 / 无障碍授权，撤销后手动卸载。"
    else
      set_counts 4 1 1
      finish_stage 4 ok "$TARGET_PKG 已卸载，复查不在应用列表。"
    fi
  fi
else
  finish_stage 4 skip "应用列表里没有 $TARGET_PKG，不需要卸载。"
fi
fi

# ============================================================
# 第 5 阶段：清理系统残留目录与临时文件
# ============================================================
if [ "$STATUS" != "failed" ]; then
begin 5 清理系统残留 "处理 /data/system 下的 devicehub 目录、引导脚本与 tmp 载荷"

F5=0
R5=0
D5=""
rm_one() {
  p=$1
  [ -e "$p" ] || return 0
  F5=$((F5 + 1))
  D5="$D5 $(basename "$p")"
  if [ "$REPORT_ONLY" = "1" ]; then
    say "发现残留 $p（只报告模式，未删除）"
    return 0
  fi
  q_copy "$p" 2>/dev/null
  rm -rf "$p" 2>/dev/null
  if [ -e "$p" ]; then
    say "尝试删除 $p 失败"
    return 0
  fi
  R5=$((R5 + 1))
  say "已删除 $p"
}

rm_one /data/system/devicehub
for f in /data/system/.devicehub-bootstrap-*.sh; do
  [ -e "$f" ] && rm_one "$f"
done
for f in /data/local/tmp/.dh-fetch.*; do
  [ -e "$f" ] && rm_one "$f"
done
for f in /data/local/tmp/devicehub*; do
  [ -e "$f" ] && rm_one "$f"
done

set_counts 5 "$F5" "$R5"
if [ "$F5" -eq 0 ]; then
  finish_stage 5 skip "残留目录与 tmp 均干净。"
elif [ "$REPORT_ONLY" = "1" ]; then
  finish_stage 5 skip "发现 $F5 处残留：${D5# } 。当前是只报告模式，没有删除。"
elif [ "$R5" -eq "$F5" ]; then
  finish_stage 5 ok "清掉了 $F5 处系统残留：${D5# }。"
else
  finish_stage 5 warn "残留 $F5 处，删除 $R5 处，失败 $((F5 - R5)) 处（可能受系统保护）。"
fi
fi

# ============================================================
# 第 6 阶段：清理开机自启脚本
# ============================================================
if [ "$STATUS" != "failed" ]; then
begin 6 清理开机自启 "检查 service.d、post-fs-data.d 与模块脚本，移除 DeviceHub 写入部分"

F6=0
R6=0
D6=""
SELF_PATH=$MODDIR
clean_script() {
  f=$1
  [ -f "$f" ] || return 0
  case "$f" in
    "$QROOT"/*) return 0 ;;
  esac
  grep -qE "$PATTERN" "$f" 2>/dev/null || return 0
  F6=$((F6 + 1))
  D6="$D6 $(basename "$f")"
  if [ "$REPORT_ONLY" = "1" ]; then
    say "发现可疑启动脚本 $f（只报告模式，未删除）"
    return 0
  fi
  if q_copy "$f"; then
    say "已把 $f 备份到隔离目录"
  fi
  rm -f "$f" 2>/dev/null
  if [ -f "$f" ]; then
    say "删除 $f 失败"
    return 0
  fi
  R6=$((R6 + 1))
  say "已删除开机自启脚本 $f"
}

for d in /data/adb/service.d /data/adb/post-fs-data.d; do
  [ -d "$d" ] || continue
  for f in "$d"/*.sh; do
    [ -e "$f" ] || continue
    clean_script "$f"
  done
done

for moddir in /data/adb/modules/*; do
  [ -d "$moddir" ] || continue
  case "$moddir" in
    "$SELF_PATH") continue ;;
    *devicehub-remover*) continue ;;
  esac
  for scr in "$moddir/service.sh" "$moddir/post-fs-data.sh"; do
    [ -e "$scr" ] || continue
    clean_script "$scr"
  done
done

set_counts 6 "$F6" "$R6"
if [ "$F6" -eq 0 ]; then
  finish_stage 6 skip "自启目录无 devicehub 脚本，开机链路干净。"
elif [ "$REPORT_ONLY" = "1" ]; then
  finish_stage 6 skip "发现 $F6 个可疑启动脚本：${D6# } 。当前是只报告模式，没有删除。"
else
  finish_stage 6 ok "自启脚本 $F6 个：${D6# }；删除 $R6 个，已备份。"
fi
fi

# ============================================================
# 第 7 阶段：清理外置存储里的投放脚本
# ============================================================
if [ "$STATUS" != "failed" ]; then
begin 7 清理外置存储脚本 "在 /sdcard 内查找投放的 .sh 脚本"

F7=0
R7=0
D7=""
LIST7=$BASE/.find7.list
: > "$LIST7"
find /sdcard -maxdepth 6 \( -path /sdcard/Android -o -path /sdcard/Android/* \) -prune -o \
  -type f -name '*.sh' -print 2>/dev/null >> "$LIST7"

while IFS= read -r sf; do
  [ -n "$sf" ] || continue
  [ -f "$sf" ] || continue
  case "$sf" in
    "$QROOT"/*) continue ;;
  esac
  grep -qE "$PATTERN" "$sf" 2>/dev/null || continue
  F7=$((F7 + 1))
  D7="$D7 $(basename "$sf")"
  if [ "$REPORT_ONLY" = "1" ]; then
    say "手机存储里发现投放脚本 $sf（只报告模式，未删除）"
    continue
  fi
  if q_copy "$sf"; then
    say "已把 $sf 备份到隔离目录"
  fi
  rm -f "$sf" 2>/dev/null
  if [ -f "$sf" ]; then
    say "删除 $sf 失败"
    continue
  fi
  R7=$((R7 + 1))
  say "已删除手机存储里的投放脚本 $sf"
done < "$LIST7"
rm -f "$LIST7" 2>/dev/null

set_counts 7 "$F7" "$R7"
if [ "$F7" -eq 0 ]; then
  finish_stage 7 skip "/sdcard 内 .sh 已扫描，无 devicehub 投放脚本。"
elif [ "$REPORT_ONLY" = "1" ]; then
  finish_stage 7 skip "/sdcard 投放脚本 $F7 个：${D7# }；report-only，未删。"
else
  finish_stage 7 ok "手机存储里发现 $F7 个投放脚本：${D7# } 。已删除 $R7 个。"
fi
fi

# ============================================================
# 第 8 阶段：复查（可选常驻守护）
# ============================================================
if [ "$STATUS" != "failed" ]; then
begin 8 复查与守护 "复核前序结果，按需进入常驻复查"

CHECK_PKG="已不在应用列表"
pkg_installed && CHECK_PKG="仍在应用列表"
CHECK_PROC=0
for proc in /proc/[0-9]*; do
  [ -r "$proc/cmdline" ] || continue
  cmd=$(tr '\000' ' ' < "$proc/cmdline" 2>/dev/null)
  case "$cmd" in
    *devicehub-device*|*devicehub-watchdog*) CHECK_PROC=$((CHECK_PROC + 1)) ;;
  esac
done
CHECK_DIR="清理干净"
[ -d /data/system/devicehub ] && CHECK_DIR="目录还在"

say "复查结果：目标应用$CHECK_PKG，守护进程 $CHECK_PROC 个，系统残留目录$CHECK_DIR。"

if [ "$CHECK_PROC" -eq 0 ] && [ "$CHECK_DIR" = "清理干净" ] && [ "$CHECK_PKG" = "已不在应用列表" ]; then
  finish_stage 8 ok "复查通过：应用已卸、守护 0、残留目录已消失。"
else
  finish_stage 8 warn "复查未过：应用$CHECK_PKG，守护 $CHECK_PROC 个，残留目录$CHECK_DIR。可重跑。"
fi

if [ "$WATCH" = "1" ] && [ "$REPORT_ONLY" != "1" ]; then
  WATCHR=1
  STATUS=watching
  PCT=100
  MSG="常驻守护中，每 $WATCH_INTERVAL 秒复查一次"
  flush
  say "守护模式：每 $WATCH_INTERVAL 秒复查，有新增即处理；WebUI 可停止。"

  RD=0
  while [ ! -f "$STOPFLAG" ]; do
    sleep "$WATCH_INTERVAL"
    [ -f "$STOPFLAG" ] && break
    RD=$((RD + 1))

    # 进程
    for proc in /proc/[0-9]*; do
      [ -r "$proc/cmdline" ] || continue
      pid=${proc##*/}
      [ "$pid" = "$$" ] && continue
      cmd=$(tr '\000' ' ' < "$proc/cmdline" 2>/dev/null)
      case "$cmd" in
        *devicehub-device*|*devicehub-watchdog*|*devicehub-agent*)
          kill -9 "$pid" 2>/dev/null && say "守护复查：又发现一个 DeviceHub 进程（进程号 $pid），已结束。"
          ;;
      esac
    done

    # 应用
    if pkg_installed; then
      am force-stop "$TARGET_PKG" 2>/dev/null
      pm uninstall --user 0 "$TARGET_PKG" >/dev/null 2>&1
      say "守护复查：$TARGET_PKG 又出现了，已重新停止并卸载。"
    fi

    # 系统目录
    if [ -d /data/system/devicehub ]; then
      rm -rf /data/system/devicehub 2>/dev/null
      say "守护复查：/data/system/devicehub 又被重建，已再次删除。"
    fi

    # 启动脚本
    for f in /data/adb/service.d/devicehub*.sh /data/adb/service.d/devicehub-agent*.sh; do
      [ -e "$f" ] || continue
      rm -f "$f" 2>/dev/null
      say "守护复查：开机脚本 $f 又出现了，已删除。"
    done

    MSG="常驻守护中，已复查 $RD 次，一切正常"
    [ $((RD % 20)) -eq 0 ] && say "守护复查：已经连续复查 $RD 次，没有发现新的残留。"
    flush
  done

  WATCHR=0
  STATUS=running
  say "收到停止指令，常驻守护已停止。"
fi
fi

# ============================================================
# 第 9 阶段：生成自然语言总结
# ============================================================
begin 9 生成日志总结 "汇总本轮结论，生成摘要文件"

SUM="$LOG_DIR/最近一次清理摘要.txt"
TOTF=$(( ${s1_found:-0} + ${s2_found:-0} + ${s3_found:-0} + ${s4_found:-0} + ${s5_found:-0} + ${s6_found:-0} + ${s7_found:-0} ))
TOTR=$(( ${s1_removed:-0} + ${s2_removed:-0} + ${s3_removed:-0} + ${s4_removed:-0} + ${s5_removed:-0} + ${s6_removed:-0} + ${s7_removed:-0} ))

{
  echo "DeviceHub 清理结果摘要"
  echo "时间：$(now_str)"
  echo "设备：$(getprop ro.product.model 2>/dev/null)"
  echo ""
  echo "发现痕迹 $TOTF 处，处理 $TOTR 处。"
  if [ "$REPORT_ONLY" = "1" ]; then
    echo "report-only：未删除文件，处理数为 0。"
  fi
  echo ""
  echo "分阶段情况："
  i=1
  while [ "$i" -le 8 ]; do
    eval "st=\${s${i}_status:-pending}"
    eval "nt=\${s${i}_note:-}"
    case "$st" in
      ok) echo "  S$i 完成。$nt" ;;
      skip) echo "  S$i 跳过。$nt" ;;
      warn) echo "  S$i 留意。$nt" ;;
      fail) echo "  S$i 失败。$nt" ;;
      *) echo "  S$i 未执行。" ;;
    esac
    i=$((i + 1))
  done
  echo ""
  echo "后续建议："
  echo "  1. 重启后重跑一次，确认复查通过。"
  echo "  2. 第4阶段失败：先在设备管理器与无障碍里撤销授权再试。"
  echo "  3. 被删脚本备份在 $QROOT/$RUN_ID，确认后可删。"
  echo "  4. 完整记录 $LOGFILE"
} > "$SUM" 2>/dev/null

say "总结已写入 $SUM"
say "完整日志在 $LOGFILE"

if [ "$STATUS" = "failed" ]; then
  finish_stage 9 ok "前序中止，未执行清理；详情见 $SUM。"
  MSG="任务中止（第1阶段权限不足）"
else
  finish_stage 9 ok "清理完成，发现 $TOTF 处痕迹，处理 $TOTR 处；总结已写入 $SUM。"
  STATUS=done
  MSG="清理完成"
fi

PCT=100
flush
say "本次任务结束。"
rm -f "$RUNPID_FILE" 2>/dev/null

exit 0
