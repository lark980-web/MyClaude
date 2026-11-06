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
          "file_path"
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
        "mode": "own",
        "reason": "upstream inputSchema is a runtime-branch getter; not statically reducible"
      },
      {
        "name": "AskUserQuestion",
        "mode": "own",
        "reason": "upstream inputSchema is a runtime-branch getter; not statically reducible"
      },
      {
        "name": "ExitPlanMode",
        "mode": "own",
        "reason": "upstream contract is allowedPrompts; MyClaude uses plan"
      }
    ]
  },
  "tools": {
    "Read": {
      "schema": {
        "type": "object",
        "properties": {
          "file_path": {
            "type": "string",
            "description": "The absolute path to the file to read"
          },
          "offset": {
            "type": "integer",
            "minimum": 0,
            "description": "The line number to start reading from. Only provide if the file is too large to read at once"
          },
          "limit": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "description": "The number of lines to read. Only provide if the file is too large to read at once."
          },
          "pages": {
            "type": "string"
          },
          "allow_large": {
            "description": "Set to true to read a text file, or a line range of one, that is over the usual size limits, up to what still fits in your context. Only use this when you genuinely need all of it or the user asked for the whole file; otherwise read it in parts with offset and limit, or search it."
          }
        },
        "required": [
          "file_path"
        ],
        "additionalProperties": false
      },
      "notes": {
        "renamedProperties": {
          "[computed:[Rge]]": "allow_large"
        },
        "unresolvedProperties": {
          "allow_large": "\"allow_large\""
        },
        "upstreamSpreads": [
          "PK()"
        ]
      },
      "source": {
        "file": "02-modules/files/chunk-e0x0xb6d.js",
        "line": 3236,
        "byteOffset": 3959550,
        "inputSchemaGetter": "(){return IXr()}",
        "schemaBuilder": "IXr",
        "builderResolution": "ok"
      },
      "searchHint": "read files, images, PDFs, notebooks"
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
      "searchHint": "create or overwrite files"
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
      "searchHint": "modify file contents in place"
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
      "searchHint": "find files by name pattern or wildcard"
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
      "searchHint": "search file contents with regex (ripgrep)"
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
      "searchHint": "execute shell commands"
    },
    "TodoWrite": {
      "schema": {
        "type": "object",
        "properties": {
          "todos": {
            "type": "object",
            "properties": {
              "content": {
                "type": "string",
                "minimum": "1,\"Content cannot be empty\""
              },
              "status": {
                "type": "unknown"
              },
              "activeForm": {
                "type": "string",
                "minimum": "1,\"Active form cannot be empty\""
              }
            },
            "required": [
              "content",
              "status",
              "activeForm"
            ],
            "description": "The updated todo list"
          }
        },
        "required": [
          "todos"
        ],
        "additionalProperties": false
      },
      "notes": {},
      "source": {
        "file": "02-modules/files/chunk-gwd0s2d1.js",
        "line": 212,
        "byteOffset": 62500,
        "inputSchemaGetter": "(){return ks()}",
        "schemaBuilder": "ks",
        "builderResolution": "ok"
      },
      "searchHint": "manage the session task checklist"
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
      "searchHint": "edit Jupyter notebook cells (.ipynb)"
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
      "searchHint": "fetch and extract content from a URL"
    }
  }
};

/** 取某工具的上游契约；没有则返回 null（调用方保留自研 schema）。 */
export function upstreamSchema(name) {
  const e = UPSTREAM_TOOL_SCHEMAS.tools[name];
  return e ? e.schema : null;
}

/** 该工具是否采用/合并了上游契约。 */
export function usesUpstreamSchema(name) {
  return Boolean(UPSTREAM_TOOL_SCHEMAS.tools[name]);
}
