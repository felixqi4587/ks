(function (root, factory) {
  var api = factory(root.BattleUpdate);
  if (typeof module === "object" && module.exports) module.exports = api;
  else {
    root.DefenseUpdate = api;
    if (root.document) {
      var install = function () { api.install(root); };
      if (root.document.readyState === "loading") {
        root.document.addEventListener("DOMContentLoaded", install, { once: true });
      } else install();
    }
  }
}(typeof globalThis !== "undefined" ? globalThis : this, function (shared) {
  "use strict";
  var BUILD = 2026071701;
  if (!shared || typeof shared.createSurface !== "function") {
    return Object.freeze({ BUILD: BUILD, install: function () { return null; } });
  }
  var surface = shared.createSurface({
    build: BUILD,
    minBuildKey: "minDefenseBuild",
    legacyMinBuildKey: "minKvkBuild",
    queryKey: "__defense_build"
  });

  function hasActivePersonalCommand(win) {
    try {
      var room = new URL(win.location.href).searchParams.get("room") || "";
      room = room.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48);
      if (!room) return false;
      var mounted = win.__kingshoterDefenseMounted;
      if (!mounted || !mounted.controller || !mounted.connection ||
          typeof mounted.controller.state !== "function" ||
          typeof mounted.connection.serverNowMs !== "function") return true;
      var state = mounted.controller.state();
      var personal = state && state.personal;
      if (!personal || personal.captured !== true || personal.tooLate === true) return false;
      return Number(personal.goAtMs) > Number(mounted.connection.serverNowMs()) - 1_000;
    } catch (error) {
      return true;
    }
  }

  function install(win) {
    if (!win || win.__kingshoterDefenseUpdate) return win && win.__kingshoterDefenseUpdate || null;
    try {
      var controller = surface.createController({
        fetcher: win.fetch.bind(win),
        location: win.location,
        document: win.document,
        hasActivePersonalCommand: function () { return hasActivePersonalCommand(win); },
        setIntervalFn: win.setInterval.bind(win),
        setTimeoutFn: typeof win.setTimeout === "function" ? win.setTimeout.bind(win) : null,
        clearTimeoutFn: typeof win.clearTimeout === "function" ? win.clearTimeout.bind(win) : null
      });
      win.__kingshoterDefenseUpdate = controller;
      controller.start();
      return controller;
    } catch (error) {
      return null;
    }
  }

  return Object.freeze({
    BUILD: surface.BUILD,
    MIN_BUILD_KEY: surface.MIN_BUILD_KEY,
    QUERY_KEY: surface.QUERY_KEY,
    shouldReload: surface.shouldReload,
    reloadURL: surface.reloadURL,
    createController: surface.createController,
    hasActivePersonalCommand: hasActivePersonalCommand,
    install: install
  });
}));
