skill_prefix := "--skill .agents/skills"
grilling_skills := skill_prefix + "/grilling " + skill_prefix + "/grill-with-docs"
context7_skills := skill_prefix + "/context7-cli " + skill_prefix + "/find-docs"
discussion_skills := context7_skills + " " + skill_prefix + "/research " + skill_prefix + "/roadmap " + skill_prefix + "/writing-for-agents " + skill_prefix + "/writing-for-humans"
cloudflare_skills := skill_prefix + "/cloudflare " + skill_prefix + "/durable-objects " + skill_prefix + "/sandbox-stable " + skill_prefix + "/workers-best-practices " + skill_prefix + "/wrangler"

default:
    @just --list

pi:
    pi --no-skills

pi-que:
    pi --no-skills {{context7_skills}}

pi-discuss:
    pi --no-skills {{grilling_skills}} {{discussion_skills}}

pi-discuss-cf:
    pi --no-skills {{grilling_skills}} {{discussion_skills}} {{cloudflare_skills}}
