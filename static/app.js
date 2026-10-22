const $ = (id) => document.getElementById(id);

const els = {
  status: $("statusText"),
  dot: $("dot"),
  device: $("deviceChip"),
  transcript: $("transcript"),
  hint: $("hint"),
  committed: $("committed"),
  partial: $("partial"),
  caret: $("caret"),
  words: $("words"),
  chars: $("chars"),
  timer: $("timer"),
  latency: $("latency"),
  mic: $("mic"),
  micLabel: $("micLabel"),
  meter: $("meter"),
  autoType: $("autoType"),
  autotypeNote: $("autotypeNote"),
  copyBtn: $("copyBtn"),
  downloadBtn: $("downloadBtn"),
  clearBtn: $("clearBtn"),
  toast: $("toast"),
  fullscreenBtn: $("fullscreenBtn"), contrastBtn: $("contrastBtn"),
  inputSelect: $("inputSelect"), gainRange: $("gainRange"), gainValue: $("gainValue"),
  inputMeter: $("inputMeterFill"), micFeedback: $("micFeedback"),
  pauseBtn: $("pauseBtn"), undoBtn: $("undoBtn"), editBtn: $("editBtn"),
  fontDownBtn: $("fontDownBtn"), fontUpBtn: $("fontUpBtn"), boardMicBtn: $("boardMicBtn"),
  serverUrl: $("serverUrl"), serverSaveBtn: $("serverSaveBtn"),
};

let ws = null;
let wsReady = false;
let recording = false;
let audioCtx = null;
let mediaStream = null;
let workletNode = null;
let scriptProcessor = null;
let legacyResamplePos = 0;
let legacyPrevSample = 0;
let legacyPacket = new Float32Array(1024);
let legacyPacketLength = 0;
let startedAt = 0;
let timerInt = null;
let lastSendAt = 0;
let autoTypeEnabled = false;
let committedParts = [];
let latencySamples = [];
let paused = false;
let inputGain = 1;
let gainNode = null;
let analyser = null;
let meterFrame = null;
let boardFontScale = 1;
const pendingFlushes = [];
const SERVER_URL_KEY = "dikte-server-url";
let serverBase = (localStorage.getItem(SERVER_URL_KEY) || window.DIKTE_SERVER_URL || location.origin).replace(/\/$/, "");

const bars = Array.from(els.meter.querySelectorAll("i"));

// ------------------------------------------------------------ yardımcılar

function toast(msg, ms = 2200) {
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.remove("show"), ms);
}

function setStatus(text, kind = "") {
  els.status.textContent = text;
  els.dot.className = "dot " + kind;
}

