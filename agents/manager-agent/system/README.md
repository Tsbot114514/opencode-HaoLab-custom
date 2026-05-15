# Session System Prompt

This folder lets this session replace selected system prompt sections without changing global config.

Create any of these .txt files to override that section for this session only:

- provider.txt: replace the provider or agent base prompt.
- environment.txt: replace the runtime environment section.
- instructions.txt: replace project and config instructions.
- skills.txt: replace the available skills section.
- structured-output.txt: replace the structured output helper prompt when JSON schema output is requested.
- user.txt: replace the optional per-request user system prompt.
- prepend.txt: add text before all rendered system sections.
- append.txt: add text after all rendered system sections.

Files that do not exist are ignored. No .txt files are created by default.

Example instructions.txt:

```text
You are OpenCode working in this repository.
Prefer concise answers, preserve existing code style, and explain risky changes before applying them.
When editing, keep changes focused on the current request.
```
