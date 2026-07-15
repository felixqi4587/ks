exports.legacyTarget = function legacyTarget(command, pid) {
  if (command.type === 'double_rally' && command.payload && Array.isArray(command.payload.pairs)) {
    const mine = command.payload.pairs.find((pair) => pair.pid === pid);
    if (mine) return { anchor: mine.pressUTC, mine: true, role: mine.role };
    return { anchor: command.payload.firstPress ?? command.anchorUTC, mine: false };
  }
  return { anchor: command.anchorUTC, mine: false };
};
