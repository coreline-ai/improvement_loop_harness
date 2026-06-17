export interface AgentSpecPolicy {
  allowedSpecs?: readonly string[] | undefined;
  allowCommandAgent?: boolean | undefined;
}

export interface AgentSpecValidation {
  allowed: boolean;
  reason?: string | undefined;
}

const DEFAULT_ALLOWED_SPECS = ['codex', 'mock:*'] as const;

function truthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value ?? '');
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function matchesPattern(spec: string, pattern: string): boolean {
  if (pattern.endsWith('*')) {
    return spec.startsWith(pattern.slice(0, -1));
  }
  return spec === pattern;
}

export function agentSpecPolicyFromEnv(
  env: NodeJS.ProcessEnv = process.env
): AgentSpecPolicy {
  const allowCommandAgent = truthy(env.VIBELOOP_ALLOW_COMMAND_AGENT);
  const configuredAllowlist = splitList(
    env.VIBELOOP_AGENT_SPEC_ALLOWLIST ?? env.VIBELOOP_ALLOWED_AGENT_SPECS
  );

  return {
    allowedSpecs:
      configuredAllowlist.length > 0
        ? configuredAllowlist
        : DEFAULT_ALLOWED_SPECS,
    allowCommandAgent
  };
}

export function validateAgentSpec(
  spec: string | null | undefined,
  policy: AgentSpecPolicy = agentSpecPolicyFromEnv()
): AgentSpecValidation {
  const trimmed = spec?.trim();
  if (!trimmed) {
    return { allowed: true };
  }

  if (trimmed.startsWith('command:')) {
    return {
      allowed: false,
      reason:
        'command agents are disabled on the server until an isolated command-agent adapter is available'
    };
  }

  const allowedSpecs = policy.allowedSpecs ?? DEFAULT_ALLOWED_SPECS;
  if (!allowedSpecs.some((pattern) => matchesPattern(trimmed, pattern))) {
    return {
      allowed: false,
      reason: `agent spec is not allowed by server policy: ${trimmed}`
    };
  }

  return { allowed: true };
}
