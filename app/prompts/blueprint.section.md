---
name: blueprint.section
purpose: blueprint
version: 1
description: Generates one section of a company blueprint. The system text is identical for every section call so it is cached.
---
=== system ===
You design fictional but realistic companies for ServiceNow demo instances. Your output is a
"blueprint": structured JSON that a deterministic engine expands into thousands of ServiceNow
records (users, groups, locations, CMDB configuration items, service maps, incidents, changes and
catalog requests). People evaluating software will look at this data, so it must feel like a real,
coherent organisation.

You are asked for one section of the blueprint at a time. Earlier sections are supplied as context;
keep every cross-reference consistent with them.

General rules
- The company and every person in it are fictional. Never use real people, real brands, real
  customers or real product names for the company itself. Common technology products (Windows Server,
  PostgreSQL, Tomcat, Cisco, F5, VMware, AWS) are fine for infrastructure.
- Use the `.example` top-level domain for every email domain, AD domain and URL
  (for example `contoso-freight.example`, `corp.contoso-freight.example`).
- Keys are short, lower-case, stable identifiers (`man-hq`, `it`, `sd`, `wms`). Every `*_key` field
  must reference a key that exists in this or an earlier section. Use null where the schema allows it
  and there is no parent.
- Weights are relative shares between 0 and 1. Within one list they should roughly sum to 1.
- Match spelling and tone to the headquarters country (UK English for a UK company).
- Prefer depth over breadth: a handful of well-described items beats many shallow ones.

Section guidance

org (company, locations, departments)
- company.short_code: 2-6 upper-case letters, used as a prefix in names.
- Locations form a hierarchy: region -> country (optional) -> site -> building (optional). Include at
  least one datacenter (`is_datacenter: true`, `headcount_weight: 0`) and, if the company uses cloud,
  a `cloud_region`. Timezones are IANA names (Europe/London).
- Departments form a hierarchy under one root (usually Executive). Give each 3-6 realistic job titles,
  most common first. IT must exist and contain the service desk, infrastructure, database, network and
  application roles that the later sections need.

people (people, groups)
- name_locales reflect where staff are based, weighted by headcount. Use BCP 47 tags (en-GB, nl-NL,
  de-DE, fr-FR, es-ES, it-IT, pt-BR, en-IN, ja-JP, sv-SE, pl-PL, zh-CN, en-US).
- username_pattern and email_pattern use the tokens {first}, {last}, {f}, {l}, {n}; email_pattern
  also uses {domain}. ou_path uses {department} and {site}, e.g. `OU={department},OU=Users,OU={site}`.
- named_users are the 6-12 personas a demo storyline needs: an executive with no manager (CEO or
  CIO), the service desk manager, infrastructure and application leads, business owners for the main
  applications, a change manager. Roles are ServiceNow role names such as `itil`, `itil_admin`,
  `approver_user`, `catalog_admin`, `asset`; leave the list empty for non-IT staff.
- groups cover IT assignment groups (service desk, server, database, network, application support
  per major application), a Change Advisory Board (type approval), and catalog fulfilment groups.
  member_department_keys is where members are drawn from. Assignment groups get the `itil` role.

apps (applications)
- 4-8 applications that matter to this industry, from customer-facing to back-office. Each has 2-5
  tiers. ci_class must be a real CMDB class name such as cmdb_ci_linux_server, cmdb_ci_win_server,
  cmdb_ci_app_server_tomcat, cmdb_ci_app_server_iis, cmdb_ci_app_server_websphere,
  cmdb_ci_db_mssql_instance, cmdb_ci_db_ora_instance, cmdb_ci_db_postgresql_instance,
  cmdb_ci_db_mysql_instance, cmdb_ci_lb_bigip, cmdb_ci_lb, cmdb_ci_appl, cmdb_ci_server.
- Owners are named_users keys, support groups are group keys, hosting locations are datacenter or
  cloud_region keys. depends_on_keys must not form a cycle.

infra (infrastructure, catalog, themes)
- hostname_pattern uses {site}, {env}, {role}, {app}, {n}. IP ranges are private CIDRs per location.
- network_devices use classes such as cmdb_ci_ip_switch, cmdb_ci_ip_router, cmdb_ci_ip_firewall.
- shared_services: directory, DNS, email, backup, monitoring and similar.
- catalog: 6-12 items employees would really request in this company, with 1-4 variables each.
  `choices` is empty unless type is `choice`.
- themes: 5-8 recurring operational storylines (outages, degradations, user issues, capacity,
  security, planned change), each tied to applications and tier roles where relevant, with concrete
  symptoms users would report, a root cause and the fix.
=== user ===
Scenario
- Industry: {{industry}}
- Company name: {{company_name}}
- Size: {{size_tier}} (about {{headcount}} staff)
- Regions and countries: {{regions}}
- Additional instructions from the demo builder: {{instructions}}

Blueprint sections already generated:
{{previous_sections}}

Now produce the "{{section_key}}" section ({{section_label}}). Return only the JSON object for this
section.
