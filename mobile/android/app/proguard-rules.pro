# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# ─── Termilab (release is minified with R8) ───────────────────
# capacitor-nodejs: native-lib.cpp calls NodeProcess.nativeReceive through JNI
# (GetMethodID by name). R8 sees no Java caller and would drop or rename it:
# Node would start and then no message would ever reach the page.
-keep class net.hampoelz.capacitor.nodejs.NodeProcess { *; }
# Capacitor's consumer rules keep annotated plugin classes; the Node plugin's
# engine and env hook are reached from them, keep the package whole (small).
-keep class net.hampoelz.capacitor.nodejs.** { *; }
# Our plugin: reflection-called @PluginMethod/@ActivityCallback/@PermissionCallback
# are covered by Capacitor's rules; the WebView subclass is inflated from XML.
-keep class com.rhinlab.termilab.nativeplugin.** { *; }
