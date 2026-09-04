export const defaultLanguagePolicy = Object.freeze({
  schemaVersion: "language-policy/v1",
  languageTag: "zh-CN",
  languageName: "Chinese",
  script: "Hans",
  scope: [
    "role_interaction",
    "dispatch_instruction",
    "room_message",
    "execution_event",
    "checkpoint",
    "repository_output",
    "review_material"
  ],
  enforcement: "required",
  fallback: "return_blocked_for_language_mismatch"
});

const languageAliases = new Map([
  ["中文", {languageTag: "zh-CN", languageName: "Chinese", script: "Hans"}],
  ["汉语", {languageTag: "zh-CN", languageName: "Chinese", script: "Hans"}],
  ["简体中文", {languageTag: "zh-CN", languageName: "Chinese", script: "Hans"}],
  ["zh", {languageTag: "zh-CN", languageName: "Chinese", script: "Hans"}],
  ["zh-cn", {languageTag: "zh-CN", languageName: "Chinese", script: "Hans"}],
  ["chinese", {languageTag: "zh-CN", languageName: "Chinese", script: "Hans"}],
  ["english", {languageTag: "en", languageName: "English"}],
  ["英语", {languageTag: "en", languageName: "English"}],
  ["en", {languageTag: "en", languageName: "English"}],
  ["en-us", {languageTag: "en-US", languageName: "English"}],
  ["french", {languageTag: "fr", languageName: "French"}],
  ["法语", {languageTag: "fr", languageName: "French"}],
  ["fr", {languageTag: "fr", languageName: "French"}],
  ["fr-fr", {languageTag: "fr-FR", languageName: "French"}],
  ["ja", {languageTag: "ja", languageName: "Japanese"}],
  ["japanese", {languageTag: "ja", languageName: "Japanese"}],
  ["de", {languageTag: "de", languageName: "German"}],
  ["german", {languageTag: "de", languageName: "German"}],
  ["es", {languageTag: "es", languageName: "Spanish"}],
  ["spanish", {languageTag: "es", languageName: "Spanish"}]
]);

export function normalizeTaskGroupLanguagePolicy(input = {}, fallback = {}) {
  const rawPolicy = input?.languagePolicy && typeof input.languagePolicy === "object" ? input.languagePolicy : input;
  const fallbackPolicy = fallback?.languagePolicy && typeof fallback.languagePolicy === "object" ? fallback.languagePolicy : fallback;
  const rawLanguage = String(
    rawPolicy.languageTag ||
    rawPolicy.language ||
    rawPolicy.outputLanguage ||
    rawPolicy.interactionLanguage ||
    fallbackPolicy.languageTag ||
    defaultLanguagePolicy.languageTag
  ).trim();
  const preset = resolveLanguagePreset(rawLanguage);
  const scope = unique([
    ...(Array.isArray(rawPolicy.scope) ? rawPolicy.scope : []),
    ...(Array.isArray(rawPolicy.appliesTo) ? rawPolicy.appliesTo : []),
    ...(!rawPolicy.scope && !rawPolicy.appliesTo && Array.isArray(fallbackPolicy.scope) ? fallbackPolicy.scope : []),
    ...(!rawPolicy.scope && !rawPolicy.appliesTo && !fallbackPolicy.scope ? defaultLanguagePolicy.scope : [])
  ]);
  return {
    schemaVersion: "language-policy/v1",
    languageTag: preset.languageTag,
    languageName: String(rawPolicy.languageName || preset.languageName || preset.languageTag),
    ...(rawPolicy.script || preset.script ? {script: String(rawPolicy.script || preset.script)} : {}),
    scope: scope.length ? scope : [...defaultLanguagePolicy.scope],
    enforcement: ["advisory", "required"].includes(rawPolicy.enforcement)
      ? rawPolicy.enforcement
      : fallbackPolicy.enforcement === "advisory" ? "advisory" : "required",
    fallback: normalizeLanguageFallback(rawPolicy.fallback, fallbackPolicy.fallback)
  };
}

export function languagePolicyDirective(policy = defaultLanguagePolicy) {
  const normalized = normalizeTaskGroupLanguagePolicy(policy);
  return `LanguagePolicy ${normalized.languageTag}/${normalized.languageName}: all role interaction, dispatch instructions, room messages, execution events, checkpoints, repository outputs and review materials MUST use this language; return blocked if unable.`;
}

function resolveLanguagePreset(rawLanguage) {
  const key = String(rawLanguage || "").trim().toLowerCase();
  const alias = languageAliases.get(key);
  if (alias) return alias;
  if (/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/iu.test(rawLanguage)) {
    return {languageTag: canonicalLanguageTag(rawLanguage), languageName: canonicalLanguageTag(rawLanguage)};
  }
  return {...defaultLanguagePolicy};
}

function normalizeLanguageFallback(primary, fallback) {
  const allowed = new Set(["return_blocked_for_language_mismatch", "translate_or_return_blocked"]);
  if (allowed.has(primary)) return primary;
  if (allowed.has(fallback)) return fallback;
  return defaultLanguagePolicy.fallback;
}

function canonicalLanguageTag(value) {
  const parts = String(value || "").trim().split("-").filter(Boolean);
  return parts.map((part, index) => index === 0 ? part.toLowerCase() : part.toUpperCase()).join("-");
}

function unique(items) {
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))];
}
