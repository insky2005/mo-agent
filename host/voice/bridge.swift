import Foundation
import AVFoundation
import AppKit
import Darwin

/**
 * mo-agent 语音桥（常驻 helper）
 *
 *   serve     启动本地 TCP 服务，等 host 发命令（默认模式，由 open 启动）
 *   selftest  打印当前麦克风状态（命令行调试用）
 *
 * 协议：127.0.0.1 上的一行一个 JSON。
 *   {"cmd":"ping"} / {"cmd":"selftest"} / {"cmd":"record","timeout":15} / {"cmd":"quit"}
 * 所有命令都要带 token；token/端口写在 ~/.mo-agent/voice-bridge.json（0600）。
 *
 * 为什么是 .app：macOS TCC 只认带 Info.plist 的 bundle，裸 CLI 调麦克风会 SIGABRT。
 */

let INFO_DIR = (NSHomeDirectory() as NSString).appendingPathComponent(".mo-agent")
let INFO_PATH = (INFO_DIR as NSString).appendingPathComponent("voice-bridge.json")
let CACHE_DIR = (NSSearchPathForDirectoriesInDomains(.cachesDirectory, .userDomainMask, true).first ?? NSTemporaryDirectory())
  + "/mo-agent/voice"

func emit(_ payload: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: payload),
     let line = String(data: data, encoding: .utf8) {
    print(line)
  }
}

func fail(_ code: String, _ message: String) -> Never {
  emit(["ok": false, "error": code, "message": message])
  exit(0)
}

func ensureDir(_ path: String, permissions: Int) {
  try? FileManager.default.createDirectory(
    atPath: path,
    withIntermediateDirectories: true,
    attributes: [.posixPermissions: permissions]
  )
}

func micAuthorizationText() -> String {
  "AVAuthorizationStatus(rawValue: \(AVCaptureDevice.authorizationStatus(for: .audio).rawValue))"
}

func inputDeviceName() -> String {
  AVCaptureDevice.default(for: .audio)?.localizedName ?? "none"
}

func selftestPayload() -> [String: Any] {
  [
    "ok": true,
    "mode": "selftest",
    "micAuthorization": micAuthorizationText(),
    "inputDevice": inputDeviceName(),
  ]
}

func requestMic(_ timeout: TimeInterval) -> Bool {
  switch AVCaptureDevice.authorizationStatus(for: .audio) {
  case .authorized: return true
  case .denied, .restricted: return false
  case .notDetermined:
    let sem = DispatchSemaphore(value: 0)
    var granted = false
    AVCaptureDevice.requestAccess(for: .audio) { ok in
      granted = ok
      sem.signal()
    }
    _ = sem.wait(timeout: .now() + timeout)
    return granted
  @unknown default:
    return false
  }
}

final class CaptureGate {
  private let lock = NSLock()
  private var value = false

  var enabled: Bool {
    lock.lock()
    defer { lock.unlock() }
    return value
  }

  func enable() {
    lock.lock()
    value = true
    lock.unlock()
  }

  func disable() {
    lock.lock()
    value = false
    lock.unlock()
  }
}

final class VadState {
  private let lock = NSLock()
  private var sawSpeech = false
  private var lastVoice = Date()
  private var started = Date()

  func reset() {
    lock.lock()
    sawSpeech = false
    lastVoice = Date()
    started = Date()
    lock.unlock()
  }

  func observe(rms: Float, threshold: Float) {
    guard rms >= threshold else { return }
    lock.lock()
    sawSpeech = true
    lastVoice = Date()
    lock.unlock()
  }

  func snapshot() -> (sawSpeech: Bool, lastVoice: Date, started: Date) {
    lock.lock()
    defer { lock.unlock() }
    return (sawSpeech, lastVoice, started)
  }
}

func rmsOf(_ buffer: AVAudioPCMBuffer) -> Float {
  guard let channel = buffer.floatChannelData?[0] else { return 0 }
  let count = Int(buffer.frameLength)
  guard count > 0 else { return 0 }
  var sum: Float = 0
  for i in 0..<count {
    let sample = channel[i]
    sum += sample * sample
  }
  return sqrt(sum / Float(count))
}

