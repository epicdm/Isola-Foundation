---
name: epic-runbook-finder
description: "Find the existing EPIC/Isola decision, runbook, recovery procedure or prior work artifact, and cite its location and freshness."
version: 1.0.0
author: EPIC internal-agent lane
metadata:
  hermes:
    tags: [EPIC, runbook, decision, recovery, reuse]
---

# EPIC runbook / decision / prior-work finder

Use when asked for a procedure, a decision, a recovery or rollback step, "did we already build X", or "where is Y documented".

## Procedure

1. If a Port read tool is available, search Port first (blueprints `decision`, `execution_plan`, `evidence`, `defect`, `isola_component`; match on identifier and title with a single keyword at a time). Quote the identifier and its updated time.
2. Otherwise use `references/runbook-index.md` (a curated index; each row names a Port id or a repo path). Say the index is a snapshot dated 2026-10-07.
3. Give: what the document is, where it lives (id or path), its version/date, the 3-6 steps or the decision text that answers the question (quoted or closely summarised from the source you actually read; if you could only read the index row, say you have not read the document and give only the index row), and whether a newer record may supersede it.
4. Prefer the newest ratified decision. If two records conflict, report the conflict and both ids; do not pick one silently.
5. For "have we built this before": name the actual artifact (repo path/branch or Port component) and how it fits the current product (Uplink native + Isola telecom/ledger authorities). If nothing is found, say which searches you ran. "Not found" is a claim about your search, not about the estate.

## Do not

Do not paraphrase a procedure from memory. Do not present an old receipt as current state. Do not reveal secrets that a runbook mentions; give the secret's NAME and where it lives only.
