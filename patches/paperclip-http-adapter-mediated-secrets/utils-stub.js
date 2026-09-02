// Minimal stand-ins matching @paperclipai/adapter-utils server-utils semantics,
// so the pure resolution logic can be proven without the Paperclip tree.
export const asString = (v, d) => (typeof v === "string" ? v : d);
export const asNumber = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);
export const parseObject = (v) =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? v : {};