/** 生成一个很短的提示音（120ms，1kHz）：系统提示音都有 0.5～1.6 秒，会吃掉开头。 */
func cueFilePath() -> String? {
  ensureDir(CACHE_DIR, permissions: 0o700)
  let path = CACHE_DIR + "/cue-1000hz-120ms.wav"
  if FileManager.default.fileExists(atPath: path) { return path }

  let sampleRate = 16000
  let frameCount = Int(Double(sampleRate) * 0.12)
  var data = Data()
  func append16(_ value: Int16) {
    var little = value.littleEndian
    data.append(Data(bytes: &little, count: 2))
  }
  func append32(_ value: UInt32) {
    var little = value.littleEndian
    data.append(Data(bytes: &little, count: 4))
  }
  let dataSize = UInt32(frameCount * 2)
  data.append(contentsOf: Array("RIFF".utf8))
  append32(36 + dataSize)
  data.append(contentsOf: Array("WAVE".utf8))
  data.append(contentsOf: Array("fmt ".utf8))
  append32(16)
  append16(1)
  append16(1)
  append32(UInt32(sampleRate))
  append32(UInt32(sampleRate * 2))
  append16(2)
  append16(16)
  data.append(contentsOf: Array("data".utf8))
  append32(dataSize)
  for i in 0..<frameCount {
    let t = Double(i) / Double(sampleRate)
    let fadeIn = min(1.0, Double(i) / (Double(sampleRate) * 0.005))
    let fadeOut = min(1.0, Double(frameCount - i) / (Double(sampleRate) * 0.02))
    let value = sin(2.0 * Double.pi * 1000.0 * t) * 0.45 * fadeIn * fadeOut
    append16(Int16(max(-32767.0, min(32767.0, value * 32767.0))))
  }
  do {
    try data.write(to: URL(fileURLWithPath: path), options: .atomic)
    return path
  } catch {
    return nil
  }
}

func playReadySound() {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/bin/afplay")
  let path = cueFilePath() ?? "/System/Library/Sounds/Glass.aiff"
  process.arguments = ["-v", "1.2", path]
  do {
    try process.run()
    process.waitUntilExit()
  } catch {
    // 没有提示音也不影响录音。
  }
}

final class CaptureStats {
  private let lock = NSLock()
  private var buffers = 0
  private var peak: Float = 0

  func observe(_ rms: Float) {
    lock.lock()
    buffers += 1
    if rms > peak { peak = rms }
    lock.unlock()
  }

  func snapshot() -> (buffers: Int, peak: Float) {
    lock.lock()
    defer { lock.unlock() }
    return (buffers, peak)
  }

  func reset() {
    lock.lock()
    buffers = 0
    peak = 0
    lock.unlock()
  }
}

final class RouteFlag {
  private let lock = NSLock()
  private var value = false

  func mark() {
    lock.lock()
    value = true
    lock.unlock()
  }

  func marked() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return value
  }
}

/**
 * WAV 写入器：tap 用 nil format 安装，第一次拿到真实 buffer 时才建文件。
 * 这样蓝牙路由从 A2DP 切到 HFP、采样率/声道数变化时，不会用过期 format 写文件。
 */
final class WavSink {
  private let lock = NSLock()
  private let path: String
  private var file: AVAudioFile?
  private var sampleRate: Double = 0
  private var channels: Int = 0
  private var wrote = false
  private var closed = false

  init(path: String) {
    self.path = path
  }

  func write(_ buffer: AVAudioPCMBuffer) {
    lock.lock()
    defer { lock.unlock() }
    if closed { return }
    if file == nil {
      let settings: [String: Any] = [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: buffer.format.sampleRate,
        AVNumberOfChannelsKey: buffer.format.channelCount,
        AVLinearPCMBitDepthKey: 16,
        AVLinearPCMIsFloatKey: false,
        AVLinearPCMIsBigEndianKey: false,
      ]
      file = try? AVAudioFile(
        forWriting: URL(fileURLWithPath: path),
        settings: settings,
        commonFormat: .pcmFormatFloat32,
        interleaved: false
      )
      sampleRate = buffer.format.sampleRate
      channels = Int(buffer.format.channelCount)
    }
    if let file = file {
      try? file.write(from: buffer)
      wrote = true
    }
  }

