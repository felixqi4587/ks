(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BattleUpdate = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var BUILD_CHECK_TIMEOUT_MS = 10_000;
  var BUILD_CHECK_INTERVAL_MS = 60_000;
  var PENDING_FLUSH_INTERVAL_MS = 1_000;
  var BUILD_QUERY_KEYS = ["__kvk_build", "__rally_build", "__defense_build"];

  function safeBuild(value) {
    return Number.isSafeInteger(value) && value > 0;
  }

  function createSurface(config) {
    config = config && typeof config === "object" ? config : {};
    var build = config.build;
    var minBuildKey = String(config.minBuildKey || "");
    var legacyMinBuildKey = String(config.legacyMinBuildKey || "");
    var queryKey = String(config.queryKey || "");
    if (!safeBuild(build) || !/^min[A-Z][A-Za-z0-9]*Build$/.test(minBuildKey) ||
        !/^__[a-z]+_build$/.test(queryKey)) {
      throw new TypeError("Invalid battle update surface configuration");
    }

    function minimumBuild(meta) {
      try {
        if (Object.prototype.hasOwnProperty.call(meta, minBuildKey)) {
          return safeBuild(meta[minBuildKey]) ? meta[minBuildKey] : 0;
        }
        if (legacyMinBuildKey && safeBuild(meta[legacyMinBuildKey])) return meta[legacyMinBuildKey];
      } catch (error) {}
      return 0;
    }

    function validMetadata(meta) {
      try {
        var minimum = minimumBuild(meta);
        return !!meta && typeof meta === "object" && safeBuild(meta.currentBuild) &&
          safeBuild(minimum) && minimum <= meta.currentBuild;
      } catch (error) {
        return false;
      }
    }

    function shouldReload(meta) {
      return validMetadata(meta) && build < minimumBuild(meta);
    }

    function reloadURL(href, minimum) {
      var url = new URL(href);
      BUILD_QUERY_KEYS.forEach(function (key) { url.searchParams.delete(key); });
      url.searchParams.set(queryKey, String(minimum));
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
            pendingBuild = minimumBuild(meta);
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
            options.setIntervalFn(checkWhenVisible, BUILD_CHECK_INTERVAL_MS);
            options.setIntervalFn(flush, PENDING_FLUSH_INTERVAL_MS);
          }
        } catch (error) {}
        check();
        return true;
      }

      return Object.freeze({ check: check, flush: flush, start: start });
    }

    return Object.freeze({
      BUILD: build,
      MIN_BUILD_KEY: minBuildKey,
      QUERY_KEY: queryKey,
      shouldReload: shouldReload,
      reloadURL: reloadURL,
      createController: createController
    });
  }

  return Object.freeze({ createSurface: createSurface });
}));
