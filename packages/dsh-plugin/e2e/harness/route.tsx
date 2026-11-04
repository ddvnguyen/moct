import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { islandHost } from "../../src/client/island";
import { createSeatComponent } from "../../src/client/seat";
import { BOARD_ROUTE, type IslandRoute } from "../../src/client/navigation";
import { installBackend } from "./backend";

/**
 * M-154 harness: one island page, chosen by the URL.
 *
 * The keep-alive harness boots the island detached and moves it between rail
 * cells, which is the right shape for M-130 but the wrong one here: the smoke
 * sweep opens fifteen Settings tabs and thirteen agent views, and the locale
 * spec has to survive a `window.location.reload()` — the Language row's own
 * confirmation. A URL-addressed page gives each of those a stable address, so a
 * reload lands on the same route instead of back at the board.
 *
 * `?route=<family>&id=<detail id>&query=<the route's own query>`; the query is
 * passed through undecoded-by-us, because the Settings page parses `tab=` out
 * of it exactly as it does in the shell.
 */

declare global {
  interface Window {
    /** The island host, so a spec can wait for the mount instead of a timer. */
    __islandHost?: () => HTMLElement | null;
  }
}

installBackend();

const params = new URLSearchParams(window.location.search);

function readRoute(): IslandRoute {
  const query = params.get("query") ?? "";
  const id = params.get("id") ?? "";
  const base = ((): IslandRoute => {
    switch (params.get("route") ?? "board") {
      case "issue":
        return { view: "issue", issueId: id === "" ? "MUL-1" : id };
      case "agents":
        return { view: "agents" };
      case "agent":
        return { view: "agent", agentId: id === "" ? "agent-1" : id };
      case "skills":
        return { view: "skills" };
      case "skill":
        return { view: "skill", skillId: id === "" ? "skill-1" : id };
      case "inbox":
        return { view: "inbox" };
      case "decisions":
        return { view: "decisions" };
      case "chat":
        return { view: "chat" };
      case "settings":
        return { view: "settings" };
      default:
        return BOARD_ROUTE;
    }
  })();
  return query === "" ? base : { ...base, query };
}

const style = document.createElement("style");
style.textContent = `
  body { margin: 0; font-family: sans-serif; }
  #main { display: flex; flex-direction: column; height: 100vh; }
`;
document.head.append(style);

const main = document.createElement("div");
main.id = "main";
document.body.append(main);

window.__islandHost = islandHost;

const Seat = createSeatComponent(createElement as never, {
  panelId: "multica",
  route: readRoute(),
});

createRoot(main).render(createElement(Seat as never));
