/** A page whose real content is buried in nav, header, sidebar, and footer. */
export const ARTICLE_HTML = `
<html>
<head>
  <title>How pnpm workspaces work</title>
  <script>window.analytics = {track(){}}</script>
  <style>body { color: red }</style>
</head>
<body>
  <header><a href="/">Home</a> <a href="/blog">Blog</a></header>
  <nav><ul><li><a href="/a">Nav A</a></li><li><a href="/b">Nav B</a></li></ul></nav>
  <article>
    <h1>How pnpm workspaces work</h1>
    <p>A workspace links packages by <a href="/docs/protocol">the workspace protocol</a>.</p>
    <h2>Linking</h2>
    <ul>
      <li>Every package resolves from the store</li>
      <li>Symlinks keep <code>node_modules</code> flat-free</li>
    </ul>
    <pre>pnpm install
pnpm -r build</pre>
    <p>Caf&eacute; &amp; croissants cost 5&nbsp;&euro;.</p>
  </article>
  <aside>Related: <a href="/other">Something else</a></aside>
  <footer>&copy; 2026</footer>
</body>
</html>
`;

/** No semantic container — extraction has to fall back to <body>. */
export const PLAIN_HTML = `
<html><head><title>Plain</title></head>
<body>
  <div><h1>Plain page</h1><p>First para.</p><p>Second para.</p></div>
</body></html>
`;