  func close() {
    lock.lock()
    closed = true
    file = nil
    lock.unlock()
  }

  func info() -> (sampleRate: Double, channels: Int, wrote: Bool) {
    lock.lock()
    defer { lock.unlock() }
    return (sampleRate, channels, wrote)
  }
}

/**
 * 一次 click-to-talk 的音频会话。
 *
 * 为什么要把引擎保持到整条命令结束：蓝牙耳机从 TTS（A2DP）切到麦克风（HFP）要 2～4 秒。
 * 旧实现每次 record 都新建引擎，TTS 播完再切路由，经常 3 秒都拿不到 buffer（日志里
 * mic-silent / buffers=0）。现在 host 先 open，等输入通道真的出音频，再播提示语；
 * 命令与确认两次 record 复用同一个引擎，不再反复切路由。
 */
final class VoiceSession {
  let engine = AVAudioEngine()
  let input: AVAudioInputNode
  let gate = CaptureGate()
  let state = VadState()
  let stats = CaptureStats()
  let route = RouteFlag()
  let threshold: Float
  let startupMs: Int

  private let lock = NSLock()
  private var sink: WavSink?
  private var observer: NSObjectProtocol?

  init(threshold: Float, startupMs: Int) {
    self.threshold = threshold
    self.startupMs = startupMs
    self.input = engine.inputNode
  }

  var isRunning: Bool {
    return engine.isRunning
  }

  func start() throws {
    input.installTap(onBus: 0, bufferSize: 1024, format: nil) { [weak self] buffer, _ in
      guard let self = self else { return }
      let level = rmsOf(buffer)
      self.stats.observe(level)
      guard self.gate.enabled else { return }
      self.lock.lock()
      let current = self.sink
      self.lock.unlock()
      current?.write(buffer)
      self.state.observe(rms: level, threshold: self.threshold)
    }
    engine.prepare()
    try engine.start()
    observer = NotificationCenter.default.addObserver(
      forName: .AVAudioEngineConfigurationChange,
      object: engine,
      queue: nil
    ) { [weak self] _ in
      guard let self = self else { return }
      self.route.mark()
      // 路由变化后引擎可能停了；尽量原地重启，保持会话。
      if !self.engine.isRunning {
        try? self.engine.start()
      }
    }
  }

  func attachSink(_ next: WavSink?) {
    lock.lock()
    let old = sink
    sink = next
    lock.unlock()
    old?.close()
  }

  /** 等输入通道真的出音频；返回状态并保留诊断。 */
  func waitLive(timeout: TimeInterval) -> (live: Bool, elapsedMs: Int, buffers: Int, peak: Float) {
    stats.reset()
    let started = Date()
    while Date().timeIntervalSince(started) < timeout {
      RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
      let snapshot = stats.snapshot()
      let elapsed = Date().timeIntervalSince(started)
      // 只要求“有 buffer 在流”，不再要求峰值：静音时蓝牙耳机可能输出全零，
      // 但引擎和路由已经就绪；真正的语音由后面的 VAD 判断。
      if snapshot.buffers >= 3 && elapsed >= 0.15 {
        return (true, Int(elapsed * 1000), snapshot.buffers, snapshot.peak)
      }
    }
    let snapshot = stats.snapshot()
    return (false, Int(Date().timeIntervalSince(started) * 1000), snapshot.buffers, snapshot.peak)
  }

  func status(reused: Bool) -> [String: Any] {
    let snapshot = stats.snapshot()
    let format = input.outputFormat(forBus: 0)
    return [
      "ok": true,
      "reused": reused,
      "startupMs": startupMs,
      "buffers": snapshot.buffers,
      "peak": Double(snapshot.peak),
      "routeChanged": route.marked(),
      "sampleRate": format.sampleRate,
      "channels": Int(format.channelCount),
      "inputDevice": inputDeviceName(),
      "micAuthorization": micAuthorizationText(),
    ]
  }

