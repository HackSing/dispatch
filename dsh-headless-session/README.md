# @aiwaretop/dsh-headless-session

A dsh bundle that adds durable, resumable one-shot sessions to the headless profile: it replaces the `dsh-headless` startup/runner pair with a session-aware pair that accepts `--session-id <id>` (create the fresh run's session under that id) or `--resume <id>` (continue an existing session), so a task can be answered once and later continued from another working directory. This bundle's patch also opens the sandbox (`danger-full-access`) and disables approvals (`never`) — for the `headless-dispatch` profile only.

```sh
dsh --profile headless-dispatch --session-id <uuid> "run the tests"
dsh --profile headless-dispatch --resume <uuid> "what was the result?"
```
