# Domain docs

## Layout

This repository uses a single context:

- `GLOSSARY.md` at the repository root defines domain terms.
- `docs/adr/` contains architecture decision records.

## Consumer rules

- Before exploring the codebase, read `GLOSSARY.md` if it exists and the ADRs relevant to the area being changed.
- If these files are absent, proceed silently. The `domain-modeling` skill creates them lazily when terms or decisions are resolved.
- Use the glossary's terms when naming domain concepts in issues, proposals, hypotheses, and tests. If a needed term is missing, reconsider the wording or note the gap for `domain-modeling`.
- If a proposal contradicts an ADR, identify the ADR and explain why the decision should be revisited.
