default:
    @just --list

# g1

pi-discuss:
    pi --no-skills --skill .agents/skills/context7-cli --skill .agents/skills/find-docs --skill .agents/skills/research --skill .agents/skills/roadmap --skill .agents/skills/writing-for-agents --skill .agents/skills/writing-for-humans

pi-discuss-cf:
    pi --no-skills --skill .agents/skills/context7-cli --skill .agents/skills/find-docs --skill .agents/skills/research --skill .agents/skills/roadmap --skill .agents/skills/writing-for-agents --skill .agents/skills/writing-for-humans --skill .agents/skills/cloudflare --skill .agents/skills/durable-objects --skill .agents/skills/sandbox-stable --skill .agents/skills/workers-best-practices --skill .agents/skills/wrangler