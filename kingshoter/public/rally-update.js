(function (root, factory) {
  var api = factory(root.BattleUpdate);
  if (typeof module === "object" && module.exports) module.exports = api;
  else {
    root.RallyUpdate = api;
    root.KvkUpdate = api;
  }
}(typeof globalThis !== "undefined" ? globalThis : this, function (shared) {
  "use strict";
  if (!shared || typeof shared.createSurface !== "function") return Object.freeze({ BUILD: 2026071603 });
  return shared.createSurface({
    build: 2026071603,
    minBuildKey: "minRallyBuild",
    legacyMinBuildKey: "minKvkBuild",
    queryKey: "__rally_build"
  });
}));
