'use strict';
const $ = (id) => document.getElementById(id);
const video = $('video');
let active = null;

function message(text, error = false) {
  $('message').textContent = text;
  $('message').classList.toggle('error', error);
}

function setStatus(text, online = false) {
  $('status').textContent = text;
  $('status-dot').classList.toggle('online', online);
  $('live').hidden = !online;
  $('snapshot').disabled = !online;
  $('fullscreen').disabled = !online;
}

async function removeSession(url) {
  if (!url) return;
  try { await fetch(url, { method: 'DELETE', mode: 'cors', credentials: 'omit', keepalive: true }); }
  catch { /* A closed peer also lets the server expire the session. */ }
}

function stop() {
  const previous = active;
  active = null;
  if (previous) {
    clearTimeout(previous.timeout);
    clearTimeout(previous.disconnectedTimer);
    previous.controller.abort();
    previous.pc.close();
    void removeSession(previous.sessionUrl);
  }
  video.srcObject = null;
  video.controls = false;
  $('placeholder').hidden = false;
  $('connect').disabled = false;
  $('endpoint').disabled = false;
  $('disconnect').disabled = true;
  $('resolution').textContent = 'WebRTC 即時串流';
  setStatus('尚未連線');
}

function fail(connection, text) {
  if (active !== connection) return;
  stop();
  setStatus('連線失敗');
  message(text, true);
}

function waitForIce(pc, signal) {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      signal.removeEventListener('abort', abort);
    };
    const check = () => { if (pc.iceGatheringState === 'complete') { cleanup(); resolve(); } };
    const abort = () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('無法完成網路協商，請檢查網路設定。')); }, 10000);
    pc.addEventListener('icegatheringstatechange', check);
    signal.addEventListener('abort', abort, { once: true });
    check();
  });
}

function parseEndpoint(value, pageProtocol) {
  const endpoint = new URL(value.trim());
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('請填入 HTTP 或 HTTPS 的 WHEP 網址。');
  if (endpoint.username || endpoint.password) throw new Error('請勿在網址內填入帳號或密碼。');
  // Loopback HTTP is a potentially trustworthy origin. The browser may still
  // require local-network permission when this player is served over HTTPS.
  const local = endpoint.hostname === 'localhost' || endpoint.hostname.endsWith('.localhost') ||
    endpoint.hostname.startsWith('127.') || endpoint.hostname === '[::1]';
  if (pageProtocol === 'https:' && endpoint.protocol !== 'https:' && !local) {
    throw new Error('遠端串流請使用 HTTPS；本機串流可使用 http://localhost:8889/cam/whep。');
  }
  if (!/\/whep\/?$/.test(endpoint.pathname)) throw new Error('請填入以 /whep 結尾的串流網址，例如 http://localhost:8889/cam/whep。');
  return endpoint;
}

$('connect-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  let endpoint;
  try {
    endpoint = parseEndpoint($('endpoint').value, location.protocol);
    if (!window.RTCPeerConnection) throw new Error('此瀏覽器不支援 WebRTC，請使用新版 Chrome、Edge、Firefox 或 Safari。');
  } catch (error) { message(error instanceof TypeError ? '串流網址格式不正確。' : error.message, true); return; }

  stop();
  const connection = { pc: new RTCPeerConnection(), controller: new AbortController(), sessionUrl: null };
  active = connection;
  const { pc, controller } = connection;
  $('connect').disabled = true;
  $('endpoint').disabled = true;
  $('disconnect').disabled = false;
  setStatus('連線中…');
  message('正在與相機建立連線…');
  connection.timeout = setTimeout(() => fail(connection, '連線逾時。請確認相機、MediaMTX、HTTPS 與 WebRTC 媒體連接埠可連線。'), 30000);
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.ontrack = (event) => {
    if (active !== connection) return;
    video.srcObject = event.streams[0] || new MediaStream([event.track]);
    video.play().catch(() => {
      if (active !== connection) return;
      message('瀏覽器暫停了自動播放，請點擊影像中的播放按鈕。');
      video.controls = true;
    });
  };
  pc.onconnectionstatechange = () => {
    if (active !== connection) return;
    if (pc.connectionState === 'connected') {
      clearTimeout(connection.disconnectedTimer);
      connection.disconnectedTimer = null;
      if (video.videoWidth && !video.paused) {
        setStatus('即時連線', true);
        message('影像已連線。');
      } else setStatus('等待影像…');
    } else if (pc.connectionState === 'failed') {
      fail(connection, '影像連線失敗。請檢查 MediaMTX 的對外 IP、UDP 8189 連接埠，或 TURN 設定。');
    } else if (pc.connectionState === 'disconnected') {
      setStatus('連線中斷…');
      message('正在等待網路恢復…');
      connection.disconnectedTimer ??= setTimeout(() => fail(connection, '連線已中斷，請重新連接。'), 10000);
    }
  };
  try {
    await pc.setLocalDescription(await pc.createOffer());
    await waitForIce(pc, controller.signal);
    const response = await fetch(endpoint.href, {
      method: 'POST', headers: { 'Content-Type': 'application/sdp' },
      body: pc.localDescription.sdp, signal: controller.signal, mode: 'cors', credentials: 'omit',
    });
    if (response.status !== 201) throw new Error(`串流服務回應 HTTP ${response.status}。請確認 /cam/whep 路徑、相機來源與服務設定。`);
    const locationHeader = response.headers.get('Location');
    const sessionUrl = locationHeader ? new URL(locationHeader, response.url) : null;
    if (sessionUrl && sessionUrl.origin !== endpoint.origin) throw new Error('串流服務回傳了不同來源的工作階段網址，請檢查反向代理設定。');
    if (active !== connection) { void removeSession(sessionUrl?.href); return; }
    connection.sessionUrl = sessionUrl?.href;
    await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() });
    message('已完成協商，正在等待相機影像…');
  } catch (error) {
    if (error.name === 'AbortError') return;
    fail(connection, error instanceof TypeError ? '無法連線。請確認本機串流服務已啟動；若瀏覽器詢問「本機／區域網路存取」，請允許此網站存取。也請檢查網址與 CORS 設定。' : error.message);
  }
});

video.addEventListener('playing', () => {
  if (!active) return;
  clearTimeout(active.timeout);
  clearTimeout(active.disconnectedTimer);
  active.disconnectedTimer = null;
  $('placeholder').hidden = true;
  setStatus('即時連線', true);
  message('影像已連線。');
});
video.addEventListener('resize', () => {
  if (video.videoWidth) $('resolution').textContent = `${video.videoWidth} × ${video.videoHeight} / WebRTC`;
});
$('disconnect').addEventListener('click', () => { stop(); message('已中斷連線。'); });
$('fullscreen').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if ($('screen').requestFullscreen) await $('screen').requestFullscreen();
    else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
    else message('此瀏覽器不支援全螢幕，請使用瀏覽器的全螢幕功能。');
  } catch { message('無法進入全螢幕，請確認瀏覽器權限。', true); }
});
$('snapshot').addEventListener('click', () => {
  if (!video.videoWidth || !active) return;
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `camera-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    message('已儲存目前畫面。');
  }, 'image/png');
});
window.addEventListener('pagehide', stop);
