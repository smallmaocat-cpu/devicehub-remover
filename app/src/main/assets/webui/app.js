/* DeviceHub 清理器 · WebUI 逻辑
 * 在 KernelSU 的 WebUI 里运行（有 root 权限），也可以在普通浏览器里预览界面。
 */

var STATE_FILE = '/data/data/io.github.smallmaocat.devicehubcleaner/files/dh/state.ini';
var LIVE_FILE = '/data/data/io.github.smallmaocat.devicehubcleaner/files/dh/live.log';
var BASE = '/data/data/io.github.smallmaocat.devicehubcleaner/files/dh';
var SCRIPT = '/data/data/io.github.smallmaocat.devicehubcleaner/files/dh/bin/dh-clean.sh';
/* 配置缓存。轮询里要判断「要不要自动回传」，但 poll 每 900ms 只 cat 一次
 * state.ini，不可能每次都再读一遍 config.conf，所以启动时读一次存这里。 */
var CFG = {};

var STAGES = [
  {
    id: 1, name: '环境自检',
    short: '权限、系统、目标应用、日志目录',
    why: '先确认这个脚本真的拿到了 root 权限，并且知道目标应用现在在不在。没有最高权限的话，后面的删除动作要么失败、要么删错东西，所以这一步不通过就直接中止。',
    what: '检查当前 uid 是否为 0；识别是 KernelSU / Magisk / APatch 中的哪一个；用 pm list packages 查目标包名是否存在；确认日志目录能写。',
    read: '结论写「已获得最高权限」说明环境正常。如果这里就失败了，检查模块是否真的被 root 管理器启用，然后在管理器里刷新一次。'
  },
  {
    id: 2, name: '停止运行中的应用',
    short: '让它别再偷偷写文件',
    why: '目标应用如果还在跑，你刚删掉的文件它可能立刻重建，卸载也可能因为进程占用而失败，所以先把它按停。',
    what: '用 am force-stop 停止应用，有 killall 的话再补一刀，一秒后复查进程是否还活着。',
    read: '结论说「已不再运行」就是停干净了。如果显示「又被拉起来了」，说明后台还有守护进程在拉活，下一步会处理。'
  },
  {
    id: 3, name: '结束常驻守护进程',
    short: '扫描 /proc 找 devicehub 进程',
    why: 'DeviceHub 这类远端控制组件一般有一个 devicehub-device 加一个 devicehub-watchdog，互相拉活。只停应用停不掉它们，必须按进程名扫出来结束。',
    what: '遍历 /proc 下所有进程的 cmdline，匹配名字里带 devicehub-device、devicehub-watchdog、devicehub-agent 的，逐个 kill -9，然后统计还剩几个。',
    read: '计数是「结束的进程数」。显示「没有发现守护进程」说明本来干净；显示仍有剩余，通常是别的自启脚本在拉起来，看第 6 阶段的结果。'
  },
  {
    id: 4, name: '卸载目标应用',
    short: 'pm uninstall 并解除保护',
    why: '应用本体不卸载，残留文件删了也会被重新生成。',
    what: '对当前用户执行 pm uninstall --user 0；如果没成功就再试一次 pm clear 加卸载；最后复查应用列表。',
    read: '成功会写「已把 … 从当前用户下卸载」。失败最常见的原因是它启用了「设备管理器」或「无障碍」权限——到系统设置里取消授权后再跑一次就能过。'
  },
  {
    id: 5, name: '清理系统残留',
    short: '/data/system 与临时文件',
    why: '真正危险的东西在这里：/data/system/devicehub 是它的脚本仓库，.devicehub-bootstrap 是开机引导脚本，/data/local/tmp/.dh-fetch 是下载下来的临时载荷。',
    what: '逐个检查并删除 /data/system/devicehub、/data/system/.devicehub-bootstrap-*.sh、/data/local/tmp/.dh-fetch.*、/data/local/tmp/devicehub*，删除前先备份到隔离目录。',
    read: '「清掉了 N 处系统残留」后面会列出具体文件名。如果写「删除失败（可能被系统保护）」，重启后再跑一次通常就好了。'
  },
  {
    id: 6, name: '清理开机自启',
    short: 'service.d / post-fs-data.d / 其他模块',
    why: '这一层是「复活」的根源：只要开机脚本还在，重启一次 DeviceHub 就整套回来了，删掉的应用也会被静默装回来。',
    what: '检查 /data/adb/service.d 和 /data/adb/post-fs-data.d 里的每个 .sh，以及其他模块自带的 service.sh、post-fs-data.sh，用关键字（devicehub、cxx.360nb.top、DH_BOOT_URL）判断是否属于它，命中就先备份再删除。',
    read: '「所有开机启动目录里都没有发现…」是最理想的结果。本模块自己会被跳过，不会被误删。'
  },
  {
    id: 7, name: '清理手机存储脚本',
    short: '下载、文档里的投放脚本',
    why: '很多这类组件会把 .sh 投放脚本放在 /sdcard 上，靠短信或网页触发执行，所以存储里也要扫一遍。',
    what: '在 /sdcard 下（最多 6 层，跳过 Android 目录）找出所有 .sh 文件，逐个用关键字过滤，命中就备份后删除。',
    read: '这一步只处理同时命中关键字的脚本，正常的用户脚本不会被动。如果误报了某个自己写的脚本，到隔离目录把备份拿回来即可。'
  },
  {
    id: 8, name: '复查与守护',
    short: '再核一遍，可常驻盯着',
    why: '前面删的东西有可能被某个还没死透的进程重建，所以要用一次独立的复查来确认，而不是相信前面的结论。',
    what: '重新查应用列表、重新扫进程表、重新看系统残留目录。开了「常驻守护」的话，之后会按设定的间隔重复这一整套动作，直到你在界面里点停止。',
    read: '「复查通过」说明三样都干净了。显示「没完全通过」就把上面几个阶段的结论一起看，通常是第 4 阶段卸载没成功。'
  },
  {
    id: 9, name: '生成日志总结',
    short: '写成人话的输出文件',
    why: '给后来的人（或者未来的你）看的东西不能只有命令行输出，得有一份能直接读懂的记录。',
    what: '把每个阶段做了什么、发现了什么、需要留意什么，写成一段连续的中文说明，保存为日志目录里的「最近一次清理摘要.txt」，完整过程记录在同目录的时间戳日志里。',
    read: '结论里会给出这两个文件的绝对路径，点右上「日志文件」可以直接看全文。'
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
        '<h4>为什么要有这一步</h4><p>' + s.why + '</p>' +
        '<h4>这一步具体做什么</h4><p>' + s.what + '</p>' +
        '<h4>本次情况</h4><div class="note" data-role="note">还没有运行记录。</div>' +
        '<h4>结果怎么读</h4><p>' + s.read + '</p>' +
        '<h4>相关日志</h4><ul class="stage-logs" data-role="logs"><li>暂无</li></ul>' +
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
    var txt = note || '还没有运行记录。';
    if (parseInt(found, 10) > 0) {
      txt += '（发现 ' + found + ' 项，处理 ' + removed + ' 项）';
    }
    noteEl.textContent = txt;

    var ul = el.querySelector('[data-role=logs]');
    var mine = (logLines || []).filter(function (l) { return l.s === id; }).slice(-6);
    if (mine.length) {
      ul.innerHTML = mine.map(function (l) {
        return '<li>' + l.t + '  ' + escapeHtml(l.m) + '</li>';
      }).join('');
    } else {
      ul.innerHTML = '<li>暂无</li>';
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}

/* ---------------- 渲染状态 ---------------- */
var MODE_TEXT = {
  webui: '在 WebUI 里手动触发', boot: '开机自动执行',
  action: '模块操作按钮触发', once: '手动执行'
};

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
    ? ('本次运行：' + (MODE_TEXT[ST.mode] || ST.mode || '未知') + '（' + ST.run_id + '）')
    : '还没有运行记录';

  $('stageLine').textContent = ST.stage
    ? ('第 ' + ST.stage + ' / ' + (ST.stage_total || 9) + ' 阶段 · ' + (ST.stage_name || '') + ' · ' + pct + '%')
    : '尚未开始';

  $('timeLine').textContent = ST.elapsed ? ('已用 ' + fmtDur(ST.elapsed)) : '—';
  $('msgLine').textContent = ST.message || '';

  // 汇总
  var sum = $('summaryText');
  var chips = $('chips');
  if (!ST.run_id) {
    sum.textContent = '还没有运行记录，点「开始清理」执行一次。';
    chips.innerHTML = '';
  } else {
    var parts = [];
    if (status === 'done') parts.push('这次清理已经跑完全部 9 个阶段。');
    else if (status === 'watching') parts.push('清理已完成，现在在按间隔持续复查。');
    else if (status === 'failed') parts.push('清理中途中止了，看下面标注「未成功」的阶段。');
    else parts.push('正在执行第 ' + ST.stage + ' 阶段：' + (ST.stage_name || '') + '。');

    var tries = 0, oks = 0;
    for (var i = 1; i <= 9; i++) {
      var s = ST['s' + i + '_status'];
      if (s && s !== 'pending' && s !== 'running') tries++;
      if (s === 'ok') oks++;
    }
    if (tries) parts.push('已经得出结论的阶段 ' + tries + ' 个，其中顺利完成 ' + oks + ' 个。');
    if (ST.report_only === '1') parts.push('当前是「只报告不删除」模式，不会真的删除文件。');
    sum.textContent = parts.join('');

    var found = 0, removed = 0;
    for (var j = 1; j <= 9; j++) {
      found += parseInt(ST['s' + j + '_found'] || '0', 10) || 0;
      removed += parseInt(ST['s' + j + '_removed'] || '0', 10) || 0;
    }
    chips.innerHTML =
      '<span class="chip">目标应用 <b>' + escapeHtml(ST.target || 'com.devicehub.agent') + '</b></span>' +
      '<span class="chip">发现痕迹 <b>' + found + '</b> 处</span>' +
      '<span class="chip">已处理 <b>' + removed + '</b> 处</span>' +
      '<span class="chip">日志目录 <b>' + escapeHtml(shortPath(ST.log_file)) + '</b></span>';
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
    box.innerHTML = '<div class="logline muted">等待日志…</div>';
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

/* 自动回传。
 * 只发「这一轮刚跑出来」的日志：lastUploadedLog 里存着已经处理过的路径，
 * 结束后轮询还会空转两轮，没有这个判断就会把同一份日志连发三次。
 * 应用启动时会先用 primeUpload() 读一次当前状态，所以「打开应用看到的是上次的旧
 * 日志」这种情况不会触发发送，想补发就手动点「立即回传」。
 */
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
  if (!hasRoot()) { toast('没有 root 权限，无法执行'); return; }
  $('btnRun').disabled = true;
  kexec('rm -f ' + BASE + '/stop.flag; (sh ' + SCRIPT + ' --mode=webui >/dev/null 2>&1 &); echo started')
    .then(function () {
      toast('已开始清理');
      setTimeout(function () { $('btnRun').disabled = false; }, 2500);
      startPolling();
      setTimeout(poll, 350);
    });
}

function stopWatch() {
  kexec('mkdir -p ' + BASE + '; echo stop > ' + BASE + '/stop.flag; echo ok')
    .then(function () { toast('已请求停止守护'); setTimeout(poll, 500); });
}

/* ---------------- 日志面板 ---------------- */
function openLog() {
  if (!hasRoot()) { toast('需要 root 权限才能查看'); return; }
  var path = ST.log_file || '';
  $('logPath').textContent = path || '(还没有生成日志)';
  $('logFull').textContent = '读取中…';
  renderUploadState(CFG);
  show($('logSheet'));
  if (!path) { $('logFull').textContent = '还没有日志文件，先执行一次清理。'; return; }
  kexec('ls -l "' + path + '" >/dev/null 2>&1 && tail -n 400 "' + path + '" || echo "文件不存在：' + path + '"')
    .then(function (t) { $('logFull').textContent = t || '(空)'; });
}

function copyPath() {
  var p = ST.log_file || '';
  if (!p) { toast('还没有日志文件'); return; }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(p).then(function () { toast('路径已复制'); },
      function () { toast(p); });
  } else { toast(p); }
}

/* ---------------- 日志回传 ---------------- */
var uploading = false;
/* auto=true 是清理跑完后自动触发的，不发 toast 打扰用户，只更新面板文字；
 * 手动点按钮时才会有提示。真正干活的是 Java 侧的 uploadLog，这里只负责
 * 传参、防并发、把结果翻译成人话。 */
function doUploadLog(path, auto) {
  var el = $('uploadState');
  if (!hasRoot()) { if (!auto) toast('需要 root 权限'); return; }
  if (!window.ksu || !ksu.uploadLog) { if (!auto) toast('当前环境不支持回传'); return; }
  if (!CFG.UPLOAD_URL) {
    if (el) el.textContent = '回传：还没填地址，先去设置里配置';
    if (!auto) toast('还没填回传地址');
    return;
  }
  if (!path) { if (!auto) toast('还没有日志文件'); return; }
  if (uploading) { if (!auto) toast('上一次还在发，稍等一下'); return; }

  uploading = true;
  if (el) el.textContent = '回传：正在发送…';
  if (!auto) toast('开始回传…');

  ksu.uploadLog(path, CFG.UPLOAD_URL, CFG.UPLOAD_CHAT || '').then(function (r) {
    uploading = false;
    var s = String(r || '');
    if (s.indexOf('OK') === 0) {
      var code = s.replace(/[^0-9]/g, '') || '200';
      if (el) el.textContent = '回传：已发送（HTTP ' + code + '）';
      toast('日志已回传');
    } else {
      var msg = s.replace(/^ERR\s*/, '') || '未知错误';
      if (el) el.textContent = '回传：失败（' + msg + '）';
      toast('回传失败：' + msg);
    }
  }, function (e) {
    uploading = false;
    var msg = (e && e.message) ? e.message : String(e);
    if (el) el.textContent = '回传：失败（' + msg + '）';
    if (!auto) toast('回传失败：' + msg);
  });
}
function uploadNow() {
  var p = ST.log_file || '';
  if (!p) { toast('还没有日志文件，先执行一次清理'); return; }
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

/* 日志面板底部那行小字：告诉用户现在到底会不会回传 */
function renderUploadState(c) {
  var el = $('uploadState');
  if (!el) return;
  if (!c || !c.UPLOAD_URL) {
    el.textContent = '回传：未配置（在设置里填地址后才会启用）';
  } else if (c.UPLOAD_AUTO === '1') {
    el.textContent = '回传：已开启，每次清理跑完自动发送';
  } else {
    el.textContent = '回传：地址已配置，需要手动点「立即回传」';
  }
}

function saveConfig() {
  var dir = ($('cfgLogDir').value || '').trim() || '/sdcard/DeviceHub清理日志';
  var report = $('cfgReport').checked ? '1' : '0';
  var boot = $('cfgBoot').checked ? '1' : '0';
  var watch = $('cfgWatch').checked ? '1' : '0';
  var interval = parseInt($('cfgInterval').value, 10);
  if (isNaN(interval) || interval < 3) interval = 6;
  /* 回传地址里可能出现空格以外的奇怪字符，去掉首尾空白就行，不要做多余转义，
     否则用户填一遍就得猜一遍自己哪里写错了。 */
  var uploadUrl = ($('cfgUploadUrl').value || '').trim();
  var uploadChat = ($('cfgUploadChat').value || '').trim();
  var uploadAuto = $('cfgUploadAuto').checked ? '1' : '0';
  /* 地址为空时自动回传没有意义，直接把开关按掉，免得配置文件里留下一个假开启状态 */
  if (!uploadUrl) uploadAuto = '0';
  if (!hasRoot()) { toast('需要 root 权限才能保存'); return; }

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
      /* 同步更新内存里的配置，否则刚打开自动回传、马上跑一次清理，
       * 轮询读到的还是旧的 CFG，会漏发这一轮。 */
      CFG.UPLOAD_URL = uploadUrl;
      CFG.UPLOAD_CHAT = uploadChat;
      CFG.UPLOAD_AUTO = uploadAuto;
      toast('设置已保存');
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
    $('modeLine').textContent = '预览模式：没有拿到 root 权限，按钮不会真的执行';
    $('msgLine').textContent = '要真正执行，请先授予本应用 root 权限，然后重新打开。';
    applyState({ status: 'idle' }, []);
    renderStages({}, []);
    return;
  }
  /* 先把配置和「启动前就已经存在的日志」读进来，再开始轮询。
   * 少这一步的话，打开应用时状态若还停在上一轮的 done，第一轮轮询就会把旧日志
   * 当成「刚跑完」再发一遍。 */
  kexec('cat ' + BASE + '/config.conf 2>/dev/null').then(function (t) {
    CFG = parseIni(t || '');
    renderUploadState(CFG);
  }, function () { CFG = {}; })
    .then(primeUpload, primeUpload);
  poll();
  startPolling();
  window.addEventListener('focus', poll);
});
