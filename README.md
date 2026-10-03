# SN Demo Data Builder

A ServiceNow scoped application that uses Claude to generate realistic, interconnected demo data on a
demo or Personal Developer Instance (PDI), and then keeps that data "alive" on a schedule so the
instance behaves like a production environment.

**Status: design phase.** No application code yet. See [`docs/DESIGN.md`](docs/DESIGN.md).

## What it will do

- **Foundation data**: companies, locations, departments, cost centers, users and groups, created
  through an LDAP/AD-shaped import path so records look as though they came from a directory sync.
- **CMDB and service maps**: servers, databases, app servers, network gear and their relationships,
  plus business and application services. CIs are written through the Identification and
  Reconciliation Engine (IRE) with a discovery source, the way Discovery and Service Mapping write them.
- **Task records**: incidents, problems, changes and catalog requests, raised by generated users
  through the channels real users use (portal, email, phone, events).
- **Lifecycle simulation**: scheduled jobs that move tickets through their states, add work notes,
  drift CI attributes, retire and discover CIs, and hire, move and terminate people.

Claude designs the fictional company (a JSON "blueprint") and writes the narrative text. Server-side
scripts expand the blueprint into high-volume records deterministically, so the same seed reproduces
the same instance and API spend stays low.

## Repository layout

| Path | Contents |
|---|---|
| `docs/DESIGN.md` | Architecture and design document |
| `docs/schemas/blueprint.schema.json` | JSON Schema the blueprint must satisfy; sent to Claude as the structured-output format |
| `docs/examples/blueprint.example.json` | A small sample blueprint that validates against the schema |

## Target platform

- ServiceNow Washington DC or later (PDI friendly; no paid plugins required)
- Delivered as a scoped application, exported as XML/update set and kept in this repository
- LLM provider is pluggable; the Anthropic API is the first implementation

> Never install this application on a production instance. It refuses to run when
> `glide.installation.production` is `true`.
