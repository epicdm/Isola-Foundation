/**
 * Service version. Kept as a literal on purpose: this service must never read a
 * file at runtime (no filesystem reads outside the app dir, and we prefer no
 * filesystem reads at all), so package.json is not imported here.
 * Keep this in sync with package.json manually.
 */
/**
 * 1.1.0 — adds the versioned `responseMode: "inline"` contract (see
 * `src/response.ts` and README section 3) and moves the default state directory
 * off `/tmp` onto the persistent `/data` volume.
 */
export const SERVICE_VERSION = "1.1.0";
export const SERVICE_NAME = "isola-runtime";
