/* DeviceHub 清理器 · WebUI */

var STATE_FILE = '/data/data/io.github.smallmaocat.devicehubcleaner/files/dh/state.ini';
var LIVE_FILE = '/data/data/io.github.smallmaocat.devicehubcleaner/files/dh/live.log';
var BASE = '/data/data/io.github.smallmaocat.devicehubcleaner/files/dh';
var SCRIPT = '/data/data/io.github.smallmaocat.devicehubcleaner/files/dh/bin/dh-clean.sh';
/* 配置缓存：poll 只读 state.ini，配置在启动时读一次 */
var CFG = {};

var STAGES = [
  {
    id: 1, name: '环境自检',
    short: 'root / 系统 / 目标 / 日志目录',
    why: '无 root 时删除会失败或误删，自检不过即中止。',
    what: '查 uid 是否为 0；识别 KernelSU / Magisk / APatch；pm list packages 查包名；测日志目录可写。',
    read: '「已获得最高权限」为正常，否则查模块启用状态。'
  },
  {
    id: 2, name: '停止运行中的应用',
    short: '先停进程，避免回写',
    why: '进程存活会立刻重建文件，也会占用卸载。',
    what: 'am force-stop；有 killall 再补一次；1 秒后复查进程。',
    read: '「已不再运行」通过；「又被拉起」见第 3 阶段。'
  },
  {
    id: 3, name: '结束常驻守护进程',
    short: '扫 /proc 按名匹配',
    why: 'devicehub-device 与 devicehub-watchdog 互拉，停应用无效。',
    what: '遍历 /proc/*/cmdline，匹配 devicehub-device、devicehub-watchdog、devicehub-agent，kill -9，统计剩余。',
    read: '计数为结束数；仍有残留多为自启拉起，见 S6。'
  },
  {
    id: 4, name: '卸载目标应用',
    short: 'pm uninstall + 解保护',
    why: '不卸载，删掉的残留会被重新生成。',
    what: 'pm uninstall --user 0；失败则 pm clear 后重试；复查包列表。',
    read: '失败多为设备管理器 / 无障碍授权，撤销后重跑。'
  },
  {
    id: 5, name: '清理系统残留',
    short: '/data/system 与 tmp',
    why: '/data/system/devicehub 为脚本仓库，.devicehub-bootstrap 为引导脚本，/data/local/tmp/.dh-fetch 为临时载荷。',
    what: '处理 /data/system/devicehub、/data/system/.devicehub-bootstrap-*.sh、/data/local/tmp/.dh-fetch.*、/data/local/tmp/devicehub*，删前先备份到隔离目录。',
    read: '「删除失败（可能被系统保护）」重启后重跑。'
  },
  {
    id: 6, name: '清理开机自启',
    short: 'service.d / 模块脚本',
    why: '开机脚本在，重启即整套复活并静默重装。',
    what: '扫 /data/adb/service.d、/data/adb/post-fs-data.d 下 .sh 及各模块 service.sh、post-fs-data.sh，按 devicehub、cxx.360nb.top、DH_BOOT_URL 匹配，命中先备份再删。',
    read: '本模块自身跳过；「都没有发现」为最佳结果。'
  },
  {
    id: 7, name: '清理手机存储脚本',
    short: '/sdcard 投放脚本',
    why: '投放脚本常落在 /sdcard，靠短信或网页触发。',
    what: '/sdcard 深 6 层、跳过 Android 目录，.sh 按关键字筛，命中即备份并删。',
    read: '仅删命中项；误删可从隔离目录取回。'
  },
  {
    id: 8, name: '复查与守护',
    short: '独立复核 + 可选常驻',
    why: '已删对象可能被未死进程重建，需独立复核。',
    what: '复查包列表 / 进程表 / 残留目录；常驻则按间隔循环，直至停止。',
    read: '「复查通过」为干净；否则多为第 4 阶段卸载未成功。'
  },
  {
    id: 9, name: '生成日志总结',
    short: '输出摘要文件',
    why: '命令行输出不便阅读，需一份可直读的记录。',
    what: '结论汇总进「最近一次清理摘要.txt」；过程见同目录时间戳日志。',
    read: '结论含两个文件路径，右上「日志文件」看全文。'
  }
];

