/** One line of the `/` menu: an action or a skill, named without the slash. */
export interface MenuItem {
  name: string;
  description: string;
}

/** What the user can do with a slash, besides running a skill. */
export const ACTIONS: MenuItem[] = [
  { name: "clear", description: "start a new conversation" },
  { name: "compact", description: "replace the conversation with a summary of it" },
  { name: "undo", description: "restore the files the last turn changed" },
  { name: "model", description: "show the model, or switch: /model provider:model" },
  { name: "tools", description: "list the tools the model can use" },
  { name: "help", description: "list the commands and keys" },
  { name: "quit", description: "exit (or Ctrl+C twice)" },
];

/**
 * The menu for what is typed. It is open only while the command word itself is
 * being typed: `/`, `/co`. A space after the word closes it, so arguments can
 * be typed and Enter runs the line as it is.
 */
export function menuFor(text: string, items: MenuItem[]): MenuItem[] {
  if (!/^\/[\w-]*$/.test(text)) return [];
  const typed = text.slice(1).toLowerCase();
  return items.filter((item) => item.name.toLowerCase().startsWith(typed));
}

/** The first sentence, on one line: descriptions come from skills and tools and can be long. */
export function firstSentence(text: string, max = 70): string {
  const sentence = text.replace(/\s+/g, " ").trim().split(/(?<=\.)\s/)[0] ?? "";
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}
