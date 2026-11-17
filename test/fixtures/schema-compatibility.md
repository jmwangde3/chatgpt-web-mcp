# Dependency upgrade schema verification (2026-11-17)

`full-toolset-schema-v3.json` contains complete input schemas obtained from the
original deployed runtime at `<deployment-checkout>/src/index.js`
using the official MCP SDK stdio client. Only initialization and listTools were
used. All ChatGPT/Gemini persistence paths and WEB_CHAT_DATA_DIR were isolated
under LOCALAPPDATA/Temp; browser executable overrides pointed to nonexistent files.
Both runtimes returned 63 tools and left the temporary directory empty.
All original input-schema SHA-256 values match the unchanged historical
`full-toolset-baseline.json`, including the original JSON object insertion order.
The fixture test rechecks that relationship without requiring the deployment.

The current comparison uses deep object equality, ignoring object key order
(including the position of `$schema`) while retaining its value, every validation
keyword, and array order. No constraints are deleted from either side.

Explicit allowed changes:

- `chatgpt_upload_files.properties.files.maxItems`: absent -> 10.
- `chatgpt_send_message.properties.files.maxItems`: absent -> 10.
- `chatgpt_route_new_chat.properties.files.maxItems`: absent -> 10.
- `chat_tasks.properties.offset.maximum`: absent -> 9007199254740991.
  Zod 4 integers exclude unsafe integers; the existing minimum 0 already provides
  the lower bound. Other integer fields already have stricter explicit bounds.

Verification result after the registration fix: `node --test test/toolsets.test.js`
passes all 6 tests. Full/default (63 tools) and unified (17 tools) preserve every
historical input-schema constraint except the four explicit changes above.
The original 63 historical hashes remain unchanged and match the complete fixture.

The previously observed loss of 48 `additionalProperties: false` keywords across
47 tools is resolved by strict object registration for nonempty shapes and strict
nested comparison targets. All 16 empty shapes retain their historical
`{type: 'object', properties: {}}` schema without an additionalProperties keyword;
unknown-key rejection is not claimed for these tools.

Actual MCP stdio calls verify root unknown-key rejection for `chat_status`
(`provider: 'chatgpt', unknown: 1`), `chatgpt_write_prompt`, and
`gemini_write_prompt`, plus nested unknown-key rejection in `chat_compare.targets`.
Each response is an input validation error identifying the unknown key, and the
isolated persistence directory remains empty. No browser is connected or launched.
This verifies runtime validation rather than only JSON Schema serialization.
Compatibility note: nonempty ordinary Zod objects previously stripped unknown
keys; strict objects now reject them, enforcing the historical published schema.
No production or dependency files are modified by this verification work.
