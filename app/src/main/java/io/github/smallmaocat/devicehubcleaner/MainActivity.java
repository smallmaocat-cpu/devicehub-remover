package io.github.smallmaocat.devicehubcleaner;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * DeviceHub 清理器 · APK 外壳
 *
 * 流程：引导页检测 Root → 3 秒后进入 WebView。
 *
 * 检测后再 loadUrl；bridge.js 首帧若取到未授权会停在预览模式。
 * 状态、配置、日志均在 files/dh，经 DH_BASE / MODDIR 传给脚本。
 */
public class MainActivity extends Activity {

    private static final String TAG = "DHCleaner";
    private static final String SCRIPT_ASSET = "bin/dh-clean.sh";
    private static final String WEB_URL = "file:///android_asset/webui/index.html";

    /** 检测结束后固定 3 秒自动进入主界面 */
    private static final int AUTO_ENTER_SECONDS = 3;
    /** 等用户在 root 管理器弹窗里点「允许」的最长时间 */
    private static final long ROOT_PROMPT_TIMEOUT_MS = 60000L;

    private static final int COLOR_BG = Color.parseColor("#0e1116");
    private static final int COLOR_CARD = Color.parseColor("#181e27");
    private static final int COLOR_LINE = Color.parseColor("#242c38");
    private static final int COLOR_FG = Color.parseColor("#e8edf4");
    private static final int COLOR_MUTED = Color.parseColor("#8b97a8");
    private static final int COLOR_ACCENT = Color.parseColor("#39d98a");
    private static final int COLOR_ACCENT_DIM = Color.parseColor("#1f5c41");
    private static final int COLOR_WARN = Color.parseColor("#f5b83d");
    private static final int COLOR_ON_ACCENT = Color.parseColor("#06120c");
    private static final int COLOR_BTN_OFF = Color.parseColor("#2a3340");

    private WebView web;
    private View guideView;
    private View mainView;
    private TextView guideStatus;
    private TextView guideBtn;
    private TextView guideHint;

    private File baseDir;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService pool = Executors.newSingleThreadExecutor();

    private boolean checking = false;
    private boolean mainEntered = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        try {
            baseDir = prepareFiles();
        } catch (Exception e) {
            Log.e(TAG, "prepareFiles failed", e);
            baseDir = new File(getFilesDir(), "dh");
        }

        applyWindowChrome();

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(COLOR_BG);

        // 主界面容器：先建好，检测完再加载
        FrameLayout mainHost = new FrameLayout(this);
        mainHost.setBackgroundColor(COLOR_BG);
        web = new WebView(this);
        web.setBackgroundColor(COLOR_BG);
        mainHost.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        configureWeb();
        mainHost.setVisibility(View.GONE);
        mainView = mainHost;

        // 启动引导页（第一个页面）
        guideView = buildGuide();

