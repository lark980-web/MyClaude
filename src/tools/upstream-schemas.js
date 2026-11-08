// 本文件由 scripts/gen-upstream-schemas.mjs 生成，请勿手改。
// 上游事实来源：docs/tool-schemas-2.1.302.json（AST 级抽取，Claude Code 2.1.302）。

export const UPSTREAM_TOOL_SCHEMAS = {
  "_meta": {
    "generatedBy": "scripts/gen-upstream-schemas.mjs",
    "upstreamSource": "docs/tool-schemas-2.1.302.json",
    "upstreamVersion": "2.1.302",
    "note": "MyClaude 的工具契约（description 之外的参数面）逐字采用上游；run() 执行体仍是 MyClaude 自研。",
    "decisions": [
      {
        "name": "Read",
        "mode": "merge",
        "required": [
          "file_path",
          "offset",
          "limit",
          "pages",
          "allow_large"
        ],
        "properties": [
          "file_path",
          "offset",
          "limit",
          "pages",
          "allow_large"
        ]
      },
      {
        "name": "Write",
        "mode": "adopt",
        "required": [
          "file_path",
          "content"
        ],
        "properties": [
          "file_path",
          "content"
        ]
      },
      {
        "name": "Edit",
        "mode": "adopt",
        "required": [
          "file_path",
          "old_string",
          "new_string"
        ],
        "properties": [
          "file_path",
          "old_string",
          "new_string",
          "replace_all"
        ]
      },
      {
        "name": "Glob",
        "mode": "adopt",
        "required": [
          "pattern"
        ],
        "properties": [
          "pattern",
          "path"
        ]
      },
      {
        "name": "Grep",
        "mode": "merge",
        "required": [
          "pattern"
        ],
        "properties": [
          "pattern",
          "path",
          "glob",
          "output_mode",
          "-B",
          "-A",
          "-C",
          "context",
          "-n",
          "-i",
          "-o",
          "type",
          "head_limit",
          "offset",
          "multiline",
          "i",
          "n",
          "A",
          "B",
          "C",
          "max_results"
        ]
      },
      {
        "name": "Bash",
        "mode": "merge",
        "required": [
          "command"
        ],
        "properties": [
          "command",
          "timeout",
          "description",
          "run_in_background",
          "dangerouslyDisableSandbox",
          "_simulatedSedEdit",
          "cwd",
          "timeout_ms",
          "signal"
        ]
      },
      {
        "name": "TodoWrite",
        "mode": "adopt",
        "required": [
          "todos"
        ],
        "properties": [
          "todos"
        ]
      },
      {
        "name": "NotebookEdit",
        "mode": "merge",
        "required": [
          "notebook_path",
          "new_source"
        ],
        "properties": [
          "notebook_path",
          "cell_id",
          "new_source",
          "cell_type",
          "edit_mode",
          "cell_index"
        ]
      },
      {
        "name": "WebFetch",
        "mode": "merge",
        "required": [
          "url",
          "prompt"
        ],
        "properties": [
          "url",
          "prompt",
          "offset",
          "max_chars"
        ]
      },
      {
        "name": "WebSearch",
        "mode": "merge",
        "required": [
          "query"
        ],
        "properties": [
          "query",
          "allowed_domains",
          "blocked_domains",
          "block_domains",
          "max_results"
        ]
      },
      {
        "name": "Task",
        "mode": "adopt",
        "required": [
          "description",
          "prompt"
        ],
        "properties": [
          "description",
          "prompt",
          "subagent_type",
          "model",
          "effort",
          "run_in_background",
          "name",
          "team_name",
          "mode",
          "isolation"
        ]
      },
      {
        "name": "AskUserQuestion",
        "mode": "adopt",
        "required": [
          "questions"
        ],
        "properties": [
          "questions",
          "answers",
          "annotations",
          "metadata"
        ]
      },
      {
        "name": "EnterPlanMode",
        "mode": "adopt",
        "required": [],
        "properties": []
      },
      {
        "name": "ExitPlanMode",
        "mode": "merge",
        "required": [],
        "properties": [
          "allowedPrompts",
          "plan"
        ]
      },
      {
        "name": "ListMcpResources",
        "mode": "adopt",
        "required": [],
        "properties": [
          "server"
        ]
      },
      {
        "name": "ReadMcpResource",
        "mode": "adopt",
        "required": [
          "server",
          "uri"
        ],
        "properties": [
          "server",
          "uri"
        ]
      },
      {
        "name": "Skill",
        "mode": "adopt",
        "required": [
          "skill"
        ],
        "properties": [
          "skill",
          "args"
        ]
      }
    ]
  },
  "tools": {
    "Read": {
      "schema": {
        "type": "object",
        "properties": {
          "file_path": {
            "description": "The absolute path to the file to read",
            "type": "string"
          },
          "offset": {
            "x-unknown-node": "ZodTransform"
          },
          "limit": {
            "x-unknown-node": "ZodTransform"
          },
          "pages": {
            "x-unknown-node": "ZodTransform"
          },
          "allow_large": {
            "x-unknown-node": "ZodTransform"
          }
        },
        "required": [
          "file_path",
          "offset",
          "limit",
          "pages",
          "allow_large"
        ],
        "additionalProperties": false
      },
      "upstreamName": null,
      "notes": {},
      "source": {
        "file": "02-modules/files/chunk-e0x0xb6d.js",
        "line": 3236,
        "byteOffset": 3959550,
        "inputSchemaGetter": "(){return IXr()}",
        "schemaBuilder": "IXr",
        "builderResolution": "ok"
      },
      "searchHint": "read files, images, PDFs, notebooks",
      "description": "Read a file from the local filesystem."
    },
    "Write": {
      "schema": {
        "type": "object",
        "properties": {
          "file_path": {
            "type": "string",
            "description": "The absolute path to the file to write (must be absolute, not relative)"
          },
          "content": {
            "type": "string",
            "description": "The content to write to the file"
          }
        },
        "required": [
          "file_path",
          "content"
        ],
        "additionalProperties": false
      },
      "upstreamName": null,
      "notes": {
        "upstreamSpreads": [
          "PK()"
        ]
      },
      "source": {
        "file": "02-modules/files/chunk-e0x0xb6d.js",
        "line": 688,
        "byteOffset": 1281896,
        "inputSchemaGetter": "(){return YGt()}",
        "schemaBuilder": "YGt",
        "builderResolution": "ok"
      },
      "searchHint": "create or overwrite files",
      "description": "Write a file to the local filesystem."
    },
    "Edit": {
      "schema": {
        "type": "object",
        "properties": {
          "file_path": {
            "type": "string",
            "description": "The absolute path to the file to modify"
          },
          "old_string": {
            "type": "string",
            "description": "The text to replace"
          },
          "new_string": {
            "type": "string",
            "description": "The text to replace it with (must be different from old_string)"
          },
          "replace_all": {
            "type": "boolean",
            "description": "Replace all occurrences of old_string (default false)",
            "default": false
          }
        },
        "required": [
          "file_path",
          "old_string",
          "new_string"
        ],
        "additionalProperties": false
      },
      "upstreamName": null,
      "notes": {
        "upstreamSpreads": [
          "PK()"
        ]
      },
      "source": {
        "file": "02-modules/files/chunk-e0x0xb6d.js",
        "line": 3536,
        "byteOffset": 4602032,
        "inputSchemaGetter": "(){return ehe()}",
        "schemaBuilder": "ehe",
        "builderResolution": "ok"
      },
      "searchHint": "modify file contents in place",
      "description": "A tool for editing files"
    },
    "Glob": {
      "schema": {
        "type": "object",
        "properties": {
          "pattern": {
            "type": "string",
            "description": "The glob pattern to match files against"
          },
          "path": {
            "type": "string",
            "description": "The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter \"undefined\" or \"null\" - simply omit it for the default behavior. Must be a valid directory path if provided."
          }
        },
        "required": [
          "pattern"
        ],
        "additionalProperties": false
      },
      "upstreamName": null,
      "notes": {
        "upstreamSpreads": [
          "PK()"
        ]
      },
      "source": {
        "file": "02-modules/files/chunk-e0x0xb6d.js",
        "line": 696,
        "byteOffset": 1310622,
        "inputSchemaGetter": "(){return dHo()}",
        "schemaBuilder": "dHo",
        "builderResolution": "ok"
      },
      "searchHint": "find files by name pattern or wildcard",
      "description": "- Fast file pattern matching tool that works with any codebase size\n- Supports glob patterns like \"**/*.js\" or \"src/**/*.ts\"\n- Returns matching file paths sorted by modification time\n- Use this tool when you need to find files by name patterns\n- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead (if available)"
    },
    "Grep": {
      "schema": {
        "type": "object",
        "properties": {
          "pattern": {
            "type": "string",
            "description": "The regular expression pattern to search for in file contents"
          },
          "path": {
            "type": "string",
            "description": "File or directory to search in (rg PATH). Defaults to current working directory."
          },
          "glob": {
            "type": "string",
            "description": "Glob pattern to filter files (e.g. \"*.js\", \"*.{ts,tsx}\") - maps to rg --glob"
          },
          "output_mode": {
            "type": "string",
            "enum": [
              "content",
              "files_with_matches",
              "count"
            ],
            "description": "Output mode: \"content\" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), \"files_with_matches\" shows file paths (supports head_limit), \"count\" shows match counts (supports head_limit). Defaults to \"files_with_matches\"."
          },
          "-B": {
            "type": "number",
            "description": "Number of lines to show before each match (rg -B). Requires output_mode: \"content\", ignored otherwise."
          },
          "-A": {
            "type": "number",
            "description": "Number of lines to show after each match (rg -A). Requires output_mode: \"content\", ignored otherwise."
          },
          "-C": {
            "type": "number",
            "description": "Alias for context."
          },
          "context": {
            "type": "number",
            "description": "Number of lines to show before and after each match (rg -C). Requires output_mode: \"content\", ignored otherwise."
          },
          "-n": {
            "type": "boolean",
            "description": "Show line numbers in output (rg -n). Requires output_mode: \"content\", ignored otherwise. Defaults to true."
          },
          "-i": {
            "type": "boolean",
            "description": "Case insensitive search (rg -i)"
          },
          "-o": {
            "type": "boolean",
            "description": "Print only the matched (non-empty) parts of each matching line, one match per output line (rg -o / --only-matching). Requires output_mode: \"content\", ignored otherwise. Defaults to false."
          },
          "type": {
            "type": "string",
            "description": "File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types."
          },
          "head_limit": {
            "type": "number",
            "description": "Limit output to first N lines/entries, equivalent to \"| head -N\". Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count (limits count entries). Defaults to 250 when unspecified. Pass 0 for unlimited (use sparingly — large result sets waste context)."
          },
          "offset": {
            "type": "number",
            "description": "Skip first N lines/entries before applying head_limit, equivalent to \"| tail -n +N | head -N\". Works across all output modes. Defaults to 0."
          },
          "multiline": {
            "type": "boolean",
            "description": "Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false."
          },
          "i": {
            "type": "boolean",
            "description": "MyClaude 兼容别名：等同上游 -i（忽略大小写）。"
          },
          "n": {
            "type": "boolean",
            "description": "MyClaude 兼容别名：等同上游 -n（显示行号）。"
          },
          "A": {
            "type": "number",
            "description": "MyClaude 兼容别名：等同上游 -A（匹配行后上下文行数）。"
          },
          "B": {
            "type": "number",
            "description": "MyClaude 兼容别名：等同上游 -B（匹配行前上下文行数）。"
          },
          "C": {
            "type": "number",
            "description": "MyClaude 兼容别名：等同上游 -C（上下文行数）。"
          },
          "max_results": {
            "type": "number",
            "description": "MyClaude 兼容别名：等同上游 head_limit（最多返回条数）。"
          }
        },
        "required": [
          "pattern"
        ],
        "additionalProperties": false
      },
      "upstreamName": null,
      "notes": {
        "myClaudeAliases": {
          "i": true,
          "n": true,
          "A": true,
          "B": true,
          "C": true,
          "max_results": true
        },
        "upstreamSpreads": [
          "PK()"
        ]
      },
      "source": {
        "file": "02-modules/files/chunk-e0x0xb6d.js",
        "line": 698,
        "byteOffset": 1316857,
        "inputSchemaGetter": "(){return bzt()}",
        "schemaBuilder": "bzt",
        "builderResolution": "ok"
      },
      "searchHint": "search file contents with regex (ripgrep)",
      "description": "A powerful search tool built on ripgrep\n\n  Usage:\n  - ALWAYS use Grep for search tasks. NEVER invoke `grep` or `rg` as a Bash command. The Grep tool has been optimized for correct permissions and access.\n  - Supports full regex syntax (e.g., \"log.*Error\", \"function\\s+\\w+\")\n  - Filter files with glob parameter (e.g., \"*.js\", \"**/*.tsx\") or type parameter (e.g., \"js\", \"py\", \"rust\")\n  - Output modes: \"content\" shows matching lines, \"files_with_matches\" shows only file paths (default), \"count\" shows match counts\n  - Use Agent tool (if available) for open-ended searches requiring multiple rounds\n  - Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use `interface\\{\\}` to find `interface{}` in Go code)\n  - Multiline matching: By default patterns match within single lines only. For cross-line patterns like `struct \\{[\\s\\S]*?field`, use `multiline: true`\n"
    },
    "Bash": {
      "schema": {
        "type": "object",
        "properties": {
          "command": {
            "type": "string",
            "description": "The command to execute"
          },
          "timeout": {
            "type": "number",
            "description": "Optional timeout in milliseconds (max <runtime Y$()> for a foreground command)"
          },
          "description": {
            "type": "string",
            "description": "Clear, concise description of what this command does in active voice. ... (long template)"
          },
          "run_in_background": {
            "type": "boolean",
            "description": "<runtime $Hn()>"
          },
          "dangerouslyDisableSandbox": {
            "type": "boolean",
            "description": "Set this to true to dangerously override sandbox mode and run commands without sandboxing."
          },
          "_simulatedSedEdit": {
            "type": "object",
            "description": "Internal: pre-computed sed edit result from preview"
          },
          "cwd": {
            "type": "string",
            "description": "MyClaude 扩展：工作目录（上游无此参数）。"
          },
          "timeout_ms": {
            "type": "number",
            "description": "MyClaude 兼容别名：等同上游 timeout（毫秒）。"
          },
          "signal": {
            "type": "string",
            "description": "MyClaude 扩展：终止后台 shell 的信号名（上游无此参数）。"
          }
        },
        "required": [
          "command"
        ],
        "additionalProperties": false
      },
      "upstreamName": null,
      "notes": {
        "myClaudeAliases": {
          "cwd": true,
          "timeout_ms": true,
          "signal": true
        },
        "upstreamConditionals": [
          "...!1 (literal false spread, no effect)",
          "...mSe()&&UAt() (feature-gated extra fields, not statically enumerable)",
          "...PK() (attached-machine computed-key field)"
        ]
      },
      "source": {
        "file": "02-modules/files/chunk-e0x0xb6d.js",
        "line": 3610,
        "byteOffset": 4771174,
        "inputSchemaGetter": "(){return SYn()}",
        "schemaBuilder": "SYn",
        "builderResolution": "ok"
      },
      "searchHint": "execute shell commands",
      "description": "Run shell command"
    },
    "TodoWrite": {
      "schema": {
        "type": "object",
        "properties": {
          "todos": {
            "description": "The updated todo list",
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "content": {
                  "type": "string"
                },
                "status": {
                  "type": "string",
                  "enum": [
                    "pending",
                    "in_progress",
                    "completed"
                  ]
                },
                "activeForm": {
                  "type": "string"
                }
              },
              "required": [
                "content",
                "status",
                "activeForm"
              ],
              "additionalProperties": false
            }
          }
        },
        "required": [
          "todos"
        ],
        "additionalProperties": false
      },
      "upstreamName": null,
      "notes": {},
      "source": {
        "file": "02-modules/files/chunk-gwd0s2d1.js",
        "line": 212,
        "byteOffset": 62500,
        "inputSchemaGetter": "(){return ks()}",
        "schemaBuilder": "ks",
        "builderResolution": "ok"
      },
      "searchHint": "manage the session task checklist",
      "description": "Update the todo list for the current session. To be used proactively and often to track progress and pending tasks. Make sure that at least one task is in_progress at all times. Always provide both content (imperative) and activeForm (present continuous) for each task."
    },
    "NotebookEdit": {
      "schema": {
        "type": "object",
        "properties": {
          "notebook_path": {
            "type": "string",
            "description": "The absolute path to the Jupyter notebook file to edit (must be absolute, not relative)"
          },
          "cell_id": {
            "type": "string",
            "description": "The ID of the cell to edit. When inserting a new cell, the new cell will be inserted after the cell with this ID, or at the beginning if not specified."
          },
          "new_source": {
            "type": "string",
            "description": "The new source for the cell"
          },
          "cell_type": {
            "type": "string",
            "enum": [
              "code",
              "markdown"
            ],
            "description": "The type of the cell (code or markdown). If not specified, it defaults to the current cell type. If using edit_mode=insert, this is required."
          },
          "edit_mode": {
            "type": "string",
            "enum": [
              "replace",
              "insert",
              "delete"
            ],
            "description": "The type of edit to make (replace, insert, delete). Defaults to replace."
          },
          "cell_index": {
            "type": "number",
            "description": "MyClaude 扩展：按序号定位单元格（上游用 cell_id）。"
          }
        },
        "required": [
          "notebook_path",
          "new_source"
        ],
        "additionalProperties": false
      },
      "upstreamName": null,
      "notes": {
        "myClaudeAliases": {
          "cell_index": true
        }
      },
      "source": {
        "file": "02-modules/files/chunk-e0x0xb6d.js",
        "line": 3545,
        "byteOffset": 4617337,
        "inputSchemaGetter": "(){return kis()}",
        "schemaBuilder": "kis",
        "builderResolution": "ok"
      },
      "searchHint": "edit Jupyter notebook cells (.ipynb)",
      "description": "Edit a cell in a Jupyter notebook — replace, insert, or delete."
    },
    "WebFetch": {
      "schema": {
        "type": "object",
        "properties": {
          "url": {
            "type": "string",
            "format": "uri",
            "description": "The URL to fetch content from"
          },
          "prompt": {
            "type": "string",
            "description": "The prompt to run on the fetched content"
          },
          "offset": {
            "type": "integer",
            "minimum": 0,
            "description": "Character position in the page text to start reading from. Use it to read on through a page too long for one call, with the value the previous result gave."
          },
          "max_chars": {
            "type": "number",
            "description": "MyClaude 扩展：最多抓取字符数（上游无此参数）。"
          }
        },
        "required": [
          "url",
          "prompt"
        ],
        "additionalProperties": false
      },
      "upstreamName": null,
      "notes": {
        "myClaudeAliases": {
          "max_chars": true
        }
      },
      "source": {
        "file": "02-modules/files/chunk-e0x0xb6d.js",
        "line": 2136,
        "byteOffset": 2530849,
        "inputSchemaGetter": "(){return _cn()}",
        "schemaBuilder": "_cn",
        "builderResolution": "ok"
      },
      "searchHint": "fetch and extract content from a URL",
      "description": "Claude wants to fetch content from this URL"
    },
    "WebSearch": {
      "schema": {
        "type": "object",
        "properties": {
          "query": {
            "description": "The search query to use",
            "type": "string"
          },
          "allowed_domains": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "Only include search results from these domains"
          },
          "blocked_domains": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "Never include search results from these domains"
          },
          "block_domains": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "MyClaude 兼容别名：等同上游 blocked_domains。"
          },
          "max_results": {
            "type": "number",
            "description": "MyClaude 扩展：最多返回结果数（上游无此参数）。"
          }
        },
        "required": [
          "query"
        ],
        "additionalProperties": false
      },
      "upstreamName": null,
      "notes": {
        "myClaudeAliases": {
          "block_domains": true,
          "max_results": true
        }
      },
      "source": {
        "file": "02-modules/files/chunk-gwd0s2d1.js",
        "line": 22,
        "byteOffset": 42850,
        "inputSchemaGetter": "(){return xft()?ds():ko()}",
        "schemaBuilder": null,
        "builderResolution": null
      },
      "searchHint": "search the web for current information",
      "description": "Claude wants to search the web for: undefined"
    },
    "Task": {
      "schema": {
        "type": "object",
        "properties": {
          "description": {
            "description": "A short (3-5 word) description of the task",
            "type": "string"
          },
          "prompt": {
            "description": "The task for the agent to perform",
            "type": "string"
          },
          "subagent_type": {
            "type": "string",
            "description": "The type of specialized agent to use for this task"
          },
          "model": {
            "type": "string",
            "enum": [
              "sonnet",
              "opus",
              "haiku",
              "fable"
            ],
            "description": "Optional model override for this agent. Takes precedence over the agent definition's model frontmatter and the configured default subagent model. If omitted, uses the agent definition's model, else the default (inherits from the parent unless a default subagent model is configured). Ignored for subagent_type: \"fork\" — forks always inherit the parent model."
          },
          "effort": {
            "type": "string",
            "enum": [
              "low",
              "medium",
              "high",
              "xhigh",
              "max"
            ],
            "description": "Reasoning effort for this agent. Set this ONLY when the user, or instructions such as CLAUDE.md or a skill, explicitly ask that this agent or delegated work run at a specific effort level, never on your own judgment; otherwise omit it and the agent runs at its usual effort. Ignored for subagent_type: \"fork\": a fork runs at your own effort."
          },
          "run_in_background": {
            "type": "boolean",
            "description": "Agents run in the background by default; you will be notified when one completes. Set to false only when your very next action depends on this agent's result and nothing else could usefully happen while it runs — otherwise leave it in the background so the user can hand you other work."
          },
          "name": {
            "type": "string",
            "description": "Name for the spawned agent. Makes it addressable via SendMessage({to: name}) while running."
          },
          "team_name": {
            "type": "string",
            "description": "Deprecated; ignored. The session has a single implicit team."
          },
          "mode": {
            "x-unknown-node": "ZodTransform",
            "description": "Deprecated; ignored. Subagents inherit the parent session's permission mode; agent-definition frontmatter may override it."
          },
          "isolation": {
            "type": "string",
            "enum": [
              "worktree",
              "remote"
            ],
            "description": "Isolation mode. \"worktree\" creates a temporary git worktree so the agent works on an isolated copy of the repo. \"remote\" launches the agent in a remote cloud environment (always runs in background; availability is gated)."
          }
        },
        "required": [
          "description",
          "prompt"
        ],
        "additionalProperties": false
      },
      "upstreamName": "Agent",
      "notes": {},
      "source": {
        "file": "02-modules/files/chunk-1nry7a4r.js",
        "line": 14,
        "byteOffset": 45987,
        "inputSchemaGetter": "(){return VYr()}",
        "schemaBuilder": "VYr",
        "builderResolution": "function"
      },
      "searchHint": "delegate work to a subagent",
      "description": "Launch a new agent"
    },
    "AskUserQuestion": {
      "schema": {
        "type": "object",
        "properties": {
          "questions": {
            "description": "Questions to ask the user (1-4 questions)",
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "question": {
                  "description": "The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: \"Which library should we use for date formatting?\" If multiSelect is true, phrase it accordingly, e.g. \"Which features do you want to enable?\"",
                  "type": "string"
                },
                "header": {
                  "description": "Very short label displayed as a chip/tag (max 12 chars). Examples: \"Auth method\", \"Library\", \"Approach\".",
                  "type": "string"
                },
                "options": {
                  "description": "The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). There should be no 'Other' option, that will be provided automatically.",
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "label": {
                        "description": "The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.",
                        "type": "string"
                      },
                      "description": {
                        "description": "Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.",
                        "type": "string"
                      },
                      "preview": {
                        "type": "string",
                        "description": "Optional preview content rendered when this option is focused. Use for mockups, code snippets, or visual comparisons that help users compare options. See the tool description for the expected content format."
                      }
                    },
                    "required": [
                      "label",
                      "description"
                    ],
                    "additionalProperties": false
                  }
                },
                "multiSelect": {
                  "type": "boolean",
                  "description": "Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.",
                  "default": false
                }
              },
              "required": [
                "question",
                "header",
                "options"
              ],
              "additionalProperties": false
            }
          },
          "answers": {
            "type": "object",
            "additionalProperties": {
              "x-unknown-node": "ZodTransform"
            },
            "description": "User answers collected by the permission component"
          },
          "annotations": {
            "type": "object",
            "additionalProperties": {
              "type": "object",
              "properties": {
                "preview": {
                  "type": "string",
                  "description": "The preview content of the selected option, if the question used previews."
                },
                "notes": {
                  "type": "string",
                  "description": "Free-text notes the user added to their selection."
                }
              },
              "required": [],
              "additionalProperties": false
            },
            "description": "Optional per-question annotations from the user (e.g., notes on preview selections). Keyed by question text."
          },
          "metadata": {
            "type": "object",
            "properties": {
              "source": {
                "type": "string",
                "description": "Optional identifier for the source of this question (e.g., \"remember\" for /remember command). Used for analytics tracking."
              }
            },
            "required": [],
            "additionalProperties": false,
            "description": "Optional metadata for tracking and analytics purposes. Not displayed to user."
          }
        },
        "required": [
          "questions"
        ],
        "additionalProperties": false
      },
      "upstreamName": null,
      "notes": {},
      "source": {
        "file": "02-modules/files/chunk-4kgb9k1d.js",
        "line": 11,
        "byteOffset": 12918,
        "inputSchemaGetter": "(){if(GTe())return be();return m2o()?ge():ye()}",
        "schemaBuilder": null,
        "builderResolution": null
      },
      "searchHint": "prompt the user with a multiple-choice question",
      "description": "Asks the user multiple choice questions to gather information, clarify ambiguity, understand preferences, make decisions or offer them choices."
    },
    "EnterPlanMode": {
      "schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      },
      "upstreamName": null,
      "notes": {},
      "source": {
        "file": "02-modules/files/chunk-qjshqk3j.js",
        "line": 101,
        "byteOffset": 29670,
        "inputSchemaGetter": "(){return He()}",
        "schemaBuilder": "He",
        "builderResolution": "ok"
      },
      "searchHint": "switch to plan mode to design an approach before coding",
      "description": "Requests permission to enter plan mode for complex tasks requiring exploration and design"
    },
    "ExitPlanMode": {
      "schema": {
        "type": "object",
        "properties": {
          "allowedPrompts": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "tool": {
                  "type": "string",
                  "enum": [
                    "Bash"
                  ],
                  "description": "The tool this prompt applies to"
                },
                "prompt": {
                  "type": "string",
                  "description": "Semantic description of the action, e.g. \"run tests\", \"install dependencies\""
                }
              },
              "required": [
                "tool",
                "prompt"
              ]
            },
            "description": "Deprecated: no longer used."
          },
          "plan": {
            "type": "string",
            "description": "MyClaude 扩展：计划的 markdown 正文（上游已弃用参数面，仅保留 allowedPrompts）。"
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "upstreamName": null,
      "notes": {
        "myClaudeAliases": {
          "plan": true
        }
      },
      "source": {
        "file": "02-modules/files/chunk-vkky4a9v.js",
        "line": 36,
        "byteOffset": 6272,
        "inputSchemaGetter": "(){return R()}",
        "schemaBuilder": "R",
        "builderResolution": "ok"
      },
      "searchHint": "present plan for approval and start coding (plan mode only)",
      "description": "Prompts the user to exit plan mode and start coding"
    },
    "ListMcpResources": {
      "schema": {
        "type": "object",
        "properties": {
          "server": {
            "type": "string",
            "description": "Optional server name to filter resources by"
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "upstreamName": "ListMcpResourcesTool",
      "notes": {},
      "source": {
        "file": "02-modules/files/chunk-s73gkqs8.js",
        "line": 11,
        "byteOffset": 2385,
        "inputSchemaGetter": "(){return U()}",
        "schemaBuilder": "U",
        "builderResolution": "ok"
      },
      "searchHint": "list resources from connected MCP servers",
      "description": "\nLists available resources from configured MCP servers.\nEach resource object includes a 'server' field indicating which server it's from.\n\nUsage examples:\n- List all resources from all servers: `listMcpResources`\n- List resources from a specific server: `listMcpResources({ server: \"myserver\" })`\n"
    },
    "ReadMcpResource": {
      "schema": {
        "type": "object",
        "properties": {
          "server": {
            "type": "string",
            "description": "The MCP server name"
          },
          "uri": {
            "type": "string",
            "description": "The resource URI to read"
          }
        },
        "required": [
          "server",
          "uri"
        ],
        "additionalProperties": false
      },
      "upstreamName": "ReadMcpResourceTool",
      "notes": {},
      "source": {
        "file": "02-modules/files/chunk-s73gkqs8.js",
        "line": 15,
        "byteOffset": 9352,
        "inputSchemaGetter": "(){return G()}",
        "schemaBuilder": "G",
        "builderResolution": "ok"
      },
      "searchHint": "read a specific MCP resource by URI",
      "description": "\nReads a specific resource from an MCP server.\n- server: The name of the MCP server to read from\n- uri: The URI of the resource to read\n\nUsage examples:\n- Read a resource from a server: `readMcpResource({ server: \"myserver\", uri: \"my-resource-uri\" })`\n"
    },
    "Skill": {
      "schema": {
        "type": "object",
        "properties": {
          "skill": {
            "type": "string",
            "description": "The name of a skill from the available-skills list. Do not guess names."
          },
          "args": {
            "type": "string",
            "description": "Optional arguments for the skill"
          }
        },
        "required": [
          "skill"
        ],
        "additionalProperties": false
      },
      "upstreamName": null,
      "notes": {},
      "source": {
        "file": "02-modules/files/chunk-qjshqk3j.js",
        "line": 11,
        "byteOffset": 15523,
        "inputSchemaGetter": "(){return xe()}",
        "schemaBuilder": "xe",
        "builderResolution": "ok"
      },
      "searchHint": "invoke a slash-command skill",
      "description": "Execute skill: undefined"
    }
  }
};

/** 取某工具的上游契约；没有则返回 null（调用方保留自研 schema）。 */
export function upstreamSchema(name) {
  const e = UPSTREAM_TOOL_SCHEMAS.tools[name];
  return e ? e.schema : null;
}

/** 取某工具的上游描述词；没有则返回 null（调用方保留自研描述词）。 */
export function upstreamDescription(name) {
  const e = UPSTREAM_TOOL_SCHEMAS.tools[name];
  return e && e.description ? e.description : null;
}

/** 该工具是否采用/合并了上游契约。 */
export function usesUpstreamSchema(name) {
  return Boolean(UPSTREAM_TOOL_SCHEMAS.tools[name]);
}
