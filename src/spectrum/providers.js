import { SpectrumConfigError } from "./config.js";

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

export function buildSpectrumOptions(opts) {
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
