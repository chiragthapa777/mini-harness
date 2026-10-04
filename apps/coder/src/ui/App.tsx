import { Box, Static, Text, useApp, useInput } from "ink";
import { homedir } from "node:os";
import { useEffect, useReducer, useRef, useState } from "react";
import { COMMANDS, type Command, type Core, type CoreMessage, type Decision } from "@mini-agent/coder-core/wire";
import { Markdown } from "@mini-agent/ink-markdown";
import { fold, initialState, type Item } from "./fold.js";
import { editInput, emptyInput } from "./input.js";

type PermissionParams = Extract<CoreMessage, { type: "permission_request" }>;
type ToolItem = Extract<Item, { kind: "tool" }>;

const ACCENT = "cyan";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TOOL_OUTPUT_LINES = 4;
const DIFF_LINES = 8;
const PERMISSION_INPUT_LINES = 20;
// ponytail: a time window, not proof the user read the prompt. Keys typed
// before this has passed are taken as meant for the input box, so typing
// ahead cannot approve a command. Upgrade: require a second confirming key.
const PERMISSION_ARM_MS = 600;

const TOOL_LABELS: Record<string, string> = {
  bash: "Bash",
  read_file: "Read",
  edit_file: "Update",
  write_file: "Write",
  glob: "Glob",
  grep: "Grep",
};

const HELP = [
  "/clear   start a new conversation",
  "/undo    restore the files the last turn changed",
  "/model   show the model, or switch: /model provider:model",
  "/quit    exit (or Ctrl+C twice)",
  "esc      interrupt the turn",
  "↑ ↓      earlier messages",
].join("\n");

interface Asking {
  params: PermissionParams;
  shownAt: number;
  choice: number;
}

/** The interactive session: transcript, tool cards, permission prompt, input. */
export function App({ core, cwd }: { core: Core; cwd: string }) {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(fold, initialState);
  const [input, setInput] = useState(emptyInput);
  const [sent, setSent] = useState<string[]>([]);
  const [sentAt, setSentAt] = useState(0); // sent.length means "not browsing"
  const [queue, setQueue] = useState<string[]>([]);
  const [asking, setAsking] = useState<Asking>();
  const [quitArmed, setQuitArmed] = useState(false);
  const turnStartedAt = useRef(0);

  useEffect(() => {
    core.onMessage((message) => {
      if (message.type === "permission_request") setAsking({ params: message, shownAt: Date.now(), choice: 0 });
      dispatch(message);
    });
  }, [core]);

  function answer(asking: Asking, decision: Decision) {
    setAsking(undefined);
    core.send({ type: "permission_answer", callId: asking.params.callId, decision });
  }

  // One turn at a time: whatever was typed goes through the queue, and the
  // next message leaves it only when no turn is running.
  useEffect(() => {
    const next = queue[0];
    if (state.running || next === undefined) return;
    setQueue(queue.slice(1));
    turnStartedAt.current = Date.now();
    dispatch({ type: "user", text: next });
    core.send({ type: "submit", text: next });
  }, [state.running, queue, core]);

  function runCommand(line: string) {
    const [word = "", ...rest] = line.slice(1).split(/\s+/);
    if (word === "quit" || word === "exit") return exit();
    if (word === "help") return dispatch({ type: "notice", text: HELP });

    if (!(COMMANDS as readonly string[]).includes(word)) {
      return dispatch({ type: "notice", text: `unknown command /${word}. /help lists the commands`, isError: true });
    }
    // The core answers with a notice.
    core.send({ type: "command", name: word as Command, arg: rest.join(" ") || undefined });
  }

  useInput((value, key) => {
    if (key.ctrl && value === "c") {
      if (quitArmed) return exit();
      setQuitArmed(true);
      setInput(emptyInput);
      return;
    }
    setQuitArmed(false);

    if (key.escape) {
      if (!state.running) return;
      setQueue([]);
      if (asking) answer(asking, "deny");
      core.send({ type: "abort" });
      return;
    }

    if (asking) {
      if (Date.now() - asking.shownAt < PERMISSION_ARM_MS) return;
      const options = permissionOptions(asking.params.tool);
      const step = key.upArrow ? -1 : key.downArrow ? 1 : 0;
      if (step) {
        const choice = (asking.choice + step + options.length) % options.length;
        return setAsking({ ...asking, choice });
      }
      const picked = key.return ? options[asking.choice] : options[Number(value) - 1];
      if (picked) answer(asking, picked.decision);
      return;
    }

    if (key.return) {
      const text = input.text.trim();
      setInput(emptyInput);
      if (!text) return;
      setSent([...sent, text]);
      setSentAt(sent.length + 1);
      if (text.startsWith("/")) return runCommand(text);
      setQueue((current) => [...current, text]);
      return;
    }

    if (key.upArrow || key.downArrow) {
      const at = Math.min(sent.length, Math.max(0, sentAt + (key.upArrow ? -1 : 1)));
      const text = sent[at] ?? "";
      setSentAt(at);
      setInput({ text, cursor: text.length });
      return;
    }

    setInput((current) => editInput(current, value, key));
  });

  // Finished items are printed once and left to the terminal's scrollback;
  // only the item still changing is redrawn.
  const finished: (Item | { kind: "welcome" })[] = [
    { kind: "welcome" },
    ...(state.running ? state.items.slice(0, -1) : state.items),
  ];
  const live = state.running ? state.items.at(-1) : undefined;

  return (
    <>
      <Static items={finished}>
        {(item, index) =>
          item.kind === "welcome" ? <Welcome key={index} cwd={cwd} /> : <ItemView key={index} item={item} />
        }
      </Static>

      <Box flexDirection="column">
        {live && <ItemView item={live} />}

        {state.running && !asking && (
          <Box marginTop={1}>
            <Spinner
              label={state.thinking ? "Thinking" : "Working"}
              startedAt={turnStartedAt.current}
              tokens={state.usage?.outputTokens}
            />
          </Box>
        )}

        {asking ? (
          <PermissionPrompt params={asking.params} choice={asking.choice} />
        ) : (
          <>
            {state.running &&
              queue.map((text, index) => (
                <Text key={index} dimColor>
                  {"> "}
                  {text}
                </Text>
              ))}
            <Box marginTop={1} borderStyle="round" borderColor="gray" paddingX={1}>
              <Text>
                {"> "}
                {input.text.slice(0, input.cursor)}
                <Text inverse>{input.text[input.cursor] ?? " "}</Text>
                {input.text.slice(input.cursor + 1)}
              </Text>
            </Box>
            <Box justifyContent="space-between" paddingX={2}>
              <Text dimColor>{quitArmed ? "Press Ctrl+C again to exit" : "/help for commands"}</Text>
              <Text dimColor>
                {state.session?.model} · {state.session?.mode}
              </Text>
            </Box>
          </>
        )}
      </Box>
    </>
  );
}

