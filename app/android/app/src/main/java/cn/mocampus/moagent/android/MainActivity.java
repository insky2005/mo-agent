package cn.mocampus.moagent.android;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;

import androidx.core.app.ActivityCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 自定义插件要在 super.onCreate 之前注册
        registerPlugin(MoAgentNotifyPlugin.class);
        super.onCreate(savedInstanceState);
        requestNotificationPermission();
        // 改用 HMS 系统推送后不再需要前台 SSE 服务，清理旧版本残留的常驻通知
        try { stopService(new android.content.Intent(this, NotifyService.class)); } catch (Exception ignored) { }
    }

    @Override
    public void onResume() {
        super.onResume();
        // 手机常放在桌上盯 Agent 状态：App 在前台时保持亮屏，
        // 免得熄屏后解锁才发现有卡片在等授权。离开 App 或按电源键后自动失效。
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    @Override
    public void onPause() {
        // 只在看得见的时候亮屏；退到后台就交还给系统息屏策略。
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        super.onPause();
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        ActivityCompat.requestPermissions(this, new String[]{ Manifest.permission.POST_NOTIFICATIONS }, 1001);
    }
}
