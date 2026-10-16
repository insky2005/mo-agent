package dev.moagent.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;

import androidx.core.app.ActivityCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 自定义插件要在 super.onCreate 之前注册
        registerPlugin(MoAgentNotifyPlugin.class);
        super.onCreate(savedInstanceState);
        requestNotificationPermission();
        startNotifyIfConfigured();
    }

    /** 只要之前配置过，就在 App 启动时从原生侧把前台服务拉起来（不依赖网页 JS）。 */
    private void startNotifyIfConfigured() {
        android.content.SharedPreferences prefs = getSharedPreferences(NotifyService.PREFS, MODE_PRIVATE);
        if (!prefs.getBoolean(NotifyService.KEY_ENABLED, false)) return;
        if (prefs.getString(NotifyService.KEY_BASE, "").isEmpty()) return;
        android.content.Intent intent = new android.content.Intent(this, NotifyService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(intent);
        else startService(intent);
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        ActivityCompat.requestPermissions(this, new String[]{ Manifest.permission.POST_NOTIFICATIONS }, 1001);
    }
}
