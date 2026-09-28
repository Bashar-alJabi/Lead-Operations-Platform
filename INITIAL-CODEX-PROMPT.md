# INITIAL CODEX PROMPT

You are responsible for implementing the complete **Lead Operations & Sales Management Platform** in this repository.

This is a **full production-ready product**, not an MVP, prototype, demo, partial implementation, or proof of concept.

## Read the complete specification first

Before making major implementation decisions, read and understand all of the following as one specification set:

```text
AGENTS.md
README.md
docs/00-comprehensive-functional-concept.md
docs/01-domain-model.md
docs/02-business-rules-permissions.md
docs/03-integrations-ui-requirements.md
docs/04-ai-agents-conversations.md
```

Then inspect the entire current repository and understand what already exists before modifying it.

The repository specifications define **what the product must do**.

You are responsible for deciding **how to build it technically**.

---

## Do not ask me to choose the technology stack

Choose the best production-ready technical stack and architecture yourself.

You are expected to choose and justify, as appropriate:

- Programming language.
- Backend framework.
- Frontend framework.
- Database.
- ORM/query layer.
- Authentication approach.
- Authorization architecture.
- Queue/background jobs.
- Cache.
- Search strategy.
- File/object storage.
- AI integration architecture.
- Messaging provider abstraction.
- Payment provider abstraction.
- Integration architecture.
- Testing stack.
- Deployment/container strategy.
- Observability.
- CI/CD structure where appropriate.

Do not ask me which framework, database, AI SDK, queue, cache, hosting provider, or ORM I prefer unless a documented business requirement genuinely depends on that choice.

Prefer the most robust, secure, scalable, maintainable, and operationally simple solution for the documented product.

Do not overengineer.

A well-designed modular monolith is acceptable if it is the best fit. Microservices are not required merely because the product is large.

---

## Execute, do not only plan

Create the technical architecture and implementation plan, but **do not stop after planning and do not wait for my approval of ordinary technical decisions**.

Create appropriate technical documentation inside the repository, for example:

```text
docs/technical-architecture.md
docs/implementation-plan.md
```

You may choose better filenames if appropriate.

After documenting the architecture and plan, continue directly into implementation.

Your job is to carry the project from the current repository state to the complete working product described by the specification.

Do not respond with only:

- an architecture proposal,
- a task list,
- a roadmap,
- pseudocode,
- a partial scaffold,
- a demo,
- or an MVP.

Implement the actual system.

---

## Do not repeatedly ask questions already answered by the specifications

Before asking any question:

1. Search all project documentation.
2. Search the current codebase.
3. Check whether the question is a technical decision you should make yourself.
4. Choose the safest and most maintainable solution when the ambiguity does not change business behavior.

Only ask me when there is a genuine blocker that cannot be resolved from the repository, such as:

- a real contradiction between business requirements,
- a missing business/legal decision that materially changes product behavior,
- or an external production credential/approval that cannot reasonably be replaced with a mock/sandbox during development.

If a real external credential is unavailable, do not stop the project. Build the provider adapter, setup UI, mocks/sandbox path, validation, failure handling, and tests, and continue with the rest of the system.

---

## Never depend on my personal external accounts during development

Do not silently connect or hardcode:

- my OpenAI account,
- my Meta account,
- my WhatsApp number,
- my payment account,
- or any other personal/production provider account.

External integrations must be implemented so that an authorized Super Admin or Manager can connect the appropriate provider/account **from inside the platform UI**, as defined in the specifications.

During development use:

- mocks,
- fakes,
- provider sandboxes,
- test doubles,
- or explicitly provided test credentials only.

Never place real credentials in source code.

---

## The platform must be scalable from the beginning

Assume the product will have:

- many active Campaigns,
- many Agents,
- many Leads arriving every day,
- concurrent users,
- large conversation histories,
- many webhooks,
- automation jobs,
- AI jobs,
- payment events,
- and growing analytics history.

Design so growth does not require rebuilding the product.

Use appropriate:

- indexing,
- pagination,
- connection pooling,
- background jobs,
- queues,
- retries,
- idempotency,
- rate-limit handling,
- bounded concurrency,
- efficient query patterns,
- observability,
- and scalable storage.

Do not load entire large datasets into memory or into the browser.

Do not use full-table scans as the normal path for common operational queries.

Do not let large imports, exports, analytics, or AI batch work block core Lead and Conversation operations.

Add meaningful performance/load tests for critical paths.

Do not invent business throughput numbers as facts. Document technical capacity assumptions and make the architecture measurable and horizontally scalable where appropriate.

---

## Security requirements are mandatory

Backend enforcement is required for:

- authentication,
- authorization,
- roles,
- branch isolation,
- Lead access,
- Conversation access,
- field visibility/editability,
- integration scope,
- AI tool access,
- payment operations,
- exports,
- bulk actions,
- and admin settings.

Frontend hiding is not security.

Protect:

- secrets,
- tokens,
- webhook endpoints,
- uploaded files,
- customer messages,
- AI context,
- logs,
- and sensitive provider configuration.

Implement appropriate:

- secure credential storage,
- session handling,
- password/credential reset,
- brute-force protection,
- signature verification,
- CSRF/XSS protections as applicable,
- input validation,
- rate limiting,
- replay protection,
- audit logging,
- and safe error handling.

---

## AI requirements are mandatory

Implement the documented:

