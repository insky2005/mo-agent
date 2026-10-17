package cn.mocampus.moagent.android;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

/**
 * 开机自启：只要之前开启过锁屏通知，开机后就把前台服务拉起来。
 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        try {
            SharedPreferences prefs = context.getSharedPreferences(NotifyService.PREFS, Context.MODE_PRIVATE);
            if (!prefs.getBoolean(NotifyService.KEY_ENABLED, false)) return;
            if (prefs.getString(NotifyService.KEY_BASE, "").isEmpty()) return;
            Intent service = new Intent(context, NotifyService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(service);
            else context.startService(service);
        } catch (Exception ignored) {
            // 启动失败不影响开机
        }
    }
}
