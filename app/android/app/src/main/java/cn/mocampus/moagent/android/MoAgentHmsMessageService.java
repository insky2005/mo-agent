package cn.mocampus.moagent.android;

import com.huawei.hms.push.HmsMessageService;
import com.huawei.hms.push.RemoteMessage;

/**
 * HMS 推送回调：token 变化时上报给 host。
 * 通知类消息由系统直接展示，不需要这里处理。
 */
public class MoAgentHmsMessageService extends HmsMessageService {
    @Override
    public void onNewToken(String token) {
        super.onNewToken(token);
        PushTokenReporter.report(getApplicationContext(), token);
    }

    @Override
    public void onMessageReceived(RemoteMessage message) {
        super.onMessageReceived(message);
    }
}
