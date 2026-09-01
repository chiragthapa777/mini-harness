/**
 * Trimmed capture of the html.duckduckgo.com result page: one ad block, two
 * organic results behind the `uddg` redirector, one already-absolute href.
 * Parsing is a scrape, so this fixture is the tripwire for markup drift.
 */
export const DDG_HTML = `
<div class="results">
  <div class="result results_links results_links_deep result--ad result--ad--small">
    <div class="links_main">
      <h2 class="result__title">
        <a class="result__a" href="//duckduckgo.com/y.js?ad_provider=bingv7aa">Sponsored thing</a>
      </h2>
      <a class="result__snippet">Buy the sponsored thing today</a>
    </div>
  </div>

  <div class="result results_links results_links_deep web-result">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a"
           href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fpnpm.io%2Finstallation&amp;rut=abc123">pnpm <b>installation</b></a>
      </h2>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fpnpm.io%2Finstallation">
        Install <b>pnpm</b> with corepack &amp; friends&hellip;
      </a>
    </div>
  </div>

  <div class="result results_links results_links_deep web-result">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="https://github.com/pnpm/pnpm/releases">pnpm releases</a>
      </h2>
      <div class="result__snippet">Release notes for every pnpm version.</div>
    </div>
  </div>
</div>
`;

export const DDG_LITE = `
<table>
  <tr>
    <td valign="top">1.&nbsp;</td>
    <td><a rel="nofollow" href="https://nodejs.org/en/download" class='result-link'>Node.js &mdash; Download</a></td>
  </tr>
  <tr><td class='result-snippet'>Get Node.js for your platform.</td></tr>
  <tr>
    <td valign="top">2.&nbsp;</td>
    <td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2F" class='result-link'>API docs</a></td>
  </tr>
  <tr><td class='result-snippet'>The Node.js API reference.</td></tr>
</table>
`;

export const DDG_BLOCKED = `
<div class="anomaly-modal__mask">
  <div class="anomaly-modal__modal">
    <p>Unfortunately, bots use DuckDuckGo too.</p>
  </div>
</div>
`;
