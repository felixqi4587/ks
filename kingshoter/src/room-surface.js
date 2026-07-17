export const RALLY_SURFACE = "rally";
export const DEFENSE_SURFACE = "defense";

const VALID_SURFACES = new Set([RALLY_SURFACE, DEFENSE_SURFACE]);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function surfaceError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function parseRequestedSurface(searchParams) {
  if (!searchParams || typeof searchParams.has !== "function" ||
      !searchParams.has("surface")) {
    return { ok: true, surface: RALLY_SURFACE, legacy: true };
  }
  if (typeof searchParams.getAll === "function" &&
      searchParams.getAll("surface").length !== 1) {
    return { ok: false, error: "invalid_surface" };
  }
  const surface = searchParams.get("surface");
  return VALID_SURFACES.has(surface)
    ? { ok: true, surface, legacy: false }
    : { ok: false, error: "invalid_surface" };
}

export function inspectSocketSurface(attachment) {
  if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
    return { ok: false, error: "invalid_surface" };
  }
  const source = attachment;
  if (!hasOwn(source, "surface")) {
    return { ok: true, surface: RALLY_SURFACE, needsMigration: true };
  }
  return VALID_SURFACES.has(source.surface)
    ? { ok: true, surface: source.surface, needsMigration: false }
    : { ok: false, error: "invalid_surface" };
}

export function mergeSocketSurface(attachment, patch) {
  const source = attachment && typeof attachment === "object" ? attachment : {};
  const update = patch && typeof patch === "object" ? patch : {};
  const current = inspectSocketSurface(source);
  if (!current.ok) throw surfaceError(current.error);

  let surface = current.surface;
  if (hasOwn(update, "surface")) {
    if (!VALID_SURFACES.has(update.surface)) throw surfaceError("invalid_surface");
    if (!current.needsMigration && update.surface !== current.surface) {
      throw surfaceError("surface_immutable");
    }
    surface = update.surface;
  }

  return { ...source, ...update, surface };
}