function Welcome({ cwd }: { cwd: string }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1} alignSelf="flex-start">
      <Text>
        Welcome to <Text bold>mini-coder</Text>
      </Text>
      <Text> </Text>
      <Text dimColor>{"  /help for commands"}</Text>
      <Text dimColor>{`  cwd: ${cwd.replace(homedir(), "~")}`}</Text>
    </Box>
  );
}

function Spinner({ label, startedAt, tokens }: { label: string; startedAt: number; tokens?: number }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((current) => current + 1), 80);
    return () => clearInterval(timer);
  }, []);

  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  return (
    <Text>
      <Text color={ACCENT}>
        {SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} {label}…
      </Text>
      <Text dimColor>{` (${seconds}s${tokens ? ` · ↓ ${tokens} tokens` : ""} · esc to interrupt)`}</Text>
    </Text>
  );
}

function ItemView({ item }: { item: Item }) {
  switch (item.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text dimColor>
            {"> "}
            {item.text}
          </Text>
        </Box>
      );

    case "assistant":
      // The text before a tool call is often only a newline.
      if (!item.text.trim()) return null;
      return (
        <Box marginTop={1}>
          <Text>⏺ </Text>
          <Box flexDirection="column" flexShrink={1}>
            <Markdown>{item.text.trim()}</Markdown>
          </Box>
        </Box>
      );

    case "tool":
      return <ToolCard item={item} />;

    case "notice":
      return <Result isError={item.isError}>{item.text}</Result>;
  }
}

