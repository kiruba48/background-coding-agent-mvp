import { z } from 'zod';

export const IntentSchema = z.object({
  taskType: z.enum(['npm-dependency-update', 'maven-dependency-update', 'unknown']),
  dep: z.string().nullable(),
  version: z.enum(['latest']).nullable(),   // NEVER a real version — sentinel only
  confidence: z.enum(['high', 'low']),
  clarifications: z.array(z.object({
    label: z.string(),
    intent: z.string(),
  })),
});

export type IntentResult = z.infer<typeof IntentSchema>;

export interface FastPathResult {
  dep: string;
  version: string;         // 'latest' sentinel or explicit version from user input
  project: string | null;  // extracted project name from "in <name>" / "for <name>"
}

export interface ClarificationOption {
  label: string;
  intent: string;
}

export interface ResolvedIntent {
  taskType: string;
  repo: string;             // absolute path to resolved project
  dep: string | null;
  version: string | null;   // 'latest' sentinel, explicit version, or null
  confidence: 'high' | 'low';
  clarifications?: ClarificationOption[];  // from LLM when confidence is low
}
