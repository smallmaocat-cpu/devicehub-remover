# ---- 混淆 / 收缩配置 ----
# R8 会重命名类、方法、字段并删除未引用代码；以下为必须保留的边界。

# WebView 的 JS 桥：方法名由 assets/webui/bridge.js 按字符串调用，混淆后即失效
-keepattributes JavascriptInterface,*Annotation*,Signature,InnerClasses,EnclosingMethod
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# 被 addJavascriptInterface 注入的对象（app.js 以 "AndroidShell" 名称访问）
-keep class io.github.smallmaocat.devicehubcleaner.MainActivity$ShellBridge { *; }

# Activity 由 AndroidManifest 引用，R8 默认保留，显式声明以防被裁剪
-keep class io.github.smallmaocat.devicehubcleaner.MainActivity { *; }

# 提高混淆强度：所有类压进同一个包，去掉可读的包层级
# 与 -flattenpackagehierarchy 同写会触发 R8 警告，只保留这一条
-repackageclasses 'a'
-allowaccessmodification

# 不保留行号，减小体积
-renamesourcefileattribute SourceFile
