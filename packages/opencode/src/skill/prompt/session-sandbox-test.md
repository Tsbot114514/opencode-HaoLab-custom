<!--
  Built-in skill. Name and description are registered in code at
  packages/opencode/src/skill/index.ts (see SESSION_SANDBOX_TEST_SKILL_NAME
  and SESSION_SANDBOX_TEST_SKILL_DESCRIPTION). The body below becomes the
  skill's content.
-->

# Session Sandbox Test

Use this skill to test session-local changes through isolated subagents. The goal is to verify whether a normal user request naturally triggers the behavior introduced by edited session files, without over-explaining the implementation to the test subagent.

Session-local changes can include prompt edits, local tools, local skills, assemble context files, schemas, README instructions, or other files under the current session directory.

## Required Workflow

Do not start testing immediately. First confirm the test goals with the user.

Ask concise questions to identify:

- What feature or behavior should be tested.
- How a normal user would try to trigger it.
- What result counts as success.
- Whether any tests are allowed to run in parallel.

After the user answers, create a test list and ask for confirmation before launching any subtask.

Each test list item should include:

- Test name.
- Normal-user request to send to the subagent.
- Expected behavior.
- Session-local capability being indirectly evaluated.
- Whether it must run sequentially or may run in parallel.

Do not launch subtasks until the user explicitly confirms the list with wording like "start", "confirmed", "run these", or an equivalent approval.

## Test Execution Order

Run tests in the confirmed list order by default.

Only run tests in parallel when the user explicitly says those tests may be parallelized. If the user has not granted parallel execution, use one subtask at a time and wait for its result before starting the next.

## Prompting The Subagent

When asking a subagent to test behavior, write the prompt from the perspective of an ordinary user. The subagent should receive a simple task request and should not be told which session-local implementation detail is under test.

The subagent prompt should include only information a normal user would reasonably provide:

- The user goal.
- Relevant project path or input material.
- Desired output format, if the user would naturally specify it.
- Any real constraints the user would naturally care about.

Do not tell the subagent:

- That this is a test of a session-local prompt, tool, skill, or assemble file.
- Which local tool, local skill, prompt, or context file should be used.
- To inspect the session folder or prove that something loaded.
- The hidden assertion or success criteria.
- Internal file structure or implementation details.

Bad subagent prompt:

```text
Please inspect the sandbox session folder and verify that the local-tool schema is loaded. Use the new local-tool if available and explain whether the session prompt changed your behavior.
```

Good subagent prompt:

```text
I want you to summarize the most recent project error into a short debugging checklist. Keep it practical and include the next command I should run.
```

The main agent is responsible for judging whether the subagent's behavior demonstrates that the session-local change worked.

## Sandbox Handling

If the user asks to migrate the session folder, create or use an isolated copy instead of modifying the original session directory directly.

Before working with session-local tools or assembled context, read the relevant contract files when present, such as:

- `tool/README.md` for session-local tools.
- `assemble-schema.md` for assembled context JSON files.

Do not guess unsupported file shapes.

If the runtime cannot actually make a subtask inherit or load the sandbox session content, say so clearly. Do not present a file-level inspection as a real runtime validation.

## Evaluation

After each test, report the result using this format:

- Normal user request.
- Subagent actual behavior.
- Expected behavior.
- Evidence observed.
- Pass/fail conclusion.
- Likely cause if it failed.

After all tests, summarize whether the session-local edits appear to work and what should be changed or retested next.

## Safety Rules

- Do not modify the original session directory unless the user explicitly asks for a fix.
- Do not delete sandbox directories unless the user explicitly asks.
- Do not let the test subagent edit code or session files unless the confirmed test requires it.
- If fixing is needed, make the fix in the intended source files, then repeat the confirmed sandbox test flow.
- Keep the test prompts natural; the value of the test is whether the behavior emerges without implementation-level hints.