  func record(timeout: TimeInterval, silence: TimeInterval, maxSeconds: TimeInterval) -> [String: Any] {
    if !engine.isRunning {
      do { try engine.start() } catch {
        return [
          "ok": false,
          "error": "engine-failed",
          "message": error.localizedDescription,
          "inputDevice": inputDeviceName(),
          "micAuthorization": micAuthorizationText(),
        ]
      }
    }

    let out = CACHE_DIR + "/utt-" + UUID().uuidString + ".wav"
    let next = WavSink(path: out)
    attachSink(next)
    gate.disable()
    state.reset()
    stats.reset()

    // 先开 gate 再响提示音：用户常在提示音一响就开口，晚开 gate 会吃掉第一个字。
    // 提示音只有 120ms，会进 WAV 开头；VAD 在提示音结束后重置，不会把它当成一句话。
    gate.enable()
    playReadySound()
    state.reset()
    let started = Date()

    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
      let snapshot = state.snapshot()
      let now = Date()
      if snapshot.sawSpeech && now.timeIntervalSince(snapshot.lastVoice) >= silence { break }
      if now.timeIntervalSince(snapshot.started) >= maxSeconds { break }
    }

    gate.disable()
    attachSink(nil)

    let snapshot = state.snapshot()
    let info = next.info()
    let recordStats = stats.snapshot()
    var payload: [String: Any] = [
      "startupMs": startupMs,
      "buffers": recordStats.buffers,
      "peak": Double(recordStats.peak),
      "cue": "beep-120ms",
      "routeChanged": route.marked(),
      "sampleRate": info.sampleRate,
      "channels": info.channels,
      "inputDevice": inputDeviceName(),
      "micAuthorization": micAuthorizationText(),
    ]

    if !snapshot.sawSpeech {
      try? FileManager.default.removeItem(atPath: out)
      payload["ok"] = false
      payload["error"] = route.marked() ? "route-changed" : "timeout"
      payload["message"] = route.marked() ? "音频路由在录音期间发生变化" : "没有听到语音"
      return payload
    }

    payload["ok"] = true
    payload["file"] = out
    payload["seconds"] = Date().timeIntervalSince(started)
    return payload
  }

  func stop() {
    engine.stop()
    input.removeTap(onBus: 0)
    if let observer = observer {
      NotificationCenter.default.removeObserver(observer)
      self.observer = nil
    }
    attachSink(nil)
  }
}

var voiceSession: VoiceSession? = nil

func closeVoiceSession() {
  voiceSession?.stop()
  voiceSession = nil
}

func openVoiceSession(threshold: Float) -> [String: Any] {
  if let existing = voiceSession {
    if existing.isRunning {
      return existing.status(reused: true)
    }
    closeVoiceSession()
  }

  // 之前只有 record 里请求权限；改成 open 时就要授权，否则引擎只会收到全零。
  if !requestMic(10) {
    return [
      "ok": false,
      "error": "mic-denied",
      "message": "未获得麦克风权限",
      "micAuthorization": micAuthorizationText(),
      "inputDevice": inputDeviceName(),
    ]
  }

  let started = Date()
  let session = VoiceSession(threshold: threshold, startupMs: 0)
  do {
    try session.start()
  } catch {
    session.stop()
    return [
      "ok": false,
      "error": "engine-failed",
      "message": error.localizedDescription,
      "inputDevice": inputDeviceName(),
      "micAuthorization": micAuthorizationText(),
    ]
  }

  // 最多等 6 秒：蓝牙 A2DP -> HFP 的切换经常超过 3 秒。
  let live = session.waitLive(timeout: 6.0)
  if !live.live {
    session.stop()
    return [
      "ok": false,
      "error": "mic-silent",
      "message": "麦克风没有音频输入",
      "startupMs": live.elapsedMs,
      "buffers": live.buffers,
      "peak": Double(live.peak),
      "routeChanged": session.route.marked(),
      "inputDevice": inputDeviceName(),
      "micAuthorization": micAuthorizationText(),
    ]
  }

  voiceSession = session
  let format = session.input.outputFormat(forBus: 0)
  return [
    "ok": true,
    "reused": false,
    "startupMs": Int(Date().timeIntervalSince(started) * 1000),
    "buffers": live.buffers,
    "peak": Double(live.peak),
    "routeChanged": session.route.marked(),
    "sampleRate": format.sampleRate,
    "channels": Int(format.channelCount),
    "inputDevice": inputDeviceName(),
    "micAuthorization": micAuthorizationText(),
  ]
}

