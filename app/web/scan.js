/**
 * 扫码配对。
 *
 * 两个关键点：
 * 1) 解码器选择：BarcodeDetector 在多数 Android WebView 里「存在但不可用」
 *    （依赖 Play 服务的条码模块），getSupportedFormats 不含 qr_code 时要直接
 *    用内置 jsQR，不能只看 window.BarcodeDetector 是否存在。
 * 2) 运行中回退：即便选了 BarcodeDetector，detect() 连续失败也要切到 jsQR，
 *    否则表现就是「扫半天没反应」。
 */
(function () {
  'use strict';

  var overlay = null;
  var video = null;
  var canvas = null;
  var ctx = null;
  var stream = null;
  var running = false;
  var handling = false;
  var decoder = null;
  var detector = null;
  var failures = 0;

  function log() {
    try { console.log.apply(console, ['[mo-agent scan]'].concat([].slice.call(arguments))); } catch (e) { /* 忽略 */ }
  }

  function setStatus(text) {
    var el = document.getElementById('scanStatus');
    if (el) el.textContent = text || '';
    log(text);
  }

  function showError(message) {
    var el = document.getElementById('scanError');
    if (el) el.textContent = message || '';
    log('ERROR ' + message);
  }

  function parsePayload(text) {
    var raw = String(text || '').trim();
    var m = raw.match(/^mo-agent:\/\/pair\?(.*)$/i);
    if (m) {
      var params = new URLSearchParams(m[1]);
      return { baseUrl: params.get('u') || '', token: params.get('t') || '' };
    }
    if (/^https?:\/\//i.test(raw)) {
      try {
        var url = new URL(raw);
        return { baseUrl: url.origin, token: url.searchParams.get('t') || '' };
      } catch (error) { return null; }
    }
    return null;
  }

  function buildOverlay() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'overlay hidden';
    overlay.id = 'scanOverlay';
    overlay.innerHTML =
      '<div class="dialog scanDialog">' +
      '<h3>扫描电脑上的二维码</h3>' +
      '<p>在电脑上打开 mo-agent 菜单栏的「设置（安装与配对）」，对准「第 2 步 配对」那个码。</p>' +
      '<video id="scanVideo" playsinline muted autoplay></video>' +
      '<div id="scanStatus" class="scanStatus">正在打开相机…</div>' +
      '<div class="dialogActions"><button id="btnScanClose" class="ghost" type="button">取消</button></div>' +
      '<p id="scanError" class="error"></p>' +
      '</div>';
    document.body.appendChild(overlay);
    video = document.getElementById('scanVideo');
    canvas = document.createElement('canvas');
    ctx = canvas.getContext('2d', { willReadFrequently: true });
    document.getElementById('btnScanClose').addEventListener('click', closeScanner);
  }

  function ensureButton() {
    var actions = document.querySelector('#pairOverlay .dialogActions');
    if (!actions || document.getElementById('btnScan')) return;
    var button = document.createElement('button');
    button.id = 'btnScan';
    button.type = 'button';
    button.className = 'ghost';
    button.textContent = '扫码配对';
    button.addEventListener('click', openScanner);
    actions.insertBefore(button, actions.firstChild);
  }

  function closeScanner() {
    running = false;
    if (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
    }
    if (overlay) overlay.classList.add('hidden');
  }

  async function chooseDecoder() {
    if (window.BarcodeDetector && typeof window.BarcodeDetector.getSupportedFormats === 'function') {
      try {
        var formats = await window.BarcodeDetector.getSupportedFormats();
        log('BarcodeDetector formats=' + JSON.stringify(formats));
        if (formats && formats.indexOf('qr_code') >= 0) return 'barcode';
      } catch (error) {
        log('getSupportedFormats 失败: ' + error.message);
      }
    }
    return window.jsQR ? 'jsqr' : null;
  }

  function openScanner() {
    buildOverlay();
    overlay.classList.remove('hidden');
    showError('');
    handling = false;
    failures = 0;
    detector = null;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('');
      showError('当前环境不支持摄像头，请用「电脑地址 + 配对码」手工配对。');
      return;
    }

    setStatus('正在打开相机…');
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: 'environment' } } })
      .then(function (s) {
        stream = s;
        video.srcObject = s;
        return video.play();
      })
      .then(function () {
        log('camera ready ' + video.videoWidth + 'x' + video.videoHeight);
        return chooseDecoder();
      })
      .then(function (kind) {
        decoder = kind;
        if (!kind) {
          setStatus('');
          showError('当前环境缺少二维码解码能力，请用「电脑地址 + 配对码」手工配对。');
          return;
        }
        setStatus(kind === 'barcode' ? '相机已就绪（系统解码器），对准二维码' : '相机已就绪（内置解码器），对准二维码');
        running = true;
        tick();
      })
      .catch(function (error) {
        setStatus('');
        showError('打不开摄像头：' + (error && error.message ? error.message : error) + '（可改用「电脑地址 + 配对码」）');
      });
  }

  function useJsQR() {
    if (!window.jsQR) return false;
    decoder = 'jsqr';
    setStatus('已切换到内置解码器，继续对准二维码');
    return true;
  }

  function tick() {
    if (!running) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      if (decoder === 'barcode' && detector !== null) {
        detector.detect(video).then(function (codes) {
          if (codes && codes.length && codes[0].rawValue) return handle(codes[0].rawValue);
          failures = 0;
        }).catch(function (error) {
          failures += 1;
          if (failures === 3) log('detect 连续失败: ' + (error && error.message ? error.message : error));
          if (failures >= 5) {
            failures = 0;
            detector = null;
            if (!useJsQR()) {
              setStatus('');
              showError('系统解码器不可用，且缺少内置解码能力。');
            }
          }
        });
      } else if (decoder === 'jsqr') {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        var frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
        var code = window.jsQR(frame.data, frame.width, frame.height);
        if (code && code.data) handle(code.data);
      }
    }
    requestAnimationFrame(tick);
  }

  function handle(text) {
    if (handling) return;
    var parsed = parsePayload(text);
    if (!parsed || !parsed.baseUrl) {
      handling = true;
      setStatus('');
      showError('扫到了内容，但不是 mo-agent 的配对码：' + String(text).slice(0, 60));
      setTimeout(function () { handling = false; }, 1500);
      return;
    }
    handling = true;
    running = false;
    setStatus('识别成功，正在连接 ' + parsed.baseUrl + ' …');
    log('paired payload base=' + parsed.baseUrl);
    fetch(parsed.baseUrl + '/api/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ qrToken: parsed.token }),
    })
      .then(function (res) { return res.json(); })
      .then(function (result) {
        if (!result || !result.ok) {
          handling = false;
          showError('配对失败：' + ((result && result.error) || '未知错误'));
          return;
        }
        localStorage.setItem('mo-agent.token', result.token);
        localStorage.setItem('mo-agent.base', parsed.baseUrl);
        localStorage.removeItem('mo-agent.seq');
        setStatus('连接成功，正在进入…');
        location.reload();
      })
      .catch(function (error) {
        handling = false;
        showError('连不上 ' + parsed.baseUrl + '：' + error.message + '（检查手机和电脑是否同一网段）');
      });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensureButton);
  else ensureButton();
  setInterval(ensureButton, 1500);
})();
