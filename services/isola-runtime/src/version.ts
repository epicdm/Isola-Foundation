/**
 * Service version. Kept as a literal on purpose: this service must never read a
 * file at runtime (no filesystem reads outside the app dir, and we prefer no
 * filesystem reads at all), so package.json is not imported here.
 * Keep this in sync with package.json manually.
 */
export const SERVICE_VERSION = "1.0.0";
export const SERVICE_NAME = "isola-runtime";
