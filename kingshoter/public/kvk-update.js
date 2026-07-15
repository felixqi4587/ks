(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KvkUpdate = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var BUILD = 2026071302;
  var BUILD_CHECK_TIMEOUT_MS = 10_000;

  function safeBuild(value) {
    return Number.isSafeInteger(value) && value > 0;
  }

  function validMetadata(meta) {
    try {
      return !!meta && typeof meta === "object" &&
        safeBuild(meta.currentBuild) && safeBuild(meta.minKvkBuild) &&
        meta.minKvkBuild <= meta.currentBuild;
    } catch (error) {
      return false;
    }
  }

  function shouldReload(meta) {
    return validMetadata(meta) && BUILD < meta.minKvkBuild;
  }

  function reloadURL(href, build) {
    var url = new URL(href);
    url.searchParams.set("__kvk_build", String(build));
    return url.toString();
  }

  function createController(options) {
    options = options && typeof options === "object" ? options : {};
    var pendingBuild = 0;
    var inFlight = null;
    var replacing = false;
    var started = false;
    var doc = options.document || null;
    var gate = null;

    try {
      if (doc && typeof doc.getElementById === "function") gate = doc.getElementById("updateGate");
    } catch (error) {}

    function hideGate() {
      try { if (gate) gate.hidden = true; } catch (error) {}
    }

    function flush() {
      if (!pendingBuild || replacing) return false;
      try {
        if (typeof options.hasActivePersonalCommand !== "function" ||
            options.hasActivePersonalCommand() !== false) return false;
        if (!options.location || typeof options.location.replace !== "function") return false;
        var target = reloadURL(options.location.href, pendingBuild);
        replacing = true;
        if (gate) gate.hidden = false;
        options.location.replace(target);
        return true;
      } catch (error) {
        replacing = false;
        hideGate();
        return false;
      }
    }

    function requestBuild() {
      var request = Promise.resolve().then(function () {
        return options.fetcher("/api/build", { cache: "no-store" });
      }).then(function (response) {
        if (!response || response.ok !== true || typeof response.json !== "function") return null;
        return response.json();
      });
      var schedule = typeof options.setTimeoutFn === "function" ? options.setTimeoutFn :
        (typeof setTimeout === "function" ? setTimeout : null);
      var cancel = typeof options.clearTimeoutFn === "function" ? options.clearTimeoutFn :
        (typeof clearTimeout === "function" ? clearTimeout : null);
      if (!schedule) return request;
      return new Promise(function (resolve, reject) {
        var settled = false;
        var timer = null;
        try {
          timer = schedule(function () {
            if (settled) return;
            settled = true;
            reject(new Error("build_check_timeout"));
          }, BUILD_CHECK_TIMEOUT_MS);
        } catch (error) {
          return request.then(resolve, reject);
        }
        request.then(function (response) {
          if (settled) return;
          settled = true;
          try { if (cancel && timer !== null) cancel(timer); } catch (error) {}
          resolve(response);
        }, function (error) {
          if (settled) return;
          settled = true;
          try { if (cancel && timer !== null) cancel(timer); } catch (cancelError) {}
          reject(error);
        });
      });
    }

    function check() {
      if (replacing) return Promise.resolve(false);
      if (inFlight) return inFlight;
      var task = (async function () {
        try {
          if (typeof options.fetcher !== "function") return false;
          var meta = await requestBuild();
          if (!validMetadata(meta)) return false;
          if (!shouldReload(meta)) {
            pendingBuild = 0;
            hideGate();
            return false;
          }
          pendingBuild = meta.minKvkBuild;
          return flush();
        } catch (error) {
          return false;
        }
      }());
      inFlight = task;
      task.then(function () {
        if (inFlight === task) inFlight = null;
      }, function () {
        if (inFlight === task) inFlight = null;
      });
      return task;
    }

    function checkWhenVisible() {
      try {
        if (!doc || doc.hidden !== true) check();
      } catch (error) {}
    }

    function start() {
      if (started) return false;
      started = true;
      try {
        if (doc && typeof doc.addEventListener === "function") {
          doc.addEventListener("visibilitychange", checkWhenVisible);
        }
      } catch (error) {}
      try {
        if (typeof options.setIntervalFn === "function") {
          options.setIntervalFn(checkWhenVisible, 60_000);
        }
      } catch (error) {}
      check();
      return true;
    }

    return { check: check, flush: flush, start: start };
  }

  return {
    BUILD: BUILD,
    shouldReload: shouldReload,
    reloadURL: reloadURL,
    createController: createController
  };
}));
