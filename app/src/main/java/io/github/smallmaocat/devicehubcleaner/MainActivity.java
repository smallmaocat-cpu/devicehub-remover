package io.github.smallmaocat.devicehubcleaner;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * DeviceHub 清理器 · APK 外壳
 * WebView 载入 assets/webui 里的界面，通过 su -c 执行 assets/bin/dh-clean.sh。
 * 运行状态、配置、日志都在 files/dh 下，通过 DH_BASE / MODDIR 环境变量传给脚本。
 */
public class MainActivity extends Activity {

    private static final String TAG = "DHCleaner";
    private static final String SCRIPT_ASSET = "bin/dh-clean.sh";

    private WebView web;
    private File baseDir;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService pool = Executors.newSingleThreadExecutor();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        try {
            baseDir = prepareFiles();
        } catch (Exception e) {
            Log.e(TAG, "prepareFiles failed", e);
            baseDir = new File(getFilesDir(), "dh");
        }

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0e1116"));
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0e1116"));
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

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
        web.loadUrl("file:///android_asset/webui/index.html");
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
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
            throw new IOException("无法创建目录: " + bin);
        }
        File script = new File(bin, "dh-clean.sh");
        copyAsset(SCRIPT_ASSET, script);
        // 脚本需要可执行位；root shell 里用 sh 调用，不依赖它，但保持正确更稳
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

        /** 同步判断是否有 root（只在页面加载时调一次） */
        @JavascriptInterface
        public boolean isRoot() {
            String out = execProc(new String[]{"su", "-c", "id"});
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
    }

    /* ---------------- 命令执行 ---------------- */

    private String runShell(String cmd) {
        String out = execProc(new String[]{"su", "-c", cmd});
        if (out == null) {
            // 没有 su：降级用普通 shell，界面上会因为权限不足而报错，但不会崩
            out = execProc(new String[]{"/system/bin/sh", "-c", cmd});
        }
        return out == null ? "" : out;
    }

    private String execProc(String[] argv) {
        Process p = null;
        try {
            ProcessBuilder pb = new ProcessBuilder(argv);
            pb.redirectErrorStream(true);
            p = pb.start();
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
            p.waitFor();
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
