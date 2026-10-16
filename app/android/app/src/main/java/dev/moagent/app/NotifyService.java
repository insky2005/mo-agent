package dev.moagent.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/**
 * 前台服务：常驻一条低优先级通知，同时在后台维持到 host 的 SSE 连接。
 * 收到 host 路由出来的 notify 事件就发本地通知——这样手机锁屏/App 退到后台也能响。
 *
 * 这条连接完全在原生侧，不依赖 WebView 是否存活。
 */
public class NotifyService extends Service {
    public static final String PREFS = "mo-agent-native";
    public static final String KEY_BASE = "base";
    public static final String KEY_TOKEN = "token";
    public static final String KEY_ENABLED = "enabled";

    private static final String CHANNEL_ONGOING = "mo-agent-service";
    private static final String CHANNEL_ALERT = "mo-agent-alert";
    private static final int ONGOING_ID = 1001;

    private volatile boolean running = false;
    private Thread worker;
    private long lastSeq = 0;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(ONGOING_ID, ongoing());
        if (!running) {
            running = true;
            worker = new Thread(this::loop, "mo-agent-sse");
            worker.setDaemon(true);
            worker.start();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        Thread current = worker;
        worker = null;
        if (current != null) current.interrupt();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel ongoing = new NotificationChannel(CHANNEL_ONGOING, "mo-agent 后台连接", NotificationManager.IMPORTANCE_LOW);
        ongoing.setDescription("保持与电脑的连接，锁屏时也能收到 Agent 提醒");
        nm.createNotificationChannel(ongoing);
        NotificationChannel alert = new NotificationChannel(CHANNEL_ALERT, "Agent 提醒", NotificationManager.IMPORTANCE_HIGH);
        alert.setDescription("Agent 需要授权、需要回答，或运行失败");
        nm.createNotificationChannel(alert);
    }

    private int pendingFlags() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            return PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.FLAG_UPDATE_CURRENT;
    }

    private Notification ongoing() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, pendingFlags());
        return new NotificationCompat.Builder(this, CHANNEL_ONGOING)
                .setContentTitle("mo-agent 正在守候")
                .setContentText("保持连接，锁屏也能收到 Agent 提醒")
                .setSmallIcon(R.drawable.ic_stat_mo_agent)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setContentIntent(pi)
                .build();
    }

    private void loop() {
        long backoff = 2000;
        while (running) {
            SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
            String base = prefs.getString(KEY_BASE, "");
            String token = prefs.getString(KEY_TOKEN, "");
            if (base == null || base.isEmpty()) {
                sleep(3000);
                continue;
            }
            HttpURLConnection conn = null;
            try {
                String url = base + "/api/events?since=" + lastSeq + "&token=" + URLEncoder.encode(token == null ? "" : token, "UTF-8");
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setRequestProperty("Accept", "text/event-stream");
                conn.setRequestProperty("Cache-Control", "no-cache");
                conn.setConnectTimeout(10000);
                conn.setReadTimeout(0);
                if (conn.getResponseCode() != 200) throw new IllegalStateException("HTTP " + conn.getResponseCode());
                backoff = 2000;

                BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8));
                String eventType = null;
                StringBuilder data = new StringBuilder();
                String line;
                while (running && (line = reader.readLine()) != null) {
                    if (line.isEmpty()) {
                        if (eventType != null && data.length() > 0) handleEvent(eventType, data.toString());
                        eventType = null;
                        data.setLength(0);
                        continue;
                    }
                    if (line.startsWith(":")) continue;
                    if (line.startsWith("event:")) eventType = line.substring(6).trim();
                    else if (line.startsWith("data:")) data.append(line.substring(5).trim());
                    else if (line.startsWith("id:")) {
                        try { lastSeq = Long.parseLong(line.substring(3).trim()); } catch (NumberFormatException ignored) { }
                    }
                }
            } catch (Exception error) {
                // 断线：退避后重连，不打扰用户
            } finally {
                if (conn != null) conn.disconnect();
            }
            sleep(backoff);
            backoff = Math.min(backoff * 2, 30000);
        }
    }

    private void handleEvent(String type, String data) {
        if (!"notify".equals(type)) return;
        try {
            JSONObject event = new JSONObject(data);
            JSONObject payload = event.optJSONObject("payload");
            if (payload != null) showAlert(payload);
        } catch (Exception ignored) {
            // 解析失败就跳过，不因为一条坏事件断掉连接
        }
    }

    private void showAlert(JSONObject payload) {
        String title = payload.optString("title", "mo-agent");
        String body = payload.optString("body", "");
        String kind = payload.optString("kind", "notice");
        String eventId = payload.isNull("eventId") ? null : payload.optString("eventId", null);
        boolean critical = "critical".equals(payload.optString("severity", "normal"));

        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int reqCode = (int) (System.currentTimeMillis() & 0xffff);
        PendingIntent contentIntent = PendingIntent.getActivity(this, reqCode, open, pendingFlags());

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ALERT)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setSmallIcon(R.drawable.ic_stat_mo_agent)
                .setContentIntent(contentIntent)
                .setAutoCancel(true)
                .setPriority(critical ? NotificationCompat.PRIORITY_HIGH : NotificationCompat.PRIORITY_DEFAULT)
                .setCategory(critical ? NotificationCompat.CATEGORY_ALARM : NotificationCompat.CATEGORY_STATUS);

        if ("approval".equals(kind) && eventId != null && !eventId.isEmpty()) {
            builder.addAction(0, "允许一次", decisionIntent(eventId, "allow_once", 1));
            builder.addAction(0, "拒绝", decisionIntent(eventId, "reject_once", 2));
        }

        NotificationManagerCompat manager = NotificationManagerCompat.from(this);
        if (manager.areNotificationsEnabled()) {
            manager.notify((int) (System.currentTimeMillis() & 0x7fffffff), builder.build());
        }
    }

    private PendingIntent decisionIntent(String eventId, String decision, int requestCode) {
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        Intent intent = new Intent(this, ApprovalActionReceiver.class);
        intent.setAction(ApprovalActionReceiver.ACTION);
        intent.putExtra("base", prefs.getString(KEY_BASE, ""));
        intent.putExtra("token", prefs.getString(KEY_TOKEN, ""));
        intent.putExtra("id", eventId);
        intent.putExtra("decision", decision);
        return PendingIntent.getBroadcast(this, requestCode, intent, pendingFlags());
    }

    private void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }
}