function ToolCard({ item }: { item: ToolItem }) {
  const fields = asFields(item.input);
  const color = item.status === "running" ? "gray" : item.status === "error" ? "red" : "green";
  const lines = item.output.trimEnd().split("\n");
  const isRead = item.name === "read_file" && item.status === "done";
  const isChange = (item.name === "edit_file" || item.name === "write_file") && item.status !== "error";

  // While it runs the newest lines matter; once done, the start reads better.
  const shown = item.status === "running" ? lines.slice(-TOOL_OUTPUT_LINES) : lines.slice(0, TOOL_OUTPUT_LINES);
  const hidden = lines.length - shown.length;
  const output = isRead
    ? `Read ${lines.length} lines`
    : shown.join("\n") + (hidden > 0 ? `\n… +${hidden} lines` : "");

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={color}>⏺ </Text>
        <Text bold>{TOOL_LABELS[item.name] ?? item.name}</Text>({inputSummary(item.input)})
      </Text>
      {output.trim() !== "" && <Result isError={item.status === "error"}>{output}</Result>}
      {isChange && (
        <Box marginLeft={5}>
          <Diff removed={fields.old_string} added={fields.new_string ?? fields.content} max={DIFF_LINES} />
        </Box>
      )}
    </Box>
  );
}

/** The `⎿` line under a tool call or a command. */
function Result({ isError, children }: { isError: boolean; children: string }) {
  return (
    <Box>
      <Text dimColor>{"  ⎿  "}</Text>
      <Box flexShrink={1}>
        <Text color={isError ? "red" : undefined} dimColor={!isError}>
          {children}
        </Text>
      </Box>
    </Box>
  );
}

function Diff({ removed, added, max }: { removed: unknown; added: unknown; max: number }) {
  const side = (text: unknown, sign: string) => {
    if (typeof text !== "string" || text === "") return [];
    const lines = text.split("\n");
    const hidden = lines.length - max;
    const shown = lines.slice(0, max).map((line) => `${sign} ${line}`);
    return hidden > 0 ? [...shown, `${sign} … +${hidden} lines`] : shown;
  };
  return (
    <Box flexDirection="column">
      {side(removed, "-").map((line, index) => (
        <Text key={`r${index}`} color="red">
          {line}
        </Text>
      ))}
      {side(added, "+").map((line, index) => (
        <Text key={`a${index}`} color="green">
          {line}
        </Text>
      ))}
    </Box>
  );
}

function permissionOptions(tool: string): { label: string; decision: Decision }[] {
  // The core's "always" covers a command only verbatim, a file tool as a whole.
  const scope = tool === "bash" ? "for this exact command" : `for ${TOOL_LABELS[tool] ?? tool}`;
  return [
    { label: "Yes", decision: "allow" },
    { label: `Yes, and don't ask again ${scope} this session`, decision: "always" },
    { label: "No, and let the model try something else", decision: "deny" },
  ];
}

function PermissionPrompt({ params, choice }: { params: PermissionParams; choice: number }) {
  // Shown in full: this is what the user is approving.
  const fields = asFields(params.input);
  // An edit shows what it replaces; a written file shows its content.
  const added = fields.new_string ?? fields.content;
  const isChange = typeof fields.path === "string" && typeof added === "string";
  const lines = inputText(params.input).split("\n");
  const hidden = lines.length - PERMISSION_INPUT_LINES;
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        {TOOL_LABELS[params.tool] ?? params.tool}
      </Text>
      <Box flexDirection="column" marginLeft={2} marginY={1}>
        {isChange ? (
          <>
            <Text>
              {String(fields.path)}
              {fields.replace_all === true && " (every occurrence)"}
            </Text>
            <Diff removed={fields.old_string} added={added} max={PERMISSION_INPUT_LINES} />
          </>
        ) : (
          <>
            <Text>{lines.slice(0, PERMISSION_INPUT_LINES).join("\n")}</Text>
            {hidden > 0 && <Text color="yellow">{`… ${hidden} more lines not shown`}</Text>}
          </>
        )}
        <Text dimColor>{params.reason}</Text>
      </Box>
      <Text>Do you want to proceed?</Text>
      {permissionOptions(params.tool).map((option, index) => (
        <Text key={index} color={index === choice ? ACCENT : undefined}>
          {index === choice ? "❯ " : "  "}
          {index + 1}. {option.label}
        </Text>
      ))}
      <Text dimColor>↑↓ and enter, or 1-3 · esc interrupts the turn</Text>
    </Box>
  );
}

function asFields(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
}

/** A lone command as it is; anything else as JSON. */
function inputText(input: unknown): string {
  const fields = asFields(input);
  if (Object.keys(fields).length === 1 && typeof fields.command === "string") return fields.command;
  return JSON.stringify(input, null, 2) ?? "";
}

function inputSummary(input: unknown): string {
  const fields = asFields(input);
  const main = fields.command ?? fields.pattern ?? fields.path;
  const text = (typeof main === "string" ? main : (JSON.stringify(input) ?? "")).replace(/\s+/g, " ");
  return text.length > 100 ? `${text.slice(0, 100)}…` : text;
}
