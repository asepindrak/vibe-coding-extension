export interface CustomProviderSettings {
  name: string;
  baseUrl: string;
  model: string;
}

export const CUSTOM_PROVIDER_SETTINGS_KEY = "vico.customProviderSettings";

export function normalizeCustomProviderSettings(
  value: unknown,
): CustomProviderSettings {
  const raw = (value || {}) as Record<string, unknown>;
  return {
    name: String(raw.name || "").trim(),
    baseUrl: String(raw.baseUrl || "").trim(),
    model: String(raw.model || "").trim(),
  };
}

export function hasCustomProviderSettings(
  settings: CustomProviderSettings | null | undefined,
): boolean {
  return !!settings?.baseUrl && !!settings?.model;
}

export function resolveProviderKind(
  provider: string | undefined,
  model?: string,
): "openai" | "ollama" | "custom" {
  if (provider === "custom") {
    return "custom";
  }
  if (provider === "ollama" || String(model || "").startsWith("ollama:")) {
    return "ollama";
  }
  return "openai";
}
