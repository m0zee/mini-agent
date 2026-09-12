export interface SkillRecord {
  name: string;
  description: string;
  location: string;
  dir: string;
  license?: string;
  compatibility?: string;
  allowedTools?: string;
  metadata: Record<string, string>;
}

export interface Diagnostic {
  level: "warn" | "error";
  skill?: string;
  message: string;
}
