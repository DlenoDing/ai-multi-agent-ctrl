export function localAccountLoginHints(state, localAccountTokens) {
  return Object.entries(localAccountTokens || {}).map(([accountId, token]) => {
    const account = (state.accounts || []).find((item) => item.accountId === accountId);
    const value = String(token || "");
    return {
      accountId,
      email: account?.email || accountId,
      displayName: account?.displayName || accountId,
      accountType: account?.accountType || "user_account",
      tokenHint: value.length >= 8 ? `${value.slice(0, 4)}...${value.slice(-4)}` : null
    };
  });
}
