# mend

`mend` is the patch CLI specified by `SPEC.md`. It reads a patch in one of four
formats — unified diff, SEARCH/REPLACE blocks, V4A, or JSON edits — applies every
edit to a tree of text files, and either writes every change or none.

Run it with Node 22 and no dependencies:

```
node main.ts [--format=auto|unified|search-replace|v4a|json] [--check] [--strict] [--] [PATCH]
```

With no `PATCH` (or `-`) the patch is read from standard input. `--check` prints
the same output without touching files; `--strict` disables the two fuzzy
matching tiers. The working directory is the root of the file tree.

## Files

- `main.ts` — the implementation: CLI handling, format detection, all four
  parsers, three-tier line matching, and the all-or-nothing writer. The final
  lines hand a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is set.
- `runner.ts` — the kit's runner, unchanged. In a trial it fetches checks from
  the env, runs `node main.ts` on each in a fresh directory, and posts results.
- `check.ts` — the local practice checker, unchanged.
- `SPEC.md` — the contract; `LICENSE` — MIT.

## Local verification

```
node check.ts ../program/generator/practice.json
```

The helper expects the kit's `program/generator/practice.json`; from this
repository layout the kit file is at
`hidden-spec-cli-01-run-20261122-kit/program/generator/practice.json`.
