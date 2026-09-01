import { useSearchParams } from "react-router-dom";
import { ChatClassic } from "./ChatClassic.js";
import { ChatStream } from "./ChatStream.js";

/** Picks response mode from `?mode=classic`; anything else defaults to streaming. */
export function Chat() {
  const [searchParams] = useSearchParams();
  return searchParams.get("mode") === "classic" ? <ChatClassic /> : <ChatStream />;
}
