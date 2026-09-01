import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { login, type AuthUser } from "./api.js";
import { writeToken } from "./token.js";

/**
 * Email then password, both typed inline. There is no self-registration
 * anywhere in this project, so this is a sign-in and nothing else.
 */
export function Login({ onDone }: { onDone(token: string, user: AuthUser): void }) {
  const [field, setField] = useState<"email" | "password">("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (address: string, secret: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await login(address, secret);
      await writeToken(result.token);
      onDone(result.token, result.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "sign in failed");
      // Keep the email, drop the password — retyping the whole thing after a
      // typo in one field is its own small punishment.
      setPassword("");
      setField("password");
    } finally {
      setBusy(false);
    }
  };

  useInput((input, key) => {
    if (busy) return;

    if (key.return) {
      if (field === "email") {
        if (email.trim()) setField("password");
        return;
      }
      if (password) void submit(email.trim(), password);
      return;
    }

    // Ink hands backspace through as `delete` on most terminals and
    // `backspace` on the rest; both mean the same thing here.
    if (key.backspace || key.delete) {
      if (field === "email") setEmail((value) => value.slice(0, -1));
      else setPassword((value) => value.slice(0, -1));
      return;
    }

    if (key.tab) {
      setField(field === "email" ? "password" : "email");
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      if (field === "email") setEmail((value) => value + input);
      else setPassword((value) => value + input);
    }
  });

  return (
    <Box flexDirection="column" paddingY={1}>
      <Text bold>mini-agent</Text>
      <Text dimColor>sign in</Text>

      <Box marginTop={1}>
        <Text color={field === "email" ? "cyan" : undefined}>email    </Text>
        <Text>{email}</Text>
        {field === "email" && <Text color="cyan">▌</Text>}
      </Box>
      <Box>
        <Text color={field === "password" ? "cyan" : undefined}>password </Text>
        <Text>{"•".repeat(password.length)}</Text>
        {field === "password" && <Text color="cyan">▌</Text>}
      </Box>

      {busy && <Text dimColor>signing in…</Text>}
      {error && <Text color="red">{error}</Text>}

      <Box marginTop={1}>
        <Text dimColor>enter to continue · tab to switch field · ctrl-c to quit</Text>
      </Box>
    </Box>
  );
}
