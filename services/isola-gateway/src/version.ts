/**
 * Service version. Kept as a literal on purpose: this service never reads a file
 * at runtime — it has no filesystem access at all — so package.json is not
 * imported here. Keep this in sync with package.json manually.
 */
export const SERVICE_VERSION = "1.0.0";
export const SERVICE_NAME = "isola-gateway";
