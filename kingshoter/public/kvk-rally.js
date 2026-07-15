(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KvkRally = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const BUILD = 2026071303;

  function isRallyCommand(command) {
    return !!command && (command.type === 'double_rally' || command.type === 'triple_rally');
  }

  function safeAnchor(command) {
    const firstPress = command && command.payload && command.payload.firstPress;
    if (Number.isFinite(firstPress)) return firstPress;
    return command && Number.isFinite(command.anchorUTC) ? command.anchorUTC : 0;
  }

  function targetFor(command, pid) {
    if (isRallyCommand(command) && command.payload && Array.isArray(command.payload.pairs)) {
      const mine = command.payload.pairs.find((pair) => pair && pair.pid === pid);
      const roles = command.type === 'triple_rally' || command.payload.rallySize === 3
        ? ['weak', 'weak2', 'main'] : ['weak', 'main'];
      if (mine && typeof mine.pid === 'string' && mine.pid.length > 0 &&
          roles.includes(mine.role) && Number.isFinite(mine.pressUTC)) {
        return { anchor: mine.pressUTC, mine: true, role: mine.role };
      }
      return { anchor: safeAnchor(command), mine: false };
    }
    return { anchor: safeAnchor(command), mine: false };
  }

  function rolesForMode(mode) {
    return mode === 'triple' ? ['weak', 'weak2', 'main'] : ['weak', 'main'];
  }

  function reconcilePicks(picks, mode) {
    const allowed = new Set(rolesForMode(mode));
    const seenPids = new Set();
    const seenRoles = new Set();
    return (Array.isArray(picks) ? picks : []).filter((pick) => {
      if (!pick || !pick.pid || !allowed.has(pick.role) || seenPids.has(pick.pid) || seenRoles.has(pick.role)) return false;
      seenPids.add(pick.pid);
      seenRoles.add(pick.role);
      return true;
    }).map((pick) => ({ pid: pick.pid, role: pick.role }));
  }

  return { BUILD, isRallyCommand, targetFor, rolesForMode, reconcilePicks };
}));
