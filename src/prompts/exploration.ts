import type { ExplorationSubtype } from '../intent/types.js';

interface SubtypeConfig {
  name: string;
  focusSection: string;
}

const SUBTYPES: Record<ExplorationSubtype, SubtypeConfig> = {
  'git-strategy': {
    name: 'Git Strategy',
    focusSection: `FOCUS: Git branching strategy
- What branches exist and their naming conventions (main, develop, feature/*, release/*)
- Merge vs rebase policy (look for .git/config, GitHub settings clues, recent merge commits)
- Branch protection indicators (.github/ configs, PR templates)
- Typical workflow inferred from git log --oneline --graph
Report sections: Branch Overview, Merge Strategy, Workflow Summary`,
  },
  'ci-checks': {
    name: 'CI/CD Setup',
    focusSection: `FOCUS: CI/CD pipeline configuration
- CI platform (GitHub Actions, CircleCI, Jenkins -- check .github/workflows/, .circleci/, Jenkinsfile)
- Workflow triggers (push, PR, schedule, manual)
- Key jobs: build, test, lint, deploy stages
- Environment targets (staging, production)
Report sections: CI Platform, Workflow Triggers, Pipeline Stages, Deployment Targets`,
  },
  'project-structure': {
    name: 'Project Structure',
    focusSection: `FOCUS: Project layout and architecture
- Top-level directory layout and purpose of each directory
- Build system and tooling (package.json scripts, pom.xml, Makefile, etc.)
- Key entry points (main files, index files, CLI entry)
- Test organization and coverage setup
Report sections: Directory Layout, Build System, Entry Points, Test Setup`,
  },
  'general': {
    name: 'General Exploration',
    focusSection: `FOCUS: General repository overview
- Language, runtime, and primary framework
- Project purpose and key features (README, package.json description)
- Top-level structure and notable files
- Development setup (how to install and run locally)
Report sections: Project Overview, Technology Stack, Structure, Getting Started`,
  },
};

/**
 * Builds an end-state prompt for read-only repository investigation tasks.
 *
 * Follows end-state prompting discipline (TASK-04): describes the desired
 * outcome (a structured report), not step-by-step instructions.
 *
 * @param description - Verbatim user instruction describing what to investigate
 * @param subtype - Exploration subtype determining the FOCUS section content
 * @returns Prompt string for the read-only investigation agent
 */
export function buildExplorationPrompt(description: string, subtype: ExplorationSubtype = 'general'): string {
  const config = SUBTYPES[subtype] ?? SUBTYPES['general'];
  return [
    `You are a read-only repository investigator. Your task: ${description}`,
    '',
    'CONSTRAINTS:',
    '- Do NOT create, edit, or delete any files',
    '- Do NOT run commands that modify state (git commit, npm install, etc.)',
    '- Use only read commands: ls, cat, git log, git branch, git status, find, grep',
    '',
    config.focusSection,
    '',
    'OUTPUT: Produce a structured markdown report with clear section headers.',
    'After your investigation, the following should be true:',
    '- Your final response IS the complete report (not a summary)',
    '- All report sections are populated with findings from the actual repo',
    '- No files have been created or modified',
    '',
    'Work in the current directory.',
  ].join('\n');
}