/**
 * 录一句。若 host 没有先 open，这里会自己开一个会话并在录完后关闭。
 */
func recordUtterance(timeout: TimeInterval, silence: TimeInterval, maxSeconds: TimeInterval, threshold: Float) -> [String: Any] {
  if voiceSession == nil {
    let opened = openVoiceSession(threshold: threshold)
    if (opened["ok"] as? Bool) != true {
      return opened
    }
  }
  guard let session = voiceSession else {
    return ["ok": false, "error": "mic-silent", "message": "音频会话不存在"]
  }
  let result = session.record(timeout: timeout, silence: silence, maxSeconds: maxSeconds)
  if (result["ok"] as? Bool) != true && (result["error"] as? String) == "mic-silent" {
    // 会话可能已经死了；下一次重试重新建。
    closeVoiceSession()
  }
  return result
}

// ---- 本地控制协议 ----

final class Activity {
  private let lock = NSLock()
  private var last = Date()

  func touch() {
    lock.lock()
    last = Date()
    lock.unlock()
  }

  func idleSeconds() -> TimeInterval {
    lock.lock()
    defer { lock.unlock() }
    return Date().timeIntervalSince(last)
  }
}

func readInfo() -> [String: Any]? {
  guard let data = FileManager.default.contents(atPath: INFO_PATH) else { return nil }
  return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}

func writeInfo(port: UInt16, token: String) {
  ensureDir(INFO_DIR, permissions: 0o700)
  let payload: [String: Any] = [
    "pid": getpid(),
    "port": Int(port),
    "token": token,
    "startedAt": Date().timeIntervalSince1970,
  ]
  guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
  do {
    try data.write(to: URL(fileURLWithPath: INFO_PATH), options: .atomic)
    chmod(INFO_PATH, 0o600)
  } catch {
    // 写不了就只是 host 找不到 helper；不要因此让录音崩掉。
  }
}

func removeInfo() {
  try? FileManager.default.removeItem(atPath: INFO_PATH)
}

func existingInstance() -> Bool {
  guard let info = readInfo(), let pidNumber = info["pid"] as? Int else { return false }
  return kill(pid_t(pidNumber), 0) == 0
}

func makeListener(port: inout UInt16) -> Int32 {
  let fd = socket(AF_INET, SOCK_STREAM, 0)
  guard fd >= 0 else { return -1 }

  var reuse: Int32 = 1
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))

  var address = sockaddr_in()
  address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
  address.sin_family = sa_family_t(AF_INET)
  address.sin_port = in_port_t(0)
  address.sin_addr.s_addr = inet_addr("127.0.0.1")

  let bound = withUnsafePointer(to: &address) { pointer in
    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { socketAddress in
      bind(fd, socketAddress, socklen_t(MemoryLayout<sockaddr_in>.size))
    }
  }
  guard bound == 0 else {
    close(fd)
    return -1
  }
  guard listen(fd, 8) == 0 else {
    close(fd)
    return -1
  }

  var actual = sockaddr_in()
  var length = socklen_t(MemoryLayout<sockaddr_in>.size)
  _ = withUnsafeMutablePointer(to: &actual) { pointer in
    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { socketAddress in
      getsockname(fd, socketAddress, &length)
    }
  }
  port = UInt16(bigEndian: actual.sin_port)
  return fd
}