        root.addView(mainHost, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(guideView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
    }

    private void configureWeb() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setTextZoom(100);
        s.setMediaPlaybackRequiresUserGesture(true);

        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient());
        web.addJavascriptInterface(new ShellBridge(), "AndroidShell");
    }

    private void applyWindowChrome() {
        try {
            getWindow().setBackgroundDrawable(new ColorDrawable(COLOR_BG));
            getWindow().setStatusBarColor(COLOR_BG);
            getWindow().setNavigationBarColor(COLOR_BG);
            View decor = getWindow().getDecorView();
            int flags = decor.getSystemUiVisibility();
            flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            decor.setSystemUiVisibility(flags);
        } catch (Throwable t) {
            Log.w(TAG, "window chrome failed: " + t.getMessage());
        }
    }

    /* ================= 引导页 · 第一屏 ================= */

    private View buildGuide() {
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(COLOR_BG);
        scroll.setFillViewport(true);

        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setGravity(Gravity.CENTER_HORIZONTAL);
        col.setPadding(dp(22), dp(36), dp(22), dp(26));

        // 应用图标
        ImageView icon = new ImageView(this);
        try {
            Drawable appIcon = getPackageManager().getApplicationIcon(getPackageName());
            if (appIcon != null) icon.setImageDrawable(appIcon);
        } catch (Exception e) {
            Log.w(TAG, "load icon failed: " + e.getMessage());
        }
        LinearLayout.LayoutParams iconLp =
                new LinearLayout.LayoutParams(dp(78), dp(78));
        iconLp.bottomMargin = dp(16);
        col.addView(icon, iconLp);

        // 标题
        TextView title = label("DeviceHub 清理器", 22f, COLOR_FG, true);
        title.setGravity(Gravity.CENTER);
        col.addView(title, wrapLp(4));

        TextView sub = label("首次启动 · 权限", 13f, COLOR_MUTED, false);
        sub.setGravity(Gravity.CENTER);
        col.addView(sub, wrapLp(20));

        // 说明卡片
        LinearLayout cardBox = new LinearLayout(this);
        cardBox.setOrientation(LinearLayout.VERTICAL);
        cardBox.setPadding(dp(18), dp(17), dp(18), dp(17));
        cardBox.setBackground(rect(COLOR_CARD, COLOR_LINE, 18f));
        col.addView(cardBox, fullLp(18));

        cardBox.addView(label("需要 Root 权限", 16f, COLOR_FG, true), wrapLp(9));
        cardBox.addView(label(
                "清理残留需读取系统私有目录。Root 仅用于两件事：",
                13.5f, COLOR_MUTED, false), wrapLp(13));

        addItem(cardBox, "1", "扫描残留文件",
                "查 com.devicehub.agent 在 /data/data、/data/user_de/0、/sdcard/Android/data 下的残留。");
        addItem(cardBox, "2", "写入清理日志",
                "过程日志与摘要写到 /sdcard/DeviceHub清理日志（可改）。");
        cardBox.addView(label(
                "不读写其它数据。日志默认仅存本机，开启回传才外发。",
                12f, COLOR_MUTED, false), wrapLp(0));

        // 检测状态
        guideStatus = label("未检测", 13f, COLOR_MUTED, false);
        guideStatus.setGravity(Gravity.CENTER);
        col.addView(guideStatus, wrapLp(11));

        // 主按钮
        guideBtn = new TextView(this);
        guideBtn.setText("检测 Root");
        guideBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f);
        guideBtn.setTextColor(COLOR_ON_ACCENT);
        guideBtn.setTypeface(Typeface.DEFAULT_BOLD);
        guideBtn.setGravity(Gravity.CENTER);
        guideBtn.setBackground(rect(COLOR_ACCENT, 0, 14f));
        guideBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                startRootCheck();
            }
        });
        LinearLayout.LayoutParams btnLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(52));
        btnLp.bottomMargin = dp(10);
        col.addView(guideBtn, btnLp);

        // 倒计时提示
        guideHint = label("3 秒后自动进入主界面", 11.5f, COLOR_MUTED, false);
        guideHint.setGravity(Gravity.CENTER);
        col.addView(guideHint, wrapLp(14));

        TextView bottom = label("未授权可进主界面，清理功能不可用。", 11.5f, COLOR_MUTED, false);
        bottom.setGravity(Gravity.CENTER);
        col.addView(bottom, wrapLp(0));

        scroll.addView(col, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return scroll;
    }

    private void addItem(LinearLayout parent, String index, String title, String desc) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(0, dp(2), 0, dp(12));

        TextView num = label(index, 12f, COLOR_ON_ACCENT, true);
        num.setGravity(Gravity.CENTER);
        num.setBackground(circle(COLOR_ACCENT));
        LinearLayout.LayoutParams np = new LinearLayout.LayoutParams(dp(22), dp(22));
        np.topMargin = dp(1);
        np.rightMargin = dp(11);
        row.addView(num, np);

        LinearLayout texts = new LinearLayout(this);
        texts.setOrientation(LinearLayout.VERTICAL);
        row.addView(texts, new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        texts.addView(label(title, 13.5f, COLOR_FG, true), wrapLp(3));
        texts.addView(label(desc, 12.5f, COLOR_MUTED, false), wrapLp(0));

        parent.addView(row, fullLp(0));
    }

    /* ================= 检测流程 ================= */

    private void startRootCheck() {
        if (checking || mainEntered) return;
        checking = true;

        guideBtn.setBackground(rect(COLOR_BTN_OFF, 0, 14f));
        guideBtn.setTextColor(COLOR_MUTED);
        guideBtn.setText("请求 Root 权限…");
        guideBtn.setEnabled(false);

        guideStatus.setTextColor(COLOR_MUTED);
        guideStatus.setText("在系统弹窗中点「允许」");
        guideHint.setTextColor(COLOR_MUTED);
        guideHint.setText("等待授权结果…");

        pool.execute(new Runnable() {
            @Override
            public void run() {
                final boolean ok = probeRoot();
                ui.post(new Runnable() {
                    @Override
                    public void run() {
                        onRootChecked(ok);
                    }
                });
            }
        });
    }

    /** 实际执行 su，此处才弹授权 */
    private boolean probeRoot() {
        String out = execProc(new String[]{"su", "-c", "id"}, ROOT_PROMPT_TIMEOUT_MS);
        if (out == null) {
            Log.w(TAG, "probeRoot: no output (timeout or su missing)");
            return false;
        }
        Log.i(TAG, "probeRoot output: " + out.trim());
        return out.contains("uid=0");
    }

    private void onRootChecked(boolean ok) {
        if (isFinishing() || mainEntered) return;
        checking = false;

        if (ok) {
            guideStatus.setTextColor(COLOR_ACCENT);
            guideStatus.setText("✓ 已获得 Root 权限");
            guideBtn.setBackground(rect(COLOR_ACCENT_DIM, 0, 14f));
            guideBtn.setTextColor(COLOR_ACCENT);
            guideBtn.setText("已授权");
        } else {
            guideStatus.setTextColor(COLOR_WARN);
            guideStatus.setText("✗ 未获授权，只读模式");
            guideBtn.setBackground(rect(COLOR_BTN_OFF, 0, 14f));
            guideBtn.setTextColor(COLOR_MUTED);
            guideBtn.setText("检测结束");
        }
        guideBtn.setEnabled(false);
        countdown(AUTO_ENTER_SECONDS);
    }

    private void countdown(final int sec) {
        if (mainEntered) return;
        if (sec <= 0) {
            enterMain();
            return;
        }
        guideHint.setTextColor(COLOR_MUTED);
        guideHint.setText(sec + " 秒后自动进入主界面…");
        ui.postDelayed(new Runnable() {
            @Override
            public void run() {
                countdown(sec - 1);
            }
        }, 1000L);
    }

    private void enterMain() {
        if (mainEntered || isFinishing()) return;
        mainEntered = true;
        if (guideView != null) guideView.setVisibility(View.GONE);
        if (mainView != null) mainView.setVisibility(View.VISIBLE);
        if (web != null) web.loadUrl(WEB_URL);
    }

    /* ================= 小工具：UI ================= */

    private TextView label(String text, float sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setLineSpacing(dp(3), 1f);
        return t;
    }

    private LinearLayout.LayoutParams wrapLp(int bottomMarginDp) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = dp(bottomMarginDp);
        return lp;
    }

    private LinearLayout.LayoutParams fullLp(int bottomMarginDp) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = dp(bottomMarginDp);
        return lp;
    }

    private GradientDrawable rect(int fill, int strokeColor, float radiusDp) {
        GradientDrawable d = new GradientDrawable();
        d.setShape(GradientDrawable.RECTANGLE);
        d.setColor(fill);
        d.setCornerRadius(dp(radiusDp));
        if (strokeColor != 0) {
            d.setStroke(Math.max(1, dp(1)), strokeColor);
        }
        return d;
    }

    private GradientDrawable circle(int fill) {
        GradientDrawable d = new GradientDrawable();
        d.setShape(GradientDrawable.OVAL);
        d.setColor(fill);
        return d;
    }

    private int dp(float value) {
        return Math.max(0, Math.round(value * getResources().getDisplayMetrics().density));
    }

    /* ================= 生命周期 ================= */

    @Override
    public void onBackPressed() {
        if (!mainEntered) {
            super.onBackPressed();
            return;
        }
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        ui.removeCallbacksAndMessages(null);
        pool.shutdownNow();
        if (web != null) {
            web.removeJavascriptInterface("AndroidShell");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    /* ---------------- 资源准备 ---------------- */

    private File prepareFiles() throws IOException {
        File base = new File(getFilesDir(), "dh");
        File bin = new File(base, "bin");
        if (!bin.isDirectory() && !bin.mkdirs() && !bin.isDirectory()) {
            throw new IOException("无法建立目录: " + bin);
        }
        File script = new File(bin, "dh-clean.sh");
        copyAsset(SCRIPT_ASSET, script);
        // 补可执行位
        script.setReadable(true, false);
        script.setExecutable(true, false);
        return base;
    }

    private void copyAsset(String assetName, File dest) throws IOException {
        try (InputStream in = getAssets().open(assetName);
             OutputStream out = new FileOutputStream(dest)) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
            }
        }
    }

    /* ---------------- JS 桥 ---------------- */

    private class ShellBridge {

        /** 异步执行；结果回到 bridge.js 注册的回调 */
        @JavascriptInterface
        public void exec(final String cmd, final String requestId) {
            final String base = baseDir.getAbsolutePath();
            final String full = "export DH_BASE='" + base + "'; "
                    + "export MODDIR='" + base + "'; "
                    + "export PATH=/system/bin:/system/xbin:/data/adb/ksu/bin:/data/adb/ap/bin:/data/adb/magisk:$PATH; "
                    + cmd;
            pool.execute(new Runnable() {
                @Override
                public void run() {
                    String out = runShell(full);
                    final String js = "window.__dhResolve(" + JSONObject.quote(requestId)
                            + "," + JSONObject.quote(out == null ? "" : out) + ");";
                    ui.post(new Runnable() {
                        @Override
                        public void run() {
                            if (web != null) {
                                web.evaluateJavascript(js, null);
                            }
                        }
                    });
                }
            });
        }

        /** 同步判断 root（页面加载时调一次） */
        @JavascriptInterface
        public boolean isRoot() {
            String out = execProc(new String[]{"su", "-c", "id"}, ROOT_PROMPT_TIMEOUT_MS);
            return out != null && out.contains("uid=0");
        }

        @JavascriptInterface
        public void toast(final String msg) {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public String baseDir() {
            return baseDir.getAbsolutePath();
        }

        /** 回传日志到指定地址；后台线程，完成后回调 JS */
        @JavascriptInterface
        public void uploadLog(final String path, final String url,
                              final String chatId, final String requestId) {
            final String rid = requestId == null ? "" : requestId;
            pool.execute(new Runnable() {
                @Override
                public void run() {
                    String result;
                    try {
                        result = doUpload(path, url, chatId);
                    } catch (Throwable t) {
                        Log.w(TAG, "upload failed", t);
                        result = "ERR " + t.getClass().getSimpleName() + ": " + t.getMessage();
                    }
                    final String js = "window.__dhResolve(" + JSONObject.quote(rid)
                            + "," + JSONObject.quote(result) + ");";
                    ui.post(new Runnable() {
                        @Override
                        public void run() {
                            if (web != null) {
                                web.evaluateJavascript(js, null);
                            }
                        }
                    });
                }
            });
        }
    }

    /* ---------------- 日志回传 ---------------- */

    /** 单次上限 512KB */
    private static final int UPLOAD_MAX_BYTES = 512 * 1024;

    private String doUpload(String path, String urlRaw, String chatId) {
        String url = urlRaw == null ? "" : urlRaw.trim();
        if (url.isEmpty()) {
            return "ERR 未配置地址";
        }
        if (path == null || path.trim().isEmpty()) {
            return "ERR 无日志路径";
        }
        File f = new File(path.trim());
        if (!f.isFile()) {
            return "ERR 文件不存在: " + f.getAbsolutePath();
        }
        if (f.length() <= 0L) {
            return "ERR 文件为空";
        }
        byte[] data = readHead(f, UPLOAD_MAX_BYTES);
        String boundary = "----DeviceHubBoundary" + System.currentTimeMillis();
        boolean telegram = url.contains("api.telegram.org");
        String fileName = f.getName();
        HttpURLConnection conn = null;
        try {
            ByteArrayOutputStream body = new ByteArrayOutputStream(data.length + 4096);
            if (telegram) {
                writeField(body, boundary, "chat_id", chatId == null ? "" : chatId.trim());
                writeField(body, boundary, "caption", buildCaption(fileName));
                writeFilePart(body, boundary, "document", fileName, data);
            } else {
                writeField(body, boundary, "device",
                        Build.MANUFACTURER + " " + Build.MODEL);
                writeField(body, boundary, "android",
                        Build.VERSION.RELEASE + " (SDK " + Build.VERSION.SDK_INT + ")");
                writeField(body, boundary, "app", appVersionName());
                writeField(body, boundary, "log_name", fileName);
                writeFilePart(body, boundary, "file", fileName, data);
            }
            body.write(("--" + boundary + "--\r\n").getBytes("UTF-8"));

            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(60000);
            conn.setDoOutput(true);
            conn.setFixedLengthStreamingMode(body.size());
            conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
            conn.setRequestProperty("User-Agent", "DeviceHubCleaner/" + appVersionName());
            try (OutputStream os = conn.getOutputStream()) {
                body.writeTo(os);
                os.flush();
            }
            int code = conn.getResponseCode();
            String resp = readText(code >= 400 ? conn.getErrorStream() : conn.getInputStream(), 240);
            if (code >= 200 && code < 300) {
                return "OK " + code + (resp.isEmpty() ? "" : " " + resp);
            }
            return "ERR HTTP " + code + (resp.isEmpty() ? "" : " " + resp);
        } catch (Exception e) {
            Log.w(TAG, "upload exception: " + e.getMessage());
            return "ERR " + e.getClass().getSimpleName() + ": " + e.getMessage();
        } finally {
            if (conn != null) {
                try {
                    conn.disconnect();
                } catch (Exception ignored) {
                }
            }
        }
    }

    private void writeField(ByteArrayOutputStream out, String boundary, String name, String value)
            throws IOException {
        out.write(("--" + boundary + "\r\n").getBytes("UTF-8"));
        out.write(("Content-Disposition: form-data; name=\"" + name + "\"\r\n").getBytes("UTF-8"));
        out.write("Content-Type: text/plain; charset=utf-8\r\n\r\n".getBytes("UTF-8"));
        out.write((value == null ? "" : value).getBytes("UTF-8"));
        out.write("\r\n".getBytes("UTF-8"));
    }

    private void writeFilePart(ByteArrayOutputStream out, String boundary, String name,
                               String fileName, byte[] data) throws IOException {
        String ascii = fileName.replaceAll("[^\\x20-\\x7e]", "_").replace("\"", "_");
        String quoted = URLEncoder.encode(fileName, "UTF-8").replace("+", "%20");
        out.write(("--" + boundary + "\r\n").getBytes("UTF-8"));
        out.write(("Content-Disposition: form-data; name=\"" + name + "\"; filename=\""
                + ascii + "\"; filename*=UTF-8''" + quoted + "\r\n").getBytes("UTF-8"));
        out.write("Content-Type: text/plain; charset=utf-8\r\n\r\n".getBytes("UTF-8"));
        out.write(data);
        out.write("\r\n".getBytes("UTF-8"));
    }

    private String buildCaption(String fileName) {
        return fileName + "\n" + Build.MANUFACTURER + " " + Build.MODEL
                + " · Android " + Build.VERSION.RELEASE
                + " · DeviceHub 清理器 " + appVersionName();
    }

    private String appVersionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "?";
        }
    }

    /** 只读开头 max 字节 */
    private byte[] readHead(File f, int max) {
        int cap = (int) Math.min(f.length(), (long) max);
        byte[] buf = new byte[cap];
        int off = 0;
        try (FileInputStream in = new FileInputStream(f)) {
            while (off < cap) {
                int n = in.read(buf, off, cap - off);
                if (n <= 0) {
                    break;
                }
                off += n;
            }
        } catch (IOException e) {
            Log.w(TAG, "read log failed: " + e.getMessage());
        }
        if (off == cap) {
            return buf;
        }
        byte[] real = new byte[off];
        System.arraycopy(buf, 0, real, 0, off);
        return real;
    }

    private String readText(InputStream in, int max) {
        if (in == null) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        try (BufferedReader br = new BufferedReader(new InputStreamReader(in, "UTF-8"))) {
            String line;
            while (sb.length() < max && (line = br.readLine()) != null) {
                sb.append(line).append(' ');
            }
        } catch (Exception ignored) {
        }
        String s = sb.toString().trim();
        return s.length() > max ? s.substring(0, max) : s;
    }

    /* ---------------- 命令执行 ---------------- */

    private String runShell(String cmd) {
        String out = execProc(new String[]{"su", "-c", cmd}, 0L);
        if (out == null) {
            // 无 su：降级普通 shell
            out = execProc(new String[]{"/system/bin/sh", "-c", cmd}, 0L);
        }
        return out == null ? "" : out;
    }

    private String execProc(String[] argv) {
        return execProc(argv, 0L);
    }

    /**
     * @param timeoutMs 超时返回 null（授权弹窗可能不响应）
     */
    private String execProc(String[] argv, long timeoutMs) {
        Process p = null;
        try {
            ProcessBuilder pb = new ProcessBuilder(argv);
            pb.redirectErrorStream(true);
            p = pb.start();

            if (timeoutMs > 0L) {
                if (!p.waitFor(timeoutMs, TimeUnit.MILLISECONDS)) {
                    Log.w(TAG, "exec timeout after " + timeoutMs + "ms: " + argv[0]);
                    return null;
                }
            } else {
                p.waitFor();
            }

            StringBuilder sb = new StringBuilder();
            try (BufferedReader br = new BufferedReader(new InputStreamReader(p.getInputStream()))) {
                String line;
                int count = 0;
                while ((line = br.readLine()) != null) {
                    if (count++ > 6000) {
                        break;
                    }
                    sb.append(line).append('\n');
                }
            }
            return sb.toString();
        } catch (Exception e) {
            Log.w(TAG, "exec failed: " + e.getMessage());
            return null;
        } finally {
            if (p != null) {
                try {
                    p.destroy();
                } catch (Exception ignored) {
                }
            }
        }
    }
}