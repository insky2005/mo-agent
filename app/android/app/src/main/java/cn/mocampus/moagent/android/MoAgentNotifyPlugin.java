package cn.mocampus.moagent.android;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.huawei.hms.push.HmsMessaging;

/**
 * 暴露给网页的开关：把当前 host 地址与设备令牌交给前台服务，
 * 之后通知由原生侧直接负责（不依赖 WebView 存活）。
 */
@CapacitorPlugin(name = "MoAgentNotify")
public class MoAgentNotifyPlugin extends Plugin {

    // AGC 里的 App ID（不是 OAuth client_id），公开信息
    private static final String HMS_APP_ID = "119386705";

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(NotifyService.PREFS, Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void start(PluginCall call) {
        String base = call.getString("base", "");
        String token = call.getString("token", "");
        if (base == null || base.isEmpty()) {
            call.reject("缺少 base");
            return;
        }
        prefs().edit()
                .putString(NotifyService.KEY_BASE, base)
                .putString(NotifyService.KEY_TOKEN, token == null ? "" : token)
                .putBoolean(NotifyService.KEY_ENABLED, true)
                .apply();

        Intent intent = new Intent(getContext(), NotifyService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) getContext().startForegroundService(intent);
        else getContext().startService(intent);

        // 配对信息已就绪，顺便取 HMS push token 上报给 host
        fetchAndReportHmsToken();

        JSObject result = new JSObject();
        result.put("running", true);
        call.resolve(result);
    }

    /** 取 HMS push token 并上报；HMS 不可用时静默跳过。 */
    private void fetchAndReportHmsToken() {
        try {
            final Context context = getContext();
            HmsMessaging.getInstance(context).setAutoInitEnabled(true);
            // getToken 是阻塞的网络调用，必须放后台线程
            new Thread(() -> {
                try {
                    String token = com.huawei.hms.aaid.HmsInstanceId.getInstance(context).getToken(HMS_APP_ID, "HCM");
                    PushTokenReporter.report(context, token);
                } catch (Exception ignored) {
                    // HMS Core 缺失或未登录华为账号：忽略
                }
            }, "mo-agent-hms-token").start();
        } catch (Exception ignored) {
            // 不影响本地功能
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        prefs().edit().putBoolean(NotifyService.KEY_ENABLED, false).apply();
        getContext().stopService(new Intent(getContext(), NotifyService.class));
        JSObject result = new JSObject();
        result.put("running", false);
        call.resolve(result);
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject result = new JSObject();
        result.put("enabled", prefs().getBoolean(NotifyService.KEY_ENABLED, false));
        result.put("base", prefs().getString(NotifyService.KEY_BASE, ""));
        call.resolve(result);
    }

    /** 把 App 加入电池优化白名单：否则锁屏久了系统会冻结后台网络，通知就会延迟。 */
    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        try {
            android.os.PowerManager pm = (android.os.PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            if (pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName())) {
                call.resolve();
                return;
            }
            Intent intent = new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(android.net.Uri.parse("package:" + getContext().getPackageName()));
            getActivity().startActivity(intent);
            call.resolve();
        } catch (Exception error) {
            call.reject("无法打开电池优化设置: " + error.getMessage());
        }
    }
}
