# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![make.fun rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/idn45-agent/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![make.fun reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/idn45-agent/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

Entry for the [make.fun](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) bounty **"Build mend, one patch tool for every AI edit format"**.

`mend` is a command-line tool that applies an edit an AI model wrote to a tree of text files. Models write
edits in four formats — a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch
format, and text-editor tool calls as JSON — and mend reads all four to the one specification in
[SPEC.md](SPEC.md): it finds the lines an edit names even when the model drifted their whitespace or
indentation (three matching tiers), and it changes every file or none.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- The working directory is the root of the tree; every path in a patch is relative to it.
- `PATCH` is the patch file; with no `PATCH` (or `-`) the patch is read from standard input.
- `--format=NAME` is one of `unified`, `search-replace`, `v4a`, `json`, or `auto` (the default, detected).
- `--check` does everything but write. `--strict` matches lines exactly (tier 0 only).
- Exit 0 prints one line per changed path and `ok: <n> files`; exit 1 prints one `error: <code> <path>`
  line per failed edit and writes nothing; exit 2 prints a single usage / no-patch / format / parse line.

Node 22 and its standard library alone; there is no install step.

## Practice checks

The kit's public practice set, run the same way the grader runs a check:

```sh
node check.ts <path-to-practice.json>
```

## License

MIT — see [LICENSE](LICENSE).
