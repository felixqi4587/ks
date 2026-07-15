export const CURRENT_KVK_BUILD = 2026071302;
export const MIN_KVK_BUILD = 2026071301;
export const MIN_TRIPLE_BUILD = 2026071302;

export function parseClientBuild(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

export function buildMetadata(tripleEnabled, tripleQaEnabled = false) {
  return {
    currentBuild: CURRENT_KVK_BUILD,
    minKvkBuild: MIN_KVK_BUILD,
    minTripleBuild: MIN_TRIPLE_BUILD,
    tripleEnabled: tripleEnabled === true,
    tripleQaEnabled: tripleQaEnabled === true
  };
}

export function projectRoomForClient(room, clientBuild) {
  if (parseClientBuild(clientBuild) >= MIN_TRIPLE_BUILD) return room;
  const sourceCommands = room && room.live && room.live.commands || { 1: null, 2: null };
  const commands = { 1: sourceCommands[1], 2: sourceCommands[2] };
  let changed = false;
  for (const kingdom of [1, 2]) {
    const command = commands[kingdom];
    if (command && command.type === 'triple_rally') {
      commands[kingdom] = {
        ...command,
        type: 'double_rally',
        payload: {
          ...command.payload,
          ...(Array.isArray(command.payload && command.payload.pairs) ? {
            pairs: command.payload.pairs.map((pair) => ({ ...pair }))
          } : {}),
          rallySize: 3
        }
      };
      changed = true;
    }
  }
  return changed ? { ...room, live: { ...room.live, commands } } : room;
}