function joinText(prev, next) {
  if (!prev) return next;
  if (!next) return prev;
  const needSpace = !/[\s\n(«"'[]$/.test(prev) && !/^[.,;:!?)\]»"']/.test(next);
  return prev + (needSpace ? " " : "") + next;
}

function fullText() {
  let t = "";
  for (const p of committedParts) t = joinText(t, p);
  return t;
}

function render() {
  const text = fullText();
  els.committed.textContent = text;
  const partial = els.partial.textContent;
  const all = partial ? joinText(text, partial) : text;
  const words = all.trim() ? all.trim().split(/\s+/).length : 0;
  els.words.textContent = words;
  els.chars.textContent = all.length;
  els.hint.style.display = all ? "none" : "inline";
  els.transcript.scrollTop = els.transcript.scrollHeight;
  els.undoBtn.disabled = committedParts.length === 0;
  els.editBtn.disabled = committedParts.length === 0;
}

function fmt(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

function tick() {
  if (!recording) return;
  els.timer.textContent = fmt((Date.now() - startedAt) / 1000);
}

function meterFrom(rms) {
  // rms 0..~0.3 -> görsel 0..1
  const level = Math.min(1, Math.sqrt(rms * 9));
  bars.forEach((bar, i) => {
    const center = 1 - Math.abs(i - (bars.length - 1) / 2) / bars.length;
    const h = 8 + level * center * 92 * (0.65 + Math.random() * 0.55);
    bar.style.height = Math.min(100, h) + "%";
  });
}

function meterIdle() {
  bars.forEach((bar) => (bar.style.height = "8%"));
}

// ------------------------------------------------------------ websocket

function connect() {
  const endpoint = new URL(serverBase || location.origin);
  const proto = endpoint.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${endpoint.host}${endpoint.pathname.replace(/\/$/, "")}/ws`);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    wsReady = true;
    setStatus("hazır", "ok");
    els.device.textContent = "yerel model";
  };

  ws.onclose = () => {
    wsReady = false;
    setStatus(serverBase === location.origin ? "sunucu adresi gerekli" : "yeniden bağlanıyor…", "err");
    setTimeout(connect, 1200);
  };

  ws.onerror = () => setStatus("bağlantı hatası", "err");

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "hello") {
      setStatus("hazır", "ok");
      els.device.textContent = msg.device || "yerel model";
      autoTypeEnabled = !!msg.autotype;
      els.autoType.checked = autoTypeEnabled;
      els.autoType.disabled = !msg.autotype_available;
      els.autotypeNote.textContent = msg.autotype_available
        ? `Arka uç: ${msg.autotype_backend}. Metin, imlecin bulunduğu uygulamaya yazılır. Bu sayfa odaktayken panoya kopyalar.`
        : "Otomatik yazma aracı bulunamadı (ydotool / xdotool / wtype).";
      els.pauseBtn.disabled = false;
    } else if (msg.type === "partial") {
      els.partial.textContent = msg.text || "";
      if (msg.text && msg.ms) els.latency.textContent = `gecikme ~${(msg.ms / 1000).toFixed(1)} sn`;
      else if (msg.text) {
        const dt = performance.now() - lastSendAt;
        if (dt > 0 && dt < 3000) {
          latencySamples.push(dt);
          if (latencySamples.length > 8) latencySamples.shift();
          const avg = latencySamples.reduce((a, b) => a + b, 0) / latencySamples.length;
          els.latency.textContent = `gecikme ~${Math.round(avg)} ms`;
        }
      }
      render();
    } else if (msg.type === "commit") {
      if (!paused) {
        committedParts.push(msg.text);
      }
      els.partial.textContent = "";
      els.latency.textContent = `son cümle ${msg.dur}s`;
      render();
    } else if (msg.type === "paused") {
      paused = !!msg.value;
      els.pauseBtn.textContent = paused ? "Altyazıya devam et" : "Altyazıyı duraklat";
      toast(paused ? "Altyazı duraklatıldı" : "Altyazı devam ediyor");
    } else if (msg.type === "flushed") {
      pendingFlushes.splice(0).forEach((resolve) => resolve());
    } else if (msg.type === "hotkey") {
      toggle();
    } else if (msg.type === "settings") {
      autoTypeEnabled = !!msg.autotype;
      els.autoType.checked = autoTypeEnabled;
    }
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function saveServerUrl() {
  const value = els.serverUrl.value.trim().replace(/\/$/, "");
  if (!value) return toast("Sunucu adresini girin.");
  let parsed;
  try { parsed = new URL(value); } catch { return toast("Geçerli bir sunucu adresi girin."); }
  if (!/^https?:$/.test(parsed.protocol)) return toast("Adres http:// veya https:// ile başlamalı.");
  if (location.protocol === "https:" && parsed.protocol !== "https:") {
    return toast("Güvenli sayfadan bağlantı için sunucu HTTPS kullanmalı.", 4500);
  }
  serverBase = value;
  localStorage.setItem(SERVER_URL_KEY, serverBase);
  if (ws) ws.close();
  connect();
  toast("Sunucu adresi kaydedildi; bağlanılıyor.");
}

// ------------------------------------------------------------ ses

async function start() {
  if (recording) return;
  if (!wsReady) {
    toast("Önce çalışan transkripsiyon sunucusunun adresini girip bağlanın.", 4000);
    return;
  }
  try {
    mediaStream = await requestUserMedia({
      audio: {
        deviceId: els.inputSelect.value ? { exact: els.inputSelect.value } : undefined,
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (err) {
    mediaStream?.getTracks().forEach((track) => track.stop());
    mediaStream = null;
    setStatus("mikrofon yok", "err");
    toast(err?.name === "OverconstrainedError"
      ? "Seçilen mikrofon açılamadı. Başka bir giriş aygıtı seçin."
      : "Mikrofona erişilemedi. Tarayıcı izinlerini kontrol et.");
    return;
  }

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    mediaStream?.getTracks().forEach((track) => track.stop());
    mediaStream = null;
    toast("Bu tarayıcı ses işleme özelliğini desteklemiyor.", 4000);
    return;
  }
  try { audioCtx = new AudioContextClass({ sampleRate: 16000 }); }
  catch { audioCtx = new AudioContextClass(); }
  if (audioCtx.state === "suspended") await audioCtx.resume();
  const src = audioCtx.createMediaStreamSource(mediaStream);
  gainNode = audioCtx.createGain();
  gainNode.gain.value = inputGain;
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  const sendAudioPacket = (data) => {
    if (!recording) return;
    let peak = 0;
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
    const safeScale = peak > 0.98 ? 0.98 / peak : 1;
    const output = safeScale === 1 ? data : data.map((sample) => sample * safeScale);
    let sum = 0;
    for (let i = 0; i < output.length; i++) sum += output[i] * output[i];
    meterFrom(Math.sqrt(sum / output.length));
    lastSendAt = performance.now();
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(output.buffer);
  };
  const mute = audioCtx.createGain();
  mute.gain.value = 0;
  src.connect(gainNode);
  gainNode.connect(analyser);
  if (audioCtx.audioWorklet && typeof AudioWorkletNode !== "undefined") {
    try {
      await audioCtx.audioWorklet.addModule("/static/pcm-worklet.js");
      workletNode = new AudioWorkletNode(audioCtx, "pcm-worklet");
      workletNode.port.onmessage = (ev) => sendAudioPacket(ev.data);
      gainNode.connect(workletNode);
      workletNode.connect(mute);
    } catch {
      workletNode = null;
    }
  }
  if (!workletNode) {
    if (!audioCtx.createScriptProcessor) throw new Error("Bu tarayıcı ses işleme özelliğini desteklemiyor.");
    scriptProcessor = audioCtx.createScriptProcessor(4096, 1, 1);
    scriptProcessor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const ratio = audioCtx.sampleRate / 16000;
      for (let i = 0; i < input.length; i++) {
        const next = input[i];
        while (legacyResamplePos < 1) {
          const value = legacyPrevSample + (next - legacyPrevSample) * legacyResamplePos;
          legacyPacket[legacyPacketLength++] = value;
          if (legacyPacketLength === legacyPacket.length) {
            sendAudioPacket(legacyPacket);
            legacyPacket = new Float32Array(1024);
            legacyPacketLength = 0;
          }
          legacyResamplePos += ratio;
        }
        legacyResamplePos -= 1;
        legacyPrevSample = next;
      }
    };
    gainNode.connect(scriptProcessor);
    scriptProcessor.connect(mute);
  }
  mute.connect(audioCtx.destination); // grafiğin canlı kalması için sessiz çıkış
  updateMicFeedback();

  recording = true;
  startedAt = Date.now();
  timerInt = setInterval(tick, 250);
  document.body.classList.add("live");
  els.mic.classList.add("recording");
  els.micLabel.textContent = "Durdur";
  setStatus("dinliyorum", "rec");
  els.timer.textContent = "00:00";
  els.latency.textContent = "";
  latencySamples = [];
}

async function stop() {
  if (!recording) return;
  // Önce AudioWorklet'in son paketlerini WebSocket kuyruğuna koy, sonra yeni sesi kapat.
  if (audioCtx && audioCtx.state !== "closed") {
    await new Promise((resolve) => audioCtx.suspend().then(resolve, resolve));
  }
  recording = false;
  document.body.classList.remove("live");
  els.mic.classList.remove("recording");
  els.micLabel.textContent = "Başlat";
  setStatus(wsReady ? "hazır" : "bağlantı yok", wsReady ? "ok" : "err");
  clearInterval(timerInt);
  meterIdle();
  if (meterFrame) cancelAnimationFrame(meterFrame);
  els.micFeedback.textContent = "Mikrofon durduruldu.";

  try {
    const flushDone = new Promise((resolve) => pendingFlushes.push(resolve));
    send({ type: "flush" });
    await Promise.race([flushDone, new Promise((resolve) => setTimeout(resolve, 15000))]);
    workletNode?.disconnect();
    if (scriptProcessor) {
      scriptProcessor.disconnect();
      scriptProcessor.onaudioprocess = null;
    }
    await audioCtx?.close();
    mediaStream?.getTracks().forEach((t) => t.stop());
  } catch {}
  audioCtx = null;
  workletNode = null;
  scriptProcessor = null;
  gainNode = null;
  analyser = null;
  mediaStream = null;
  els.inputMeter.style.width = "0";
  setTimeout(() => (els.partial.textContent = ""), 2500);
}

function toggle() {
  recording ? stop() : start();
}

async function enumerateInputs() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const selected = els.inputSelect.value;
    els.inputSelect.innerHTML = '<option value="">Varsayılan mikrofon</option>';
    devices.filter((d) => d.kind === "audioinput").forEach((d, i) => {
      const option = document.createElement("option");
      option.value = d.deviceId;
      option.textContent = d.label || `Mikrofon ${i + 1}`;
      els.inputSelect.append(option);
    });
    if ([...els.inputSelect.options].some((o) => o.value === selected)) els.inputSelect.value = selected;
  } catch { /* izin verilmeden aygıt adları listelenmeyebilir */ }
}

function requestUserMedia(constraints) {
  if (navigator.mediaDevices?.getUserMedia) return navigator.mediaDevices.getUserMedia(constraints);
  const legacy = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
  if (legacy) return new Promise((resolve, reject) => legacy.call(navigator, constraints, resolve, reject));
  return Promise.reject(new Error("getUserMedia desteklenmiyor"));
}

async function revealInputNames() {
  let permissionStream;
  try {
    permissionStream = await requestUserMedia({ audio: true });
    await enumerateInputs();
  } catch {
    els.micFeedback.textContent = "Mikrofon izni kayıt başlatılırken istenir.";
    await enumerateInputs();
  } finally {
    permissionStream?.getTracks().forEach((track) => track.stop());
  }
}

function changeBoardFont(delta) {
  boardFontScale = Math.max(0.75, Math.min(1.8, boardFontScale + delta));
  document.documentElement.style.setProperty("--board-font-scale", boardFontScale);
}

function updateMicFeedback() {
  if (!analyser || !recording) return;
  const data = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(data);
  let sum = 0;
  for (const sample of data) sum += sample * sample;
  const rms = Math.sqrt(sum / data.length);
  const level = Math.min(100, Math.round(Math.sqrt(rms * 12) * 100));
  els.inputMeter.style.width = `${level}%`;
  els.inputMeter.parentElement.setAttribute("aria-valuenow", level);
  els.micFeedback.textContent = level < 3 ? "Sinyal düşük: mikrofonu veya ses girişini kontrol edin." : "Mikrofon sinyali alınıyor.";
  meterFrame = requestAnimationFrame(updateMicFeedback);
}

// ------------------------------------------------------------ eylemler

els.mic.addEventListener("click", toggle);
els.fullscreenBtn.addEventListener("click", async () => {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    else await document.exitFullscreen();
  } catch { toast("Tam ekran açılamadı. Tarayıcı izinlerini kontrol edin."); }
  document.body.classList.toggle("board-mode", !!document.fullscreenElement);
  els.fullscreenBtn.textContent = document.fullscreenElement ? "Tam ekrandan çık" : "Tam ekran";
});
document.addEventListener("fullscreenchange", () => {
  document.body.classList.toggle("board-mode", !!document.fullscreenElement);
  els.fullscreenBtn.textContent = document.fullscreenElement ? "Tam ekrandan çık" : "Tam ekran";
});
els.contrastBtn.addEventListener("click", () => {
  const enabled = document.body.classList.toggle("high-contrast");
  els.contrastBtn.setAttribute("aria-pressed", String(enabled));
  els.contrastBtn.textContent = enabled ? "Normal kontrast" : "Yüksek kontrast";
});
els.fontDownBtn.addEventListener("click", () => changeBoardFont(-0.1));
els.fontUpBtn.addEventListener("click", () => changeBoardFont(0.1));
els.boardMicBtn.addEventListener("click", toggle);
document.addEventListener("fullscreenchange", () => {
  els.boardMicBtn.textContent = recording ? "Durdur" : "Başlat";
});
els.inputSelect.addEventListener("change", async () => {
  if (recording) { await stop(); await start(); }
});
els.gainRange.addEventListener("input", () => {
  inputGain = Number(els.gainRange.value) / 100;
  els.gainValue.value = `${els.gainRange.value}%`;
  if (gainNode && audioCtx) gainNode.gain.setTargetAtTime(inputGain, audioCtx.currentTime, 0.03);
});
els.pauseBtn.addEventListener("click", () => send({ type: "pause_toggle" }));
els.undoBtn.addEventListener("click", () => {
  if (!committedParts.length) return;
  committedParts.pop();
  render();
  if (autoTypeEnabled) {
    autoTypeEnabled = false;
    els.autoType.checked = false;
    send({ type: "settings", autotype: false });
    toast("Son cümle kaldırıldı. Dış uygulamadaki metin otomatik silinemedi; otomatik yazma kapatıldı.", 5000);
  } else toast("Son cümle kaldırıldı");
  send({ type: "undo" });
});
els.editBtn.addEventListener("click", () => {
  if (!committedParts.length) return;
  const previous = committedParts[committedParts.length - 1];
  const corrected = window.prompt("Son cümleyi düzeltin:", previous);
  if (corrected === null) return;
  if (corrected.trim()) committedParts[committedParts.length - 1] = corrected.trim();
  else committedParts.pop();
  render();
  if (autoTypeEnabled) {
    autoTypeEnabled = false;
    els.autoType.checked = false;
    send({ type: "settings", autotype: false });
    toast("Düzeltme uygulandı. Dış uygulamadaki eski metin otomatik düzeltilemedi; otomatik yazma kapatıldı.", 5000);
  } else toast("Düzeltme uygulandı");
  send({ type: "correct", text: corrected || "" });
});

els.autoType.addEventListener("change", () => {
  autoTypeEnabled = els.autoType.checked;
  send({ type: "settings", autotype: autoTypeEnabled });
  toast(autoTypeEnabled ? "Otomatik yazma açık" : "Otomatik yazma kapalı");
});

els.copyBtn.addEventListener("click", async () => {
  const text = joinText(fullText(), els.partial.textContent);
  if (!text) return toast("Kopyalanacak metin yok");
  try {
    await navigator.clipboard.writeText(text);
    toast("Panoya kopyalandı");
  } catch {
    toast("Kopyalama izni yok");
  }
});

els.downloadBtn.addEventListener("click", () => {
  const text = joinText(fullText(), els.partial.textContent);
  if (!text) return toast("İndirilecek metin yok");
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
  const blob = new Blob([text + "\n"], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `dikte-${stamp}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
});

els.clearBtn.addEventListener("click", () => {
  committedParts = [];
  els.partial.textContent = "";
  els.hint.style.display = "inline";
  els.words.textContent = "0";
  els.chars.textContent = "0";
  els.timer.textContent = "00:00";
  els.latency.textContent = "";
  send({ type: "reset" });
});

document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName) || e.target.isContentEditable;
  if (e.code === "Space" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    toggle();
  } else if (e.key === "Escape" && recording) {
    stop();
  } else if (e.code === "KeyZ" && (e.ctrlKey || e.metaKey) && !typing) {
    e.preventDefault();
    els.undoBtn.click();
  } else if (e.code === "KeyC" && e.ctrlKey && e.shiftKey) {
    e.preventDefault();
    els.copyBtn.click();
  }
});

const needsRemoteServer = location.hostname.endsWith(".github.io") && !localStorage.getItem(SERVER_URL_KEY) && !window.DIKTE_SERVER_URL;
els.serverUrl.value = serverBase === location.origin ? "" : serverBase;
if (needsRemoteServer) setStatus("sunucu adresi gerekli", "err");
else connect();
els.serverSaveBtn.addEventListener("click", saveServerUrl);
revealInputNames();
navigator.mediaDevices?.addEventListener?.("devicechange", enumerateInputs);
render();
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN && !recording) send({ type: "ping" });
}, 20000);