var ST = {};          // 当前状态
var polling = null;
var expanded = {};

/* ---------------- root 调用适配 ---------------- */
function hasRoot() {
  return !!(window.ksu && typeof window.ksu.exec === 'function');
}

function kexec(cmd) {
  return new Promise(function (resolve) {
    if (!hasRoot()) { resolve(''); return; }
    var finished = false;
    var timer = setTimeout(function () {
      if (!finished) { finished = true; resolve(''); }
    }, 12000);
    function done(v) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(v == null ? '' : String(v));
    }
    function cb(a, b, c) {
      if (typeof a === 'string') return done(a);
      if (a && typeof a === 'object') {
        var s = a.stdout || a.result || '';
        if (!s && a.stderr) s = a.stderr;
        return done(s);
      }
      if (typeof a === 'number') return done(b || '');
      done(a);
    }
    try {
      var r = ksu.exec(cmd, '{}', cb);
      if (r && typeof r.then === 'function') {
        r.then(function (v) {
          if (typeof v === 'string') done(v);
          else if (v && typeof v === 'object') done(v.stdout || '');
        }).catch(function () { done(''); });
      }
    } catch (e) {
      done('');
    }
  });
}

function toast(msg) {
  if (window.ksu && typeof ksu.toast === 'function') { try { ksu.toast(msg); return; } catch (e) {} }
  console.log(msg);
}

/* ---------------- 工具 ---------------- */
function $(id) { return document.getElementById(id); }

function parseIni(text) {
  var o = {};
  if (!text) return o;
  text.split('\n').forEach(function (line) {
    var i = line.indexOf('=');
    if (i <= 0) return;
    var k = line.slice(0, i).trim();
    var v = line.slice(i + 1);
    if (k) o[k] = v;
  });
  return o;
}

function fmtDur(sec) {
  sec = parseInt(sec, 10);
  if (isNaN(sec) || sec < 0) return '—';
  var m = Math.floor(sec / 60), s = sec % 60;
  return m > 0 ? m + ' 分 ' + s + ' 秒' : s + ' 秒';
}

var STATUS_TEXT = {
  ok: '已完成', skip: '无需处理', warn: '需留意', fail: '未成功',
  running: '进行中', pending: '未开始'
};

/* ---------------- 渲染阶段 ---------------- */
function buildStages() {
  var box = $('stages');
  box.innerHTML = '';
  STAGES.forEach(function (s) {
    var el = document.createElement('div');
    el.className = 'stage';
    el.dataset.st = 'pending';
    el.dataset.open = '0';
    el.innerHTML =
      '<div class="stage-head">' +
        '<div class="dot">' + s.id + '</div>' +
        '<div class="stage-title"><b>' + s.name + '</b><span>' + s.short + '</span></div>' +
        '<div class="tag">未开始</div>' +
      '</div>' +
      '<div class="stage-body">' +
        '<h4>目的</h4><p>' + s.why + '</p>' +
        '<h4>动作</h4><p>' + s.what + '</p>' +
        '<h4>现状</h4><div class="note" data-role="note">暂无记录。</div>' +
        '<h4>判读</h4><p>' + s.read + '</p>' +
        '<h4>日志</h4><ul class="stage-logs" data-role="logs"><li>—</li></ul>' +
      '</div>';
    el.querySelector('.stage-head').addEventListener('click', function () {
      var open = el.dataset.open === '1';
      el.dataset.open = open ? '0' : '1';
      expanded[s.id] = !open;
    });
    box.appendChild(el);
  });
}

