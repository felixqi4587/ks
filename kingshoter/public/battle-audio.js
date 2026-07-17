(function (root, factory) {
  var api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BattleAudio = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  var STALL_CONFIRM_MS = 80;
  var PAUSE_RECOVERY_MS = 250;
  var BEEP_HZ = 740;
  var SFX_LANGUAGES = ["zh", "en"];
  var SFX_NAMES = ["5", "4", "3", "2", "1", "go"];

  function createAudioEngine(options, injectedRuntime) {
    options = options || {};
    var runtime = injectedRuntime || root;
    var doc = runtime.document || {};
    var nav = runtime.navigator || {};
    var setTimer = runtime.setTimeout || root.setTimeout;
    var clearTimer = runtime.clearTimeout || root.clearTimeout;
    var AudioCtor = runtime.Audio || root.Audio;
    var ContextCtor = runtime.AudioContext || runtime.webkitAudioContext || root.AudioContext || root.webkitAudioContext;
    var language = typeof options.language === "function" ? options.language : function () { return "en"; };
    var onStateChange = typeof options.onStateChange === "function" ? options.onStateChange : function () {};
    var mediaTitle = String(options.mediaTitle || "Kingshoter alerts on");
    var userAgent = String(nav.userAgent || "");
    var isIOS = /iP(hone|od|ad)/.test(userAgent) || (nav.platform === "MacIntel" && Number(nav.maxTouchPoints || 0) > 1);
    var isAndroid = /android/i.test(userAgent);

    var context = null;
    var carrier = null;
    var carrierAlive = false;
    var userEnabled = false;
    var stallTimer = 0;
    var recoveryTimer = 0;
    var wakeLock = null;
    var wakeRequest = null;
    var sfxStarted = false;
    var sfxBuffers = { zh: {}, en: {} };
    var listeners = [];
    var liveNodes = [];
    var lastNotifiedSignature = "";
    var disposed = false;

    function assertActive() {
      if (disposed) throw new Error("audio engine disposed");
    }

    function state() {
      return Object.freeze({
        userEnabled: disposed ? false : userEnabled,
        audioContextRunning: !!(!disposed && context && context.state === "running"),
        carrierAlive: !!(!disposed && carrierAlive && carrier && carrier.paused === false && !carrier.ended)
      });
    }

    function notify() {
      if (disposed) return;
      var next = state();
      var signature = [next.userEnabled, next.audioContextRunning, next.carrierAlive].join(":");
      if (signature === lastNotifiedSignature) return;
      lastNotifiedSignature = signature;
      onStateChange(next);
    }

    function setCarrierAlive(value) {
      if (disposed) return;
      var next = !!(value && carrier && carrier.paused === false && !carrier.ended);
      if (next === carrierAlive) return;
      carrierAlive = next;
      notify();
    }

    function ensure() {
      assertActive();
      if (!context) {
        if (typeof ContextCtor !== "function") return null;
        context = new ContextCtor();
        context.onstatechange = function () {
          if (disposed) return;
          if (context.state !== "running") {
            try { context.resume(); } catch (error) {}
          }
          notify();
        };
      }
      if (context.state !== "running") {
        try {
          var resumed = context.resume();
          if (resumed && typeof resumed.catch === "function") resumed.catch(function () {});
        } catch (error) {}
      }
      try { if (nav.audioSession && nav.audioSession.type !== "playback") nav.audioSession.type = "playback"; } catch (error) {}
      notify();
      return context;
    }

    function binaryBase64(value) {
      if (typeof runtime.btoa === "function") return runtime.btoa(value);
      if (typeof root.btoa === "function") return root.btoa(value);
      throw new Error("btoa is unavailable");
    }

    function bedURI(amplitude) {
      var sampleRate = 8000;
      var count = sampleRate;
      var samples = new Int16Array(count);
      var index;
      for (index = 0; index < count; index += 1) {
        samples[index] = Math.sin(index / sampleRate * 2 * Math.PI * 40) * amplitude * 32767;
      }
      var buffer = new ArrayBuffer(44 + count * 2);
      var view = new DataView(buffer);
      var offset = 0;
      function string(value) { for (var i = 0; i < value.length; i += 1) view.setUint8(offset++, value.charCodeAt(i)); }
      function u32(value) { view.setUint32(offset, value, true); offset += 4; }
      function u16(value) { view.setUint16(offset, value, true); offset += 2; }
      string("RIFF"); u32(36 + count * 2); string("WAVE"); string("fmt "); u32(16); u16(1); u16(1);
      u32(sampleRate); u32(sampleRate * 2); u16(2); u16(16); string("data"); u32(count * 2);
      for (index = 0; index < count; index += 1) { view.setInt16(offset, samples[index], true); offset += 2; }
      var bytes = new Uint8Array(buffer);
      var binary = "";
      for (index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
      return "data:audio/wav;base64," + binaryBase64(binary);
    }

    function carrierVolume() {
      if (!doc.hidden) return 0;
      return isIOS ? 0.04 : (isAndroid ? 1 : 0.3);
    }

    function syncCarrierVolume() {
      try { if (carrier) carrier.volume = carrierVolume(); } catch (error) {}
    }

    function cancelStallTimer() {
      if (stallTimer) clearTimer(stallTimer);
      stallTimer = 0;
    }

    function carrierPlaying() {
      cancelStallTimer();
      setCarrierAlive(true);
    }

    function carrierStopped() {
      cancelStallTimer();
      setCarrierAlive(false);
    }

    function confirmCarrierLoss() {
      if (stallTimer || disposed) return;
      stallTimer = setTimer(function () {
        stallTimer = 0;
        if (!carrier || carrier.paused || carrier.ended || carrier.error || Number(carrier.readyState || 0) < 3) {
          setCarrierAlive(false);
        }
      }, STALL_CONFIRM_MS);
    }

    function listen(target, eventName, handler) {
      target.addEventListener(eventName, handler);
      listeners.push([target, eventName, handler]);
    }

    function mediaSessionSetup() {
      if (!("mediaSession" in nav) || !nav.mediaSession) return;
      try {
        var Metadata = runtime.MediaMetadata || root.MediaMetadata;
        if (typeof Metadata === "function") nav.mediaSession.metadata = new Metadata({ title: mediaTitle, artist: "kingshoter" });
        nav.mediaSession.setActionHandler("play", resume);
        nav.mediaSession.setActionHandler("pause", function () {});
      } catch (error) {}
    }

    function startCarrier() {
      assertActive();
      ensure();
      if (typeof AudioCtor !== "function") return null;
      if (!carrier) {
        carrier = new AudioCtor();
        carrier.src = bedURI(isIOS ? 0.002 : 0.05);
        carrier.loop = true;
        carrier.volume = carrierVolume();
        carrier.preload = "auto";
        if (typeof carrier.setAttribute === "function") carrier.setAttribute("playsinline", "");
        listen(carrier, "playing", carrierPlaying);
        listen(carrier, "pause", function () {
          carrierStopped();
          if (userEnabled && !disposed) {
            if (recoveryTimer) clearTimer(recoveryTimer);
            recoveryTimer = setTimer(function () { recoveryTimer = 0; resume(); }, PAUSE_RECOVERY_MS);
          }
        });
        listen(carrier, "error", carrierStopped);
        listen(carrier, "ended", carrierStopped);
        listen(carrier, "waiting", confirmCarrierLoss);
        listen(carrier, "stalled", confirmCarrierLoss);
      }
      try {
        var playing = carrier.play();
        if (playing && typeof playing.then === "function") playing.then(carrierPlaying).catch(carrierStopped);
        else if (carrier.paused) carrierStopped(); else carrierPlaying();
      } catch (error) { carrierStopped(); }
      mediaSessionSetup();
      return carrier;
    }

    function resume() {
      assertActive();
      ensure();
      if (!carrier && userEnabled) return startCarrier();
      try {
        if (carrier) {
          syncCarrierVolume();
          if (carrier.paused || !carrierAlive) {
            var playing = carrier.play();
            if (playing && typeof playing.then === "function") playing.then(carrierPlaying).catch(carrierStopped);
            else setCarrierAlive(!carrier.paused);
          }
        }
      } catch (error) { setCarrierAlive(false); }
      notify();
      return context;
    }

    function loadSfx() {
      assertActive();
      if (sfxStarted || !context) return;
      sfxStarted = true;
      var fetcher = runtime.fetch || root.fetch;
      if (typeof fetcher !== "function") return;
      SFX_LANGUAGES.forEach(function (lang) {
        SFX_NAMES.forEach(function (name) {
          var url = "/sfx/" + lang + "_" + name + ".mp3";
          Promise.resolve(fetcher(url)).then(function (response) { return response.arrayBuffer(); })
            .then(function (arrayBuffer) { return context.decodeAudioData(arrayBuffer); })
            .then(function (buffer) { if (!disposed) sfxBuffers[lang][name] = buffer; })
            .catch(function () {});
        });
      });
    }

    function forget(node) {
      var index = liveNodes.indexOf(node);
      if (index >= 0) liveNodes.splice(index, 1);
    }

    function disconnect(node) {
      try { node.o.disconnect(); } catch (error) {}
      try { node.g.disconnect(); } catch (error) {}
    }

    function remember(node) {
      liveNodes.push(node);
      var previousEnded = node.o.onended;
      node.o.onended = function (event) {
        forget(node);
        disconnect(node);
        if (typeof previousEnded === "function") previousEnded.call(node.o, event);
      };
      return node;
    }

    function createTone(when, frequency, duration, volume) {
      var oscillator = context.createOscillator();
      var gain = context.createGain();
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(volume, when + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
      oscillator.start(when);
      oscillator.stop(when + duration + 0.03);
      return remember({ o: oscillator, g: gain });
    }

    function tone(when, frequency, duration, volume) {
      assertActive();
      ensure();
      if (!context || context.state !== "running") return null;
      return createTone(when, frequency, duration, volume);
    }

    function clip(when, buffer, volume) {
      assertActive();
      ensure();
      if (!context || context.state !== "running" || !buffer) return null;
      var source = context.createBufferSource();
      var gain = context.createGain();
      source.buffer = buffer;
      source.connect(gain);
      gain.connect(context.destination);
      gain.gain.setValueAtTime(volume, when);
      source.start(when);
      return remember({ o: source, g: gain });
    }

    function normalizeLanguage(value) {
      value = String(value || language() || "en").toLowerCase();
      return value.indexOf("zh") === 0 ? "zh" : "en";
    }

    function compact(nodes) { return nodes.filter(function (node) { return !!node; }); }

    function schedule(event, when) {
      assertActive();
      var firstNewNode = liveNodes.length;
      try {
        event = event || {};
        var kind = String(event.kind || "");
        var lang = normalizeLanguage(event.language);
        var name = event.name == null ? "" : String(event.name);
        if (kind === "tick" || kind === "beep") {
          return compact([tone(when, Number(event.frequency) || BEEP_HZ,
            Number(event.duration) || 0.12, Number(event.volume) || 0.5)]);
        }
        if (kind === "countdown" || (kind === "clip" && name !== "go")) {
          var countBuffer = sfxBuffers[lang][name];
          return countBuffer ? compact([clip(when, countBuffer, 0.95)]) : compact([tone(when, BEEP_HZ, 0.13, 0.55)]);
        }
        if (kind === "go" || (kind === "clip" && name === "go")) {
          var goBuffer = sfxBuffers[lang].go;
          return goBuffer ? compact([
            clip(when, goBuffer, 1),
            tone(when, 1320, 0.4, 0.3),
            tone(when, 1760, 0.4, 0.2)
          ]) : compact([
            tone(when, 1320, 0.5, 0.7),
            tone(when, 1760, 0.5, 0.5)
          ]);
        }
        if (kind === "prepare") {
          return compact([
            tone(when, 587, 0.14, 0.5),
            tone(when + 0.18, 784, 0.18, 0.58)
          ]);
        }
        if (kind === "tone") {
          return compact([tone(when, Number(event.frequency) || BEEP_HZ,
            Number(event.duration) || 0.12, Number(event.volume) || 0.5)]);
        }
        throw new TypeError("unsupported cue kind: " + kind);
      } catch (error) {
        cancel(liveNodes.slice(firstNewNode));
        throw error;
      }
    }

    function cancel(nodes) {
      (nodes || []).forEach(function (node) {
        try {
          node.g.gain.cancelScheduledValues(0);
          node.g.gain.setValueAtTime(0.0001, 0);
          node.o.stop(0);
          node.o.disconnect();
          node.g.disconnect();
        } catch (error) {}
        forget(node);
      });
    }

    function playConfirm() {
      var when = ensure() && context.currentTime;
      if (!Number.isFinite(when)) return [];
      return compact([createTone(when, 880, 0.12, 0.55), createTone(when + 0.15, 1175, 0.14, 0.55)]);
    }

    function playCancelled() {
      var when = ensure() && context.currentTime;
      if (!Number.isFinite(when)) return [];
      return compact([createTone(when, 740, 0.16, 0.5), createTone(when + 0.2, 494, 0.3, 0.5)]);
    }

    function playFire() {
      var when = ensure() && context.currentTime;
      if (!Number.isFinite(when) || context.state !== "running") return [];
      var oscillator = context.createOscillator();
      var gain = context.createGain();
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.type = "sine";
      oscillator.frequency.value = 880;
      gain.gain.setValueAtTime(0.001, when);
      gain.gain.exponentialRampToValueAtTime(0.4, when + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, when + 0.5);
      oscillator.start(when);
      oscillator.stop(when + 0.5);
      return [remember({ o: oscillator, g: gain })];
    }

    function requestWakeLock() {
      assertActive();
      if (doc.visibilityState !== "visible" || !nav.wakeLock || wakeLock) return Promise.resolve(wakeLock);
      if (wakeRequest) return wakeRequest;
      wakeRequest = Promise.resolve(nav.wakeLock.request("screen")).then(function (lock) {
        wakeRequest = null;
        if (disposed) {
          try { if (lock && typeof lock.release === "function") lock.release(); } catch (error) {}
          return null;
        }
        wakeLock = lock;
        if (lock && typeof lock.addEventListener === "function") {
          lock.addEventListener("release", function () { if (wakeLock === lock) wakeLock = null; });
        }
        return lock;
      }, function () { wakeRequest = null; return null; });
      return wakeRequest;
    }

    function enable() {
      assertActive();
      if (!userEnabled) { userEnabled = true; notify(); }
      ensure();
      loadSfx();
      startCarrier();
      requestWakeLock();
      return state();
    }

    function dispose() {
      if (disposed) return;
      if (stallTimer) clearTimer(stallTimer);
      if (recoveryTimer) clearTimer(recoveryTimer);
      stallTimer = 0;
      recoveryTimer = 0;
      liveNodes.slice().forEach(function (node) { cancel([node]); });
      listeners.forEach(function (item) {
        try { if (typeof item[0].removeEventListener === "function") item[0].removeEventListener(item[1], item[2]); } catch (error) {}
      });
      listeners = [];
      try { if (carrier && typeof carrier.pause === "function") carrier.pause(); } catch (error) {}
      try { if (wakeLock && typeof wakeLock.release === "function") wakeLock.release(); } catch (error) {}
      try { if (context) { context.onstatechange = null; if (typeof context.close === "function") context.close(); } } catch (error) {}
      carrierAlive = false;
      userEnabled = false;
      wakeLock = null;
      wakeRequest = null;
      disposed = true;
    }

    return Object.freeze({
      enable: enable,
      ensure: ensure,
      startCarrier: startCarrier,
      resume: resume,
      loadSfx: loadSfx,
      syncCarrierVolume: syncCarrierVolume,
      requestWakeLock: requestWakeLock,
      state: state,
      context: function () { return disposed ? null : context; },
      carrier: function () { return disposed ? null : carrier; },
      nowSeconds: function () { return context ? Number(context.currentTime) || 0 : 0; },
      tone: tone,
      clip: clip,
      schedule: schedule,
      cancel: cancel,
      playConfirm: playConfirm,
      playCancelled: playCancelled,
      playFire: playFire,
      dispose: dispose
    });
  }

  return Object.freeze({ createAudioEngine: createAudioEngine });
}));
