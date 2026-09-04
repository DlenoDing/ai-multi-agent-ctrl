export function defaultSkillSource(digestOf) {
  return {
    schemaVersion: "agent-skill-source/v1",
    sourceId: "agency-agents-zh",
    repositoryUrl: "https://github.com/DlenoDing/agency-agents-zh.git",
    defaultRef: "main",
    pinnedCommit: "1d2345927e4a70c426472c37771e31f9333d7e0a",
    status: "configured",
    stateVersion: 1,
    catalogFiles: ["AGENT-LIST.md", "CATALOG.md"],
    roleFileGlobs: [
      "academic/**/*.md",
      "design/**/*.md",
      "engineering/**/*.md",
      "finance/**/*.md",
      "game-development/**/*.md",
      "gis/**/*.md",
      "hr/**/*.md",
      "integrations/**/*.md",
      "legal/**/*.md",
      "marketing/**/*.md",
      "paid-media/**/*.md",
      "product/**/*.md",
      "project-management/**/*.md",
      "sales/**/*.md",
      "security/**/*.md",
      "spatial-computing/**/*.md",
      "specialized/**/*.md",
      "strategy/**/*.md",
      "supply-chain/**/*.md",
      "support/**/*.md",
      "testing/**/*.md",
      "writing/**/*.md"
    ],
    catalogDigest: digestOf("agency-agents-zh:configured"),
    roleSkillIndexRef: "runtime://skill-sources/agency-agents-zh/index.json",
    digestIndexRef: "runtime://skill-sources/agency-agents-zh/digest-index.json",
    digestIndexVerified: false,
    trustPolicy: {
      requirePinnedCommit: true,
      requireFrontmatter: true,
      requireDigestIndex: true,
      allowUnsignedContent: false
    },
    syncPolicy: {
      mode: "pinned_snapshot",
      refreshTrigger: "orchestrator_need",
      onUpstreamChange: "create_system_upgrade_candidate"
    },
    overlayPolicy: {
      defaultPrecedence: ["task_group_overlay", "project_overlay", "upstream_default"],
      allowedScopes: ["project", "task_group"],
      requiresDecisionRecord: true,
      requiresDigest: true
    }
  };
}