- AI Lead Assistant,
- AI Operations Assistant,
- Campaign Knowledge,
- Knowledge Draft/Published versions,
- Qualification,
- AI follow-up policy,
- Human handoff,
- AI Copilot,
- AI tools,
- AI permissions,
- AI auditability,
- AI failure handling,
- and AI evaluations.

The AI must not have unrestricted direct database access for business actions.

Use approved tools/application services with authorization and validation.

Do not allow customer messages, imported content, or knowledge documents to override system rules or expand tool permissions.

Do not rely on self-reported LLM confidence as the only safety mechanism.

Keep AI facts grounded in platform data.

---

## Messaging requirements are mandatory

Implement Customer Conversations as part of Lead Operations.

The platform must support the documented separation between:

```text
Lead Owner
```

and:

```text
Conversation Controller
```

Agents must communicate with authorized Leads from inside the platform.

Agents must not see Leads or Conversations belonging to other Agents unless their permissions allow it.

Support the documented:

- inbound/outbound messages,
- provider message IDs,
- delivery state,
- AI/Human identity,
- handoff,
- provider policies,
- consent/do-not-contact state,
- templates when required,
- business/sending hours,
- multiple Messaging Connections/senders.

Do not reduce WhatsApp back to notification-only behavior.

---

## Integration setup must be UI-driven

Every operational integration setup defined in the specifications must be manageable from the platform UI according to permissions.

This includes, where applicable:

- Meta connections,
- Meta Pages/Forms,
- webhooks,
- Messaging/WhatsApp,
- AI providers,
- AI model profiles,
- Payment providers,
- Email,
- Google integrations,
- generic API/webhook lead sources.

Provide:

- setup guidance,
- credential/OAuth flow,
- test connection,
- status,
- last error,
- reconnect,
- disable,
- bindings,
- and relevant audit history.

If an external provider requires a step that cannot be completed through its API, guide the user through that external step from the platform UI and resume the setup inside the platform.

---

## Preserve the complete product scope

Do not remove, postpone, or downgrade documented functionality because it is difficult.

Do not label documented features as:

- V2,
- future work,
- optional later,
- or out of scope,

unless the specification explicitly says so.

The complete product includes all documented areas such as:

- Branches.
- Users.
- Contacts.
- Leads.
- Campaigns.
- Flexible Fields.
- Forms/source bindings.
- Meta intake.
- Routing.
- Capacity/working hours.
- Conversations.
- AI.
- Follow-ups.
- Activity/history.
- Notifications.
- Payments.
- Enrollment.
- Analytics.
- Automations.
- Search/filters.
- Saved Views.
- Bulk Actions.
- Import/export.
- Google Sheets.
- Integrations.
- Audit Logs.
- Arabic/French/English.
- RTL/LTR.
- Responsive/mobile Agent workflows.
- Security.
- Failure handling.
- Scalability.

---

## Preserve data integrity

Design and test for:

- duplicate webhook events,
- retries,
- concurrent routing,
- duplicate messages,
- duplicate payments,
- out-of-order callbacks,
- partial provider failures,
- reassignment,
- Agent deactivation,
- Contact ambiguity,
- multiple Leads for one Contact,
- historical integrity,
- and idempotent background jobs.

Never silently discard source submissions, customer messages, payment events, or important historical activity.

---

## Testing is part of implementation

A feature is not complete when code merely compiles.

Create and run appropriate:

- unit tests,
- integration tests,
- authorization tests,
- end-to-end tests,
- provider adapter tests,
- webhook tests,
- idempotency tests,
- concurrency tests,
- payment tests,
- AI evaluations,
- and load/performance tests.

Test happy paths and failure paths.

Fix failures before treating the corresponding feature as complete.

---

## Keep the repository clean and production-oriented

Do not leave:

- TODO implementations for documented core features,
- dead code,
- fake production behavior,
- hardcoded provider IDs,
- hardcoded credentials,
- temporary hacks,
- duplicated business logic,
- or unexplained architectural exceptions.

Use migrations for schema changes.

Provide seed/demo development data only in a clearly separated non-production way.

Do not make development fixtures a production dependency.

---

## Work continuously through the implementation

Organize the work into sensible phases, but continue from one phase to the next without waiting for routine confirmation.

At each phase:

1. inspect the relevant specifications,
2. implement,
3. run tests,
4. verify permissions and failure paths,
5. fix regressions,
6. update technical documentation when needed,
7. continue.

Do not stop merely because the project is large.

If the environment imposes a hard execution limit, leave the repository in a consistent, tested state and create a precise continuation record so the next Codex run can resume from the exact remaining work without rediscovery.

---

## Definition of done

The project is complete only when:

- the documented product is implemented end-to-end,
- the application builds and runs,
- database migrations work,
- required screens and workflows exist,
- permissions are enforced in the backend,
- integrations have production-ready adapters/setup flows,
- AI flows and human handoff work,
- core failure modes are handled,
- tests pass,
- critical paths have performance/load coverage,
- documentation explains local setup and production configuration,
- no personal provider account is required by the codebase,
- and the repository is in a state suitable for deployment.

At completion, provide a concise final report containing:

- architecture actually used,
- major implemented modules,
- how to run locally,
- required environment/infrastructure dependencies,
- how Super Admin connects external providers from the UI,
- migrations/seeding instructions,
- test commands and results,
- deployment guidance,
- any external provider approvals/credentials that the operator must still supply,
- and any genuine remaining blocker that cannot be solved inside the codebase.

Start now by reading the files listed at the top, inspecting the repository, documenting the technical architecture and implementation plan, and then proceed directly with the full implementation.
