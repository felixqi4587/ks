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

  function selectPlayer(picks, pid, mode, replaceRole) {
    const current = reconcilePicks(picks, mode);
    const existing = current.find((pick) => pick.pid === pid);
    if (existing) return { picks: current.filter((pick) => pick.pid !== pid), needsReplacement: false };
    const roles = rolesForMode(mode);
    const used = new Set(current.map((pick) => pick.role));
    const emptyRole = roles.find((role) => !used.has(role));
    if (emptyRole) return { picks: current.concat({ pid, role: emptyRole }), needsReplacement: false };
    if (!roles.includes(replaceRole)) return { picks: current, needsReplacement: true, roles };
    return {
      picks: current.filter((pick) => pick.role !== replaceRole).concat({ pid, role: replaceRole }),
      needsReplacement: false
    };
  }

  function movePlayerToRole(picks, pid, targetRole, mode) {
    const current = reconcilePicks(picks, mode);
    const roles = rolesForMode(mode);
    if (!roles.includes(targetRole)) return current;
    const moving = current.find((pick) => pick.pid === pid);
    if (!moving || moving.role === targetRole) return current;
    const occupied = current.find((pick) => pick.role === targetRole);
    return current.map((pick) => {
      if (pick.pid === pid) return { pid: pick.pid, role: targetRole };
      if (occupied && pick.pid === occupied.pid) return { pid: pick.pid, role: moving.role };
      return pick;
    });
  }

  return { BUILD, isRallyCommand, targetFor, rolesForMode, reconcilePicks, selectPlayer, movePlayerToRole };
}));
