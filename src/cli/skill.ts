// The agent skill, embedded at build time (Vite `?raw`): `cais llm skill` prints it with the app closed and no socket.
// One source file: skills/cais/SKILL.md (the app also ships it as resources/skill/SKILL.md for the menu install).
import skill from '../../skills/cais/SKILL.md?raw';

export const SKILL: string = skill;
