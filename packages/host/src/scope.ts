export interface AgentScopeResolution {
  runtimeDirectory: string;
}

export interface AgentScopeAdapter {
  resolve(scopeId: string): Promise<AgentScopeResolution> | AgentScopeResolution;
}
