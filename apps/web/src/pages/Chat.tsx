import { useSearchParams } from "react-router-dom";
import { ChatClassic } from "./ChatClassic.js";
import { ChatStream } from "./ChatStream.js";

/** Picks response mode from `?mode=stream`; anything else falls back to classic. */
export function Chat() {
  const [searchParams] = useSearchParams();
  return searchParams.get("mode") === "stream" ? <ChatStream /> : <ChatClassic />;
}
