package cn.mocampus.moagent.android;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 通知上的「允许一次 / 拒绝」按钮回调：直接 POST /api/approve，不用先打开 App。
 */
public class ApprovalActionReceiver extends BroadcastReceiver {
    public static final String ACTION = "cn.mocampus.moagent.android.APPROVE";

    @Override
    public void onReceive(Context context, Intent intent) {
        final String base = intent.getStringExtra("base");
        final String token = intent.getStringExtra("token");
        final String id = intent.getStringExtra("id");
        final String decision = intent.getStringExtra("decision");
        if (base == null || base.isEmpty() || id == null || id.isEmpty()) return;

        final PendingResult pending = goAsync();
        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                JSONObject body = new JSONObject();
                body.put("id", id);
                body.put("decision", decision == null ? "reject_once" : decision);

                conn = (HttpURLConnection) new URL(base + "/api/approve").openConnection();
                conn.setRequestMethod("POST");
                conn.setDoOutput(true);
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);
                conn.setRequestProperty("content-type", "application/json");
                if (token != null && !token.isEmpty()) conn.setRequestProperty("x-mo-agent-token", token);
                try (OutputStream os = conn.getOutputStream()) {
                    os.write(body.toString().getBytes("UTF-8"));
                }
                conn.getResponseCode();
            } catch (Exception ignored) {
                // 网络失败也无妨：本地终端仍会看到原来的授权提示
            } finally {
                if (conn != null) conn.disconnect();
                pending.finish();
            }
        }, "mo-agent-approve").start();
    }
}
