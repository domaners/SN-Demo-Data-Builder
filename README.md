# SN Demo Data Builder

A ServiceNow scoped application that uses Claude to generate realistic, interconnected demo data on a
demo or Personal Developer Instance (PDI), and then keeps that data "alive" on a schedule so the
instance behaves like a production environment.

**Status: Phase 1 (foundation data) built, not yet verified on a live instance.**
Install: [`docs/INSTALL.md`](docs/INSTALL.md). Design: [`docs/DESIGN.md`](docs/DESIGN.md).

## What it does

| | Phase | |
|---|---|---|
| Claude designs a fictional company as a JSON "blueprint" (or use the bundled example) | 1 | Built |
| **Foundation data**: companies, locations, departments, cost centers, users, groups, roles, created through a simulated Active Directory sync | 1 | Built |
| Record ledger, reset, setup check, background jobs with retries | 1 | Built |
| **CMDB and service maps** through IRE with a discovery source | 2 | Planned |
| **Task records**: incidents, problems, changes, catalog requests | 3 | Planned |
| **Lifecycle simulation**: scheduled updates that keep the data evolving | 4 | Planned |

Claude supplies structure and language; scripts expand the blueprint deterministically into volume,
so the same blueprint and seed always give the same instance and API spend stays low.

## Repository layout

| Path | Contents |
|---|---|
| `app/app.json` | Application name, scope (`x_ddb`), version, cross-scope privileges |
| `app/script_includes/` | Server-side logic, one Script Include per file |
| `app/tables/` | Table definitions (columns, choices, read role) |
| `app/records/` | Roles, menu and modules, properties, UI actions, event, Script Action, scheduled job, business rule, UI page |
| `app/scripts/` | Script bodies referenced by `app/records/` |
| `app/prompts/` | Prompt templates (front matter + `=== system ===` / `=== user ===`) |
| `build/` | Generates the update set from `app/` |
| `dist/ddb-<version>.xml` | The importable update set (generated, committed) |
| `test/` | Node tests running the Script Includes against in-memory Glide mocks |
| `docs/` | Design, install guide, blueprint schema and example |

`docs/schemas/blueprint.schema.json`, `docs/examples/blueprint.example.json` and `app/prompts/*.md` are
injected into Script Includes at build time, so there is one copy of each.

## Development

Requires Node 20 or later; no dependencies.

```sh
npm test          # unit, planner, provider, job and build tests
npm run build     # regenerate dist/ddb-<version>.xml
npm run check     # fail if dist/ is stale, then run the tests
```

Commit the regenerated `dist/` file with every change under `app/` or `docs/schemas`/`docs/examples`;
`npm run check` and the build test fail otherwise.

The tests run the real Script Include source in a Node `vm` with mocks of `GlideRecord`, `gs`,
`GlideDigest`, `GlideDateTime`, `GlideTableHierarchy`, `sn_ws.RESTMessageV2` and
`sn_cc.StandardCredentialsProvider`. The mocks do not run business rules, ACLs or flows, so they
complement, not replace, testing on an instance.

Script Includes are written for the app's ECMAScript 2021 mode (`let`/`const`, arrow functions) and use
the `Class.create()` pattern. New Script Includes must be added to `SCRIPT_INCLUDE_ORDER` in
`build/lib/source.js`.

> Never install this application on a production instance. It refuses to run when
> `glide.installation.production` is `true`.
