import { z } from 'zod';

/** Shared enum values — used by both Zod schema and OUTPUT_SCHEMA for the LLM */
export const TASK_TYPES = ['npm-dependency-update', 'maven-dependency-update', 'generic'] as const;
export const TASK_CATEGORIES = ['code-change', 'config-edit', 'refactor'] as const;

export type TaskType = (typeof TASK_TYPES)[number];
export type TaskCategory = (typeof TASK_CATEGORIES)[number];

export const IntentSchema = z.object({
  taskType: z.enum(TASK_TYPES),
  dep: z.string().nullable(),
  version: z.enum(['latest']).nullable(),   // NEVER a real version — sentinel only
  confidence: z.enum(['high', 'low']),
  createPr: z.boolean(),
  taskCategory: z.enum(TASK_CATEGORIES).nullable(),
  clarifications: z.array(z.object({
    label: z.string(),
    intent: z.string(),
  })),
}).refine(
  (data) => data.taskType !== 'generic' || data.taskCategory !== null,
  { message: 'taskCategory is required when taskType is generic', path: ['taskCategory'] },
);

export type IntentResult = z.infer<typeof IntentSchema>;

export interface FastPathResult {
  dep: string;
  version: string;         // 'latest' sentinel or explicit version from user input
  project: string | null;  // extracted project name from "in <name>" / "for <name>"
  createPr: boolean;       // user requested PR creation (e.g. "and create PR")
  isFollowUp?: boolean;    // true when detected via follow-up patterns ("also X", "X too", etc.)
}

export interface ClarificationOption {
  label: string;
  intent: string;
}

export interface ResolvedIntent {
  taskType: TaskType;
  repo: string;             // absolute path to resolved project
  dep: string | null;
  version: string | null;   // 'latest' sentinel, explicit version, or null
  confidence: 'high' | 'low';
  createPr?: boolean;       // user requested PR creation (e.g. "and create PR")
  description?: string;     // raw NL input when taskType is 'generic'
  taskCategory?: TaskCategory | null;
  clarifications?: ClarificationOption[];  // from LLM when confidence is low
  inheritedFields?: Array<'taskType' | 'repo'>; // fields inherited from session history (follow-up)
}
