import { Box, render, Text } from "ink";
import { useEffect, useState } from "react";
import { me, type AuthUser } from "./api.js";
import { applyArgs } from "./cli.js";
import { Chat } from "./Chat.js";
import { Login } from "./Login.js";
import { clearToken, readToken } from "./token.js";

/**
 * The terminal gateway. Same endpoints as the web app, same JWT, no harness
 * logic of its own — a different surface onto one agent, not a second one.
 */
function App() {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [checking, setChecking] = useState(true);

  // A cached token is only worth having if it still works; validating it here
  // means an expired one drops to the sign-in prompt instead of failing on the
  // first message.
  useEffect(() => {
    void (async () => {
      const cached = await readToken();
      if (cached) {
        try {
          setUser(await me(cached));
          setToken(cached);
        } catch {
          await clearToken();
        }
      }
      setChecking(false);
    })();
  }, []);

  if (checking) {
    return (
      <Box paddingY={1}>
        <Text dimColor>connecting…</Text>
      </Box>
    );
  }

  if (!token || !user) {
    return (
      <Login
        onDone={(newToken, newUser) => {
          setToken(newToken);
          setUser(newUser);
        }}
      />
    );
  }

  return <Chat token={token} user={user} />;
}

// Flags first: --help and --version have to work in a pipe (`mini-agent
// --help | less` is the obvious thing to try), so they are answered before the
// terminal check below.
const { exit } = applyArgs();
if (exit) {
  (exit.code === 0 ? console.log : console.error)(exit.message);
  process.exit(exit.code);
}

// Ink reads keystrokes in raw mode, which needs a real terminal. Piped or
// redirected stdin otherwise fails deep inside a render with a React stack
// trace, which tells the reader nothing about what to do next.
if (!process.stdin.isTTY) {
  console.error("mini-agent needs an interactive terminal — run it directly, not through a pipe.");
  process.exit(1);
}

render(<App />);
