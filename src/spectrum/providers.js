/**
 * Build Spectrum provider configs from validated provider names.
 * Uses official spectrum-ts provider `.config()` APIs.
 */

import { SpectrumConfigError } from "./config.js";

/**
 * @typedef {object} ProviderModules
 * @property {{ config: (opts?: object) => unknown }} imessage
 * @property {{ config: (opts?: object) => unknown }} terminal
 */

/**
 * @param {string[]} providerNames
 * @param {ProviderModules} modules
 * @returns {unknown[]}
 */
export function buildProviderConfigs(providerNames, modules) {
  if (!Array.isArray(providerNames) || providerNames.length === 0) {
    throw new SpectrumConfigError("At least one Spectrum provider is required.");
  }
  return providerNames.map((name) => {
    if (name === "imessage") {
      if (!modules.imessage?.config) {
        throw new SpectrumConfigError("imessage provider module is missing config().");
      }
      return modules.imessage.config();
    }
    if (name === "terminal") {
      if (!modules.terminal?.config) {
        throw new SpectrumConfigError("terminal provider module is missing config().");
      }
      return modules.terminal.config();
    }
    throw new SpectrumConfigError(
      `Unknown Spectrum provider: ${name}. Allowed: imessage, terminal`,
    );
  });
}

/**
 * Options object passed to Spectrum().
 * @param {{
 *   providers: any[],
 *   projectId?: string,
 *   projectSecret?: string,
 *   logLevel?: string,
 * }} opts
 * @returns {Record<string, any>}
 */
export function buildSpectrumOptions(opts) {
  /** @type {Record<string, any>} */
  const options = {
    providers: opts.providers,
  };
  if (opts.projectId && opts.projectSecret) {
    options.projectId = opts.projectId;
    options.projectSecret = opts.projectSecret;
  }
  if (opts.logLevel) {
    options.options = { logLevel: opts.logLevel };
  }
  return options;
}