func readLine(fd: Int32) -> String? {
  var data = Data()
  var byte: UInt8 = 0
  while true {
    let count = read(fd, &byte, 1)
    if count <= 0 { return nil }
    if byte == 10 { break }
    data.append(byte)
    if data.count > 65536 { return nil }
  }
  return String(data: data, encoding: .utf8)
}

func sendJSON(fd: Int32, _ payload: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: payload),
        var line = String(data: data, encoding: .utf8) else { return }
  line += "\n"
  _ = line.withCString { pointer in
    Darwin.write(fd, pointer, strlen(pointer))
  }
}

func handleClient(fd: Int32, token: String, activity: Activity) {
  defer { close(fd) }
  activity.touch()

  guard let line = readLine(fd: fd),
        let data = line.data(using: .utf8),
        let object = try? JSONSerialization.jsonObject(with: data),
        let json = object as? [String: Any] else {
    sendJSON(fd: fd, ["ok": false, "error": "bad-request"])
    return
  }

  guard (json["token"] as? String) == token else {
    sendJSON(fd: fd, ["ok": false, "error": "unauthorized"])
    return
  }

  let command = json["cmd"] as? String ?? ""
  switch command {
  case "ping":
    sendJSON(fd: fd, ["ok": true])
  case "selftest":
    sendJSON(fd: fd, selftestPayload())
  case "open":
    let threshold = Float((json["threshold"] as? Double) ?? 0.008)
    sendJSON(fd: fd, openVoiceSession(threshold: threshold))
  case "close":
    closeVoiceSession()
    sendJSON(fd: fd, ["ok": true])
  case "record":
    let timeout = (json["timeout"] as? Double) ?? 15
    let silence = (json["silence"] as? Double) ?? 1.1
    let maxSeconds = (json["max"] as? Double) ?? 12
    let threshold = Float((json["threshold"] as? Double) ?? 0.008)
    sendJSON(fd: fd, recordUtterance(
      timeout: timeout,
      silence: silence,
      maxSeconds: maxSeconds,
      threshold: threshold
    ))
  case "quit":
    sendJSON(fd: fd, ["ok": true])
    activity.touch()
    removeInfo()
    exit(0)
  default:
    sendJSON(fd: fd, ["ok": false, "error": "unknown-command"])
  }
  activity.touch()
}

func serve() -> Never {
  signal(SIGPIPE, SIG_IGN)

  // open -n 可能再拉起一个实例；已有活着的就安静退出。
  if existingInstance() { exit(0) }

  var port: UInt16 = 0
  let server = makeListener(port: &port)
  if server < 0 { fail("listen-failed", "无法监听本地端口") }

  let token = UUID().uuidString
  writeInfo(port: port, token: token)

  let activity = Activity()
  let idleTimer = DispatchSource.makeTimerSource(queue: DispatchQueue.global())
  idleTimer.schedule(deadline: .now() + 30, repeating: 30)
  idleTimer.setEventHandler {
    // host 异常退出时兜底：别让麦克风一直开着。
    if activity.idleSeconds() > 120 {
      closeVoiceSession()
    }
    if activity.idleSeconds() > 300 {
      closeVoiceSession()
      removeInfo()
      exit(0)
    }
  }
  idleTimer.resume()

  DispatchQueue.global(qos: .userInitiated).async {
    while true {
      let client = accept(server, nil, nil)
      if client < 0 { continue }
      handleClient(fd: client, token: token, activity: activity)
    }
  }

  // 用 NSApplication 跑事件循环，而不是 dispatchMain：
  // 这样 LaunchServices/系统设置尝试“打开”它时能得到响应，
  // 不会报 “not responding”。激活策略设为 prohibited，不出现 Dock/菜单。
  let application = NSApplication.shared
  application.setActivationPolicy(.prohibited)
  application.run()
  exit(0)
}

let args = CommandLine.arguments
let mode = args.count > 1 ? args[1] : "serve"
switch mode {
case "serve":
  serve()
case "selftest":
  emit(selftestPayload())
default:
  fail("usage", "未知模式: " + mode)
}