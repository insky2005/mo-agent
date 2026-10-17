package cn.mocampus.moagent.android;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** 把 HMS push token 上报给 host（用已配对的设备令牌鉴权）。 */
final class PushTokenReporter {
    private PushTokenReporter() { }

    static void report(Context context, String token) {
        if (token == null || token.isEmpty()) return;
        SharedPreferences prefs = context.getSharedPreferences(NotifyService.PREFS, Context.MODE_PRIVATE);
        final String base = prefs.getString(NotifyService.KEY_BASE, "");
        final String deviceToken = prefs.getString(NotifyService.KEY_TOKEN, "");
        if (base.isEmpty() || deviceToken.isEmpty()) return; // 还没配对，等 start() 时再报

        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                JSONObject body = new JSONObject();
                body.put("token", token);
                conn = (HttpURLConnection) new URL(base + "/api/push-token").openConnection();
                conn.setRequestMethod("POST");
                conn.setDoOutput(true);
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);
                conn.setRequestProperty("content-type", "application/json");
                conn.setRequestProperty("x-mo-agent-token", deviceToken);
                try (OutputStream os = conn.getOutputStream()) {
                    os.write(body.toString().getBytes("UTF-8"));
                }
                conn.getResponseCode();
            } catch (Exception ignored) {
                // 上报失败下次再报，不影响本地功能
            } finally {
                if (conn != null) conn.disconnect();
            }
        }, "mo-agent-push-token").start();
    }
}