function renderStages(st, logLines) {
  var nodes = document.querySelectorAll('.stage');
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    var id = i + 1;
    var status = st['s' + id + '_status'] || 'pending';
    var note = st['s' + id + '_note'] || '';
    var found = st['s' + id + '_found'] || '0';
    var removed = st['s' + id + '_removed'] || '0';

    el.dataset.st = status;
    el.querySelector('.tag').textContent = STATUS_TEXT[status] || status;

    var noteEl = el.querySelector('[data-role=note]');
    var txt = note || '暂无记录。';
    if (parseInt(found, 10) > 0) {
      txt += '（发现 ' + found + ' / 处理 ' + removed + '）';
    }
    noteEl.textContent = txt;

    var ul = el.querySelector('[data-role=logs]');
    var mine = (logLines || []).filter(function (l) { return l.s === id; }).slice(-6);
    if (mine.length) {
      ul.innerHTML = mine.map(function (l) {
        return '<li>' + l.t + '  ' + escapeHtml(l.m) + '</li>';
      }).join('');
    } else {
      ul.innerHTML = '<li>—</li>';
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}

/* ---------------- 渲染状态 ---------------- */
var MODE_TEXT = { webui: 'WebUI 手动', boot: '开机自动', action: '模块按钮', once: '手动' };

function applyState(st, logLines) {
  ST = st || {};
  var badge = $('stateBadge');
  var status = ST.status || 'idle';
  var map = {
    running: ['进行中', 'running'], done: ['已完成', 'done'],
    watching: ['守护中', 'watching'], failed: ['已中止', 'failed'],
    idle: ['待机', 'idle']
  };
  var m = map[status] || ['待机', 'idle'];
  badge.textContent = m[0];
  badge.className = 'badge ' + m[1];

  var pct = parseInt(ST.percent || '0', 10);
  if (isNaN(pct)) pct = 0;
  $('barFill').style.width = Math.max(0, Math.min(100, pct)) + '%';

  $('modeLine').textContent = ST.run_id
    ? ('本次：' + (MODE_TEXT[ST.mode] || ST.mode || '未知') + ' · ' + ST.run_id)
    : '无运行记录';

  $('stageLine').textContent = ST.stage
    ? ('第 ' + ST.stage + ' / ' + (ST.stage_total || 9) + ' 阶段 · ' + (ST.stage_name || '') + ' · ' + pct + '%')
    : '未开始';

  $('timeLine').textContent = ST.elapsed ? ('已用 ' + fmtDur(ST.elapsed)) : '—';
  $('msgLine').textContent = ST.message || '';

  // 汇总
  var sum = $('summaryText');
  var chips = $('chips');
  if (!ST.run_id) {
    sum.textContent = '无运行记录。';
    chips.innerHTML = '';
  } else {
    var parts = [];
    if (status === 'done') parts.push('9 个阶段已走完。');
    else if (status === 'watching') parts.push('清理完成，正在按间隔复查。');
    else if (status === 'failed') parts.push('流程中止，见标注「未成功」的阶段。');
    else parts.push('执行中：第 ' + ST.stage + ' 阶段 ' + (ST.stage_name || ''));

    var tries = 0, oks = 0;
    for (var i = 1; i <= 9; i++) {
      var s = ST['s' + i + '_status'];
      if (s && s !== 'pending' && s !== 'running') tries++;
      if (s === 'ok') oks++;
    }
    if (tries) parts.push('已出结论 ' + tries + ' 个 / 通过 ' + oks + ' 个。');
    if (ST.report_only === '1') parts.push('report-only，不落地删除。');
    sum.textContent = parts.join('');

    var found = 0, removed = 0;
    for (var j = 1; j <= 9; j++) {
      found += parseInt(ST['s' + j + '_found'] || '0', 10) || 0;
      removed += parseInt(ST['s' + j + '_removed'] || '0', 10) || 0;
    }
    chips.innerHTML =
      '<span class="chip">目标 <b>' + escapeHtml(ST.target || 'com.devicehub.agent') + '</b></span>' +
      '<span class="chip">发现 <b>' + found + '</b></span>' +
      '<span class="chip">处理 <b>' + removed + '</b></span>' +
      '<span class="chip">日志 <b>' + escapeHtml(shortPath(ST.log_file)) + '</b></span>';
  }

  renderStages(ST, logLines);
  renderLog(logLines);
}

function shortPath(p) {
  if (!p) return '—';
  return p.replace(/^\/sdcard\//, '').replace(/^\/storage\/emulated\/0\//, '');
}

function renderLog(lines) {
  var box = $('logBox');
  if (!lines || !lines.length) {
    box.innerHTML = '<div class="logline muted">无日志</div>';
    return;
  }
  var atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  box.innerHTML = lines.map(function (l) {
    return '<div class="logline"><span class="t">' + l.t.slice(11) + '</span>' + escapeHtml(l.m) + '</div>';
  }).join('');
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function parseLog(text) {
  var out = [];
  (text || '').split('\n').forEach(function (line) {
    if (!line) return;
    var p = line.indexOf('|');
    if (p < 0) return;
    var sTag = line.slice(0, p);
    var rest = line.slice(p + 1);
    var q = rest.indexOf('|');
    if (q < 0) return;
    out.push({
      s: parseInt(sTag.replace(/[^0-9]/g, ''), 10) || 0,
      t: rest.slice(0, q),
      m: rest.slice(q + 1)
    });
  });
  return out.slice(-60);
}

/* ---------------- 轮询 ---------------- */
function poll() {
  if (!hasRoot()) return Promise.resolve();
  return kexec('cat ' + STATE_FILE + ' 2>/dev/null; echo "@@@LOG@@@"; tail -n 80 ' + LIVE_FILE + ' 2>/dev/null')
    .then(function (out) {
      var parts = (out || '').split('@@@LOG@@@');
      var st = parseIni(parts[0] || '');
      var lines = parseLog(parts[1] || '');
      applyState(st, lines);
      if (st.status === 'done' || st.status === 'failed') {
        maybeAutoUpload(st);
        // 结束后再多看两轮就停，避免一直占着 root 通道
        stopPollingSoon();
      }
    });
}

/* 自动回传：仅发本轮新产生的日志，避免重复发送 */
var lastUploadedLog = '';
var primed = false;
function maybeAutoUpload(st) {
  var path = st.log_file || '';
  if (!path) return;
  if (!CFG.UPLOAD_URL || CFG.UPLOAD_AUTO !== '1') return;
  if (!primed) return;
  if (lastUploadedLog === path) return;
  lastUploadedLog = path;
  doUploadLog(path, true);
}
function primeUpload() {
  if (!hasRoot()) return Promise.resolve();
  return kexec('cat ' + STATE_FILE + ' 2>/dev/null').then(function (txt) {
    var st = parseIni(txt || '');
    lastUploadedLog = st.log_file || '';
    primed = true;
  }, function () { primed = true; });
}

var idleTicks = 0;
function stopPollingSoon() {
  idleTicks++;
  if (idleTicks > 2) stopPolling();
}

function startPolling() {
  if (polling) return;
  idleTicks = 0;
  polling = setInterval(poll, 900);
}
function stopPolling() {
  if (polling) { clearInterval(polling); polling = null; }
}

/* ---------------- 动作 ---------------- */
function runClean() {
  if (!hasRoot()) { toast('无 root，无法执行'); return; }
  $('btnRun').disabled = true;
  kexec('rm -f ' + BASE + '/stop.flag; (sh ' + SCRIPT + ' --mode=webui >/dev/null 2>&1 &); echo started')
    .then(function () {
      toast('已启动');
      setTimeout(function () { $('btnRun').disabled = false; }, 2500);
      startPolling();
      setTimeout(poll, 350);
    });
}

function stopWatch() {
  kexec('mkdir -p ' + BASE + '; echo stop > ' + BASE + '/stop.flag; echo ok')
    .then(function () { toast('已发送停止'); setTimeout(poll, 500); });
}

/* ---------------- 日志面板 ---------------- */
function openLog() {
  if (!hasRoot()) { toast('需 root'); return; }
  var path = ST.log_file || '';
  $('logPath').textContent = path || '(无日志)';
  $('logFull').textContent = '读取中…';
  renderUploadState(CFG);
  show($('logSheet'));
  if (!path) { $('logFull').textContent = '无日志文件，先跑一次。'; return; }
  kexec('ls -l "' + path + '" >/dev/null 2>&1 && tail -n 400 "' + path + '" || echo "不存在：' + path + '"')
    .then(function (t) { $('logFull').textContent = t || '(空)'; });
}

function copyPath() {
  var p = ST.log_file || '';
  if (!p) { toast('无日志文件'); return; }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(p).then(function () { toast('已复制'); },
      function () { toast(p); });
  } else { toast(p); }
}

/* ---------------- 日志回传 ---------------- */
var uploading = false;
/* auto=true 时不弹 toast；实际发送在 Java 侧 uploadLog */
function doUploadLog(path, auto) {
  var el = $('uploadState');
  if (!hasRoot()) { if (!auto) toast('需 root'); return; }
  if (!window.ksu || !ksu.uploadLog) { if (!auto) toast('环境不支持回传'); return; }
  if (!CFG.UPLOAD_URL) {
    if (el) el.textContent = '回传：未配置';
    if (!auto) toast('未填地址');
    return;
  }
  if (!path) { if (!auto) toast('还没有日志文件'); return; }
  if (uploading) { if (!auto) toast('发送中'); return; }

  uploading = true;
  if (el) el.textContent = '回传：发送中';
  if (!auto) toast('回传中');

  ksu.uploadLog(path, CFG.UPLOAD_URL, CFG.UPLOAD_CHAT || '').then(function (r) {
    uploading = false;
    var s = String(r || '');
    if (s.indexOf('OK') === 0) {
      var code = s.replace(/[^0-9]/g, '') || '200';
      if (el) el.textContent = '回传：HTTP ' + code;
      toast('已回传');
    } else {
      var msg = s.replace(/^ERR\s*/, '') || '未知';
      if (el) el.textContent = '回传：失败 ' + msg;
      toast('回传失败 ' + msg);
    }
  }, function (e) {
    uploading = false;
    var msg = (e && e.message) ? e.message : String(e);
    if (el) el.textContent = '回传：失败 ' + msg;
    if (!auto) toast('回传失败 ' + msg);
  });
}
function uploadNow() {
  var p = ST.log_file || '';
  if (!p) { toast('无日志文件，先跑一次'); return; }
  doUploadLog(p, false);
}

/* ---------------- 设置面板 ---------------- */
function loadConfig() {
  if (!hasRoot()) {
    $('cfgLogDir').value = '/sdcard/DeviceHub清理日志';
    return;
  }
  kexec('cat ' + BASE + '/config.conf 2>/dev/null').then(function (txt) {
    var c = parseIni(txt || '');
    CFG = c;
    $('cfgLogDir').value = c.LOG_DIR || '/sdcard/DeviceHub清理日志';
    $('cfgReport').checked = c.REPORT_ONLY === '1';
    $('cfgBoot').checked = (c.AUTO_BOOT || '1') === '1';
    $('cfgWatch').checked = c.WATCH === '1';
    $('cfgInterval').value = c.WATCH_INTERVAL || 6;
    $('cfgUploadUrl').value = c.UPLOAD_URL || '';
    $('cfgUploadChat').value = c.UPLOAD_CHAT || '';
    $('cfgUploadAuto').checked = c.UPLOAD_AUTO === '1';
    renderUploadState(c);
  });
}

/* 日志面板底部状态行 */
function renderUploadState(c) {
  var el = $('uploadState');
  if (!el) return;
  if (!c || !c.UPLOAD_URL) {
    el.textContent = '回传：未配置';
  } else if (c.UPLOAD_AUTO === '1') {
    el.textContent = '回传：自动';
  } else {
    el.textContent = '回传：手动';
  }
}

function saveConfig() {
  var dir = ($('cfgLogDir').value || '').trim() || '/sdcard/DeviceHub清理日志';
  var report = $('cfgReport').checked ? '1' : '0';
  var boot = $('cfgBoot').checked ? '1' : '0';
  var watch = $('cfgWatch').checked ? '1' : '0';
  var interval = parseInt($('cfgInterval').value, 10);
  if (isNaN(interval) || interval < 3) interval = 6;
  /* 仅去首尾空白，不做额外转义 */
  var uploadUrl = ($('cfgUploadUrl').value || '').trim();
  var uploadChat = ($('cfgUploadChat').value || '').trim();
  var uploadAuto = $('cfgUploadAuto').checked ? '1' : '0';
  /* 无地址时强制关闭自动回传 */
  if (!uploadUrl) uploadAuto = '0';
  if (!hasRoot()) { toast('需 root'); return; }

  var content = [
    'TARGET_PKG=' + (ST.target || 'com.devicehub.agent'),
    'LOG_DIR=' + dir,
    'REPORT_ONLY=' + report,
    'AUTO_BOOT=' + boot,
    'WATCH=' + watch,
    'WATCH_INTERVAL=' + interval,
    'UPLOAD_URL=' + uploadUrl,
    'UPLOAD_CHAT=' + uploadChat,
    'UPLOAD_AUTO=' + uploadAuto,
    'PATTERN=devicehub|cxx\\.360nb\\.top|DH_BOOT_URL'
  ].join('\n') + '\n';

  var cmd = 'mkdir -p ' + BASE + ' && cat > ' + BASE + '/config.conf <<\'DHEOF\'\n' +
    content + 'DHEOF\necho saved';
  kexec(cmd).then(function (r) {
    if (r && r.indexOf('saved') >= 0) {
      /* 同步内存配置，避免本轮漏发 */
      CFG.UPLOAD_URL = uploadUrl;
      CFG.UPLOAD_CHAT = uploadChat;
      CFG.UPLOAD_AUTO = uploadAuto;
      toast('已保存');
      hide($('cfgSheet'));
      poll();
    } else {
      toast('保存失败');
    }
  });
}

/* ---------------- 面板控制 ---------------- */
function show(el) { el.classList.remove('hidden'); $('mask').classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); $('mask').classList.add('hidden'); }

/* ---------------- 初始化 ---------------- */
document.addEventListener('DOMContentLoaded', function () {
  buildStages();

  $('btnRun').addEventListener('click', runClean);
  $('btnStop').addEventListener('click', stopWatch);
  $('btnLog').addEventListener('click', openLog);
  $('btnCfg').addEventListener('click', function () { loadConfig(); show($('cfgSheet')); });
  $('btnSaveCfg').addEventListener('click', saveConfig);
  $('btnCloseCfg').addEventListener('click', function () { hide($('cfgSheet')); });
  $('btnCloseLog').addEventListener('click', function () { hide($('logSheet')); });
  $('btnCopyPath').addEventListener('click', copyPath);
  $('btnUploadLog').addEventListener('click', uploadNow);
  $('mask').addEventListener('click', function () {
    hide($('cfgSheet')); hide($('logSheet'));
  });
  if (!hasRoot()) {
    $('modeLine').textContent = '预览模式：无 root，按钮不执行';
    $('msgLine').textContent = '授予 root 后重新打开。';
    applyState({ status: 'idle' }, []);
    renderStages({}, []);
    return;
  }
  /* 先读配置与已有日志，再开始轮询 */
  kexec('cat ' + BASE + '/config.conf 2>/dev/null').then(function (t) {
    CFG = parseIni(t || '');
    renderUploadState(CFG);
  }, function () { CFG = {}; })
    .then(primeUpload, primeUpload);
  poll();
  startPolling();
  window.addEventListener('focus', poll);
});
