export function consoleScopesForAccount(account = {}) {
  if (account.accountType === "system_admin") return ["system"];
  if (account.accountType === "org_admin") return ["organization", "project"];
  return ["project"];
}
