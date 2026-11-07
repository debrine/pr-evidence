import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CliError } from "../errors.js";
import { helperVersion, readSkillTemplate } from "../packageInfo.js";
import { findMissingPrerequisites } from "../prerequisites.js";

interface Agent {
  name: string;
  /** Exists in the home directory when the agent is in use. */
  detectionDirectory: string;
  /** User-level skills directory, relative to the home directory. */
  skillsDirectory: string;
}

const agents: Agent[] = [
  { name: "claude", detectionDirectory: ".claude", skillsDirectory: ".claude/skills" },
  { name: "codex", detectionDirectory: ".codex", skillsDirectory: ".agents/skills" },
  { name: "cursor", detectionDirectory: ".cursor", skillsDirectory: ".cursor/skills" },
];

function chooseAgents(requestedNames: string[]): Agent[] {
  if (requestedNames.length > 0) {
    return requestedNames.map((name) => {
      const agent = agents.find((candidate) => candidate.name === name);
      if (agent === undefined) {
        const supported = agents.map((candidate) => candidate.name).join(", ");
        throw new CliError("usage", `Unknown agent "${name}". Supported: ${supported}.`);
      }
      return agent;
    });
  }
  const detected = agents.filter((agent) => existsSync(join(homedir(), agent.detectionDirectory)));
  if (detected.length === 0) {
    throw new CliError(
      "no_agent_found",
      "Found no Claude Code, Codex or Cursor in your home directory. Name one with --agent.",
    );
  }
  return detected;
}

export function setup(requestedAgentNames: string[]): Record<string, unknown> {
  const skill = readSkillTemplate().replaceAll("{{version}}", helperVersion);
  const installed = chooseAgents(requestedAgentNames).map((agent) => {
    const path = join(homedir(), agent.skillsDirectory, "pr-evidence", "SKILL.md");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, skill);
    process.stderr.write(`Installed the skill for ${agent.name}: ${path}\n`);
    return { agent: agent.name, path };
  });

  const missingPrerequisites = findMissingPrerequisites();
  for (const { name, fix } of missingPrerequisites) {
    process.stderr.write(`Missing ${name}. ${fix}\n`);
  }
  return { installed, ready: missingPrerequisites.length === 0, missingPrerequisites };
}
